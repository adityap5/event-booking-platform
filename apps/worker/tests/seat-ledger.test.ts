import { describe, it, expect, beforeEach } from 'vitest';
import { env, runInDurableObject, runDurableObjectAlarm } from 'cloudflare:test';
import type { Env } from '../src/index.js';
import * as schema from '@event-booking/shared';
import { setupTestDb, createTestCaller } from './test-helpers.js';
import type { SeatLedger } from '../src/seat-ledger.js';

describe('SeatLedger DO & reserveSeat regression tests', () => {
  let db: Awaited<ReturnType<typeof setupTestDb>>;
  const workerEnv = env as unknown as Env;

  beforeEach(async () => {
    db = await setupTestDb(workerEnv.DB);
  });

  describe('getHold() zero mutation', () => {
    it('performs zero mutation on reservations table and schedules no alarm', async () => {
      const eventId = 'test-gethold-zero-mutation';
      const stub = workerEnv.SEAT_LEDGER.get(workerEnv.SEAT_LEDGER.idFromName(eventId));
      stub.initialize(10);

      const hold = await stub.reserveSeat('user-1', 2);

      // Read reservations row directly before getHold()
      const beforeState = await runInDurableObject(stub, (instance: SeatLedger) => {
        const rows = (instance as any).ctx.storage.sql.exec(
          'SELECT * FROM reservations WHERE id = ?',
          hold.reservationId
        ).toArray();
        return {
          row: rows[0],
        };
      });

      // Get alarm state before getHold()
      const alarmBefore = await runInDurableObject(stub, async (instance: SeatLedger) => {
        return await (instance as any).ctx.storage.getAlarm();
      });

      // Call getHold()
      const holdDetails = await stub.getHold(hold.reservationId);
      expect(holdDetails).not.toBeNull();
      expect(holdDetails?.userId).toBe('user-1');

      // Read reservations row directly after getHold()
      const afterState = await runInDurableObject(stub, (instance: SeatLedger) => {
        const rows = (instance as any).ctx.storage.sql.exec(
          'SELECT * FROM reservations WHERE id = ?',
          hold.reservationId
        ).toArray();
        return {
          row: rows[0],
        };
      });

      // Get alarm state after getHold()
      const alarmAfter = await runInDurableObject(stub, async (instance: SeatLedger) => {
        return await (instance as any).ctx.storage.getAlarm();
      });

      // Assert row is byte-identical
      expect(JSON.stringify(afterState.row)).toBe(JSON.stringify(beforeState.row));

      // Assert alarm is unchanged
      expect(alarmAfter).toBe(alarmBefore);
    });
  });

  describe('listConfirmedHolds() zero mutation', () => {
    it('performs zero mutation on reservations table and schedules no alarm', async () => {
      const eventId = 'test-listconfirmedholds-zero-mutation';
      const stub = workerEnv.SEAT_LEDGER.get(workerEnv.SEAT_LEDGER.idFromName(eventId));
      stub.initialize(10);

      const hold = await stub.reserveSeat('user-1', 2);
      await stub.confirmSeat(hold.reservationId);

      // Read reservations row directly before listConfirmedHolds()
      const beforeState = await runInDurableObject(stub, (instance: SeatLedger) => {
        const rows = (instance as any).ctx.storage.sql.exec(
          'SELECT * FROM reservations WHERE id = ?',
          hold.reservationId
        ).toArray();
        return {
          row: rows[0],
        };
      });

      // Get alarm state before listConfirmedHolds()
      const alarmBefore = await runInDurableObject(stub, async (instance: SeatLedger) => {
        return await (instance as any).ctx.storage.getAlarm();
      });

      // Call listConfirmedHolds()
      const confirmedHolds = await stub.listConfirmedHolds();
      expect(confirmedHolds).toHaveLength(1);
      expect(confirmedHolds[0]?.id).toBe(hold.reservationId);
      expect(confirmedHolds[0]?.userId).toBe('user-1');
      expect(confirmedHolds[0]?.seatCount).toBe(2);

      // Read reservations row directly after listConfirmedHolds()
      const afterState = await runInDurableObject(stub, (instance: SeatLedger) => {
        const rows = (instance as any).ctx.storage.sql.exec(
          'SELECT * FROM reservations WHERE id = ?',
          hold.reservationId
        ).toArray();
        return {
          row: rows[0],
        };
      });

      // Get alarm state after listConfirmedHolds()
      const alarmAfter = await runInDurableObject(stub, async (instance: SeatLedger) => {
        return await (instance as any).ctx.storage.getAlarm();
      });

      // Assert row is byte-identical
      expect(JSON.stringify(afterState.row)).toBe(JSON.stringify(beforeState.row));

      // Assert alarm is unchanged
      expect(alarmAfter).toBe(alarmBefore);
    });
  });

  describe('reserveSeat pending-hold cap', () => {

    it('blocks a second pending hold for the same user with CONFLICT / TOO_MANY_PENDING_HOLDS', async () => {
      const eventId = 'test-hold-cap-event';

      await db.insert((await import('@event-booking/shared')).events).values({
        id: eventId,
        organisationId: 'test-org-1',
        name: 'Pending Hold Cap Event',
        date: new Date(Date.now() + 86400000),
        totalSeats: 100,
        pricePerSeat: 1000,
      });

      const callerUser1 = createTestCaller({
        env: workerEnv,
        db,
        userId: 'user-cap-1',
      });

      // First reservation succeeds
      const res1 = await callerUser1.reserveSeat({ eventId, seatCount: 1 });
      expect(res1.reservationId).toBeDefined();

      // Second reservation for same user fails with CONFLICT
      await expect(
        callerUser1.reserveSeat({ eventId, seatCount: 1 })
      ).rejects.toThrowError(/TOO_MANY_PENDING_HOLDS/);
    });

    it('allows two different users to hold seats independently without blocking each other', async () => {
      const eventId = 'test-multi-user-hold-event';

      await db.insert((await import('@event-booking/shared')).events).values({
        id: eventId,
        organisationId: 'test-org-1',
        name: 'Multi User Hold Event',
        date: new Date(Date.now() + 86400000),
        totalSeats: 100,
        pricePerSeat: 1000,
      });

      const callerUserA = createTestCaller({
        env: workerEnv,
        db,
        userId: 'user-multi-A',
      });

      const callerUserB = createTestCaller({
        env: workerEnv,
        db,
        userId: 'user-multi-B',
      });

      const resA = await callerUserA.reserveSeat({ eventId, seatCount: 2 });
      const resB = await callerUserB.reserveSeat({ eventId, seatCount: 2 });

      expect(resA.reservationId).toBeDefined();
      expect(resB.reservationId).toBeDefined();
      expect(resA.reservationId).not.toBe(resB.reservationId);
    });

    it('expired pending hold inserted directly into SQLite does not count toward the cap', async () => {
      const eventId = 'test-expired-hold-cap-event';
      const stub = workerEnv.SEAT_LEDGER.get(workerEnv.SEAT_LEDGER.idFromName(eventId));
      stub.initialize(100);

      // Insert an expired pending hold row directly into DO SQLite
      await runInDurableObject(stub, (instance: SeatLedger) => {
        (instance as any).ctx.storage.sql.exec(
          "INSERT INTO reservations (id, user_id, seat_count, expires_at, status) VALUES (?, ?, ?, ?, 'pending')",
          'expired-hold-id-123',
          'user-expired-cap',
          1,
          Date.now() - 1000 // In the past!
        );
      });

      await db.insert((await import('@event-booking/shared')).events).values({
        id: eventId,
        organisationId: 'test-org-1',
        name: 'Expired Cap Event',
        date: new Date(Date.now() + 86400000),
        totalSeats: 100,
        pricePerSeat: 1000,
      });

      const caller = createTestCaller({
        env: workerEnv,
        db,
        userId: 'user-expired-cap',
      });

      // reserveSeat should succeed because the existing pending hold has expired
      const res = await caller.reserveSeat({ eventId, seatCount: 1 });
      expect(res.reservationId).toBeDefined();
    });

    it('rejects reservation attempts for past events with PRECONDITION_FAILED and creates no DO hold', async () => {
      const pastEventId = 'test-past-event-id';

      // Seed past event (date 2 hours ago)
      await db.insert(schema.events).values({
        id: pastEventId,
        organisationId: 'test-org-1',
        name: 'Past Event',
        date: new Date(Date.now() - 2 * 60 * 60 * 1000),
        totalSeats: 20,
        pricePerSeat: 1000,
      });

      const stub = workerEnv.SEAT_LEDGER.get(workerEnv.SEAT_LEDGER.idFromName(pastEventId));

      const caller = createTestCaller({
        env: workerEnv,
        db,
        userId: 'user-past-reservation-attempt',
      });

      await expect(
        caller.reserveSeat({ eventId: pastEventId, seatCount: 1 })
      ).rejects.toThrowError('Event has already started.');

      // Verify no DO reservation was created
      const confirmedHolds = await stub.listConfirmedHolds(0);
      expect(confirmedHolds).toHaveLength(0);
    });

    it('rejects reservation attempts for non-existent events with NOT_FOUND', async () => {
      const caller = createTestCaller({
        env: workerEnv,
        db,
        userId: 'user-nonexistent-event',
      });

      await expect(
        caller.reserveSeat({ eventId: 'completely-nonexistent-event-id', seatCount: 1 })
      ).rejects.toThrowError('Event not found');
    });
  });

  describe('Task 3: True Concurrency Seat Race', () => {
    it('handles 20 parallel reserveSeat calls for 1 seat and allows exactly 1 to succeed', async () => {
      const eventId = 'test-concurrency-race-event';
      const stub = workerEnv.SEAT_LEDGER.get(workerEnv.SEAT_LEDGER.idFromName(eventId));
      
      // Initialize DO with exactly 1 total seat
      await stub.initialize(1);

      // Generate 20 distinct user IDs
      const userIds = Array.from({ length: 20 }, (_, i) => `race-user-${i + 1}`);

      // Fire 20 parallel reserveSeat calls using Promise.all
      const results = await Promise.allSettled(
        userIds.map((userId) => stub.reserveSeat(userId, 1))
      );

      const fulfilled = results.filter((r) => r.status === 'fulfilled');
      const rejected = results.filter((r) => r.status === 'rejected');

      expect(fulfilled.length).toBe(1);
      expect(rejected.length).toBe(19);

      // Verify all rejected calls failed with sold out error
      for (const rej of rejected) {
        if (rej.status === 'rejected') {
          expect(rej.reason.message).toMatch(/Only 0 seats available/);
        }
      }
    });
  });

  describe('Task 4: Alarm Expiry', () => {
    it('executes real DO alarm handler to release expired pending hold and update available seats', async () => {
      const eventId = 'test-alarm-expiry-event';
      const stub = workerEnv.SEAT_LEDGER.get(workerEnv.SEAT_LEDGER.idFromName(eventId));
      await stub.initialize(5);

      // Create a pending hold directly with expires_at in the past
      const holdId = 'alarm-hold-123';
      await runInDurableObject(stub, async (instance: SeatLedger) => {
        (instance as any).ctx.storage.sql.exec(
          "INSERT INTO reservations (id, user_id, seat_count, expires_at, status) VALUES (?, ?, ?, ?, 'pending')",
          holdId,
          'user-alarm-test',
          2,
          1000
        );
        await (instance as any).ctx.storage.setAlarm(1000);
      });

      // Confirm available seats is 3 before alarm
      const availableBefore = await stub.getAvailableSeats();
      expect(availableBefore).toBe(3);

      // Trigger real Durable Object alarm handler
      await runDurableObjectAlarm(stub);

      // Assert status became 'released'
      const holdState = await stub.getHold(holdId);
      expect(holdState?.status).toBe('released');

      // Assert available seats restored to 5
      const availableAfter = await stub.getAvailableSeats();
      expect(availableAfter).toBe(5);
    });
  });

  describe('Task 6: Ticket Single-Use', () => {
    it('mints a socket ticket and throws TICKET_NOT_FOUND on second redemption', async () => {
      const eventId = 'test-ticket-single-use-event';
      const stub = workerEnv.SEAT_LEDGER.get(workerEnv.SEAT_LEDGER.idFromName(eventId));

      const ticket = await stub.mintTicket('user-ticket-1', 'org-1', eventId);
      expect(ticket).toBeDefined();

      // First redemption succeeds
      const firstRedeem = await runInDurableObject(stub, (instance: SeatLedger) => {
        return instance.redeemTicket(ticket, eventId);
      });

      expect(firstRedeem.userId).toBe('user-ticket-1');
      expect(firstRedeem.orgId).toBe('org-1');

      // Second redemption fails with TICKET_NOT_FOUND
      await expect(
        runInDurableObject(stub, (instance: SeatLedger) => {
          return instance.redeemTicket(ticket, eventId);
        })
      ).rejects.toThrowError('TICKET_NOT_FOUND');
    });
  });

  describe('A1: releaseHold mutation', () => {
    const eventId = 'test-release-hold-event';

    beforeEach(async () => {
      // Seed event in D1
      await db.insert(schema.events).values({
        id: eventId,
        organisationId: 'test-org-1',
        name: 'Release Hold Test Event',
        date: new Date(Date.now() + 86400000),
        totalSeats: 10,
        pricePerSeat: 1000,
      });

      const stub = workerEnv.SEAT_LEDGER.get(workerEnv.SEAT_LEDGER.idFromName(eventId));
      await stub.initialize(10);
    });

    it('allows owner to release pending hold and immediately re-reserve without hitting pending-hold cap', async () => {
      const caller = createTestCaller({
        env: workerEnv,
        db,
        userId: 'user-release-1',
      });

      // 1. Reserve 2 seats
      const hold = await caller.reserveSeat({ eventId, seatCount: 2 });
      expect(hold.reservationId).toBeDefined();

      // 2. Second reserveSeat call is blocked by pending-hold cap
      await expect(
        caller.reserveSeat({ eventId, seatCount: 3 })
      ).rejects.toThrowError('TOO_MANY_PENDING_HOLDS');

      // 3. Voluntarily release the pending hold
      const releaseRes = await caller.releaseHold({
        eventId,
        holdId: hold.reservationId,
      });
      expect(releaseRes).toEqual({ success: true });

      // 4. User can immediately re-reserve with new seat count
      const newHold = await caller.reserveSeat({ eventId, seatCount: 4 });
      expect(newHold.reservationId).toBeDefined();
    });

    it('rejects attempt to release another user hold with FORBIDDEN', async () => {
      const callerA = createTestCaller({
        env: workerEnv,
        db,
        userId: 'user-A-owner',
      });

      const callerB = createTestCaller({
        env: workerEnv,
        db,
        userId: 'user-B-attacker',
      });

      const holdA = await callerA.reserveSeat({ eventId, seatCount: 1 });

      await expect(
        callerB.releaseHold({
          eventId,
          holdId: holdA.reservationId,
        })
      ).rejects.toThrowError('This hold does not belong to you');
    });

    it('rejects attempt to release an already confirmed hold with CONFLICT', async () => {
      const caller = createTestCaller({
        env: workerEnv,
        db,
        userId: 'user-confirmed-release',
      });

      const hold = await caller.reserveSeat({ eventId, seatCount: 1 });
      const stub = workerEnv.SEAT_LEDGER.get(workerEnv.SEAT_LEDGER.idFromName(eventId));
      await stub.confirmSeat(hold.reservationId);

      await expect(
        caller.releaseHold({
          eventId,
          holdId: hold.reservationId,
        })
      ).rejects.toThrowError('Cannot release a confirmed booking');
    });

    it('rejects non-matching eventId or non-existent hold with NOT_FOUND', async () => {
      const caller = createTestCaller({
        env: workerEnv,
        db,
        userId: 'user-not-found',
      });

      // Non-existent hold
      await expect(
        caller.releaseHold({
          eventId,
          holdId: crypto.randomUUID(),
        })
      ).rejects.toThrowError('Hold not found');

      // Non-existent event
      await expect(
        caller.releaseHold({
          eventId: 'non-existent-event-id',
          holdId: crypto.randomUUID(),
        })
      ).rejects.toThrowError('Event not found');
    });
  });

  describe('A4: listConfirmedHolds() time-window filtering', () => {
    it('excludes confirmed holds older than the cutoff window while returning active confirmed holds', async () => {
      const eventId = 'test-list-confirmed-windowing';
      const stub = workerEnv.SEAT_LEDGER.get(workerEnv.SEAT_LEDGER.idFromName(eventId));
      await stub.initialize(20);

      const oldHoldId = 'old-confirmed-hold';
      const recentHoldId = 'recent-confirmed-hold';

      // 8 days ago (beyond 7-day cutoff)
      const eightDaysAgo = Date.now() - 8 * 24 * 60 * 60 * 1000;
      // 1 day ago (within 7-day cutoff)
      const oneDayAgo = Date.now() - 1 * 24 * 60 * 60 * 1000;

      await runInDurableObject(stub, (instance: SeatLedger) => {
        (instance as any).ctx.storage.sql.exec(
          "INSERT INTO reservations (id, user_id, seat_count, expires_at, status) VALUES (?, ?, ?, ?, 'confirmed'), (?, ?, ?, ?, 'confirmed')",
          oldHoldId,
          'user-old',
          1,
          eightDaysAgo,
          recentHoldId,
          'user-recent',
          2,
          oneDayAgo
        );
      });

      // Default call filters to last 7 days
      const results = await stub.listConfirmedHolds();

      expect(results).toHaveLength(1);
      expect(results[0]?.id).toBe(recentHoldId);
      expect(results[0]?.userId).toBe('user-recent');
      expect(results[0]?.seatCount).toBe(2);

      // Explicitly passing an older timestamp returns both
      const allResults = await stub.listConfirmedHolds(Date.now() - 10 * 24 * 60 * 60 * 1000);
      expect(allResults).toHaveLength(2);
    });
  });

  describe('refundSeat() DO transitions & state-machine invariants', () => {
    it('successfully transitions confirmed hold to refunded and immediately releases full seat count', async () => {
      const eventId = 'test-refund-seat-happy';
      const stub = workerEnv.SEAT_LEDGER.get(workerEnv.SEAT_LEDGER.idFromName(eventId));
      await stub.initialize(10);

      const hold = await stub.reserveSeat('user-1', 4);
      expect(await stub.getAvailableSeats()).toBe(6);

      await stub.confirmSeat(hold.reservationId);
      expect(await stub.getAvailableSeats()).toBe(6);

      // Refund the hold
      await stub.refundSeat(hold.reservationId);

      // Invariant: full seat count (4 seats) returned to availability immediately
      expect(await stub.getAvailableSeats()).toBe(10);

      const holdDetails = await stub.getHold(hold.reservationId);
      expect(holdDetails?.status).toBe('refunded');
      expect(holdDetails?.seatCount).toBe(4);
    });

    it('throws HOLD_NOT_FOUND for non-existent hold', async () => {
      const eventId = 'test-refund-not-found';
      const stub = workerEnv.SEAT_LEDGER.get(workerEnv.SEAT_LEDGER.idFromName(eventId));
      await stub.initialize(10);

      await expect(
        runInDurableObject(stub, (instance: SeatLedger) => {
          return instance.refundSeat('non-existent-hold-id');
        })
      ).rejects.toThrowError('HOLD_NOT_FOUND');
    });

    it('throws HOLD_ALREADY_REFUNDED when attempting to refund an already refunded hold', async () => {
      const eventId = 'test-refund-already-refunded';
      const stub = workerEnv.SEAT_LEDGER.get(workerEnv.SEAT_LEDGER.idFromName(eventId));
      await stub.initialize(10);

      const hold = await stub.reserveSeat('user-1', 2);
      await stub.confirmSeat(hold.reservationId);
      await stub.refundSeat(hold.reservationId);

      // Second attempt must throw distinct HOLD_ALREADY_REFUNDED
      await expect(
        runInDurableObject(stub, (instance: SeatLedger) => {
          return instance.refundSeat(hold.reservationId);
        })
      ).rejects.toThrowError('HOLD_ALREADY_REFUNDED');
    });

    it('throws HOLD_NOT_CONFIRMED when attempting to refund a pending hold', async () => {
      const eventId = 'test-refund-pending';
      const stub = workerEnv.SEAT_LEDGER.get(workerEnv.SEAT_LEDGER.idFromName(eventId));
      await stub.initialize(10);

      const hold = await stub.reserveSeat('user-1', 2);
      // Still pending
      await expect(
        runInDurableObject(stub, (instance: SeatLedger) => {
          return instance.refundSeat(hold.reservationId);
        })
      ).rejects.toThrowError('HOLD_NOT_CONFIRMED');
    });

    it('throws HOLD_RELEASED when attempting to refund an expired/released hold', async () => {
      const eventId = 'test-refund-released';
      const stub = workerEnv.SEAT_LEDGER.get(workerEnv.SEAT_LEDGER.idFromName(eventId));
      await stub.initialize(10);

      const hold = await stub.reserveSeat('user-1', 2);
      await stub.releaseSeat(hold.reservationId);

      await expect(
        runInDurableObject(stub, (instance: SeatLedger) => {
          return instance.refundSeat(hold.reservationId);
        })
      ).rejects.toThrowError('HOLD_RELEASED');
    });

    it('releaseSeat() refuses to touch confirmed or refunded holds', async () => {
      const eventId = 'test-release-guard-untouched';
      const stub = workerEnv.SEAT_LEDGER.get(workerEnv.SEAT_LEDGER.idFromName(eventId));
      await stub.initialize(10);

      const hold1 = await stub.reserveSeat('user-1', 2);
      await stub.confirmSeat(hold1.reservationId);

      // releaseSeat on confirmed hold is a no-op
      await stub.releaseSeat(hold1.reservationId);
      let details1 = await stub.getHold(hold1.reservationId);
      expect(details1?.status).toBe('confirmed');
      expect(await stub.getAvailableSeats()).toBe(8);

      // refund the hold
      await stub.refundSeat(hold1.reservationId);
      expect(await stub.getAvailableSeats()).toBe(10);

      // releaseSeat on refunded hold is a no-op
      await stub.releaseSeat(hold1.reservationId);
      let details2 = await stub.getHold(hold1.reservationId);
      expect(details2?.status).toBe('refunded');
      expect(await stub.getAvailableSeats()).toBe(10);
    });

    it('listConfirmedHolds() excludes refunded holds', async () => {
      const eventId = 'test-list-confirmed-excludes-refunded';
      const stub = workerEnv.SEAT_LEDGER.get(workerEnv.SEAT_LEDGER.idFromName(eventId));
      await stub.initialize(10);

      const hold1 = await stub.reserveSeat('user-1', 2);
      const hold2 = await stub.reserveSeat('user-2', 3);
      await stub.confirmSeat(hold1.reservationId);
      await stub.confirmSeat(hold2.reservationId);

      let confirmed = await stub.listConfirmedHolds();
      expect(confirmed).toHaveLength(2);

      // Refund hold1
      await stub.refundSeat(hold1.reservationId);

      // listConfirmedHolds must now only return hold2
      confirmed = await stub.listConfirmedHolds();
      expect(confirmed).toHaveLength(1);
      expect(confirmed[0]?.id).toBe(hold2.reservationId);
    });
  });
});

