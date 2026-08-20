import { describe, it, expect, beforeEach, vi } from 'vitest';
import { env, SELF } from 'cloudflare:test';
import type { Env } from '../src/index.js';
import worker from '../src/index.js';
import { setupTestDb } from './test-helpers.js';
import * as Sentry from '@sentry/cloudflare';
import { handleClerkWebhook } from '../src/handlers/clerk-webhook.js';
import { handleStripeWebhook } from '../src/handlers/stripe-webhook.js';
import { Webhook } from 'svix';
import * as schema from '@event-booking/shared';
import Stripe from 'stripe';
import type { SeatLedger } from '../src/seat-ledger.js';

vi.mock('@sentry/cloudflare', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@sentry/cloudflare')>();
  return {
    ...actual,
    captureException: vi.fn(),
    captureMessage: vi.fn(),
  };
});

vi.mock('@clerk/backend', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@clerk/backend')>();
  return {
    ...actual,
    verifyToken: vi.fn(async (token: string) => {
      if (token.startsWith('valid-test-token')) {
        return {
          sub: `user_${token}`,
          o: {
            id: 'test-org-sentry',
            rol: 'organiser',
            slg: 'test-org-sentry',
          },
        };
      }
      throw new Error('Invalid token');
    }),
  };
});

let mockStripeEvent: Stripe.Event | null = null;

vi.mock('stripe', () => {
  return {
    default: class MockStripe {
      webhooks = {
        constructEventAsync: vi.fn(async () => {
          if (!mockStripeEvent) {
            throw new Error('Stripe signature verification failed');
          }
          return mockStripeEvent;
        }),
      };
      static createFetchHttpClient = vi.fn();
    },
  };
});

function createMockSeatLedgerNamespace(
  reserveSeatImpl?: () => Promise<{ reservationId: string; expiresAt: number }>,
  confirmSeatImpl?: () => Promise<{ userId: string; seatCount: number }>
): DurableObjectNamespace<SeatLedger> {
  const dummyId: DurableObjectId = {
    name: 'mock-id',
    toString: () => 'mock-id',
    equals: (other: DurableObjectId) => other.name === 'mock-id',
  };

  const stub = {
    getAvailableSeats: async () => 10,
    reserveSeat: reserveSeatImpl ?? (async () => { throw new Error('DO Failure'); }),
    confirmSeat: confirmSeatImpl ?? (async () => { throw new Error('DO Failure'); }),
  } as unknown as DurableObjectStub<SeatLedger>;

  const ns: DurableObjectNamespace<SeatLedger> = {
    get: () => stub,
    getByName: () => stub,
    idFromName: () => dummyId,
    idFromString: () => dummyId,
    newUniqueId: () => dummyId,
    jurisdiction: () => ns,
  };

  return ns;
}

describe('Sentry Error Monitoring Integration', () => {
  let db: Awaited<ReturnType<typeof setupTestDb>>;
  const workerEnv = env as unknown as Env;

  const clerkWebhookSecret = 'whsec_' + Buffer.from('12345678901234567890123456789012').toString('base64');

  beforeEach(async () => {
    db = await setupTestDb(workerEnv.DB);
    vi.clearAllMocks();
    mockStripeEvent = null;
  });

  async function createSignedClerkWebhookRequest(payload: object): Promise<Request> {
    const rawBody = JSON.stringify(payload);
    const wh = new Webhook(clerkWebhookSecret);
    const msgId = 'msg_' + crypto.randomUUID();
    const timestamp = new Date();
    const signature = wh.sign(msgId, timestamp, rawBody);

    return new Request('https://worker.dev/api/webhooks/clerk', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'svix-id': msgId,
        'svix-timestamp': Math.floor(timestamp.getTime() / 1000).toString(),
        'svix-signature': signature,
      },
      body: rawBody,
    });
  }

  it('1. Unexpected / internal tRPC error in reserveSeat (INTERNAL_SERVER_ERROR): fetchRequestHandler.onError captures exact underlying exception with metadata, response unchanged', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const expectedError = new Error('DO SQLite internal corruption');

    const testEnv: Env = {
      ...workerEnv,
      SEAT_LEDGER: createMockSeatLedgerNamespace(async () => {
        throw expectedError;
      }),
    };

    const req = new Request('https://worker.dev/trpc/reserveSeat', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer valid-test-token-sentry',
      },
      body: JSON.stringify({ eventId: 'event-sentry-err-1', seatCount: 1 }),
    });

    const res = await worker.fetch(req, testEnv);

    // Verify response is HTTP 500 with unchanged tRPC error payload
    expect(res.status).toBe(500);
    const body = await res.json() as { error: { message: string; data: { code: string } } };
    expect(body.error.message).toBe('Unable to reserve seats');
    expect(body.error.data.code).toBe('INTERNAL_SERVER_ERROR');

    // Verify fetchRequestHandler.onError caught INTERNAL_SERVER_ERROR and captured the exact underlying Error instance
    expect(Sentry.captureException).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'DO SQLite internal corruption' }),
      expect.objectContaining({
        tags: { path: 'reserveSeat', type: 'mutation' },
        extra: { code: 'INTERNAL_SERVER_ERROR' },
      })
    );
  });

  it('1b. Unexpected / internal tRPC error in ensureAttendee (INTERNAL_SERVER_ERROR): fetchRequestHandler.onError captures exact underlying DB error with metadata, response unchanged', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const expectedDbError = new Error('D1 attendee table write error');
    const originalPrepare = workerEnv.DB.prepare.bind(workerEnv.DB);

    // Spy on DB prepare to throw error ONLY when inserting into attendees table
    const dbSpy = vi.spyOn(workerEnv.DB, 'prepare').mockImplementation((query: string) => {
      const q = query.toLowerCase();
      if (q.includes('insert') && q.includes('attendees')) {
        throw expectedDbError;
      }
      return originalPrepare(query);
    });

    try {
      const req = new Request('https://worker.dev/trpc/ensureAttendee', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer valid-test-token-new-user-123',
        },
        body: JSON.stringify({}),
      });

      const res = await worker.fetch(req, workerEnv);

      // Verify client response is HTTP 500 with unchanged error payload
      expect(res.status).toBe(500);
      const body = await res.json() as { error: { message: string; data: { code: string } } };
      expect(body.error.message).toBe('Failed to create attendee profile');
      expect(body.error.data.code).toBe('INTERNAL_SERVER_ERROR');

      // Verify Sentry.captureException was called with the real underlying DB error (not the TRPCError wrapper)
      expect(Sentry.captureException).toHaveBeenCalledWith(
        expect.objectContaining({ message: 'D1 attendee table write error' }),
        expect.objectContaining({
          tags: { path: 'ensureAttendee', type: 'mutation' },
          extra: { code: 'INTERNAL_SERVER_ERROR' },
        })
      );
    } finally {
      dbSpy.mockRestore();
    }
  });

  it('2. Expected tRPC error path (UNAUTHORIZED): does NOT capture exception, response unchanged', async () => {
    // Unauthenticated request to workerProcedure (reserveSeat)
    const res = await SELF.fetch('https://worker.dev/trpc/reserveSeat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ eventId: 'non-existent', seatCount: 1 }),
    });

    expect(res.status).toBe(401);
    expect(Sentry.captureException).not.toHaveBeenCalled();
  });

  it('3. Expected tRPC error (NOT_FOUND): does NOT capture exception, response unchanged', async () => {
    const res = await SELF.fetch('https://worker.dev/trpc/getPublicEvent?input=%7B%22eventId%22%3A%22non-existent-event-id%22%7D', {
      method: 'GET',
    });

    expect(res.status).toBe(404);
    expect(Sentry.captureException).not.toHaveBeenCalled();
  });

  it('4. Genuine exception in Clerk webhook: triggers Sentry.captureException, response unchanged', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const payload: Record<string, unknown> = {
      type: 'organization.created',
      data: {
        id: 'org-invalid-name',
        name: null, // Triggers NOT NULL constraint in D1
        created_by: 'owner-unique-999',
        created_at: Date.now(),
      },
    };

    const req = await createSignedClerkWebhookRequest(payload);
    const testEnv: Env = {
      ...workerEnv,
      CLERK_WEBHOOK_SECRET: clerkWebhookSecret,
    };

    const res = await handleClerkWebhook(req, testEnv);

    expect(res?.status).toBe(500);
    expect(await res?.text()).toBe('Database error');
    expect(Sentry.captureException).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        extra: {
          orgId: 'org-invalid-name',
          ownerId: 'owner-unique-999',
        },
      })
    );
  });

  it('5. Operational failure [ORG_OWNER_CONFLICT] in Clerk webhook: triggers Sentry.captureMessage with warning severity', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const existingOrgId = 'seeded-org-100';
    const ownerId = 'clerk-user-owner-100';

    await db.insert(schema.organisations).values({
      id: existingOrgId,
      name: 'Initial Org',
      ownerId: ownerId,
    });

    const conflictingOrgId = 'clerk-org-conflict-200';
    const payload = {
      type: 'organization.created',
      data: {
        id: conflictingOrgId,
        name: 'Second Org',
        created_by: ownerId,
        created_at: Date.now(),
      },
    };

    const req = await createSignedClerkWebhookRequest(payload);
    const testEnv: Env = {
      ...workerEnv,
      CLERK_WEBHOOK_SECRET: clerkWebhookSecret,
    };

    const res = await handleClerkWebhook(req, testEnv);

    expect(res?.status).toBe(200);
    expect(Sentry.captureMessage).toHaveBeenCalledWith(
      '[ORG_OWNER_CONFLICT]',
      expect.objectContaining({
        level: 'warning',
        extra: {
          existingOrgId,
          newOrgId: conflictingOrgId,
          ownerId,
        },
      })
    );
  });

  it('6. Genuine exception in Stripe webhook confirmSeat failure: triggers Sentry.captureException', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const holdId = 'test-hold-sentry-err';
    const eventId = 'test-event-sentry-err';
    const orgId = 'org-sentry-err-1';

    await db.insert(schema.organisations).values({
      id: orgId,
      name: 'Test Org',
      ownerId: 'owner_123',
    });

    await db.insert(schema.events).values({
      id: eventId,
      name: 'Test Event',
      date: new Date(),
      totalSeats: 100,
      pricePerSeat: 5000,
      organisationId: orgId,
    });

    const testEnv: Env = {
      ...workerEnv,
      STRIPE_SECRET_KEY: 'sk_test_123',
      STRIPE_WEBHOOK_SECRET: 'whsec_test_123',
      SEAT_LEDGER: createMockSeatLedgerNamespace(undefined, async () => {
        throw new Error('Unexpected DO Failure');
      }),
    };

    mockStripeEvent = {
      id: 'evt_test_123',
      object: 'event',
      api_version: '2020-08-27',
      created: Date.now(),
      livemode: false,
      pending_webhooks: 0,
      request: null,
      type: 'payment_intent.succeeded',
      data: {
        object: {
          id: 'pi_test_123',
          amount_received: 5000,
          metadata: { holdId, eventId },
        } as unknown as Stripe.PaymentIntent,
      },
    };

    const req = new Request('https://worker.dev/stripe/webhook', {
      method: 'POST',
      headers: { 'stripe-signature': 'sig_123' },
      body: 'raw_body',
    });

    const res = await handleStripeWebhook(req, testEnv);

    expect(res?.status).toBe(500);
    expect(Sentry.captureException).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        extra: {
          holdId,
          eventId,
          paymentIntentId: 'pi_test_123',
        },
      })
    );
  });

  it('7. Operational failure ORPHANED HOLD in Stripe webhook: triggers Sentry.captureMessage with error severity', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const holdId = 'orphaned-hold-id';
    const eventId = 'orphaned-event-id';
    const orgId = 'org-orphaned-1';

    await db.insert(schema.organisations).values({
      id: orgId,
      name: 'Test Org',
      ownerId: 'owner_orphaned',
    });

    // Ensure event exists in D1 so outcome reaches HOLD_ALREADY_USED -> orphaned_hold check
    await db.insert(schema.events).values({
      id: eventId,
      name: 'Test Event',
      date: new Date(),
      totalSeats: 100,
      pricePerSeat: 5000,
      organisationId: orgId,
    });

    const testEnv: Env = {
      ...workerEnv,
      STRIPE_SECRET_KEY: 'sk_test_123',
      STRIPE_WEBHOOK_SECRET: 'whsec_test_123',
      SEAT_LEDGER: createMockSeatLedgerNamespace(undefined, async () => {
        throw new Error('HOLD_ALREADY_USED');
      }),
    };

    mockStripeEvent = {
      id: 'evt_orphaned_123',
      object: 'event',
      api_version: '2020-08-27',
      created: Date.now(),
      livemode: false,
      pending_webhooks: 0,
      request: null,
      type: 'payment_intent.succeeded',
      data: {
        object: {
          id: 'pi_orphaned_123',
          amount_received: 5000,
          metadata: { holdId, eventId },
        } as unknown as Stripe.PaymentIntent,
      },
    };

    const req = new Request('https://worker.dev/stripe/webhook', {
      method: 'POST',
      headers: { 'stripe-signature': 'sig_123' },
      body: 'raw_body',
    });

    const res = await handleStripeWebhook(req, testEnv);

    expect(res?.status).toBe(500);
    expect(await res?.text()).toBe('Orphaned hold — needs reconciliation');
    expect(Sentry.captureMessage).toHaveBeenCalledWith(
      'payment_intent.succeeded: ORPHANED HOLD',
      expect.objectContaining({
        level: 'error',
        extra: {
          holdId,
          eventId,
          stripePaymentIntentId: 'pi_orphaned_123',
        },
      })
    );
  });

  it('8. SENTRY_DSN unset/empty: proves normal worker HTTP request handling when SENTRY_DSN is unset/empty', async () => {
    // Proves that when SENTRY_DSN is unset/empty at runtime, normal worker HTTP request handling functions without throwing
    const res = await SELF.fetch('https://worker.dev/trpc/listPublicEvents', {
      method: 'GET',
    });

    expect(res.status).toBe(200);
  });
});
