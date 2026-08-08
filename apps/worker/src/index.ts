import { fetchRequestHandler } from '@trpc/server/adapters/fetch';
import { createContext } from '@event-booking/trpc';
import { appRouter } from './router.js';
import { drizzle } from 'drizzle-orm/d1';
import * as schema from '@event-booking/shared';
import { Webhook } from 'svix';
import Stripe from 'stripe';
import { eq } from 'drizzle-orm';

import { SeatLedger } from "./seat-ledger.js";
export { SeatLedger };

export type Env = {
  CLERK_JWT_KEY: string;
  CLERK_WEBHOOK_SECRET: string;
  STRIPE_SECRET_KEY: string;
  STRIPE_WEBHOOK_SECRET: string;
  DB: D1Database;
  SEAT_LEDGER: DurableObjectNamespace<SeatLedger>;
};

const ALLOWED_ORIGIN = 'https://event-booking-web.aditya29.workers.dev';

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // Handle Webhooks before CORS and tRPC
    if (url.pathname === '/api/webhooks/clerk' && request.method === 'POST') {
      const WEBHOOK_SECRET = env.CLERK_WEBHOOK_SECRET;
      if (!WEBHOOK_SECRET) {
        return new Response('Missing CLERK_WEBHOOK_SECRET', { status: 500 });
      }

      const svix_id = request.headers.get("svix-id");
      const svix_timestamp = request.headers.get("svix-timestamp");
      const svix_signature = request.headers.get("svix-signature");

      if (!svix_id || !svix_timestamp || !svix_signature) {
        return new Response('Error: Missing svix headers', { status: 400 });
      }

      const payload = await request.text();
      const wh = new Webhook(WEBHOOK_SECRET);

      let evt: any;
      try {
        evt = wh.verify(payload, {
          "svix-id": svix_id,
          "svix-timestamp": svix_timestamp,
          "svix-signature": svix_signature,
        });
      } catch (err: any) {
        console.error('Error verifying webhook:', err.message);
        return new Response('Error verifying signature', { status: 400 });
      }

      if (evt.type === 'organization.created') {
        const db = drizzle(env.DB, { schema });
        try {
          console.log('Webhook organization.created_at raw value:', evt.data.created_at);
          console.log('Webhook organization.created_at typeof:', typeof evt.data.created_at);
          
          await db.insert(schema.organisations).values({
            id: evt.data.id,
            name: evt.data.name,
            ownerId: evt.data.created_by,
            // Clerk returns created_at as milliseconds, our schema expects a Date object because mode='timestamp'
            createdAt: evt.data.created_at ? new Date(evt.data.created_at) : new Date(),
          }).onConflictDoNothing();
          console.log(`Successfully synced organisation ${evt.data.id} to D1`);
        } catch (err: any) {
          console.error('Error inserting organisation to DB:', err);
          console.error('Error cause:', err.cause);
          console.error('Error stack:', err.stack);
          return new Response('Database error', { status: 500 });
        }
      }

      return new Response('', { status: 200 });
    }

    // Handle Stripe webhook
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

    // Handle WebSocket upgrades — forward to the SeatLedger DO for the event
    if (url.pathname === '/ws' && request.headers.get('Upgrade') === 'websocket') {
      const eventId = url.searchParams.get('eventId');
      if (!eventId) {
        return new Response('Missing eventId', { status: 400 });
      }

      const id = env.SEAT_LEDGER.idFromName(eventId);
      const stub = env.SEAT_LEDGER.get(id) as DurableObjectStub;
      return stub.fetch(request);
    }

    // Handle CORS preflight requests for tRPC
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
          'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type, Authorization',
          'Access-Control-Max-Age': '86400',
        },
      });
    }

    const response = await fetchRequestHandler({
      endpoint: '/trpc',
      req: request,
      router: appRouter,
      createContext: (opts) =>
        createContext({
          ...opts,
          clerkJwtKey: env.CLERK_JWT_KEY,
          authorizedParties: [ALLOWED_ORIGIN, 'http://localhost:3000'],
          db: drizzle(env.DB, { schema }),
          env,
        }),
    });

    // Append CORS headers to the tRPC response
    response.headers.set('Access-Control-Allow-Origin', ALLOWED_ORIGIN);
    return response;
  },
} satisfies ExportedHandler<Env>;
