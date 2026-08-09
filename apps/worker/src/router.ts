import { router, protectedProcedure, publicProcedure, enforceOrganiserAccess } from '@event-booking/trpc';
import { z } from 'zod';
import * as schema from '@event-booking/shared';
import { events } from '@event-booking/shared';
import { eq } from 'drizzle-orm';
import Stripe from 'stripe';

import { TRPCError } from '@trpc/server';

interface WorkerEnv {
  STRIPE_SECRET_KEY: string;
  STRIPE_WEBHOOK_SECRET: string;  
  SEAT_LEDGER: {
    idFromName: (name: string) => any;
    get: (id: any) => {
      getAvailableSeats: () => Promise<number | null>;
      initialize: (seats: number) => Promise<void>;
      reserveSeat: (userId: string, seats: number) => Promise<{ reservationId: string; expiresAt: number }>;
      confirmSeat: (holdId: string) => Promise<{ userId: string; seatCount: number }>;
      releaseSeat: (holdId: string) => Promise<void>;
      mintTicket: (userId: string, orgId: string | null, eventId: string) => Promise<string>;
    };
  };
  EVENT_CACHE: KVNamespace;
}

// Create a worker-specific procedure that strongly types the environment
const workerProcedure = protectedProcedure.use(({ next, ctx }) => {
  return next({
    ctx: {
      ...ctx,
      env: ctx.env as WorkerEnv,
    }
  });
});

const publicWorkerProcedure = publicProcedure.use(({ next, ctx }) => {
  return next({
    ctx: {
      ...ctx,
      env: ctx.env as WorkerEnv,
    }
  });
});

export const appRouter = router({
  whoami: protectedProcedure.query(({ ctx }) => {
    return {
      userId: ctx.userId,
      orgId: ctx.orgId,
      role: ctx.role,
    };
  }),

  getEvent: protectedProcedure
    .input(z.object({ eventId: z.string() }))
    .use(enforceOrganiserAccess<{ eventId: string }>(async ({ input, ctx }) => {
      const db = ctx.db; 
      const [event] = await db.select().from(events).where(eq(events.id, input.eventId));
      return event?.organisationId || null;
    }))
    .query(async ({ input, ctx }) => {
      const db = ctx.db;
      const [event] = await db.select().from(events).where(eq(events.id, input.eventId));
      return { name: event?.name };
    }),

  getAvailableSeats: publicWorkerProcedure
    .input(z.object({ eventId: z.string() }))
    .query(async ({ input, ctx }) => {
      const id = ctx.env.SEAT_LEDGER.idFromName(input.eventId);
      const stub = ctx.env.SEAT_LEDGER.get(id);

      const available = await stub.getAvailableSeats();
      if (available !== null) {
        return available;
      }

      // If the DO is not initialized, it means NO reservations have ever been made.
      // We can just fetch totalSeats from D1 and return it directly.
      const [event] = await ctx.db.select({ totalSeats: events.totalSeats })
        .from(events)
        .where(eq(events.id, input.eventId));
        
      if (!event) throw new TRPCError({ code: 'NOT_FOUND', message: 'Event not found' });
      
      return event.totalSeats;
    }),

  reserveSeat: workerProcedure
    .input(z.object({ eventId: z.string(), seatCount: z.number().min(1).max(10) }))
    .mutation(async ({ input, ctx }) => {
      const id = ctx.env.SEAT_LEDGER.idFromName(input.eventId);
      const stub = ctx.env.SEAT_LEDGER.get(id);

      const available = await stub.getAvailableSeats();
      if (available === null) {
        const [event] = await ctx.db.select({ totalSeats: events.totalSeats })
          .from(events)
          .where(eq(events.id, input.eventId));
          
        if (!event) throw new TRPCError({ code: 'NOT_FOUND', message: 'Event not found' });
        
        await stub.initialize(event.totalSeats);
      }

      try {
        const result = await stub.reserveSeat(ctx.userId, input.seatCount);
        return result;
      } catch (err: any) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: err.message });
      }
    }),

  ensureAttendee: protectedProcedure.mutation(async ({ ctx }) => {
    const db = ctx.db;
    const [attendee] = await db.select().from(schema.attendees).where(eq(schema.attendees.userId, ctx.userId));
    if (attendee) {
      return attendee;
    }
    
    try {
      const [newAttendee] = await db.insert(schema.attendees).values({
        id: crypto.randomUUID(),
        userId: ctx.userId,
        email: '',
        name: 'Attendee',
      }).returning();
      return newAttendee;
    } catch (err: any) {
      const [existingAttendee] = await db.select().from(schema.attendees).where(eq(schema.attendees.userId, ctx.userId));
      if (existingAttendee) {
        return existingAttendee;
      }
      throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: err.message });
    }
  }),

  confirmBooking: workerProcedure
    .input(z.object({ 
      holdId: z.string().uuid(), 
      eventId: z.string(),
      stripePaymentIntentId: z.string().optional()
    }))
    .mutation(async ({ input, ctx }) => {
      const [attendee] = await ctx.db.select().from(schema.attendees).where(eq(schema.attendees.userId, ctx.userId));
      if (!attendee) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Attendee profile not found. Call ensureAttendee first.' });
      }

      const id = ctx.env.SEAT_LEDGER.idFromName(input.eventId);
      const stub = ctx.env.SEAT_LEDGER.get(id);

      let confirmResult;
      try {
        confirmResult = await stub.confirmSeat(input.holdId);
      } catch (err: any) {
        if (err.message === 'HOLD_NOT_FOUND') throw new TRPCError({ code: 'NOT_FOUND', message: err.message });
        if (err.message === 'HOLD_ALREADY_USED') throw new TRPCError({ code: 'CONFLICT', message: err.message });
        if (err.message === 'HOLD_EXPIRED') throw new TRPCError({ code: 'PRECONDITION_FAILED', message: err.message });
        throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: err.message });
      }

      const [booking] = await ctx.db.insert(schema.bookings).values({
        id: crypto.randomUUID(),
        eventId: input.eventId,
        attendeeId: attendee.id,
        status: 'confirmed',
        seatCount: confirmResult.seatCount,
        holdId: input.holdId,
        stripePaymentIntentId: input.stripePaymentIntentId ?? null,
      }).returning();

      return booking;
    }),

  releaseBooking: workerProcedure
    .input(z.object({ 
      holdId: z.string().uuid(), 
      eventId: z.string() 
    }))
    .mutation(async ({ input, ctx }) => {
      const id = ctx.env.SEAT_LEDGER.idFromName(input.eventId);
      const stub = ctx.env.SEAT_LEDGER.get(id);

      await stub.releaseSeat(input.holdId);

     // Cancel the D1 booking row if it exists
        await ctx.db
        .update(schema.bookings)
        .set({ status: 'cancelled' })
        .where(eq(schema.bookings.holdId, input.holdId));

      return { released: true };
    }),

  createCheckoutSession: workerProcedure
    .input(z.object({
      holdId: z.string().uuid(),
      eventId: z.string(),
      seatCount: z.number().min(1).max(10),
    }))
    .mutation(async ({ input, ctx }) => {
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

      const session = await stripe.checkout.sessions.create({
        mode: 'payment',
        line_items: [
          {
            price_data: {
              currency: 'gbp',
              unit_amount: event.pricePerSeat,
              product_data: {
                name: event.name,
                description: `${input.seatCount} seat(s) for ${event.name}`,
              },
            },
            quantity: input.seatCount,
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

  checkOrgSync: protectedProcedure.query(async ({ ctx }) => {
    if (!ctx.orgId) return false;
    const db = ctx.db;
    const [org] = await db.select().from(schema.organisations).where(eq(schema.organisations.id, ctx.orgId));
    return !!org;
  }),

  createSocketTicket: workerProcedure
    .input(z.object({ eventId: z.string() }))
    .mutation(async ({ input, ctx }) => {
      const stub = ctx.env.SEAT_LEDGER.get(ctx.env.SEAT_LEDGER.idFromName(input.eventId));
      const ticket = await stub.mintTicket(ctx.userId, ctx.orgId ?? null, input.eventId);
      return { ticket };
    }),

  getPublicEvent: publicWorkerProcedure
    .input(z.object({ eventId: z.string() }))
    .query(async ({ input, ctx }) => {
      // Check KV cache first — avoids D1 round-trip on hot event pages
      const cacheKey = `event:${input.eventId}`;
      const cached = await ctx.env.EVENT_CACHE.get(cacheKey);
      if (cached !== null) return JSON.parse(cached) as {
        id: string; name: string; description: string | null; date: number;
        totalSeats: number; pricePerSeat: number; coverImageUrl: string | null;
        organisationId: string;
      };

      // Cache miss — query D1
      const [event] = await ctx.db
        .select({
          id: events.id,
          name: events.name,
          description: events.description,
          date: events.date,
          totalSeats: events.totalSeats,
          pricePerSeat: events.pricePerSeat,
          coverImageUrl: events.coverImageUrl,
          organisationId: events.organisationId,
        })
        .from(events)
        .where(eq(events.id, input.eventId));

      if (!event) throw new TRPCError({ code: 'NOT_FOUND', message: 'Event not found' });

      const payload = {
        id: event.id,
        name: event.name,
        description: event.description,
       date: event.date instanceof Date ? event.date.getTime() : Number(event.date), // ← force to ms timestamp
        totalSeats: event.totalSeats,
        pricePerSeat: event.pricePerSeat,
        coverImageUrl: event.coverImageUrl,
        organisationId: event.organisationId,
        // NOTE: seat count is deliberately excluded from this cached payload.
        // Available seats change frequently; they are fetched separately via
        // getAvailableSeats which reads live from the SeatLedger DO.
      };

      // Cache for 5 minutes
      await ctx.env.EVENT_CACHE.put(cacheKey, JSON.stringify(payload), {
        expirationTtl: 300,
      });

      return payload;
    }),

  invalidateEventCache: workerProcedure
    .input(z.object({ eventId: z.string() }))
    .mutation(async ({ input, ctx }) => {
      await ctx.env.EVENT_CACHE.delete(`event:${input.eventId}`);
      return { invalidated: true };
    }),
});

export type AppRouter = typeof appRouter;
