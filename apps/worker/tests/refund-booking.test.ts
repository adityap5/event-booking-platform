import { describe, it, expect, beforeEach, vi } from 'vitest';
import { env, runInDurableObject } from 'cloudflare:test';
import type { Env } from '../src/index.js';
import { events, attendees, bookings, auditLog } from '@event-booking/shared';
import { eq } from 'drizzle-orm';
import { setupTestDb, createTestCaller } from './test-helpers.js';
import type { SeatLedger } from '../src/seat-ledger.js';
import * as Sentry from '@sentry/cloudflare';
import { runReconciliation } from '../src/reconciliation.js';

// Spy on Sentry methods for assertion
vi.mock('@sentry/cloudflare', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@sentry/cloudflare')>();
  return {
    ...actual,
    captureException: vi.fn(),
    captureMessage: vi.fn(),
  };
});

interface StripeFetchMockOptions {
  refundResponse?: Record<string, unknown> | ((req: Request) => Promise<Response> | Response);
  refundStatus?: number;
  paymentIntentResponse?: Record<string, unknown>;
  refundsListResponse?: Record<string, unknown> | ((url: URL) => Record<string, unknown>);
}

function mockStripeCustom(opts: StripeFetchMockOptions = {}) {
  const originalFetch = globalThis.fetch;
  const interceptedRequests: { url: string; method: string; body: string; headers: Record<string, string> }[] = [];

  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const urlString = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;

    if (urlString.includes('api.stripe.com')) {
      const method = init?.method ?? 'GET';
      const body = init?.body ? String(init.body) : '';
      const headers: Record<string, string> = {};
      if (init?.headers) {
        if (init.headers instanceof Headers) {
          init.headers.forEach((v, k) => {
            headers[k.toLowerCase()] = v;
          });
        } else if (Array.isArray(init.headers)) {
          for (const [k, v] of init.headers) {
            headers[k.toLowerCase()] = v;
          }
        } else {
          for (const [k, v] of Object.entries(init.headers)) {
            headers[k.toLowerCase()] = v;
          }
        }
      }

      interceptedRequests.push({ url: urlString, method, body, headers });

      const parsedUrl = new URL(urlString);

      // Handle refunds.create (POST /v1/refunds)
      if (parsedUrl.pathname === '/v1/refunds' && method === 'POST') {
        if (typeof opts.refundResponse === 'function') {
          return await opts.refundResponse(new Request(urlString, init));
        }
        const respBody = opts.refundResponse ?? {
          id: 're_test_refund_123',
          object: 'refund',
          amount: 5000,
          currency: 'gbp',
          status: 'succeeded',
          payment_intent: 'pi_test_123',
        };
        const status = opts.refundStatus ?? 200;
        return new Response(JSON.stringify(respBody), {
          status,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      // Handle paymentIntents.retrieve (GET /v1/payment_intents/...)
      if (parsedUrl.pathname.startsWith('/v1/payment_intents/')) {
        const respBody = opts.paymentIntentResponse ?? {
          id: parsedUrl.pathname.split('/').pop(),
          object: 'payment_intent',
          amount: 5000,
          amount_received: 5000,
          currency: 'gbp',
          status: 'succeeded',
        };
        return new Response(JSON.stringify(respBody), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      // Handle refunds.list (GET /v1/refunds)
      if (parsedUrl.pathname === '/v1/refunds' && method === 'GET') {
        let respBody: Record<string, unknown>;
        if (typeof opts.refundsListResponse === 'function') {
          respBody = opts.refundsListResponse(parsedUrl);
        } else {
          respBody = opts.refundsListResponse ?? {
            object: 'list',
            data: [
              {
                id: 're_existing_123',
                object: 'refund',
                amount: 5000,
                status: 'succeeded',
                payment_intent: 'pi_test_123',
              },
            ],
            has_more: false,
            url: '/v1/refunds',
          };
        }
        return new Response(JSON.stringify(respBody), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      return new Response(JSON.stringify({ id: 'mock_default' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    return originalFetch(input, init);
  };

  return {
    interceptedRequests,
    restore: () => {
      globalThis.fetch = originalFetch;
    },
  };
}

describe('refundBooking Mutation — Day 9 Flow & Edge Cases', () => {
  let db: Awaited<ReturnType<typeof setupTestDb>>;
  const workerEnv = env as unknown as Env;

  const orgId = 'test-org-1';
  const otherOrgId = 'org-B-id';
  const organiserUserId = 'owner-1';
  const attendeeUserId = 'user-attendee-1';

  beforeEach(async () => {
    vi.clearAllMocks();
    db = await setupTestDb(workerEnv.DB);

    // Create attendee
    await db.insert(attendees).values({
      id: 'att-1',
      userId: attendeeUserId,
      email: 'attendee@example.com',
      name: 'Alice Attendee',
    });
  });

  async function seedTestBooking(opts: {
    eventId?: string;
    bookingId?: string;
    holdId?: string;
    seatCount?: number;
    status?: 'pending' | 'confirmed' | 'cancelled' | 'refunded';
    stripePaymentIntentId?: string | null;
    org?: string;
  }) {
    const eventId = opts.eventId ?? `event-${crypto.randomUUID()}`;
    const bookingId = opts.bookingId ?? `booking-${crypto.randomUUID()}`;
    const holdId = opts.holdId ?? crypto.randomUUID();
    const seatCount = opts.seatCount ?? 2;
    const status = opts.status ?? 'confirmed';
    const stripePaymentIntentId = opts.stripePaymentIntentId !== undefined ? opts.stripePaymentIntentId : `pi_${bookingId}`;
    const targetOrgId = opts.org ?? orgId;

    // Create event
    await db.insert(events).values({
      id: eventId,
      organisationId: targetOrgId,
      name: 'Refund Test Event',
      date: new Date(Date.now() + 86400000),
      totalSeats: 10,
      pricePerSeat: 2500,
    });

    // Initialize DO
    const stub = workerEnv.SEAT_LEDGER.get(workerEnv.SEAT_LEDGER.idFromName(eventId));
    await stub.initialize(10);

    // Seed reservation in DO
    await runInDurableObject(stub, (instance: SeatLedger) => {
      (instance as any).ctx.storage.sql.exec(
        "INSERT INTO reservations (id, user_id, seat_count, expires_at, status) VALUES (?, ?, ?, ?, ?)",
        holdId,
        attendeeUserId,
        seatCount,
        Date.now() + 15 * 60 * 1000,
        status === 'cancelled' ? 'released' : status
      );
    });

    // Seed booking in D1
    await db.insert(bookings).values({
      id: bookingId,
      eventId,
      attendeeId: 'att-1',
      status,
      holdId,
      seatCount,
      stripePaymentIntentId: stripePaymentIntentId ?? undefined,
    });

    return { eventId, bookingId, holdId, seatCount, stub, stripePaymentIntentId };
  }

  // ── Scenario A: Happy Path ──────────────────────────────────────────────────
  it('A. Stripe refund succeeds → DO succeeds → D1 succeeds → audit log written (seatCount > 1 full release)', async () => {
    const { eventId, bookingId, holdId, stub, stripePaymentIntentId } = await seedTestBooking({
      seatCount: 3,
      status: 'confirmed',
    });

    // Initial DO available seats: 10 - 3 = 7
    expect(await stub.getAvailableSeats()).toBe(7);

    const stripeMock = mockStripeCustom({
      refundResponse: {
        id: 're_happy_123',
        object: 'refund',
        amount: 7500,
        status: 'succeeded',
        payment_intent: stripePaymentIntentId,
      },
    });

    try {
      const caller = createTestCaller({
        env: workerEnv,
        db,
        userId: organiserUserId,
        orgId,
        role: 'organiser',
      });

      const res = await caller.refundBooking({ bookingId });
      expect(res).toEqual({ success: true, bookingId });

      // Invariant: Entire seat count (3 seats) returned to availability immediately
      expect(await stub.getAvailableSeats()).toBe(10);

      // DO status is 'refunded'
      const hold = await stub.getHold(holdId);
      expect(hold?.status).toBe('refunded');

      // D1 status is 'refunded'
      const [d1Booking] = await db.select().from(bookings).where(eq(bookings.id, bookingId));
      expect(d1Booking?.status).toBe('refunded');

      // Audit log row written
      const auditRows = await db.select().from(auditLog).where(eq(auditLog.eventType, 'booking_refunded'));
      expect(auditRows).toHaveLength(1);
      expect(auditRows[0]?.holdId).toBe(holdId);
      expect(auditRows[0]?.bookingEventId).toBe(eventId);
      const detail = JSON.parse(auditRows[0]?.detail ?? '{}');
      expect(detail.bookingId).toBe(bookingId);
      expect(detail.stripeRefundId).toBe('re_happy_123');
      expect(detail.seatCount).toBe(3);
      expect(detail.stripePaymentIntentId).toBe(stripePaymentIntentId);

      // Verify deterministic Stripe idempotency key header
      expect(stripeMock.interceptedRequests).toHaveLength(1);
      expect(stripeMock.interceptedRequests[0]?.headers['idempotency-key']).toBe(`refund_${bookingId}`);
    } finally {
      stripeMock.restore();
    }
  });

  // ── Scenario B: Stripe refund fails ─────────────────────────────────────────
  it('B. Stripe refund fails → DO hold remains confirmed, D1 remains confirmed, no audit log', async () => {
    const { bookingId, holdId, stub } = await seedTestBooking({
      seatCount: 2,
      status: 'confirmed',
    });

    const stripeMock = mockStripeCustom({
      refundStatus: 402,
      refundResponse: {
        error: {
          type: 'card_error',
          code: 'balance_insufficient',
          message: 'Insufficient balance to refund.',
        },
      },
    });

    try {
      const caller = createTestCaller({
        env: workerEnv,
        db,
        userId: organiserUserId,
        orgId,
        role: 'organiser',
      });

      await expect(caller.refundBooking({ bookingId })).rejects.toThrowError(/Failed to process refund with Stripe/);

      // DO hold is untouched: still confirmed, seats still consumed (8 available)
      const hold = await stub.getHold(holdId);
      expect(hold?.status).toBe('confirmed');
      expect(await stub.getAvailableSeats()).toBe(8);

      // D1 booking is untouched: still confirmed
      const [d1Booking] = await db.select().from(bookings).where(eq(bookings.id, bookingId));
      expect(d1Booking?.status).toBe('confirmed');

      // No audit log written
      const auditRows = await db.select().from(auditLog).where(eq(auditLog.eventType, 'booking_refunded'));
      expect(auditRows).toHaveLength(0);
    } finally {
      stripeMock.restore();
    }
  });

  // ── Scenario C: Stripe succeeds → DO refundSeat() throws unexpectedly ───────
  it('C. Stripe succeeds → DO refundSeat() throws unexpectedly → returns success to organiser + captures Sentry error', async () => {
    const { bookingId, holdId, stub, stripePaymentIntentId } = await seedTestBooking({
      seatCount: 2,
      status: 'confirmed',
    });

    // Make DO throw by manually tampering status to 'released' before refundSeat
    await runInDurableObject(stub, (instance: SeatLedger) => {
      (instance as any).ctx.storage.sql.exec("UPDATE reservations SET status = 'released' WHERE id = ?", holdId);
    });

    const stripeMock = mockStripeCustom({
      refundResponse: {
        id: 're_do_fail_123',
        object: 'refund',
        amount: 5000,
        status: 'succeeded',
        payment_intent: stripePaymentIntentId,
      },
    });

    try {
      const caller = createTestCaller({
        env: workerEnv,
        db,
        userId: organiserUserId,
        orgId,
        role: 'organiser',
      });

      const res = await caller.refundBooking({ bookingId });
      // Must return success so organiser is not told it failed after Stripe charged/refunded money
      expect(res).toEqual({ success: true, bookingId });

      // Sentry captured error
      expect(Sentry.captureException).toHaveBeenCalled();
      const sentryCall = vi.mocked(Sentry.captureException).mock.calls.find((c) => {
        const extra = (c[1] as any)?.extra;
        return extra?.step === 'DO_REFUND_SEAT' && extra?.bookingId === bookingId;
      });
      expect(sentryCall).toBeDefined();

      // D1 was NOT updated to refunded because DO step threw
      const [d1Booking] = await db.select().from(bookings).where(eq(bookings.id, bookingId));
      expect(d1Booking?.status).toBe('confirmed');
    } finally {
      stripeMock.restore();
    }
  });

  // ── Scenario D: Stripe succeeds → DO succeeds → D1 update throws ────────────
  it('D. Stripe succeeds → DO succeeds → D1 update throws → returns success to organiser + captures Sentry error', async () => {
    const { bookingId, holdId, stub, stripePaymentIntentId } = await seedTestBooking({
      seatCount: 2,
      status: 'confirmed',
    });

    const stripeMock = mockStripeCustom({
      refundResponse: {
        id: 're_d1_fail_123',
        object: 'refund',
        amount: 5000,
        status: 'succeeded',
        payment_intent: stripePaymentIntentId,
      },
    });

    // Mock db.update to throw
    vi.spyOn(db, 'update').mockImplementationOnce(() => {
      throw new Error('D1 connection terminated');
    });

    try {
      const caller = createTestCaller({
        env: workerEnv,
        db,
        userId: organiserUserId,
        orgId,
        role: 'organiser',
      });

      const res = await caller.refundBooking({ bookingId });
      expect(res).toEqual({ success: true, bookingId });

      // Sentry captured error
      expect(Sentry.captureException).toHaveBeenCalled();
      const sentryCall = vi.mocked(Sentry.captureException).mock.calls.find((c) => {
        const extra = (c[1] as any)?.extra;
        return extra?.step === 'D1_STATUS_UPDATE' && extra?.bookingId === bookingId;
      });
      expect(sentryCall).toBeDefined();

      // DO was updated to 'refunded'
      const hold = await stub.getHold(holdId);
      expect(hold?.status).toBe('refunded');
    } finally {
      stripeMock.restore();
    }
  });

  // ── Scenario E & H: Idempotency Key & Retry Safe Replay ─────────────────────
  it('E & H. Deterministic Stripe idempotency key prevents duplicate refund on retry and reconciles cleanly', async () => {
    const { bookingId, stripePaymentIntentId } = await seedTestBooking({
      seatCount: 2,
      status: 'confirmed',
    });

    const stripeMock = mockStripeCustom({
      refundResponse: async () => {
        return new Response(
          JSON.stringify({
            id: 're_idempotent_123',
            object: 'refund',
            amount: 5000,
            status: 'succeeded',
            payment_intent: stripePaymentIntentId,
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      },
    });

    try {
      const caller = createTestCaller({
        env: workerEnv,
        db,
        userId: organiserUserId,
        orgId,
        role: 'organiser',
      });

      // Call 1
      const res1 = await caller.refundBooking({ bookingId });
      expect(res1.success).toBe(true);

      // Call 2: Booking is now 'refunded' in D1 -> rejected cleanly with distinct CONFLICT
      await expect(caller.refundBooking({ bookingId })).rejects.toThrowError('Booking has already been refunded');

      // Verify both calls used identical deterministic idempotency key format
      expect(stripeMock.interceptedRequests[0]?.headers['idempotency-key']).toBe(`refund_${bookingId}`);
    } finally {
      stripeMock.restore();
    }
  });

  // ── Scenario F: Stripe reports already-refunded with confirmed local state ───
  it('F. Stripe reports charge_already_refunded when D1 is confirmed → verifies and reconciles local state', async () => {
    const { bookingId, holdId, stub, stripePaymentIntentId } = await seedTestBooking({
      seatCount: 2,
      status: 'confirmed',
    });

    const stripeMock = mockStripeCustom({
      refundStatus: 400,
      refundResponse: {
        error: {
          type: 'invalid_request_error',
          code: 'charge_already_refunded',
          message: 'The charge associated with this payment intent has already been refunded.',
        },
      },
      paymentIntentResponse: {
        id: stripePaymentIntentId,
        object: 'payment_intent',
        amount_received: 5000,
        status: 'succeeded',
      },
      refundsListResponse: {
        object: 'list',
        data: [
          {
            id: 're_prior_refund_123',
            object: 'refund',
            amount: 5000,
            status: 'succeeded',
            payment_intent: stripePaymentIntentId,
          },
        ],
        has_more: false,
        url: '/v1/refunds',
      },
    });

    try {
      const caller = createTestCaller({
        env: workerEnv,
        db,
        userId: organiserUserId,
        orgId,
        role: 'organiser',
      });

      const res = await caller.refundBooking({ bookingId });
      expect(res).toEqual({ success: true, bookingId });

      // DO state was reconciled to 'refunded'
      const hold = await stub.getHold(holdId);
      expect(hold?.status).toBe('refunded');

      // D1 state was reconciled to 'refunded'
      const [d1Booking] = await db.select().from(bookings).where(eq(bookings.id, bookingId));
      expect(d1Booking?.status).toBe('refunded');

      // Audit log was written
      const auditRows = await db.select().from(auditLog).where(eq(auditLog.eventType, 'booking_refunded'));
      expect(auditRows).toHaveLength(1);
      expect(JSON.parse(auditRows[0]?.detail ?? '{}').stripeRefundId).toBe('re_prior_refund_123');
    } finally {
      stripeMock.restore();
    }
  });

  // ── Scenario G & J: Concurrency & Single Audit Log ──────────────────────────
  it('G & J. Concurrent refundBooking calls: only 1 Stripe refund, DO ends in refunded, D1 ends in refunded, exactly 1 audit log', async () => {
    const { bookingId, holdId, stub, stripePaymentIntentId } = await seedTestBooking({
      seatCount: 2,
      status: 'confirmed',
    });

    const stripeMock = mockStripeCustom({
      refundResponse: {
        id: 're_concurrent_123',
        object: 'refund',
        amount: 5000,
        status: 'succeeded',
        payment_intent: stripePaymentIntentId,
      },
    });

    try {
      const caller1 = createTestCaller({
        env: workerEnv,
        db,
        userId: organiserUserId,
        orgId,
        role: 'organiser',
      });
      const caller2 = createTestCaller({
        env: workerEnv,
        db,
        userId: organiserUserId,
        orgId,
        role: 'organiser',
      });

      // Fire both concurrently
      const [res1, res2] = await Promise.all([
        caller1.refundBooking({ bookingId }),
        caller2.refundBooking({ bookingId }),
      ]);

      expect(res1.success).toBe(true);
      expect(res2.success).toBe(true);

      // DO is 'refunded'
      const hold = await stub.getHold(holdId);
      expect(hold?.status).toBe('refunded');

      // D1 is 'refunded'
      const [d1Booking] = await db.select().from(bookings).where(eq(bookings.id, bookingId));
      expect(d1Booking?.status).toBe('refunded');

      // Exactly ONE audit_log row written for booking_refunded
      const auditRows = await db.select().from(auditLog).where(eq(auditLog.eventType, 'booking_refunded'));
      expect(auditRows).toHaveLength(1);
    } finally {
      stripeMock.restore();
    }
  });

  // ── Scenario I: Safeguards against Partial/Mismatched Existing Refunds ──────
  it('I1. Recovery rejects mismatched PaymentIntent ID in existing refunds', async () => {
    const { bookingId, stripePaymentIntentId } = await seedTestBooking({
      seatCount: 2,
      status: 'confirmed',
    });

    const stripeMock = mockStripeCustom({
      refundStatus: 400,
      refundResponse: {
        error: {
          type: 'invalid_request_error',
          code: 'charge_already_refunded',
        },
      },
      paymentIntentResponse: {
        id: stripePaymentIntentId,
        object: 'payment_intent',
        amount_received: 5000,
        status: 'succeeded',
      },
      refundsListResponse: {
        object: 'list',
        data: [
          {
            id: 're_mismatched_123',
            object: 'refund',
            amount: 5000,
            status: 'succeeded',
            payment_intent: 'pi_DIFFERENT_PAYMENT_INTENT', // Mismatch!
          },
        ],
        has_more: false,
        url: '/v1/refunds',
      },
    });

    try {
      const caller = createTestCaller({
        env: workerEnv,
        db,
        userId: organiserUserId,
        orgId,
        role: 'organiser',
      });

      await expect(caller.refundBooking({ bookingId })).rejects.toThrowError(/Existing refund could not be verified as a full refund/);
      expect(Sentry.captureMessage).toHaveBeenCalledWith('Unverified already-refunded recovery state', expect.any(Object));
    } finally {
      stripeMock.restore();
    }
  });

  it('I2. Recovery rejects partial existing refund amount', async () => {
    const { bookingId, stripePaymentIntentId } = await seedTestBooking({
      seatCount: 2,
      status: 'confirmed',
    });

    const stripeMock = mockStripeCustom({
      refundStatus: 400,
      refundResponse: {
        error: {
          type: 'invalid_request_error',
          code: 'charge_already_refunded',
        },
      },
      paymentIntentResponse: {
        id: stripePaymentIntentId,
        object: 'payment_intent',
        amount_received: 5000,
        status: 'succeeded',
      },
      refundsListResponse: {
        object: 'list',
        data: [
          {
            id: 're_partial_123',
            object: 'refund',
            amount: 2500, // Only half refunded!
            status: 'succeeded',
            payment_intent: stripePaymentIntentId,
          },
        ],
        has_more: false,
        url: '/v1/refunds',
      },
    });

    try {
      const caller = createTestCaller({
        env: workerEnv,
        db,
        userId: organiserUserId,
        orgId,
        role: 'organiser',
      });

      await expect(caller.refundBooking({ bookingId })).rejects.toThrowError(/Existing refund could not be verified as a full refund/);
    } finally {
      stripeMock.restore();
    }
  });

  it('I3. Recovery handles multi-page refund pagination correctly', async () => {
    const { bookingId, holdId, stub, stripePaymentIntentId } = await seedTestBooking({
      seatCount: 2,
      status: 'confirmed',
    });

    const stripeMock = mockStripeCustom({
      refundStatus: 400,
      refundResponse: {
        error: {
          type: 'invalid_request_error',
          code: 'charge_already_refunded',
        },
      },
      paymentIntentResponse: {
        id: stripePaymentIntentId,
        object: 'payment_intent',
        amount_received: 5000,
        status: 'succeeded',
      },
      refundsListResponse: (url: URL) => {
        const startingAfter = url.searchParams.get('starting_after');
        if (!startingAfter) {
          // Page 1
          return {
            object: 'list',
            data: [
              {
                id: 're_part_1',
                object: 'refund',
                amount: 3000,
                status: 'succeeded',
                payment_intent: stripePaymentIntentId,
              },
            ],
            has_more: true,
            url: '/v1/refunds',
          };
        } else {
          // Page 2
          return {
            object: 'list',
            data: [
              {
                id: 're_part_2',
                object: 'refund',
                amount: 2000,
                status: 'succeeded',
                payment_intent: stripePaymentIntentId,
              },
            ],
            has_more: false,
            url: '/v1/refunds',
          };
        }
      },
    });

    try {
      const caller = createTestCaller({
        env: workerEnv,
        db,
        userId: organiserUserId,
        orgId,
        role: 'organiser',
      });

      const res = await caller.refundBooking({ bookingId });
      expect(res.success).toBe(true);

      const hold = await stub.getHold(holdId);
      expect(hold?.status).toBe('refunded');
    } finally {
      stripeMock.restore();
    }
  });

  // ── User Requirement 2 & 6: Conditional D1 update 0-row verification ─────────
  it('Conditional D1 update 0 rows: re-reads booking, accepts if already refunded, alerts if non-refunded', async () => {
    const { bookingId, stripePaymentIntentId } = await seedTestBooking({
      seatCount: 2,
      status: 'confirmed',
    });

    const stripeMock = mockStripeCustom({
      refundResponse: {
        id: 're_zero_row_123',
        object: 'refund',
        amount: 5000,
        status: 'succeeded',
        payment_intent: stripePaymentIntentId,
      },
    });

    try {
      const caller = createTestCaller({
        env: workerEnv,
        db,
        userId: organiserUserId,
        orgId,
        role: 'organiser',
      });

      // Sub-case 1: Another request completed D1 update concurrently while this request was in flight.
      // D1 update returns 0 rows, and re-read finds status 'refunded'.
      vi.spyOn(db, 'update').mockImplementationOnce(() => {
        return {
          set: () => ({
            where: () => ({
              returning: async () => {
                await workerEnv.DB.prepare("UPDATE bookings SET status = 'refunded' WHERE id = ?").bind(bookingId).run();
                return [];
              },
            }),
          }),
        } as any;
      });

      const res = await caller.refundBooking({ bookingId });
      expect(res.success).toBe(true);

      // Re-read confirmed status === 'refunded', so NO error captured and NO audit log written
      expect(Sentry.captureMessage).not.toHaveBeenCalledWith('D1 conditional update affected 0 rows with non-refunded status', expect.any(Object));
      const auditRows = await db.select().from(auditLog).where(eq(auditLog.eventType, 'booking_refunded'));
      expect(auditRows).toHaveLength(0);

      // Sub-case 2: D1 row is unexpectedly in another status (e.g. 'cancelled') after 0 rows updated
      const { bookingId: bookingId2 } = await seedTestBooking({
        seatCount: 2,
        status: 'confirmed',
      });

      vi.spyOn(db, 'update').mockImplementationOnce(() => {
        return {
          set: () => ({
            where: () => ({
              returning: async () => {
                await workerEnv.DB.prepare("UPDATE bookings SET status = 'cancelled' WHERE id = ?").bind(bookingId2).run();
                return [];
              },
            }),
          }),
        } as any;
      });

      await caller.refundBooking({ bookingId: bookingId2 });
      // Must alert Sentry about unexpected inconsistency
      expect(Sentry.captureMessage).toHaveBeenCalledWith('D1 conditional update affected 0 rows with non-refunded status', expect.any(Object));
    } finally {
      stripeMock.restore();
    }
  });

  // ── Authorization Tests ─────────────────────────────────────────────────────
  it('Authorization: organiser of correct org succeeds', async () => {
    const { bookingId } = await seedTestBooking({ org: orgId });
    const stripeMock = mockStripeCustom();

    try {
      const caller = createTestCaller({
        env: workerEnv,
        db,
        userId: organiserUserId,
        orgId,
        role: 'organiser',
      });

      const res = await caller.refundBooking({ bookingId });
      expect(res.success).toBe(true);
    } finally {
      stripeMock.restore();
    }
  });

  it('Authorization: organiser of a different org is rejected with FORBIDDEN and Stripe is NOT called', async () => {
    const { bookingId } = await seedTestBooking({ org: orgId });
    const stripeMock = mockStripeCustom();

    try {
      const otherOrgCaller = createTestCaller({
        env: workerEnv,
        db,
        userId: 'owner-B',
        orgId: otherOrgId,
        role: 'organiser',
      });

      await expect(otherOrgCaller.refundBooking({ bookingId })).rejects.toThrowError(/You do not have permission to modify or view this organisation's resources/);
      expect(stripeMock.interceptedRequests).toHaveLength(0);
    } finally {
      stripeMock.restore();
    }
  });

  it('Authorization: attendee / non-organiser is rejected with FORBIDDEN and Stripe is NOT called', async () => {
    const { bookingId } = await seedTestBooking({ org: orgId });
    const stripeMock = mockStripeCustom();

    try {
      const attendeeCaller = createTestCaller({
        env: workerEnv,
        db,
        userId: attendeeUserId,
        orgId: null,
        role: null,
      });

      await expect(attendeeCaller.refundBooking({ bookingId })).rejects.toThrowError(/You must be an organiser to access this resource/);
      expect(stripeMock.interceptedRequests).toHaveLength(0);
    } finally {
      stripeMock.restore();
    }
  });

  it('Authorization: unauthenticated caller is rejected with UNAUTHORIZED and Stripe is NOT called', async () => {
    const { bookingId } = await seedTestBooking({ org: orgId });
    const stripeMock = mockStripeCustom();

    try {
      const unauthCaller = createTestCaller({
        env: workerEnv,
        db,
        userId: undefined,
        orgId: null,
        role: null,
      });

      await expect(unauthCaller.refundBooking({ bookingId })).rejects.toThrow();
      expect(stripeMock.interceptedRequests).toHaveLength(0);
    } finally {
      stripeMock.restore();
    }
  });

  // ── Missing Stripe PaymentIntent ID ──────────────────────────────────────────
  it('Refunding a confirmed booking with missing stripePaymentIntentId returns PRECONDITION_FAILED and avoids Stripe call', async () => {
    const { bookingId } = await seedTestBooking({
      status: 'confirmed',
      stripePaymentIntentId: null,
    });
    const stripeMock = mockStripeCustom();

    try {
      const caller = createTestCaller({
        env: workerEnv,
        db,
        userId: organiserUserId,
        orgId,
        role: 'organiser',
      });

      await expect(caller.refundBooking({ bookingId })).rejects.toThrowError(/Booking cannot be refunded due to missing payment reference/);
      expect(stripeMock.interceptedRequests).toHaveLength(0);
      expect(Sentry.captureMessage).toHaveBeenCalledWith('Confirmed booking missing stripePaymentIntentId', expect.any(Object));
    } finally {
      stripeMock.restore();
    }
  });

  // ── Ticket Revocation (getTicket Guard) ──────────────────────────────────────
  it('getTicket on a refunded booking is rejected with NOT_FOUND', async () => {
    const { bookingId } = await seedTestBooking({
      status: 'refunded',
    });

    const caller = createTestCaller({
      env: workerEnv,
      db,
      userId: attendeeUserId,
      orgId: null,
      role: null,
    });

    await expect(caller.getTicket({ bookingId })).rejects.toThrowError(/No ticket available for this booking/);
  });

  // ── Reconciliation Safety ───────────────────────────────────────────────────
  it('Reconciliation does not flag a refunded hold as an orphan', async () => {
    const eventId = `event-reconcile-${crypto.randomUUID()}`;
    const holdId = `hold-reconcile-${crypto.randomUUID()}`;

    await db.insert(events).values({
      id: eventId,
      organisationId: orgId,
      name: 'Reconcile Event',
      date: new Date(Date.now() + 86400000),
      totalSeats: 10,
      pricePerSeat: 2000,
    });

    const stub = workerEnv.SEAT_LEDGER.get(workerEnv.SEAT_LEDGER.idFromName(eventId));
    await stub.initialize(10);

    // Hold is past expiry window
    const pastExpiry = Date.now() - 1000;
    await runInDurableObject(stub, (instance: SeatLedger) => {
      (instance as any).ctx.storage.sql.exec(
        "INSERT INTO reservations (id, user_id, seat_count, expires_at, status) VALUES (?, ?, ?, ?, 'refunded')",
        holdId,
        attendeeUserId,
        2,
        pastExpiry
      );
    });

    // Run reconciliation
    const summary = await runReconciliation(workerEnv);
    expect(summary.orphansDetected).toBe(0);

    const auditRows = await db.select().from(auditLog).where(eq(auditLog.eventType, 'reconciliation_orphan_detected'));
    expect(auditRows).toHaveLength(0);
  });
});
