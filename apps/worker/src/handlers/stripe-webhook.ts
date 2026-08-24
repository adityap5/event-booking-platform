import Stripe from 'stripe';
import { drizzle } from 'drizzle-orm/d1';
import * as schema from '@event-booking/shared';
import { events } from '@event-booking/shared';
import { eq } from 'drizzle-orm';
import { dispatchEmailConfirmation, dispatchCalendarInvite } from '../integrations.js';
import { confirmBookingFromPayment } from '../booking-confirmation.js';
import { generateTicketPdf } from '../ticket-pdf.js';
import type { Env } from '../index.js';
import * as Sentry from '@sentry/cloudflare';
import { logStructured } from '../logger.js';

export async function handleStripeWebhook(request: Request, env: Env): Promise<Response | null> {
  const url = new URL(request.url);

  if (url.pathname === '/stripe/webhook' && request.method === 'POST') {
    const rawBody = await request.text();

    const stripeSignature = request.headers.get('stripe-signature');
    if (!stripeSignature) {
      return new Response('Missing stripe-signature header', { status: 400 });
    }

    const stripe = new Stripe(env.STRIPE_SECRET_KEY, {
      httpClient: Stripe.createFetchHttpClient(),
    });

    let stripeEvent: Stripe.Event;
    try {
      stripeEvent = await stripe.webhooks.constructEventAsync(
        rawBody,
        stripeSignature,
        env.STRIPE_WEBHOOK_SECRET,
      );
    } catch (err: any) {
      console.error('Stripe signature verification failed:', err.message);
      return new Response('Invalid signature', { status: 400 });
    }

    if (stripeEvent.type === 'payment_intent.succeeded') {
      const paymentIntent = stripeEvent.data.object as Stripe.PaymentIntent;
      const holdId = paymentIntent.metadata.holdId;
      const eventId = paymentIntent.metadata.eventId;

      if (!holdId || !eventId) {
        console.warn('payment_intent.succeeded: missing metadata — not from our checkout flow', paymentIntent.metadata);
        return new Response('', { status: 200 });
      }

      const db = drizzle(env.DB, { schema });
      const seatLedger = env.SEAT_LEDGER.get(env.SEAT_LEDGER.idFromName(eventId));

      let result;
      try {
        result = await confirmBookingFromPayment({
          db,
          seatLedger,
          holdId,
          eventId,
          stripePaymentIntentId: paymentIntent.id,
          amountReceivedPence: paymentIntent.amount_received,
        });
      } catch (err: any) {
        console.error('payment_intent.succeeded: unexpected confirmSeat error:', err);
        Sentry.captureException(err, {
          extra: {
            holdId,
            eventId,
            paymentIntentId: paymentIntent.id,
          },
        });
        return new Response('Internal error', { status: 500 });
      }

      switch (result.outcome) {
        case 'hold_not_found':
          console.warn('payment_intent.succeeded: HOLD_NOT_FOUND — stale webhook, hold already expired', { holdId, eventId });
          return new Response('', { status: 200 });

        case 'already_confirmed':
          console.warn('payment_intent.succeeded: HOLD_ALREADY_USED — already confirmed, idempotent', { holdId, eventId });
          return new Response('', { status: 200 });

        case 'hold_expired':
          console.warn('payment_intent.succeeded: HOLD_EXPIRED — releasing hold', { holdId, eventId });
          try {
            await db.insert(schema.auditLog).values({
              eventType: 'hold_released_explicit',
              holdId,
              bookingEventId: eventId,
              detail: JSON.stringify({ reason: 'hold_expired' }),
            });
          } catch (auditErr: unknown) {
            console.error('Failed to write audit_log for hold_expired:', auditErr);
            Sentry.captureMessage('Failed to write audit_log for hold_expired', {
              level: 'warning',
              extra: { holdId, eventId, error: auditErr instanceof Error ? auditErr.message : String(auditErr) },
            });
          }
          return new Response('', { status: 200 });

        case 'event_not_found':
          // No side effects occurred (checked before confirmSeat) — safe to
          // return 500 and let Stripe retry once the data issue is fixed.
          console.error('payment_intent.succeeded: event not found', { holdId, eventId });
          Sentry.captureMessage('payment_intent.succeeded: event not found', {
            level: 'warning',
            extra: { holdId, eventId },
          });
          return new Response('Event not found', { status: 500 });

        case 'attendee_not_found':
          console.error('payment_intent.succeeded: attendee not found for userId', result.userId);
          Sentry.captureMessage('payment_intent.succeeded: attendee not found', {
            level: 'warning',
            extra: { userId: result.userId, holdId, eventId },
          });
          return new Response('Attendee not found', { status: 500 });

        case 'orphaned_hold':
          // The DO shows this hold as consumed but no booking exists in D1.
          // A previous attempt confirmed the seat, then failed before the
          // booking insert. Retrying alone will not fix this today (there's
          // no way to re-derive seatCount/userId once the hold is consumed)
          // — 500 keeps Stripe retrying in case a fix lands within its retry
          // window, but this needs eyes-on / day-7 reconciliation regardless.
          console.error('payment_intent.succeeded: ORPHANED HOLD — DO shows consumed, no D1 booking exists', result);
          Sentry.captureMessage('payment_intent.succeeded: ORPHANED HOLD', {
            level: 'error',
            extra: {
              holdId: result.holdId,
              eventId: result.eventId,
              stripePaymentIntentId: paymentIntent.id,
            },
          });
          logStructured({
            category: 'invariant_violation',
            action: 'orphaned_hold',
            holdId: result.holdId,
            eventId: result.eventId,
          });
          return new Response('Orphaned hold — needs reconciliation', { status: 500 });

        case 'amount_mismatch':
          // Stripe collected a different amount than pricePerSeat × seatCount implies.
          // The seat is already consumed in the DO (see helper's comment) and no
          // booking row was written. This should be effectively unreachable now that
          // seatCount is derived server-side rather than client-supplied — if it
          // fires, that invariant has broken somewhere and needs investigating,
          // not just retrying. Loud on purpose; wire to Sentry/Axiom on days 5–6.
          console.error('payment_intent.succeeded: AMOUNT MISMATCH — possible seatCount/price desync', result);
          Sentry.captureMessage('payment_intent.succeeded: AMOUNT MISMATCH', {
            level: 'error',
            extra: {
              holdId: result.holdId,
              eventId: result.eventId,
              seatCount: result.seatCount,
              expectedPence: result.expectedPence,
              receivedPence: result.receivedPence,
            },
          });
          logStructured({
            category: 'invariant_violation',
            action: 'amount_mismatch',
            holdId: result.holdId,
            eventId: result.eventId,
            seatCount: result.seatCount,
            expectedPence: result.expectedPence,
            receivedPence: result.receivedPence,
          });
          return new Response('Amount mismatch', { status: 500 });

        case 'confirmed': {
          const { booking, attendee, seatCount } = result;

          try {
            await db.insert(schema.auditLog).values({
              eventType: 'booking_confirmed',
              holdId,
              bookingEventId: eventId,
              userId: attendee.userId,
              detail: JSON.stringify({
                bookingId: booking.id,
                seatCount,
                amountReceivedPence: paymentIntent.amount_received,
              }),
            });
          } catch (auditErr: unknown) {
            console.error('Failed to write audit_log for booking_confirmed:', auditErr);
            Sentry.captureMessage('Failed to write audit_log for booking_confirmed', {
              level: 'warning',
              extra: {
                holdId,
                eventId,
                bookingId: booking.id,
                error: auditErr instanceof Error ? auditErr.message : String(auditErr),
              },
            });
          }

          // Fetch real event metadata (name + date) for integration payloads and ticket.
          // The event is guaranteed to exist here (already checked before confirmSeat),
          // but the lookup is in its own try/catch so a transient D1 error never causes
          // a non-200 response or introduces fake fallback data.
          let realEventName: string | null = null;
          let realEventDate: number | null = null;
          try {
            const [eventRow] = await db
              .select({ name: events.name, date: events.date })
              .from(events)
              .where(eq(events.id, eventId));
            if (eventRow) {
              realEventName = eventRow.name;
              realEventDate = eventRow.date instanceof Date
                ? eventRow.date.getTime()
                : Number(eventRow.date);
            }
          } catch (eventLookupErr: unknown) {
            console.error('Failed to fetch event metadata for confirmed booking:', eventLookupErr);
            Sentry.captureMessage('Failed to fetch event metadata for confirmed booking', {
              level: 'warning',
              extra: {
                holdId,
                eventId,
                bookingId: booking.id,
                error: eventLookupErr instanceof Error ? eventLookupErr.message : String(eventLookupErr),
              },
            });
          }

          // Fire-and-forget integration stubs.
          // Errors are swallowed — a failed email must not cause a non-200 response,
          // which would trigger Stripe to retry the webhook and double-book.
          // Skipped entirely when event metadata is unavailable (avoids fake data).
          if (realEventName !== null && realEventDate !== null) {
            try {
              await dispatchEmailConfirmation({
                idempotencyKey: holdId,
                to: attendee.email,
                attendeeName: attendee.name,
                eventName: realEventName,
                eventDate: realEventDate,
                seatCount,
                bookingId: booking.id,
                totalPaidPence: paymentIntent.amount_received,
              });
              await dispatchCalendarInvite({ // organizerEmail intentionally omitted — no organiser-email lookup exists yet. See CalendarInvitePayload in integrations.ts.
                idempotencyKey: holdId,
                attendeeEmail: attendee.email,
                eventName: realEventName,
                eventDate: realEventDate,
                durationMinutes: 120,
                locationOrUrl: 'TBD',
                bookingId: booking.id,
              });
            } catch {
              // Stub errors are swallowed — real implementation would log to a dead-letter queue
              console.error('[INTEGRATIONS] Stub dispatch failed — would DLQ in production');
              Sentry.captureMessage('[INTEGRATIONS] Stub dispatch failed — would DLQ in production', {
                level: 'warning',
                extra: {
                  holdId,
                  bookingId: booking.id,
                },
              });
            }
          }

          // Generate PDF ticket and upload to R2.
          // Failure is fully isolated — a PDF/R2 error must not turn a successfully
          // confirmed booking into a non-200 response. If generation fails here the
          // ticket is generated lazily on first download via getTicket.
          // Skipped when event metadata is unavailable (same guard as integrations above).
          if (realEventName !== null && realEventDate !== null) {
            try {
              const pdfBytes = await generateTicketPdf({
                attendeeName: attendee.name,
                eventName: realEventName,
                eventDate: realEventDate,
                seatCount,
                bookingId: booking.id,
              });
              await env.EVENT_TICKETS.put(
                `tickets/${booking.id}.pdf`,
                pdfBytes,
                { httpMetadata: { contentType: 'application/pdf' } },
              );
            } catch (ticketErr: unknown) {
              console.error('[TICKET] PDF generation or R2 upload failed:', ticketErr);
              Sentry.captureMessage('[TICKET] PDF generation or R2 upload failed at webhook time', {
                level: 'warning',
                extra: {
                  holdId,
                  bookingId: booking.id,
                  error: ticketErr instanceof Error ? ticketErr.message : String(ticketErr),
                },
              });
              // Not re-thrown — ticket can be generated lazily on first getTicket call.
            }
          }

          return new Response('', { status: 200 });
        }
      }
    }

    if (stripeEvent.type === 'payment_intent.payment_failed') {
      const paymentIntent = stripeEvent.data.object as Stripe.PaymentIntent;
      const holdId = paymentIntent.metadata.holdId;
      const eventId = paymentIntent.metadata.eventId;

      if (!holdId || !eventId) {
        return new Response('', { status: 200 }); // Nothing to release
      }

      const stub = env.SEAT_LEDGER.get(env.SEAT_LEDGER.idFromName(eventId));
      await stub.releaseSeat(holdId);

      const db = drizzle(env.DB, { schema });
      await db.update(schema.bookings)
        .set({ status: 'cancelled' })
        .where(eq(schema.bookings.holdId, holdId));

      try {
        await db.insert(schema.auditLog).values({
          eventType: 'hold_released_explicit',
          holdId,
          bookingEventId: eventId,
          detail: JSON.stringify({ reason: 'payment_failed' }),
        });
      } catch (auditErr: unknown) {
        console.error('Failed to write audit_log for payment_failed:', auditErr);
        Sentry.captureMessage('Failed to write audit_log for payment_failed', {
          level: 'warning',
          extra: { holdId, eventId, error: auditErr instanceof Error ? auditErr.message : String(auditErr) },
        });
      }

      return new Response('', { status: 200 });
    }



    // Acknowledge and ignore all other event types
    return new Response('', { status: 200 });
  }

  return null;
}