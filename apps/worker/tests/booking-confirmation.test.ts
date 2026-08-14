import { describe, it, expect, beforeEach } from 'vitest';
import { env, runInDurableObject } from 'cloudflare:test';
import type { Env } from '../src/index.js';
import { setupTestDb } from './test-helpers.js';
import { confirmBookingFromPayment } from '../src/booking-confirmation.js';
import * as schema from '@event-booking/shared';
import { eq } from 'drizzle-orm';
import type { SeatLedger } from '../src/seat-ledger.js';

describe('confirmBookingFromPayment outcome coverage', () => {
  let db: Awaited<ReturnType<typeof setupTestDb>>;
  const workerEnv = env as unknown as Env;

  beforeEach(async () => {
    db = await setupTestDb(workerEnv.DB);
  });

  it('1. outcome: confirmed — confirms seat and inserts D1 booking row', async () => {
    const eventId = 'bc-event-confirmed';
    const userId = 'bc-user-confirmed';
    const pricePerSeat = 2000;

    // Seed event in D1
    await db.insert(schema.events).values({
      id: eventId,
      organisationId: 'org-1',
      name: 'Confirmed Event',
      date: new Date(Date.now() + 86400000),
      totalSeats: 10,
      pricePerSeat,
    });

    // Seed attendee in D1
    await db.insert(schema.attendees).values({
      id: 'attendee-confirmed',
      userId,
      email: 'user@example.com',
      name: 'Test Attendee',
    });

    const stub = workerEnv.SEAT_LEDGER.get(workerEnv.SEAT_LEDGER.idFromName(eventId));
    await stub.initialize(10);

    // Create hold
    const hold = await stub.reserveSeat(userId, 2);

    const result = await confirmBookingFromPayment({
      db,
      seatLedger: stub,
      holdId: hold.reservationId,
      eventId,
      stripePaymentIntentId: 'pi_confirmed_123',
      amountReceivedPence: pricePerSeat * 2, // 4000
    });

    expect(result.outcome).toBe('confirmed');
    if (result.outcome === 'confirmed') {
      expect(result.seatCount).toBe(2);
      expect(result.booking.id).toBeDefined();
      expect(result.booking.stripePaymentIntentId).toBe('pi_confirmed_123');

      // Verify D1 booking row exists
      const [bookingRow] = await db
        .select()
        .from(schema.bookings)
        .where(eq(schema.bookings.holdId, hold.reservationId));
      expect(bookingRow).toBeDefined();
      expect(bookingRow?.status).toBe('confirmed');
    }
  });

  it('2. outcome: already_confirmed — idempotent replay when booking row exists in D1', async () => {
    const eventId = 'bc-event-already';
    const userId = 'bc-user-already';
    const pricePerSeat = 2000;

    await db.insert(schema.events).values({
      id: eventId,
      organisationId: 'org-1',
      name: 'Already Confirmed Event',
      date: new Date(Date.now() + 86400000),
      totalSeats: 10,
      pricePerSeat,
    });

    await db.insert(schema.attendees).values({
      id: 'attendee-already',
      userId,
      email: 'user-already@example.com',
      name: 'Test Attendee Already',
    });

    const stub = workerEnv.SEAT_LEDGER.get(workerEnv.SEAT_LEDGER.idFromName(eventId));
    await stub.initialize(10);
    const hold = await stub.reserveSeat(userId, 2);

    // First call confirms
    const firstResult = await confirmBookingFromPayment({
      db,
      seatLedger: stub,
      holdId: hold.reservationId,
      eventId,
      stripePaymentIntentId: 'pi_already_123',
      amountReceivedPence: pricePerSeat * 2,
    });
    expect(firstResult.outcome).toBe('confirmed');

    // Second call with same holdId returns already_confirmed
    const secondResult = await confirmBookingFromPayment({
      db,
      seatLedger: stub,
      holdId: hold.reservationId,
      eventId,
      stripePaymentIntentId: 'pi_already_123',
      amountReceivedPence: pricePerSeat * 2,
    });
    expect(secondResult.outcome).toBe('already_confirmed');
  });

  it('3. outcome: hold_not_found — when DO holds row does not exist', async () => {
    const eventId = 'bc-event-notfound';

    await db.insert(schema.events).values({
      id: eventId,
      organisationId: 'org-1',
      name: 'Not Found Event',
      date: new Date(Date.now() + 86400000),
      totalSeats: 10,
      pricePerSeat: 1000,
    });

    const stub = workerEnv.SEAT_LEDGER.get(workerEnv.SEAT_LEDGER.idFromName(eventId));

    const result = await confirmBookingFromPayment({
      db,
      seatLedger: stub,
      holdId: 'non-existent-hold-uuid',
      eventId,
      stripePaymentIntentId: 'pi_fake',
      amountReceivedPence: 1000,
    });

    expect(result.outcome).toBe('hold_not_found');
  });

  it('4. outcome: hold_expired — releases hold when expires_at has passed', async () => {
    const eventId = 'bc-event-expired';
    const stub = workerEnv.SEAT_LEDGER.get(workerEnv.SEAT_LEDGER.idFromName(eventId));
    await stub.initialize(10);

    const expiredHoldId = 'expired-hold-uuid-999';
    await runInDurableObject(stub, (instance: SeatLedger) => {
      (instance as any).ctx.storage.sql.exec(
        "INSERT INTO reservations (id, user_id, seat_count, expires_at, status) VALUES (?, ?, ?, ?, 'pending')",
        expiredHoldId,
        'user-expired',
        1,
        Date.now() - 10000
      );
    });

    await db.insert(schema.events).values({
      id: eventId,
      organisationId: 'org-1',
      name: 'Expired Event',
      date: new Date(Date.now() + 86400000),
      totalSeats: 10,
      pricePerSeat: 1000,
    });

    const result = await confirmBookingFromPayment({
      db,
      seatLedger: stub,
      holdId: expiredHoldId,
      eventId,
      stripePaymentIntentId: 'pi_expired',
      amountReceivedPence: 1000,
    });

    expect(result.outcome).toBe('hold_expired');

    const holdDetails = await stub.getHold(expiredHoldId);
    expect(holdDetails?.status).toBe('released');
  });

  it('5. outcome: event_not_found — when eventId is not present in D1', async () => {
    const stub = workerEnv.SEAT_LEDGER.get(workerEnv.SEAT_LEDGER.idFromName('missing-event-id'));

    const result = await confirmBookingFromPayment({
      db,
      seatLedger: stub,
      holdId: 'some-hold-id',
      eventId: 'missing-event-id',
      stripePaymentIntentId: 'pi_no_event',
      amountReceivedPence: 1000,
    });

    expect(result.outcome).toBe('event_not_found');
  });

  it('6. outcome: attendee_not_found — when attendee row for userId does not exist in D1', async () => {
    const eventId = 'bc-event-no-attendee';
    const userId = 'user-without-attendee-row';

    await db.insert(schema.events).values({
      id: eventId,
      organisationId: 'org-1',
      name: 'No Attendee Event',
      date: new Date(Date.now() + 86400000),
      totalSeats: 10,
      pricePerSeat: 1000,
    });

    const stub = workerEnv.SEAT_LEDGER.get(workerEnv.SEAT_LEDGER.idFromName(eventId));
    await stub.initialize(10);
    const hold = await stub.reserveSeat(userId, 1);

    const result = await confirmBookingFromPayment({
      db,
      seatLedger: stub,
      holdId: hold.reservationId,
      eventId,
      stripePaymentIntentId: 'pi_no_attendee',
      amountReceivedPence: 1000,
    });

    expect(result.outcome).toBe('attendee_not_found');
    if (result.outcome === 'attendee_not_found') {
      expect(result.userId).toBe(userId);
    }
  });

  it('7. outcome: amount_mismatch — asserts no D1 booking row is written', async () => {
    const eventId = 'bc-event-mismatch';
    const userId = 'user-mismatch';
    const pricePerSeat = 2500; // £25.00

    await db.insert(schema.events).values({
      id: eventId,
      organisationId: 'org-1',
      name: 'Mismatch Event',
      date: new Date(Date.now() + 86400000),
      totalSeats: 10,
      pricePerSeat,
    });

    await db.insert(schema.attendees).values({
      id: 'attendee-mismatch',
      userId,
      email: 'user-mismatch@example.com',
      name: 'Mismatch User',
    });

    const stub = workerEnv.SEAT_LEDGER.get(workerEnv.SEAT_LEDGER.idFromName(eventId));
    await stub.initialize(10);
    const hold = await stub.reserveSeat(userId, 2); // Expected 2 * 2500 = 5000

    // Provide wrong amount (1000 pence instead of 5000)
    const result = await confirmBookingFromPayment({
      db,
      seatLedger: stub,
      holdId: hold.reservationId,
      eventId,
      stripePaymentIntentId: 'pi_mismatch',
      amountReceivedPence: 1000,
    });

    expect(result.outcome).toBe('amount_mismatch');
    if (result.outcome === 'amount_mismatch') {
      expect(result.expectedPence).toBe(5000);
      expect(result.receivedPence).toBe(1000);
    }

    // Assert NO booking row was written in D1
    const [bookingRow] = await db
      .select()
      .from(schema.bookings)
      .where(eq(schema.bookings.holdId, hold.reservationId));

    expect(bookingRow).toBeUndefined();
  });

  it('8. outcome: orphaned_hold — when DO returns HOLD_ALREADY_USED but no D1 booking exists', async () => {
    const eventId = 'bc-event-orphaned';
    const userId = 'user-orphaned';

    await db.insert(schema.events).values({
      id: eventId,
      organisationId: 'org-1',
      name: 'Orphaned Hold Event',
      date: new Date(Date.now() + 86400000),
      totalSeats: 10,
      pricePerSeat: 1000,
    });

    const stub = workerEnv.SEAT_LEDGER.get(workerEnv.SEAT_LEDGER.idFromName(eventId));
    await stub.initialize(10);

    const orphanedHoldId = 'orphaned-hold-123';

    // Insert a reservation with status = 'confirmed' directly in DO, but NO booking in D1
    await runInDurableObject(stub, (instance: SeatLedger) => {
      (instance as any).ctx.storage.sql.exec(
        "INSERT INTO reservations (id, user_id, seat_count, expires_at, status) VALUES (?, ?, ?, ?, 'confirmed')",
        orphanedHoldId,
        userId,
        1,
        Date.now() + 900000
      );
    });

    const result = await confirmBookingFromPayment({
      db,
      seatLedger: stub,
      holdId: orphanedHoldId,
      eventId,
      stripePaymentIntentId: 'pi_orphaned',
      amountReceivedPence: 1000,
    });

    // Must return orphaned_hold, NOT already_confirmed
    expect(result.outcome).toBe('orphaned_hold');
    if (result.outcome === 'orphaned_hold') {
      expect(result.holdId).toBe(orphanedHoldId);
      expect(result.eventId).toBe(eventId);
    }
  });
});
