import { describe, it, expect, beforeEach, expectTypeOf } from 'vitest';
import { env, runInDurableObject } from 'cloudflare:test';
import type { Env } from '../src/index.js';
import { setupTestDb, createTestCaller, mockStripeNetworkCall } from './test-helpers.js';
import type { AppRouter } from '../src/router.js';
import type { inferProcedureInput } from '@trpc/server';

import type { SeatLedger } from '../src/seat-ledger.js';

type CreateCheckoutInput = inferProcedureInput<AppRouter['createCheckoutSession']>;

describe('paymentsRouter.createCheckoutSession', () => {
  let db: Awaited<ReturnType<typeof setupTestDb>>;
  const workerEnv = env as unknown as Env;

  beforeEach(async () => {
    db = await setupTestDb(workerEnv.DB);
  });

  it('compile-time check: input schema must NOT accept seatCount', () => {
    // Assert at compile-time that input type has no seatCount property
    expectTypeOf<CreateCheckoutInput>().not.toHaveProperty('seatCount');
  });

  it('validation order: checks ownership (FORBIDDEN) before non-pending status', async () => {
    const eventId = 'test-event-order';
    const stub = workerEnv.SEAT_LEDGER.get(workerEnv.SEAT_LEDGER.idFromName(eventId));
    stub.initialize(100);

    // Create a hold owned by user A
    const holdA = await stub.reserveSeat('user-A', 2);

    // Caller is user B (different owner)
    const callerUserB = createTestCaller({
      env: workerEnv,
      db,
      userId: 'user-B',
    });

    // 1. Check ownership vs pending status: confirm hold as user A first so status is 'confirmed'
    await stub.confirmSeat(holdA.reservationId);
    
    // User B attempts createCheckoutSession for hold owned by User A (which is also non-pending)
    await expect(
      callerUserB.createCheckoutSession({
        holdId: holdA.reservationId,
        eventId,
      })
    ).rejects.toThrowError(/This hold does not belong to you/);
  });

  it('validation order: checks ownership (FORBIDDEN) before expiry (PRECONDITION_FAILED)', async () => {
    const eventId = 'test-event-order-expiry';
    const stub = workerEnv.SEAT_LEDGER.get(workerEnv.SEAT_LEDGER.idFromName(eventId));
    stub.initialize(100);

    // Create an expired hold directly in DO SQLite owned by user A
    const holdId = crypto.randomUUID();
    await runInDurableObject(stub, (instance: SeatLedger) => {
      (instance as any).ctx.storage.sql.exec(
        "INSERT INTO reservations (id, user_id, seat_count, expires_at, status) VALUES (?, ?, ?, ?, 'pending')",
        holdId,
        'user-A',
        1,
        Date.now() - 5000
      );
    });

    // Caller is user B (different owner)
    const callerUserB = createTestCaller({
      env: workerEnv,
      db,
      userId: 'user-B',
    });

    // User B attempts createCheckoutSession for user A's expired hold -> MUST throw FORBIDDEN, not PRECONDITION_FAILED
    await expect(
      callerUserB.createCheckoutSession({
        holdId,
        eventId,
      })
    ).rejects.toThrowError(/This hold does not belong to you/);
  });

  it('derives seatCount from getHold() and ignores client-sent seatCount', async () => {
    const eventId = 'test-event-stripe-qty';
    const pricePerSeat = 1500; // £15.00

    // Create event in D1
    await db.insert((await import('@event-booking/shared')).events).values({
      id: eventId,
      organisationId: 'test-org-1',
      name: 'Stripe Quantity Test Event',
      date: new Date(Date.now() + 86400000),
      totalSeats: 10,
      pricePerSeat,
    });

    const stub = workerEnv.SEAT_LEDGER.get(workerEnv.SEAT_LEDGER.idFromName(eventId));
    stub.initialize(10);

    // Hold 3 seats for user-A
    const hold = await stub.reserveSeat('user-A', 3);

    const callerUserA = createTestCaller({
      env: workerEnv,
      db,
      userId: 'user-A',
    });

    const stripeMock = mockStripeNetworkCall({
      id: 'cs_test_session_id',
      url: 'https://checkout.stripe.com/pay/cs_test_session_id',
    });

    try {
      // Call createCheckoutSession with valid holdId and eventId
      const res = await callerUserA.createCheckoutSession({
        holdId: hold.reservationId,
        eventId,
      });

      expect(res.sessionUrl).toBe('https://checkout.stripe.com/pay/cs_test_session_id');

      // Verify outbound Stripe fetch payload
      expect(stripeMock.interceptedRequests.length).toBe(1);
      const req = stripeMock.interceptedRequests[0]!;
      expect(req.url).toContain('api.stripe.com/v1/checkout/sessions');

      // Parse body parameters sent to Stripe API
      const params = new URLSearchParams(req.body);
      
      // Stripe quantity must match the hold seatCount (3), NOT any client parameter
      expect(params.get('line_items[0][quantity]')).toBe('3');
      expect(params.get('line_items[0][price_data][unit_amount]')).toBe('1500');
    } finally {
      stripeMock.restore();
    }
  });

  it('rejects or ignores extra seatCount field passed in request', async () => {
    const eventId = 'test-event-zod-extra';
    const stub = workerEnv.SEAT_LEDGER.get(workerEnv.SEAT_LEDGER.idFromName(eventId));
    stub.initialize(10);
    const hold = await stub.reserveSeat('user-A', 2);

    const callerUserA = createTestCaller({
      env: workerEnv,
      db,
      userId: 'user-A',
    });

    // Pass extra seatCount field to procedure
    const extraInput = {
      holdId: hold.reservationId,
      eventId,
      seatCount: 99, // Tampered count
    };

    // tRPC procedures with Zod strip or reject unrecognized fields
    // Let's verify caller ignores seatCount and derives 2 from hold
    const stripeMock = mockStripeNetworkCall({
      id: 'cs_test_session_extra',
      url: 'https://checkout.stripe.com/pay/cs_test_session_extra',
    });

    try {
      await db.insert((await import('@event-booking/shared')).events).values({
        id: eventId,
        organisationId: 'test-org-1',
        name: 'Extra Field Test Event',
        date: new Date(Date.now() + 86400000),
        totalSeats: 10,
        pricePerSeat: 1000,
      });

      await callerUserA.createCheckoutSession(extraInput as any);
      
      const req = stripeMock.interceptedRequests[0]!;
      const params = new URLSearchParams(req.body);
      expect(params.get('line_items[0][quantity]')).toBe('2'); // Derived from hold (2), not input (99)
    } finally {
      stripeMock.restore();
    }
  });
});
