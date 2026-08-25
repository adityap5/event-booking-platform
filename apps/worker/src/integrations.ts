/**
 * integrations.ts — Single dispatch point for all external integrations.
 *
 * Every function here is a pluggable stub. A stub qualifies as pluggable when:
 *   1. It has a typed payload interface (documented schema below).
 *   2. It carries an idempotencyKey on every dispatch call.
 *   3. It is dispatched from this file only — never scattered across procedures.
 *
 * To swap a stub for a real provider, replace only the function body.
 * Callers (index.ts) do not need to change.
 */

// ---------------------------------------------------------------------------
// Email confirmation
// ---------------------------------------------------------------------------

// SECURITY NOTE: When a real email provider is eventually wired in (replacing the stub below),
// unescaped newlines (\r\n) in `to` or `attendeeName` become header-injection vectors if interpolated
// directly into raw email headers (classic SMTP/email header injection). Ensure input sanitization/escaping
// or structured SDK payload parameters are used when implementing the real provider dispatch.
export interface EmailConfirmationPayload {
  idempotencyKey: string;   // bookingId — prevents duplicate sends on retry
  to: string;               // attendee email address
  attendeeName: string;     // attendee display name
  eventName: string;        // name of the event
  eventDate: number;        // unix timestamp ms
  seatCount: number;        // number of seats booked
  bookingId: string;        // D1 booking row id
  totalPaidPence: number;   // seatCount * pricePerSeat
}

export async function dispatchEmailConfirmation(
   _payload: EmailConfirmationPayload,
): Promise<void> {
  // STUB: Replace with real email provider (Resend, SendGrid, Postmark)
  // Payload schema is stable — swap the implementation without changing callers
  // Idempotency: use payload.idempotencyKey as the provider's idempotency key
}

// ---------------------------------------------------------------------------
// Calendar invite
// ---------------------------------------------------------------------------

export interface CalendarInvitePayload {
  idempotencyKey: string;   // bookingId
  attendeeEmail: string;    // attendee email for invite
  organizerEmail?: string;  // event organiser email (optional until organiser lookup is implemented)
  eventName: string;
  eventDate: number;        // unix timestamp ms
  durationMinutes: number;  // default 120 if unknown
  locationOrUrl: string;    // venue address or stream URL
  bookingId: string;
}

export async function dispatchCalendarInvite(
   _payload: CalendarInvitePayload,
): Promise<void> {
  // STUB: Replace with Google Calendar API, iCal generation + email, or Nylas
  // Payload schema is stable — swap the implementation without changing callers
  // Idempotency: use payload.idempotencyKey to deduplicate calendar creates
}
