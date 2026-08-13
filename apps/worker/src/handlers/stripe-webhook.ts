import Stripe from 'stripe';
import { drizzle } from 'drizzle-orm/d1';
import * as schema from '@event-booking/shared';
import { eq } from 'drizzle-orm';
import { dispatchEmailConfirmation, dispatchCalendarInvite } from '../integrations.js';
import type { Env } from '../index.js';

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
      const userId = paymentIntent.metadata.userId;

      if (!holdId || !eventId || !userId) {
        console.warn('payment_intent.succeeded: missing metadata — not from our checkout flow', paymentIntent.metadata);
        return new Response('', { status: 200 });
      }

      const stub = env.SEAT_LEDGER.get(env.SEAT_LEDGER.idFromName(eventId));

      let confirmResult: { userId: string; seatCount: number };
      try {
        confirmResult = await stub.confirmSeat(holdId);
      } catch (err: any) {
        if (err.message === 'HOLD_NOT_FOUND') {
          console.warn('payment_intent.succeeded: HOLD_NOT_FOUND — stale webhook, hold already expired', { holdId, eventId });
          return new Response('', { status: 200 });
        }
        if (err.message === 'HOLD_ALREADY_USED') {
          console.warn('payment_intent.succeeded: HOLD_ALREADY_USED — already confirmed, idempotent', { holdId, eventId });
          return new Response('', { status: 200 });
        }
        if (err.message === 'HOLD_EXPIRED') {
          console.warn('payment_intent.succeeded: HOLD_EXPIRED — releasing hold', { holdId, eventId });
          await stub.releaseSeat(holdId);
          return new Response('', { status: 200 });
        }
        console.error('payment_intent.succeeded: unexpected confirmSeat error:', err);
        return new Response('Internal error', { status: 500 });
      }

      const db = drizzle(env.DB, { schema });
      const [attendee] = await db.select().from(schema.attendees).where(eq(schema.attendees.userId, userId));

      if (!attendee) {
        console.error('payment_intent.succeeded: attendee not found for userId', userId);
        return new Response('Attendee not found', { status: 500 });
      }

      await db.insert(schema.bookings).values({
        id: crypto.randomUUID(),
        eventId: eventId,
        attendeeId: attendee.id,
        status: 'confirmed',
        seatCount: confirmResult.seatCount,
        holdId: holdId,
        stripePaymentIntentId: paymentIntent.id,
      });

      // Fire-and-forget integration stubs.
      // Errors are swallowed — a failed email must not cause a non-200 response,
      // which would trigger Stripe to retry the webhook and double-book.
      try {
        await dispatchEmailConfirmation({
          idempotencyKey: holdId,
          to: attendee.email,
          attendeeName: attendee.name,
          eventName: eventId,        // stub: replace with real event name lookup
          eventDate: Date.now(),     // stub: replace with real event date lookup
          seatCount: confirmResult.seatCount,
          bookingId: crypto.randomUUID(), // stub: use actual inserted booking id
          totalPaidPence: 0,         // stub: replace with real price lookup
        });
        await dispatchCalendarInvite({
          idempotencyKey: holdId,
          attendeeEmail: attendee.email,
          organizerEmail: 'organiser@example.com', // stub: replace with real organiser lookup
          eventName: eventId,
          eventDate: Date.now(),
          durationMinutes: 120,
          locationOrUrl: 'TBD',
          bookingId: holdId,
        });
      } catch {
        // Stub errors are swallowed — real implementation would log to a dead-letter queue
        console.error('[INTEGRATIONS] Stub dispatch failed — would DLQ in production');
      }

      return new Response('', { status: 200 });
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

      return new Response('', { status: 200 });
    }

    // Acknowledge and ignore all other event types
    return new Response('', { status: 200 });
  }
  
  return null;
}
