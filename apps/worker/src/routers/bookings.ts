import { protectedProcedure, enforceOrganiserAccess } from '@event-booking/trpc';
import { z } from 'zod';
import * as schema from '@event-booking/shared';
import { events } from '@event-booking/shared';
import { eq, and, asc } from 'drizzle-orm';
import { createClerkClient } from '@clerk/backend';
import { TRPCError } from '@trpc/server';
import { workerProcedure } from '../procedures.js';

export const bookingsRouter = {
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

  reserveSeat: workerProcedure
    .input(
      z.object({
        eventId: z.string(),
        // Without .int(), a client can request a fractional seat count (e.g. 1.5).
        // The SeatLedger Durable Object stores seatCount directly into SQLite and later runs
        // SUM(seat_count) across all reservations to compute available seats — a fractional value
        // corrupts that arithmetic, which is the exact invariant the DO's concurrency guarantee
        // depends on. totalSeats in createEvent (same codebase, events.ts) already correctly
        // uses .int() — this brings seatCount in line with that existing pattern, it isn't a new convention.
        seatCount: z.number().int().min(1).max(10),
      })
    )
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
      } catch (err: unknown) {
  const message = err instanceof Error ? err.message : '';

  if (message === 'TOO_MANY_PENDING_HOLDS') {
    throw new TRPCError({
      code: 'CONFLICT',
      message: 'TOO_MANY_PENDING_HOLDS',
    });
  }

  console.error('[reserveSeat] Unexpected error', err);

  throw new TRPCError({
    code: 'INTERNAL_SERVER_ERROR',
    message: 'Unable to reserve seats',
    cause: err,
  });
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
      // Log detail server-side, return generic message — the error formatter only strips
      // stack traces, not message content, so raw exception text must never be passed through directly.
      console.error('[ensureAttendee] Failed to create attendee record:', err);
      throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'Failed to create attendee profile' });
    }
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
};
