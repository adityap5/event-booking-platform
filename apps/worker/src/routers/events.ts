import { protectedProcedure } from '@event-booking/trpc';
import { authorizeOrganiserAccess, requireActiveOrganisation, requireOrganiserRole } from '@event-booking/permissions';
import { z } from 'zod';
import * as schema from '@event-booking/shared';
import { events } from '@event-booking/shared';
import { eq, gte, asc } from 'drizzle-orm';
import { TRPCError } from '@trpc/server';
import { workerProcedure, publicWorkerProcedure } from '../procedures.js';
import * as Sentry from '@sentry/cloudflare';
import { logStructured } from '../logger.js';

export function getPublicEventCacheKey(eventId: string): string {
  return `event:${eventId}`;
}

export function getPublicEventsCacheKey(): string {
  return 'events:public';
}

async function safeInvalidateCache(
  env: { EVENT_CACHE: { delete: (key: string) => Promise<void> } },
  ...keys: string[]
): Promise<void> {
  for (const key of keys) {
    try {
      await env.EVENT_CACHE.delete(key);
    } catch (err) {
      console.error(`[EVENT_CACHE] Failed to delete cache key "${key}":`, err);
      Sentry.captureException(err, {
        extra: { cacheKey: key, action: 'cache_invalidation_failure' },
      });
    }
  }
}

export const eventsRouter = {
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

  getPublicEvent: publicWorkerProcedure
    .input(z.object({ eventId: z.string() }))
    .query(async ({ input, ctx }) => {
      // Check KV cache first — avoids D1 round-trip on hot event pages
      const cacheKey = getPublicEventCacheKey(input.eventId);
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

  listOrgEvents: protectedProcedure.query(async ({ ctx }) => {
    const orgId = requireActiveOrganisation(ctx);

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
      .where(eq(events.organisationId, orgId));

    return rows.map((event) => ({
      ...event,
      date: event.date instanceof Date ? event.date.getTime() : Number(event.date),
    }));
  }),

  listPublicEvents: publicWorkerProcedure.query(async ({ ctx }) => {
    const cacheKey = getPublicEventsCacheKey();
    const cached = await ctx.env.EVENT_CACHE.get(cacheKey);
    if (cached !== null) {
      return JSON.parse(cached) as Array<{
        id: string;
        name: string;
        date: number;
        totalSeats: number;
        pricePerSeat: number;
        coverImageUrl: string | null;
      }>;
    }

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

    const payload = rows.map((event) => ({
      ...event,
      date: event.date instanceof Date ? event.date.getTime() : Number(event.date),
    }));

    await ctx.env.EVENT_CACHE.put(cacheKey, JSON.stringify(payload), {
      expirationTtl: 300,
    });

    return payload;
  }),

  createEvent: workerProcedure
    .input(z.object({
      name: z.string().min(1).max(200),
      description: z.string().max(2000).optional(),
      date: z.number()
        .int()
        .finite()
        .refine((value) => value > Date.now() && Number.isFinite(new Date(value).getTime()), {
          message: 'Event date must be in the future',
        }),
      totalSeats: z.number().int().min(1).max(100000),
      // Sanity bound (£100,000.00 stored in cents/pence), not a business rule set in stone.
      pricePerSeat: z.number().int().min(0).max(100_000_00),
      tempImageKey: z.string().optional(),
    }))
    .mutation(async ({ input, ctx }) => {
      // Event creation is restricted to organisers — today this is unreachable (no invite-member feature exists yet, every org has exactly one member), but closing it now avoids it becoming a real gap the moment that feature ships.
      const orgId = requireOrganiserRole(ctx, 'organiser');

      const rateLimiter = ctx.env.RATE_LIMITER.get(ctx.env.RATE_LIMITER.idFromName(orgId));
      const { allowed } = await rateLimiter.checkLimit('createEvent', 5, 60 * 60_000);
      if (!allowed) {
        logStructured({
          category: 'rate_limit_rejection',
          action: 'createEvent',
          userId: ctx.userId,
          orgId,
        });
        throw new TRPCError({
          code: 'TOO_MANY_REQUESTS',
          message: 'Too many events created recently. Try again later.',
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

              coverImageUrl = `${ctx.env.WORKER_URL}/images/events/${eventId}/cover.${ext}`;
            }
          } catch (err) {
            // R2 error must not block event creation — log and continue with no image
            console.error('[createEvent] R2 image finalize failed, creating event without cover:', err);
            Sentry.captureException(err, {
              extra: {
                eventId,
                tempImageKey: input.tempImageKey,
              },
            });
          }
        }
      }

      const [created] = await ctx.db.insert(schema.events).values({
        id: eventId,
        organisationId: orgId, // always from verified JWT, never from input
        name: input.name,
        description: input.description ?? null,
        date: new Date(input.date), // mode:'timestamp' — Drizzle expects a Date object
        totalSeats: input.totalSeats,
        pricePerSeat: input.pricePerSeat,
        coverImageUrl,
      }).returning({ id: schema.events.id, name: schema.events.name });

      // Invalidate public event list cache after successful D1 insert
      await safeInvalidateCache(ctx.env, getPublicEventsCacheKey());

      return created;
    }),

  updateEvent: workerProcedure
    .input(z.object({
      eventId: z.string().min(1),
      name: z.string().min(1).max(200),
      description: z.string().max(2000).nullable(),
    }))
    .mutation(async ({ input, ctx }) => {
      requireOrganiserRole(ctx, 'organiser');

      const [existingEvent] = await ctx.db
        .select({
          id: events.id,
          organisationId: events.organisationId,
        })
        .from(events)
        .where(eq(events.id, input.eventId));

      if (!existingEvent) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Event not found' });
      }

      authorizeOrganiserAccess(ctx, existingEvent.organisationId);

      const [updated] = await ctx.db
        .update(events)
        .set({
          name: input.name,
          description: input.description,
        })
        .where(eq(events.id, input.eventId))
        .returning({ id: events.id, name: events.name });

      if (!updated) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Event not found' });
      }

      // Invalidate both event-specific and public list caches after D1 update succeeds
      await safeInvalidateCache(
        ctx.env,
        getPublicEventCacheKey(input.eventId),
        getPublicEventsCacheKey(),
      );

      return updated;
    }),
};

