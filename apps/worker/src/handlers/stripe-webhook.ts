import Stripe from 'stripe';
import { drizzle } from 'drizzle-orm/d1';
import * as schema from '@event-booking/shared';
import { events } from '@event-booking/shared';
import { eq, and, or, isNull } from 'drizzle-orm';
import { dispatchEmailConfirmation, dispatchCalendarInvite } from '../integrations.js';
import { confirmBookingFromPayment } from '../booking-confirmation.js';
import { generateTicketPdf } from '../ticket-pdf.js';
import type { Env } from '../index.js';
import * as Sentry from '@sentry/cloudflare';
import { logStructured } from '../logger.js';
import { findOrgByStripeCustomerId } from '../subscription-helpers.js';

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
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.error('Stripe signature verification failed:', message);
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
      } catch (err: unknown) {
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
          console.warn('payment_intent.succeeded: HOLD_ALREADY_USED — same PaymentIntent redelivered, idempotent', { holdId, eventId });
          return new Response('', { status: 200 });

        case 'duplicate_payment_for_confirmed_hold':
          // A genuinely different PaymentIntent succeeded for a hold that is already
          // confirmed. Real money was captured with no corresponding booking.
          // Do NOT auto-refund here — that requires deliberate, isolated handling
          // matching the refundBooking path. Alert loudly so a human can act.
          console.error('payment_intent.succeeded: DUPLICATE PAYMENT — different PaymentIntent for already-confirmed hold', {
            holdId,
            eventId,
            incomingPaymentIntentId: result.incomingPaymentIntentId,
            existingPaymentIntentId: result.existingPaymentIntentId,
          });
          Sentry.captureMessage('payment_intent.succeeded: DUPLICATE PAYMENT — different PaymentIntent captured for already-confirmed hold', {
            level: 'error',
            extra: {
              holdId,
              eventId,
              incomingPaymentIntentId: result.incomingPaymentIntentId,
              existingPaymentIntentId: result.existingPaymentIntentId,
            },
          });
          // Write audit row so a human reviewing the log has the conflicting IDs.
          // Failure is fully isolated — audit write errors must not affect the HTTP
          // response, per this codebase's established audit-isolation pattern.
          try {
            await db.insert(schema.auditLog).values({
              eventType: 'duplicate_payment_captured',
              holdId,
              bookingEventId: eventId,
              detail: JSON.stringify({
                incomingPaymentIntentId: result.incomingPaymentIntentId,
                existingPaymentIntentId: result.existingPaymentIntentId,
              }),
            });
          } catch (auditErr: unknown) {
            console.error('Failed to write audit_log for duplicate_payment_captured:', auditErr);
            Sentry.captureMessage('Failed to write audit_log for duplicate_payment_captured', {
              level: 'warning',
              extra: {
                holdId,
                eventId,
                incomingPaymentIntentId: result.incomingPaymentIntentId,
                error: auditErr instanceof Error ? auditErr.message : String(auditErr),
              },
            });
          }
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

    if (stripeEvent.type === 'customer.subscription.created') {
      const subscription = stripeEvent.data.object as Stripe.Subscription;
      const customerId = typeof subscription.customer === 'string'
        ? subscription.customer
        : subscription.customer?.id;

      if (!customerId) {
        console.warn('customer.subscription.created: missing customer ID on subscription object', subscription.id);
        return new Response('', { status: 200 });
      }

      const db = drizzle(env.DB, { schema });
      const org = await findOrgByStripeCustomerId(db, customerId);

      if (!org) {
        console.warn('customer.subscription.created: unknown stripeCustomerId', customerId);
        return new Response('', { status: 200 });
      }

      // 1. If already authoritative for this exact subscription ID, update status idempotently
      if (org.stripeSubscriptionId === subscription.id) {
        await db
          .update(schema.organisations)
          .set({
            subscriptionStatus: subscription.status,
          })
          .where(eq(schema.organisations.id, org.id));
        return new Response('', { status: 200 });
      }

      // 2. Atomic Compare-And-Set claim:
      // If org has no subscription ID or is canceled, attempt an atomic claim where stripeSubscriptionId is NULL
      // or subscriptionStatus is 'canceled'.
      if (!org.stripeSubscriptionId || org.subscriptionStatus === 'canceled') {
        const claimResult = await db
          .update(schema.organisations)
          .set({
            stripeSubscriptionId: subscription.id,
            subscriptionStatus: subscription.status,
          })
          .where(
            and(
              eq(schema.organisations.id, org.id),
              or(
                isNull(schema.organisations.stripeSubscriptionId),
                eq(schema.organisations.subscriptionStatus, 'canceled'),
              ),
            ),
          )
          .returning({ id: schema.organisations.id });

        if (claimResult.length > 0) {
          // Won the atomic claim — this subscription is now authoritative in D1
          return new Response('', { status: 200 });
        }
      }

      // 3. Race lost or existing non-terminal subscription already held.
      // Re-read D1 to identify the authoritative winner.
      const freshOrg = await findOrgByStripeCustomerId(db, customerId);
      if (freshOrg?.stripeSubscriptionId === subscription.id) {
        return new Response('', { status: 200 });
      }

      // Defensively cancel the redundant secondary subscription on Stripe to prevent double-billing
      console.warn('customer.subscription.created: ignoring and canceling unexpected secondary subscription for customer', {
        orgId: org.id,
        authoritativeSubscriptionId: freshOrg?.stripeSubscriptionId,
        rejectedSubscriptionId: subscription.id,
      });

      try {
        const stripeClient = new Stripe(env.STRIPE_SECRET_KEY, {
          httpClient: Stripe.createFetchHttpClient(),
        });
        await stripeClient.subscriptions.cancel(subscription.id);
      } catch (cancelErr) {
        console.error('Failed to cancel redundant secondary subscription on Stripe:', cancelErr);
        Sentry.captureMessage('customer.subscription.created: failed to cancel redundant secondary subscription', {
          level: 'error',
          extra: {
            orgId: org.id,
            authoritativeSubscriptionId: freshOrg?.stripeSubscriptionId,
            rejectedSubscriptionId: subscription.id,
            error: cancelErr instanceof Error ? cancelErr.message : String(cancelErr),
          },
        });
      }

      return new Response('', { status: 200 });
    }

    if (stripeEvent.type === 'customer.subscription.updated') {
      const subscription = stripeEvent.data.object as Stripe.Subscription;
      const customerId = typeof subscription.customer === 'string'
        ? subscription.customer
        : subscription.customer?.id;

      if (!customerId) {
        console.warn('customer.subscription.updated: missing customer ID on subscription object', subscription.id);
        return new Response('', { status: 200 });
      }

      const db = drizzle(env.DB, { schema });
      const org = await findOrgByStripeCustomerId(db, customerId);

      if (!org) {
        console.warn('customer.subscription.updated: unknown stripeCustomerId', customerId);
        return new Response('', { status: 200 });
      }

      // 1. Matching current subscription — update status
      if (org.stripeSubscriptionId === subscription.id) {
        await db
          .update(schema.organisations)
          .set({
            subscriptionStatus: subscription.status,
          })
          .where(eq(schema.organisations.id, org.id));
        return new Response('', { status: 200 });
      }

      // 2. Out-of-order delivery protection: If stripeSubscriptionId was null, attempt atomic claim
      if (!org.stripeSubscriptionId) {
        const claimResult = await db
          .update(schema.organisations)
          .set({
            stripeSubscriptionId: subscription.id,
            subscriptionStatus: subscription.status,
          })
          .where(
            and(
              eq(schema.organisations.id, org.id),
              isNull(schema.organisations.stripeSubscriptionId),
            ),
          )
          .returning({ id: schema.organisations.id });

        if (claimResult.length > 0) {
          // Won the claim and adopted the subscription
          return new Response('', { status: 200 });
        }
      }

      // 3. Race lost or stale event for non-matching subscription ID
      const freshOrg = await findOrgByStripeCustomerId(db, customerId);
      if (freshOrg?.stripeSubscriptionId === subscription.id) {
        return new Response('', { status: 200 });
      }

      console.warn('customer.subscription.updated: ignoring stale event for non-matching subscription ID', {
        orgId: org.id,
        currentSubscriptionId: freshOrg?.stripeSubscriptionId,
        eventSubscriptionId: subscription.id,
      });

      return new Response('', { status: 200 });
    }

    if (stripeEvent.type === 'customer.subscription.deleted') {
      const subscription = stripeEvent.data.object as Stripe.Subscription;
      const customerId = typeof subscription.customer === 'string'
        ? subscription.customer
        : subscription.customer?.id;

      if (!customerId) {
        console.warn('customer.subscription.deleted: missing customer ID on subscription object', subscription.id);
        return new Response('', { status: 200 });
      }

      const db = drizzle(env.DB, { schema });
      const org = await findOrgByStripeCustomerId(db, customerId);

      if (!org) {
        console.warn('customer.subscription.deleted: unknown stripeCustomerId', customerId);
        return new Response('', { status: 200 });
      }

      // Only transition to canceled if the deleted subscription matches the current subscription ID
      if (org.stripeSubscriptionId === subscription.id) {
        await db
          .update(schema.organisations)
          .set({
            subscriptionStatus: 'canceled',
          })
          .where(eq(schema.organisations.id, org.id));
      } else {
        console.warn('customer.subscription.deleted: ignoring stale deletion for non-matching subscription ID', {
          orgId: org.id,
          currentSubscriptionId: org.stripeSubscriptionId,
          eventSubscriptionId: subscription.id,
        });
      }

      return new Response('', { status: 200 });
    }

    // Acknowledge and ignore all other event types
    return new Response('', { status: 200 });
  }

  return null;
}