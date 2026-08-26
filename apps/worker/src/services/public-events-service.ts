import { eq, and, gte, asc } from 'drizzle-orm';
import type { DrizzleD1Database } from 'drizzle-orm/d1';
import * as schema from '@event-booking/shared';
import { events } from '@event-booking/shared';
import type { Env } from '../index.js';

export interface PaginationParams {
  limit?: number;
  offset?: number;
}

export interface PublicEventListItem {
  id: string;
  name: string;
  date: number;
  totalSeats: number;
  pricePerSeat: number;
  coverImageUrl: string | null;
}

export interface PublicEventListResponse {
  events: PublicEventListItem[];
  pagination: {
    limit: number;
    offset: number;
    hasMore: boolean;
  };
}

export interface PublicEventDetailItem {
  id: string;
  name: string;
  description: string | null;
  date: number;
  totalSeats: number;
  availableSeats: number;
  pricePerSeat: number;
  coverImageUrl: string | null;
  organisationId: string;
}

/**
 * Queries future events for a specific organisation with bounded pagination.
 * Excludes live seat count DO lookups to avoid N+1 DO calls.
 */
export async function listOrgPublicEvents(
  db: DrizzleD1Database<typeof schema>,
  orgId: string,
  params: PaginationParams = {},
): Promise<PublicEventListResponse> {
  // Normalize & clamp pagination parameters
  let limit = params.limit !== undefined && !isNaN(params.limit) ? Math.floor(params.limit) : 50;
  if (limit < 1) limit = 50;
  if (limit > 100) limit = 100; // Clamp max 100

  let offset = params.offset !== undefined && !isNaN(params.offset) ? Math.floor(params.offset) : 0;
  if (offset < 0) offset = 0;

  const now = new Date();

  // Fetch limit + 1 items to determine hasMore without a separate COUNT query
  const rows = await db
    .select({
      id: events.id,
      name: events.name,
      date: events.date,
      totalSeats: events.totalSeats,
      pricePerSeat: events.pricePerSeat,
      coverImageUrl: events.coverImageUrl,
    })
    .from(events)
    .where(
      and(
        eq(events.organisationId, orgId),
        gte(events.date, now),
      ),
    )
    .orderBy(asc(events.date))
    .limit(limit + 1)
    .offset(offset);

  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;

  return {
    events: items.map((e) => ({
      id: e.id,
      name: e.name,
      date: e.date instanceof Date ? e.date.getTime() : Number(e.date),
      totalSeats: e.totalSeats,
      pricePerSeat: e.pricePerSeat,
      coverImageUrl: e.coverImageUrl,
    })),
    pagination: {
      limit,
      offset,
      hasMore,
    },
  };
}

/**
 * Queries a single event belonging to the authenticated organisation (including past events)
 * and composes live seat availability from the event's SeatLedger Durable Object.
 * Returns null if the event does not exist or belongs to another organisation.
 */
export async function getOrgPublicEvent(
  db: DrizzleD1Database<typeof schema>,
  env: Env,
  orgId: string,
  eventId: string,
): Promise<PublicEventDetailItem | null> {
  const [event] = await db
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
    .where(
      and(
        eq(events.id, eventId),
        eq(events.organisationId, orgId),
      ),
    );

  if (!event) {
    return null;
  }

  // Live available seat count from SeatLedger Durable Object
  const stub = env.SEAT_LEDGER.get(env.SEAT_LEDGER.idFromName(event.id));
  const available = await stub.getAvailableSeats();
  const availableSeats = available !== null ? available : event.totalSeats;

  return {
    id: event.id,
    name: event.name,
    description: event.description,
    date: event.date instanceof Date ? event.date.getTime() : Number(event.date),
    totalSeats: event.totalSeats,
    availableSeats,
    pricePerSeat: event.pricePerSeat,
    coverImageUrl: event.coverImageUrl,
    organisationId: event.organisationId,
  };
}
