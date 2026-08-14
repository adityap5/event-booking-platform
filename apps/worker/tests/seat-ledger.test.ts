import { describe, it, expect, beforeEach } from 'vitest';
import { env, runInDurableObject, runDurableObjectAlarm } from 'cloudflare:test';
import type { Env } from '../src/index.js';
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
});
