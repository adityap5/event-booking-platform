import { DurableObject } from "cloudflare:workers";
import type { Env } from "./index.js";

/**
 * SeatLedger — Durable Object for per-event seat reservation.
 *
 * Each instance tracks seat holds and confirmed bookings for a single event,
 * providing strong consistency guarantees within a single coordination point.
 */
export class SeatLedger extends DurableObject {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    
    // Created once when the isolate spins up
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS event_state (
        id INTEGER PRIMARY KEY,
        total_seats INTEGER NOT NULL,
        initialized INTEGER NOT NULL
      );
    `);
    
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS reservations (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        seat_count INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        status TEXT NOT NULL
      );
    `);
  }

  initialize(totalSeats: number) {
    const rows = this.ctx.storage.sql.exec("SELECT initialized FROM event_state WHERE id = 1").toArray();
    if (rows.length > 0 && rows[0]!.initialized === 1) {
      return; // Safe no-op, already initialized
    }
    
    this.ctx.storage.sql.exec(
      "INSERT INTO event_state (id, total_seats, initialized) VALUES (1, ?, 1) ON CONFLICT(id) DO NOTHING",
      totalSeats
    );
  }

  getAvailableSeats() {
    const state = this.ctx.storage.sql.exec("SELECT total_seats, initialized FROM event_state WHERE id = 1").toArray();
    if (state.length === 0 || state[0]!.initialized !== 1) {
      return null; // Signals to the worker that it needs to fetch from D1 and initialize
    }
    const totalSeats = state[0]!.total_seats as number;

    const used = this.ctx.storage.sql.exec("SELECT SUM(seat_count) as used_seats FROM reservations WHERE status = 'pending' OR status = 'confirmed'").toArray();
    const usedSeats = (used[0]!.used_seats as number) || 0;

    return totalSeats - usedSeats;
  }

  async reserveSeat(userId: string, seatCount: number) {
    if (seatCount <= 0 || seatCount > 10) {
      throw new Error("Invalid seat count. Must be between 1 and 10.");
    }

    // =========================================================================
    // START SYNCHRONOUS BLOCK
    // =========================================================================
    const state = this.ctx.storage.sql.exec("SELECT total_seats FROM event_state WHERE id = 1").toArray();
    if (state.length === 0) {
      throw new Error("Event not initialized");
    }
    const totalSeats = state[0]!.total_seats as number;

    const used = this.ctx.storage.sql.exec("SELECT SUM(seat_count) as used_seats FROM reservations WHERE status = 'pending' OR status = 'confirmed'").toArray();
    const usedSeats = (used[0]!.used_seats as number) || 0;

    const available = totalSeats - usedSeats;

    if (available < seatCount) {
      throw new Error(`Only ${available} seats available`);
    }

    const reservationId = crypto.randomUUID();
    const expiresAt = Date.now() + 15 * 60 * 1000; // 15-minute hold

    this.ctx.storage.sql.exec(
      "INSERT INTO reservations (id, user_id, seat_count, expires_at, status) VALUES (?, ?, ?, ?, 'pending')",
      reservationId, userId, seatCount, expiresAt
    );
    // =========================================================================
    // END SYNCHRONOUS BLOCK
    // =========================================================================

    const currentAlarm = await this.ctx.storage.getAlarm();
    if (currentAlarm === null || expiresAt < currentAlarm) {
      await this.ctx.storage.setAlarm(expiresAt);
    }

    return { reservationId, expiresAt };
  }

  async confirmSeat(holdId: string): Promise<{ userId: string; seatCount: number }> {
    const holds = this.ctx.storage.sql.exec("SELECT user_id, seat_count, status, expires_at FROM reservations WHERE id = ?", holdId).toArray();
    if (holds.length === 0) {
      throw new Error('HOLD_NOT_FOUND');
    }
    
    const hold = holds[0]!;
    if (hold.status !== 'pending') {
      throw new Error('HOLD_ALREADY_USED');
    }
    
    if ((hold.expires_at as number) < Date.now()) {
      throw new Error('HOLD_EXPIRED');
    }
    
    this.ctx.storage.sql.exec("UPDATE reservations SET status = 'confirmed' WHERE id = ?", holdId);
    
    return {
      userId: hold.user_id as string,
      seatCount: hold.seat_count as number,
      // Note: eventId is omitted here as it's not stored in the DO (DO is already 1:1 with an event)
    };
  }

  async releaseSeat(holdId: string): Promise<void> {
    const holds = this.ctx.storage.sql.exec("SELECT status, seat_count FROM reservations WHERE id = ?", holdId).toArray();
    if (holds.length === 0) return; // Silent return if not found (idempotent)
    
    const status = holds[0]!.status;
    if (status === 'confirmed') return; // Cannot release a confirmed booking
    if (status === 'released') return;  // Already released — idempotent no-op
    
    if (status === 'pending') {
      // By changing status to 'released', it automatically stops counting towards used_seats 
      // in our dynamic SUM() queries for getAvailableSeats and reserveSeat.
      // This achieves the identical idempotent availability increment you requested.
      this.ctx.storage.sql.exec("UPDATE reservations SET status = 'released' WHERE id = ?", holdId);
    }
  }

  async alarm() {
    const now = Date.now();
    
    const expired = this.ctx.storage.sql.exec("SELECT id FROM reservations WHERE status = 'pending' AND expires_at <= ?", now).toArray();
    for (const row of expired) {
      await this.releaseSeat(row.id as string);
    }

    // Find the next upcoming expiration
    const next = this.ctx.storage.sql.exec("SELECT MIN(expires_at) as next_expiry FROM reservations WHERE status = 'pending'").toArray();
    const nextExpiry = (next.length > 0 ? next[0]!.next_expiry : null) as number | null;

    if (nextExpiry) {
      await this.ctx.storage.setAlarm(nextExpiry);
    }
  }
}