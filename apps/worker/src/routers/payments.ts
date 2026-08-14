import { z } from 'zod';
import { events } from '@event-booking/shared';
import { eq } from 'drizzle-orm';
import Stripe from 'stripe';
import { TRPCError } from '@trpc/server';
import { workerProcedure } from '../procedures.js';

export const paymentsRouter = {
  createCheckoutSession: workerProcedure
    .input(z.object({
      holdId: z.string().uuid(),
      eventId: z.string(),
    }))
    .mutation(async ({ input, ctx }) => {
      const doId = ctx.env.SEAT_LEDGER.idFromName(input.eventId);
      const stub = ctx.env.SEAT_LEDGER.get(doId);
      const hold = await stub.getHold(input.holdId);

      if (!hold) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Hold not found or expired' });
      }

      // Ownership is checked immediately after existence, before status/expiry —
      // checking status or expiry first would let a FORBIDDEN response leak
      // whether another user's hold is pending, confirmed, or expired, even
      // without exposing its contents.
      if (hold.userId !== ctx.userId) {
        throw new TRPCError({ code: 'FORBIDDEN', message: 'This hold does not belong to you' });
      }

      if (hold.status !== 'pending') {
        throw new TRPCError({ code: 'CONFLICT', message: 'Hold is no longer valid' });
      }

      if (Date.now() > hold.expiresAt) {
        throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'Hold has expired' });
      }

      const [event] = await ctx.db
        .select({ id: events.id, name: events.name, pricePerSeat: events.pricePerSeat })
        .from(events)
        .where(eq(events.id, input.eventId));

      if (!event) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Event not found' });
      }

      const stripe = new Stripe(ctx.env.STRIPE_SECRET_KEY, {
        httpClient: Stripe.createFetchHttpClient(),
      });

      // seatCount is derived from the hold, never accepted from the client — see CRITICAL_FINDINGS.md.
      const seatCount = hold.seatCount;

      const session = await stripe.checkout.sessions.create({
        mode: 'payment',
        line_items: [
          {
            price_data: {
              currency: 'gbp',
              unit_amount: event.pricePerSeat,
              product_data: {
                name: event.name,
                description: `${seatCount} seat(s) for ${event.name}`,
              },
            },
            quantity: seatCount,
          },
        ],
        payment_intent_data: {
          metadata: {
            holdId: input.holdId,
            eventId: input.eventId,
            userId: ctx.userId,
          },
        },
        success_url: 'https://event-booking-web.aditya29.workers.dev/booking/success?session_id={CHECKOUT_SESSION_ID}',
        cancel_url: 'https://event-booking-web.aditya29.workers.dev/booking/cancelled',
      });

      return { sessionUrl: session.url };
    }),
};
