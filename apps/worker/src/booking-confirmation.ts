import { eq } from 'drizzle-orm';
import type { DrizzleD1Database } from 'drizzle-orm/d1';
import * as schema from '@event-booking/shared';
import { events } from '@event-booking/shared';
import { logStructured } from './logger.js';

/**
 * Minimal shape of the SEAT_LEDGER DO stub this helper needs.
 * Narrowed on purpose (not the full WorkerEnv binding) so this file
 * can be unit-tested with a plain mock object instead of the whole Env.
 */
export interface SeatLedgerStub {
  confirmSeat: (holdId: string) => Promise<{ userId: string; seatCount: number }>;
  releaseSeat: (holdId: string) => Promise<void>;
}

export interface ConfirmBookingFromPaymentInput {
  db: DrizzleD1Database<typeof schema>;
  seatLedger: SeatLedgerStub;
  holdId: string;
  eventId: string;
  stripePaymentIntentId: string;
  /** From Stripe's payment_intent.succeeded payload — what was actually collected. */
  amountReceivedPence: number;
}

export type ConfirmBookingFromPaymentResult =
  | {
      outcome: 'confirmed';
      booking: typeof schema.bookings.$inferSelect;
      attendee: typeof schema.attendees.$inferSelect;
      seatCount: number;
    }
  // A booking row already exists for this holdId — genuine idempotent replay
  // (Stripe re-sent a webhook we've already fully processed). Verified by
  // querying D1, not assumed from the DO's HOLD_ALREADY_USED alone — see
  // 'orphaned_hold' below for why that distinction matters.
  | { outcome: 'already_confirmed' }
  | { outcome: 'hold_not_found' }
  // Hold expired between checkout and webhook delivery; the DO hold has been released.
  | { outcome: 'hold_expired' }
  // Event referenced by the hold's metadata no longer exists in D1. Checked
  // BEFORE confirmSeat() is called, so this is a clean pre-check: the hold
  // has not been consumed and remains valid for a future retry once the
  // underlying data issue (event deleted mid-flow?) is investigated.
  | { outcome: 'event_not_found' }
  | { outcome: 'attendee_not_found'; userId: string }
  // See the comment above the check below: the hold is already consumed by the time
  // this is detected, so this outcome cannot be fully resolved here. It exists so the
  // caller can log/alert loudly rather than silently writing an unpaid confirmed seat.
  | {
      outcome: 'amount_mismatch';
      expectedPence: number;
      receivedPence: number;
      seatCount: number;
      holdId: string;
      eventId: string;
    }
  // The DO reports this hold as already consumed (HOLD_ALREADY_USED), but D1
  // has no booking row for it. This means a PREVIOUS call to this function
  // confirmed the seat on the DO and then failed before (or during) the
  // booking insert — attendee lookup failure, D1 write error, worker crash,
  // etc. This is a genuine reconciliation gap: the seat is gone from the DO's
  // perspective but no booking exists anywhere. While getHold(holdId) and
  // listConfirmedHolds() exist on the DO, automated self-healing is intentionally
  // deferred; orphaned holds are surfaced loudly and caught by the Day 7
  // periodic reconciliation job (using listConfirmedHolds()) for alerting and manual intervention.
  | { outcome: 'orphaned_hold'; holdId: string; eventId: string };



/**
 * Confirms a seat hold against a successful Stripe payment and writes the
 * resulting booking row. This is the single place "a payment became a
 * confirmed booking" happens — kept deliberately free of HTTP/tRPC concerns
 * so it's an isolated, testable business-logic function. Not a pure
 * function: it performs real side effects against the SeatLedger DO and D1,
 * and those two writes are not atomic with each other (see 'orphaned_hold'
 * above for what that means in practice).
 *
 * Ownership note: `seatCount` and `pricePerSeat` are never accepted as
 * arguments from outside this module for the values that matter — seatCount
 * comes back from the DO's confirmSeat() call (the hold, not the client),
 * and pricePerSeat is read from D1. The only externally-supplied number is
 * amountReceivedPence, which exists purely to be checked against those two,
 * never trusted on its own. See CRITICAL_FINDINGS.md #1 — this is the fix.
 *
 * Ordering note: the event lookup happens BEFORE confirmSeat() is called,
 * deliberately, because it's a read with no side effects — there's no reason
 * to consume the hold and only then discover the event is gone. Everything
 * that happens AFTER confirmSeat() succeeds (attendee lookup, booking
 * insert) can still fail independently, and there is no rollback for
 * confirmSeat() — so those failures are made detectable-on-retry via the
 * 'orphaned_hold' check, rather than assumed away.
 */
export async function confirmBookingFromPayment(
  input: ConfirmBookingFromPaymentInput,
): Promise<ConfirmBookingFromPaymentResult> {
  const { db, seatLedger, holdId, eventId, stripePaymentIntentId, amountReceivedPence } = input;

  const [event] = await db
    .select({ pricePerSeat: events.pricePerSeat })
    .from(events)
    .where(eq(events.id, eventId));

  if (!event) {
    // No side effects yet — safe to report and let a retry happen after
    // investigation, without needing any reconciliation machinery.
    return { outcome: 'event_not_found' };
  }

  let confirmResult: { userId: string; seatCount: number };
  try {
    confirmResult = await seatLedger.confirmSeat(holdId);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String((err as { message?: unknown })?.message ?? '');
    if (message === 'HOLD_NOT_FOUND') return { outcome: 'hold_not_found' };

    if (message === 'HOLD_ALREADY_USED') {
      // Do NOT assume this means "already confirmed" — verify a booking
      // actually exists. See the 'orphaned_hold' / 'already_confirmed'
      // doc comments above for why this distinction is load-bearing.
      const [existingBooking] = await db
        .select()
        .from(schema.bookings)
        .where(eq(schema.bookings.holdId, holdId));

      if (existingBooking) {
        return { outcome: 'already_confirmed' };
      }
      return { outcome: 'orphaned_hold', holdId, eventId };
    }

    if (message === 'HOLD_EXPIRED') {
      await seatLedger.releaseSeat(holdId);
      return { outcome: 'hold_expired' };
    }
    throw err; // genuinely unexpected — let the caller's error path handle it
  }

  // Defence-in-depth, not the primary fix. The primary fix is that seatCount
  // is no longer client-supplied anywhere upstream (see createCheckoutSession).
  // This check exists so that if that invariant is ever violated by a future
  // change, it's caught here instead of silently producing a mismatched booking.
  const expectedPence = event.pricePerSeat * confirmResult.seatCount;
  if (expectedPence !== amountReceivedPence) {
    // NOTE: the hold is already consumed above — confirmSeat() has no "peek"
    // mode, so by the time a mismatch is detectable it can't be undone here.
    // Deliberately not inserting a booking row (no unpaid/mismatched booking
    // is created), but the seat itself is gone from the DO's perspective.
    // A retry after this will land in the 'orphaned_hold' branch above
    // (booking still won't exist), which is the correct outcome — this is
    // exactly the kind of gap the day-7 reconciliation job is meant to catch.
    logStructured({
      category: 'invariant_violation',
      action: 'amount_mismatch',
      holdId,
      eventId,
      seatCount: confirmResult.seatCount,
      expectedPence,
      receivedPence: amountReceivedPence,
    });
    return {
      outcome: 'amount_mismatch',
      expectedPence,
      receivedPence: amountReceivedPence,
      seatCount: confirmResult.seatCount,
      holdId,
      eventId,
    };
  }

  const [attendee] = await db
    .select()
    .from(schema.attendees)
    .where(eq(schema.attendees.userId, confirmResult.userId));

  if (!attendee) {
    // Same as above: hold is consumed, no booking written. A retry lands in
    // 'orphaned_hold', not a silent 'already_confirmed'.
    return { outcome: 'attendee_not_found', userId: confirmResult.userId };
  }

  const [booking] = await db
    .insert(schema.bookings)
    .values({
      id: crypto.randomUUID(),
      eventId,
      attendeeId: attendee.id,
      status: 'confirmed',
      seatCount: confirmResult.seatCount,
      holdId,
      stripePaymentIntentId,
    })
    .returning();
  // If this insert itself throws (D1 error, constraint violation, etc.), it
  // propagates to the caller uncaught — same reasoning as above: the hold is
  // consumed, no booking exists, and a retry will correctly land in
  // 'orphaned_hold' rather than silently re-confirming or silently no-op-ing.

  if (!booking) {
  throw new Error('Booking insert succeeded but returned no booking row');
}

  return { outcome: 'confirmed', booking, attendee, seatCount: confirmResult.seatCount };
}