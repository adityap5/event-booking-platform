import { describe, it, expect, beforeEach, vi } from 'vitest';
import { env, runInDurableObject } from 'cloudflare:test';
import type { Env } from '../src/index.js';
import { setupTestDb, createTestCaller } from './test-helpers.js';
import * as Sentry from '@sentry/cloudflare';
import Stripe from 'stripe';
import * as schema from '@event-booking/shared';
import type { SeatLedger } from '../src/seat-ledger.js';
import { confirmBookingFromPayment } from '../src/booking-confirmation.js';
import { handleStripeWebhook } from '../src/handlers/stripe-webhook.js';
import { handleUpload } from '../src/handlers/upload.js';
import { TRPCError } from '@trpc/server';

vi.mock('@sentry/cloudflare', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@sentry/cloudflare')>();
  return {
    ...actual,
    captureException: vi.fn(),
    captureMessage: vi.fn(),
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
        generateTestHeaderStringAsync: vi.fn(async () => 't=123,v1=mock_sig'),
      };
      static createFetchHttpClient = vi.fn();
    },
  };
});

describe('Day 6 Structured Logging & Observability Groundwork', () => {
  let workerEnv: Env;
  let db: Awaited<ReturnType<typeof setupTestDb>>;

  beforeEach(async () => {
    workerEnv = env as unknown as Env;
    db = await setupTestDb(workerEnv.DB);
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  describe('1. Rate-limit rejection structured logging (7 call sites)', () => {
    it('logs structured JSON on reserveSeat rate-limit rejection', async () => {
      const consoleSpy = vi.spyOn(console, 'log');
      const userId = 'user-rate-reserve-test';
      const caller = createTestCaller({ env: workerEnv, db, userId });

      // Exhaust 10 allowed requests across distinct event DO instances
      for (let i = 0; i < 10; i++) {
        const eventId = `evt-reserve-rate-${i}`;
        const stub = workerEnv.SEAT_LEDGER.get(workerEnv.SEAT_LEDGER.idFromName(eventId));
        stub.initialize(100);
        await caller.reserveSeat({ eventId, seatCount: 1 });
      }

      consoleSpy.mockClear();

      // 11th request should trigger rate limit rejection
      await expect(caller.reserveSeat({ eventId: 'evt-reserve-rate-11', seatCount: 1 })).rejects.toThrowError(
        new TRPCError({
          code: 'TOO_MANY_REQUESTS',
          message: 'Too many reservation attempts. Try again in a minute.',
        })
      );

      const rateLimitLog = consoleSpy.mock.calls.find((call) => {
        try {
          const parsed = JSON.parse(call[0]);
          return parsed.category === 'rate_limit_rejection' && parsed.action === 'reserveSeat';
        } catch {
          return false;
        }
      });

      expect(rateLimitLog).toBeDefined();
      const parsedLog = JSON.parse(rateLimitLog![0]);
      expect(parsedLog).toMatchObject({
        category: 'rate_limit_rejection',
        action: 'reserveSeat',
        userId,
      });
      expect(parsedLog.ts).toBeTypeOf('number');
    });

    it('logs structured JSON on createEvent rate-limit rejection', async () => {
      const consoleSpy = vi.spyOn(console, 'log');
      const userId = 'user-rate-create-evt';
      const orgId = 'test-org-1';
      const caller = createTestCaller({ env: workerEnv, db, userId, orgId, role: 'org:admin' });

      // Exhaust 5 allowed requests
      for (let i = 0; i < 5; i++) {
        await caller.createEvent({
          name: `Test Event ${i}`,
          date: Date.now() + 86400000,
          totalSeats: 50,
          pricePerSeat: 1000,
        });
      }

      consoleSpy.mockClear();

      // 6th request triggers rate limit
      await expect(
        caller.createEvent({
          name: 'Excess Event',
          date: Date.now() + 86400000,
          totalSeats: 50,
          pricePerSeat: 1000,
        })
      ).rejects.toThrowError(
        new TRPCError({
          code: 'TOO_MANY_REQUESTS',
          message: 'Too many events created recently. Try again later.',
        })
      );

      const rateLimitLog = consoleSpy.mock.calls.find((call) => {
        try {
          const parsed = JSON.parse(call[0]);
          return parsed.category === 'rate_limit_rejection' && parsed.action === 'createEvent';
        } catch {
          return false;
        }
      });

      expect(rateLimitLog).toBeDefined();
      const parsedLog = JSON.parse(rateLimitLog![0]);
      expect(parsedLog).toMatchObject({
        category: 'rate_limit_rejection',
        action: 'createEvent',
        userId,
        orgId,
      });
    });

    it('logs structured JSON on createCheckoutSession rate-limit rejection', async () => {
      const consoleSpy = vi.spyOn(console, 'log');
      const userId = 'user-rate-checkout';
      const caller = createTestCaller({ env: workerEnv, db, userId });
      const fakeUuid = '11111111-2222-3333-4444-555555555555';

      for (let i = 0; i < 10; i++) {
        try {
          await caller.createCheckoutSession({ holdId: fakeUuid, eventId: 'evt-1' });
        } catch {
          // Expected NOT_FOUND before rate limit is reached
        }
      }

      consoleSpy.mockClear();

      await expect(
        caller.createCheckoutSession({ holdId: fakeUuid, eventId: 'evt-1' })
      ).rejects.toThrowError(
        new TRPCError({
          code: 'TOO_MANY_REQUESTS',
          message: 'Too many requests. Please try again shortly.',
        })
      );

      const rateLimitLog = consoleSpy.mock.calls.find((call) => {
        try {
          const parsed = JSON.parse(call[0]);
          return parsed.category === 'rate_limit_rejection' && parsed.action === 'createCheckoutSession';
        } catch {
          return false;
        }
      });

      expect(rateLimitLog).toBeDefined();
      const parsedLog = JSON.parse(rateLimitLog![0]);
      expect(parsedLog).toMatchObject({
        category: 'rate_limit_rejection',
        action: 'createCheckoutSession',
        userId,
      });
    });

    it('logs structured JSON on createSocketTicket rate-limit rejection', async () => {
      const consoleSpy = vi.spyOn(console, 'log');
      const userId = 'user-rate-ticket';
      const caller = createTestCaller({ env: workerEnv, db, userId });

      const eventId = 'evt-ticket-rate-log';
      const stub = workerEnv.SEAT_LEDGER.get(workerEnv.SEAT_LEDGER.idFromName(eventId));
      stub.initialize(100);

      for (let i = 0; i < 10; i++) {
        await caller.createSocketTicket({ eventId });
      }

      consoleSpy.mockClear();

      await expect(caller.createSocketTicket({ eventId })).rejects.toThrowError(
        new TRPCError({
          code: 'TOO_MANY_REQUESTS',
          message: 'Too many requests. Please try again shortly.',
        })
      );

      const rateLimitLog = consoleSpy.mock.calls.find((call) => {
        try {
          const parsed = JSON.parse(call[0]);
          return parsed.category === 'rate_limit_rejection' && parsed.action === 'createSocketTicket';
        } catch {
          return false;
        }
      });

      expect(rateLimitLog).toBeDefined();
      const parsedLog = JSON.parse(rateLimitLog![0]);
      expect(parsedLog).toMatchObject({
        category: 'rate_limit_rejection',
        action: 'createSocketTicket',
        userId,
      });
    });

    it('logs structured JSON on uploadEventCover rate-limit rejection', async () => {
      const consoleSpy = vi.spyOn(console, 'log');
      const userId = 'user_upload_test_ratelimit';

      // Mock Clerk verifyToken inside upload handler path
      const clerkMock = await import('@clerk/backend');
      vi.spyOn(clerkMock, 'verifyToken').mockResolvedValue({ sub: userId } as any);

      for (let i = 0; i < 5; i++) {
        const formData = new FormData();
        const dummyFile = new File([new Uint8Array([0xFF, 0xD8, 0xFF])], 'test.jpg', { type: 'image/jpeg' });
        formData.append('file', dummyFile);

        const req = new Request('https://worker.dev/upload/event-cover', {
          method: 'POST',
          headers: { Authorization: 'Bearer mock-token' },
          body: formData,
        });
        await handleUpload(req, workerEnv);
      }

      consoleSpy.mockClear();

      const formData = new FormData();
      const dummyFile = new File([new Uint8Array([0xFF, 0xD8, 0xFF])], 'test.jpg', { type: 'image/jpeg' });
      formData.append('file', dummyFile);

      const req = new Request('https://worker.dev/upload/event-cover', {
        method: 'POST',
        headers: { Authorization: 'Bearer mock-token' },
        body: formData,
      });

      const res = await handleUpload(req, workerEnv);

      expect(res?.status).toBe(429);
      expect(await res?.text()).toBe('Too many uploads. Please try again shortly.');

      const rateLimitLog = consoleSpy.mock.calls.find((call) => {
        try {
          const parsed = JSON.parse(call[0]);
          return parsed.category === 'rate_limit_rejection' && parsed.action === 'uploadEventCover';
        } catch {
          return false;
        }
      });

      expect(rateLimitLog).toBeDefined();
      const parsedLog = JSON.parse(rateLimitLog![0]);
      expect(parsedLog).toMatchObject({
        category: 'rate_limit_rejection',
        action: 'uploadEventCover',
        userId,
      });
    });

    it('logs structured JSON on publicImageRead rate-limit rejection (unauthenticated IP keying)', async () => {
      const consoleSpy = vi.spyOn(console, 'log');
      const testIp = '203.0.113.195';

      for (let i = 0; i < 120; i++) {
        const req = new Request('https://worker.dev/images/some-nonexistent-key', {
          headers: { 'CF-Connecting-IP': testIp },
        });
        await handleUpload(req, workerEnv);
      }

      consoleSpy.mockClear();

      const req = new Request('https://worker.dev/images/some-nonexistent-key', {
        headers: { 'CF-Connecting-IP': testIp },
      });
      const res = await handleUpload(req, workerEnv);

      expect(res?.status).toBe(429);

      const rateLimitLog = consoleSpy.mock.calls.find((call) => {
        try {
          const parsed = JSON.parse(call[0]);
          return parsed.category === 'rate_limit_rejection' && parsed.action === 'publicImageRead';
        } catch {
          return false;
        }
      });

      expect(rateLimitLog).toBeDefined();
      const parsedLog = JSON.parse(rateLimitLog![0]);
      expect(parsedLog).toMatchObject({
        category: 'rate_limit_rejection',
        action: 'publicImageRead',
        keyType: 'ip',
      });
      expect(parsedLog.ip).toBeUndefined();
    });

    it('logs structured JSON on publicRead middleware rate-limit rejection (unauthenticated IP keying)', async () => {
      const consoleSpy = vi.spyOn(console, 'log');
      const testIp = '198.51.100.44';
      const caller = createTestCaller({ env: workerEnv, db, ip: testIp });

      for (let i = 0; i < 60; i++) {
        await caller.listPublicEvents();
      }

      consoleSpy.mockClear();

      await expect(caller.listPublicEvents()).rejects.toThrowError(
        new TRPCError({
          code: 'TOO_MANY_REQUESTS',
          message: 'Too many requests. Please try again shortly.',
        })
      );

      const rateLimitLog = consoleSpy.mock.calls.find((call) => {
        try {
          const parsed = JSON.parse(call[0]);
          return parsed.category === 'rate_limit_rejection' && parsed.action === 'publicRead';
        } catch {
          return false;
        }
      });

      expect(rateLimitLog).toBeDefined();
      const parsedLog = JSON.parse(rateLimitLog![0]);
      expect(parsedLog).toMatchObject({
        category: 'rate_limit_rejection',
        action: 'publicRead',
        keyType: 'ip',
      });
      expect(parsedLog.ip).toBeUndefined();
    });
  });

  describe('2. TOO_MANY_PENDING_HOLDS logEvent in SeatLedger DO', () => {
    it('emits TOO_MANY_PENDING_HOLDS structured logEvent when user attempts second concurrent hold', async () => {
      const consoleSpy = vi.spyOn(console, 'log');
      const eventId = 'event-hold-cap-test';
      const userId = 'user_hold_cap_test';

      const id = workerEnv.SEAT_LEDGER.idFromName(eventId);
      const stub = workerEnv.SEAT_LEDGER.get(id);

      await stub.initialize(10);
      await stub.reserveSeat(userId, 1);

      consoleSpy.mockClear();

      let thrownErr: Error | null = null;
      try {
        await stub.reserveSeat(userId, 1);
      } catch (err: any) {
        thrownErr = err;
      }
      expect(thrownErr?.message).toBe('TOO_MANY_PENDING_HOLDS');

      const holdCapLog = consoleSpy.mock.calls.find((call) => {
        try {
          const parsed = JSON.parse(call[0]);
          return parsed.type === 'TOO_MANY_PENDING_HOLDS';
        } catch {
          return false;
        }
      });

      expect(holdCapLog).toBeDefined();
      const parsedLog = JSON.parse(holdCapLog![0]);
      expect(parsedLog).toMatchObject({
        type: 'TOO_MANY_PENDING_HOLDS',
        userId,
        reason: 'Pending hold limit reached',
      });
      expect(parsedLog.holdId).toBeUndefined();
      expect(parsedLog.ts).toBeTypeOf('number');
    });
  });

  describe('3. Invariant-violation logging (amount_mismatch & orphaned_hold)', () => {
    it('logs structured JSON on amount_mismatch in confirmBookingFromPayment', async () => {
      const consoleSpy = vi.spyOn(console, 'log');
      const eventId = 'event-mismatch-test';
      const holdId = 'hold-mismatch-1';
      const userId = 'user-mismatch-1';

      await db.insert(schema.events).values({
        id: eventId,
        name: 'Mismatch Event',
        date: new Date(Date.now() + 86400000),
        totalSeats: 100,
        pricePerSeat: 5000,
        organisationId: 'test-org-1',
      });

      const doStub = {
        confirmSeat: vi.fn(async () => ({ userId, seatCount: 2 })),
        releaseSeat: vi.fn(async () => {}),
      };

      const result = await confirmBookingFromPayment({
        db,
        seatLedger: doStub as any,
        holdId,
        eventId,
        stripePaymentIntentId: 'pi_mismatch_1',
        amountReceivedPence: 7000, // 7000 !== 5000 * 2 (10000)
      });

      expect(result.outcome).toBe('amount_mismatch');

      const mismatchLog = consoleSpy.mock.calls.find((call) => {
        try {
          const parsed = JSON.parse(call[0]);
          return parsed.category === 'invariant_violation' && parsed.action === 'amount_mismatch';
        } catch {
          return false;
        }
      });

      expect(mismatchLog).toBeDefined();
      const parsedLog = JSON.parse(mismatchLog![0]);
      expect(parsedLog).toMatchObject({
        category: 'invariant_violation',
        action: 'amount_mismatch',
        holdId,
        eventId,
        seatCount: 2,
        expectedPence: 10000,
        receivedPence: 7000,
      });
    });

    it('logs structured JSON alongside Sentry.captureMessage on orphaned_hold in handleStripeWebhook', async () => {
      const consoleSpy = vi.spyOn(console, 'log');
      const holdId = 'webhook-orphaned-hold-test';
      const eventId = 'webhook-event-orphaned-test';

      // Insert event into D1 so confirmBookingFromPayment passes event pre-check
      await db.insert(schema.events).values({
        id: eventId,
        name: 'Orphaned Event',
        date: new Date(Date.now() + 86400000),
        totalSeats: 10,
        pricePerSeat: 5000,
        organisationId: 'test-org-1',
      });

      mockStripeEvent = {
        id: 'evt_stripe_orphaned',
        object: 'event',
        type: 'payment_intent.succeeded',
        data: {
          object: {
            id: 'pi_orphaned_1',
            amount_received: 5000,
            metadata: { holdId, eventId },
          } as any,
        },
      } as any;

      const doId = workerEnv.SEAT_LEDGER.idFromName(eventId);
      const stub = workerEnv.SEAT_LEDGER.get(doId);

      await runInDurableObject(stub, (instance: SeatLedger) => {
        (instance as any).ctx.storage.sql.exec(
          "INSERT INTO reservations (id, user_id, seat_count, expires_at, status) VALUES (?, 'user1', 1, ?, 'confirmed')",
          holdId,
          Date.now() + 60000
        );
      });

      const rawBody = JSON.stringify(mockStripeEvent);
      const req = new Request('https://worker.dev/stripe/webhook', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'stripe-signature': 't=123,v1=mock_sig',
        },
        body: rawBody,
      });

      const res = await handleStripeWebhook(req, workerEnv);
      expect(res?.status).toBe(500);

      // Verify existing Sentry captureMessage is preserved
      expect(Sentry.captureMessage).toHaveBeenCalledWith(
        'payment_intent.succeeded: ORPHANED HOLD',
        expect.objectContaining({
          level: 'error',
          extra: expect.objectContaining({
            holdId,
            eventId,
            stripePaymentIntentId: 'pi_orphaned_1',
          }),
        })
      );

      // Verify new structured log line
      const orphanedLog = consoleSpy.mock.calls.find((call) => {
        try {
          const parsed = JSON.parse(call[0]);
          return parsed.category === 'invariant_violation' && parsed.action === 'orphaned_hold';
        } catch {
          return false;
        }
      });

      expect(orphanedLog).toBeDefined();
      const parsedLog = JSON.parse(orphanedLog![0]);
      expect(parsedLog).toMatchObject({
        category: 'invariant_violation',
        action: 'orphaned_hold',
        holdId,
        eventId,
      });
    });

    it('logs structured JSON alongside Sentry.captureMessage on amount_mismatch in handleStripeWebhook', async () => {
      const consoleSpy = vi.spyOn(console, 'log');
      const holdId = 'webhook-mismatch-hold-test';
      const eventId = 'webhook-mismatch-event-test';

      await db.insert(schema.events).values({
        id: eventId,
        name: 'Webhook Mismatch Event',
        date: new Date(Date.now() + 86400000),
        totalSeats: 10,
        pricePerSeat: 5000,
        organisationId: 'test-org-1',
      });

      const doId = workerEnv.SEAT_LEDGER.idFromName(eventId);
      const stub = workerEnv.SEAT_LEDGER.get(doId);

      await stub.initialize(10);
      await runInDurableObject(stub, (instance: SeatLedger) => {
        (instance as any).ctx.storage.sql.exec(
          "INSERT INTO reservations (id, user_id, seat_count, expires_at, status) VALUES (?, 'user1', 2, ?, 'pending')",
          holdId,
          Date.now() + 60000
        );
      });

      mockStripeEvent = {
        id: 'evt_stripe_mismatch',
        object: 'event',
        type: 'payment_intent.succeeded',
        data: {
          object: {
            id: 'pi_mismatch_webhook',
            amount_received: 7000, // Expected 10000 (5000 * 2)
            metadata: { holdId, eventId },
          } as any,
        },
      } as any;

      const rawBody = JSON.stringify(mockStripeEvent);
      const req = new Request('https://worker.dev/stripe/webhook', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'stripe-signature': 't=123,v1=mock_sig',
        },
        body: rawBody,
      });

      const res = await handleStripeWebhook(req, workerEnv);
      expect(res?.status).toBe(500);

      // Verify existing Sentry captureMessage is preserved
      expect(Sentry.captureMessage).toHaveBeenCalledWith(
        'payment_intent.succeeded: AMOUNT MISMATCH',
        expect.objectContaining({
          level: 'error',
          extra: expect.objectContaining({
            holdId,
            eventId,
            seatCount: 2,
            expectedPence: 10000,
            receivedPence: 7000,
          }),
        })
      );

      // Verify new structured log line
      const mismatchLog = consoleSpy.mock.calls.find((call) => {
        try {
          const parsed = JSON.parse(call[0]);
          return parsed.category === 'invariant_violation' && parsed.action === 'amount_mismatch';
        } catch {
          return false;
        }
      });

      expect(mismatchLog).toBeDefined();
      const parsedLog = JSON.parse(mismatchLog![0]);
      expect(parsedLog).toMatchObject({
        category: 'invariant_violation',
        action: 'amount_mismatch',
        holdId,
        eventId,
        seatCount: 2,
        expectedPence: 10000,
        receivedPence: 7000,
      });
    });
  });
});
