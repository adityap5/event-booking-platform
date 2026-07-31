import { DurableObject } from "cloudflare:workers";

/**
 * SeatLedger — Durable Object for per-event seat reservation.
 *
 * Each instance tracks seat holds and confirmed bookings for a single event,
 * providing strong consistency guarantees within a single coordination point.
 *
 * TODO: Implement actual seat reservation logic.
 */
export class SeatLedger extends DurableObject {
  async fetch(_request: Request): Promise<Response> {
    return new Response("SeatLedger OK", { status: 200 });
  }
}
