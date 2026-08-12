import { router, protectedProcedure, publicProcedure, enforceOrganiserAccess } from '@event-booking/trpc';
import { z } from 'zod';
import * as schema from '@event-booking/shared';
import { events } from '@event-booking/shared';
import { eq, gte, asc, and } from 'drizzle-orm';
import Stripe from 'stripe';
import { createClerkClient } from '@clerk/backend';

import { TRPCError } from '@trpc/server';
import type { R2Bucket } from '@cloudflare/workers-types';

interface WorkerEnv {
  CLERK_SECRET_KEY: string;
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
  EVENT_CACHE: {
    get: (key: string) => Promise<string | null>;
    put: (key: string, value: string, opts?: { expirationTtl?: number }) => Promise<void>;
    delete: (key: string) => Promise<void>;
  };
  RATE_LIMITER: {
    idFromName: (name: string) => any;
    get: (id: any) => {
      checkLimit: (action: string, limit: number, windowMs: number) => Promise<{ allowed: boolean; remaining: number }>;
    };
  };
  EVENT_COVERS: R2Bucket;
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

  getEventAttendees: protectedProcedure
    .input(z.object({ eventId: z.string() }))
    .use(enforceOrganiserAccess<{ eventId: string }>(async ({ input, ctx }) => {
      const db = ctx.db; 
      const [event] = await db.select().from(events).where(eq(events.id, input.eventId));
      return event?.organisationId || null;
    }))
    .query(async ({ input, ctx }) => {
      const rows = await ctx.db
        .select({
          id: schema.bookings.id,
          seatCount: schema.bookings.seatCount,
          attendeeName: schema.attendees.name,
          attendeeEmail: schema.attendees.email,
        })
        .from(schema.bookings)
        .innerJoin(schema.attendees, eq(schema.bookings.attendeeId, schema.attendees.id))
        .where(
          and(
            eq(schema.bookings.eventId, input.eventId),
            eq(schema.bookings.status, 'confirmed'),
          )
        )
        .orderBy(asc(schema.bookings.createdAt));

      return rows;
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
      // Rate limit: 10 reservation attempts per userId per 60 seconds
      const rateLimiter = ctx.env.RATE_LIMITER.get(ctx.env.RATE_LIMITER.idFromName(ctx.userId));
      const { allowed } = await rateLimiter.checkLimit('reserveSeat', 10, 60_000);
      if (!allowed) {
        throw new TRPCError({
          code: 'TOO_MANY_REQUESTS',
          message: 'Too many reservation attempts. Try again in a minute.',
        });
      }

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

  ensureAttendee: workerProcedure.mutation(async ({ ctx }) => {
    const db = ctx.db;
    const [attendee] = await db.select().from(schema.attendees).where(eq(schema.attendees.userId, ctx.userId));
    if (attendee) {
      return attendee;
    }
    
    let resolvedEmail = '';
    let resolvedName = 'Attendee';
    try {
      const clerk = createClerkClient({ secretKey: ctx.env.CLERK_SECRET_KEY });
      const user = await clerk.users.getUser(ctx.userId);
      const primaryEmail = user.emailAddresses.find(e => e.id === user.primaryEmailAddressId);
      resolvedEmail = primaryEmail?.emailAddress || user.emailAddresses[0]?.emailAddress || '';
      const fullName = `${user.firstName ?? ''} ${user.lastName ?? ''}`.trim();
      resolvedName = fullName || resolvedEmail || 'Attendee';
    } catch (err) {
      console.error('Failed to fetch user from Clerk:', err);
    }

    try {
      const [newAttendee] = await db.insert(schema.attendees).values({
        id: crypto.randomUUID(),
        userId: ctx.userId,
        email: resolvedEmail,
        name: resolvedName,
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

      let confirmResult: { userId: string; seatCount: number };
try {
        confirmResult = await stub.confirmSeat(input.holdId);
      } catch (err: any) {
        if (err.message === 'HOLD_NOT_FOUND') throw new TRPCError({ code: 'NOT_FOUND', message: err.message });
  if (err.message === 'HOLD_ALREADY_USED') throw new TRPCError({ code: 'CONFLICT', message: err.message });
  if (err.message === 'HOLD_EXPIRED') throw new TRPCError({ code: 'PRECONDITION_FAILED', message: err.message });
  throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: err.message });
      }
      // Security: verify the caller owns this hold — OUTSIDE the try block
if (confirmResult.userId !== ctx.userId) {
  throw new TRPCError({ code: 'FORBIDDEN', message: 'This hold does not belong to you.' });
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

      const available = await stub.getAvailableSeats();
      if (available === null) {
        const [event] = await ctx.db.select({ totalSeats: events.totalSeats })
          .from(events)
          .where(eq(events.id, input.eventId));
          
        if (!event) throw new TRPCError({ code: 'NOT_FOUND', message: 'Event not found' });
        
        await stub.initialize(event.totalSeats);
      }

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

  listOrgEvents: protectedProcedure.query(async ({ ctx }) => {
    if (!ctx.orgId) {
      throw new TRPCError({ code: 'FORBIDDEN', message: 'No active organisation.' });
    }

    const rows = await ctx.db
      .select({
        id: events.id,
        name: events.name,
        date: events.date,
        totalSeats: events.totalSeats,
        pricePerSeat: events.pricePerSeat,
        coverImageUrl: events.coverImageUrl,
      })
      .from(events)
      .where(eq(events.organisationId, ctx.orgId));

    return rows.map((event) => ({
      ...event,
      date: event.date instanceof Date ? event.date.getTime() : Number(event.date),
    }));
  }),

  listPublicEvents: publicWorkerProcedure.query(async ({ ctx }) => {
    const now = new Date(Date.now());

    const rows = await ctx.db
      .select({
        id: events.id,
        name: events.name,
        date: events.date,
        totalSeats: events.totalSeats,
        pricePerSeat: events.pricePerSeat,
        coverImageUrl: events.coverImageUrl,
      })
      .from(events)
      .where(gte(events.date, now))
      .orderBy(asc(events.date));

    return rows.map((event) => ({
      ...event,
      date: event.date instanceof Date ? event.date.getTime() : Number(event.date),
    }));
  }),

  listMyBookings: protectedProcedure.query(async ({ ctx }) => {
    // Attendee row may not exist if the user has never booked — return empty array
    const [attendee] = await ctx.db
      .select()
      .from(schema.attendees)
      .where(eq(schema.attendees.userId, ctx.userId));
    if (!attendee) return [];

    const rows = await ctx.db
      .select({
        id: schema.bookings.id,
        seatCount: schema.bookings.seatCount,
        eventId: events.id,
        eventName: events.name,
        eventDate: events.date,
        eventCoverImageUrl: events.coverImageUrl,
      })
      .from(schema.bookings)
      .innerJoin(events, eq(schema.bookings.eventId, events.id))
      .where(
        and(
          eq(schema.bookings.attendeeId, attendee.id),
          eq(schema.bookings.status, 'confirmed'),
        )
      )
      .orderBy(asc(events.date));

    return rows.map((row) => ({
      ...row,
      eventDate: row.eventDate instanceof Date ? row.eventDate.getTime() : Number(row.eventDate),
    }));
  }),

  createEvent: workerProcedure
    .input(z.object({
      name: z.string().min(1).max(200),
      description: z.string().max(2000).optional(),
      date: z.number(),
      totalSeats: z.number().int().min(1).max(100000),
      pricePerSeat: z.number().int().min(0),
      tempImageKey: z.string().optional(),
    }))
    .mutation(async ({ input, ctx }) => {
      if (!ctx.orgId) {
        throw new TRPCError({
          code: 'FORBIDDEN',
          message: 'Only organisers with an active organisation can create events.',
        });
      }

      const eventId = crypto.randomUUID();

      // Finalize the temp cover image, if one was provided
      let coverImageUrl: string | null = null;
      if (input.tempImageKey) {
        const expectedPrefix = `uploads/tmp/${ctx.userId}/`;
        if (!input.tempImageKey.startsWith(expectedPrefix)) {
          // Malformed / tampered key — silently ignore, proceed with no image
          console.error('[createEvent] tempImageKey prefix mismatch, ignoring:', input.tempImageKey);
        } else {
          try {
            const tempObject = await ctx.env.EVENT_COVERS.get(input.tempImageKey);
            if (tempObject === null) {
              // Object expired or already cleaned up — proceed with no image
              console.error('[createEvent] tempImageKey not found in R2, proceeding without image:', input.tempImageKey);
            } else {
              // Derive extension from the temp key (ends in .jpg / .png / .webp)
              const ext = input.tempImageKey.split('.').pop() ?? 'jpg';
              const finalKey = `events/${eventId}/cover.${ext}`;

              // R2 has no copy() — get body, put at final key, then delete temp
              await ctx.env.EVENT_COVERS.put(finalKey, tempObject.body, {
                httpMetadata: { contentType: tempObject.httpMetadata?.contentType },
              });
              await ctx.env.EVENT_COVERS.delete(input.tempImageKey);

              coverImageUrl = `https://event-booking-worker.aditya29.workers.dev/images/events/${eventId}/cover.${ext}`;
            }
          } catch (err) {
            // R2 error must not block event creation — log and continue with no image
            console.error('[createEvent] R2 image finalize failed, creating event without cover:', err);
          }
        }
      }

      const [created] = await ctx.db.insert(schema.events).values({
        id: eventId,
        organisationId: ctx.orgId, // always from verified JWT, never from input
        name: input.name,
        description: input.description ?? null,
        date: new Date(input.date), // mode:'timestamp' — Drizzle expects a Date object
        totalSeats: input.totalSeats,
        pricePerSeat: input.pricePerSeat,
        coverImageUrl,
      }).returning({ id: schema.events.id, name: schema.events.name });

      return created;
    }),
});

export type AppRouter = typeof appRouter;
