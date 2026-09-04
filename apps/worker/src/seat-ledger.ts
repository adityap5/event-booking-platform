import { DurableObject } from "cloudflare:workers";
import type { Env } from "./index.js";
import { z } from 'zod';
import * as Sentry from '@sentry/cloudflare';

const socketMessageSchema = z.object({
  type: z.enum(['ping']),
});

class SeatLedgerBase extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    
    // Created once when the isolate spins up
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS event_state (
        id INTEGER PRIMARY KEY,
        total_seats INTEGER NOT NULL,
        initialized INTEGER NOT NULL,
        pruned_seats INTEGER NOT NULL DEFAULT 0
      );
    `);

    try {
      this.ctx.storage.sql.exec("ALTER TABLE event_state ADD COLUMN pruned_seats INTEGER NOT NULL DEFAULT 0");
    } catch {
      // Column already exists
    }
    
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS reservations (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        seat_count INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        status TEXT NOT NULL
      );
    `);

    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS socket_tickets (
        ticket TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        org_id TEXT,
        event_id TEXT NOT NULL,
        expires_at INTEGER NOT NULL
      );
    `);
  }

  private logEvent(event: {
    type: 'RESERVED' | 'CONFIRMED' | 'RELEASED' | 'REFUNDED' | 'EXPIRED' | 'ALREADY_USED' | 'NOT_FOUND' | 'SOLD_OUT' | 'TOO_MANY_PENDING_HOLDS'
    holdId?: string
    eventId?: string
    userId?: string
    seatCount?: number
    availableSeats?: number
    reason?: string
  }): void {
    try {
      console.log({ ts: Date.now(), ...event });
    } catch {
      // Never crash the DO due to logging failure
    }
  }

  initialize(totalSeats: number) {
    const rows = this.ctx.storage.sql.exec("SELECT initialized FROM event_state WHERE id = 1").toArray();
    if (rows.length > 0 && rows[0]!.initialized === 1) {
      return; // Safe no-op, already initialized
    }
    
    this.ctx.storage.sql.exec(
      "INSERT INTO event_state (id, total_seats, initialized, pruned_seats) VALUES (1, ?, 1, 0) ON CONFLICT(id) DO NOTHING",
      totalSeats
    );
  }

  getAvailableSeats() {
    const state = this.ctx.storage.sql.exec("SELECT total_seats, initialized, COALESCE(pruned_seats, 0) as pruned_seats FROM event_state WHERE id = 1").toArray();
    if (state.length === 0 || state[0]!.initialized !== 1) {
      return null; // Signals to the worker that it needs to fetch from D1 and initialize
    }
    const totalSeats = state[0]!.total_seats as number;
    const prunedSeats = (state[0]!.pruned_seats as number) || 0;

    const used = this.ctx.storage.sql.exec("SELECT SUM(seat_count) as used_seats FROM reservations WHERE status = 'pending' OR status = 'confirmed'").toArray();
    const usedSeats = ((used[0]!.used_seats as number) || 0) + prunedSeats;

    return totalSeats - usedSeats;
  }

  async reserveSeat(userId: string, seatCount: number) {
    if (seatCount <= 0 || seatCount > 10) {
      throw new Error("Invalid seat count. Must be between 1 and 10.");
    }

    // =========================================================================
    // START SYNCHRONOUS BLOCK
    // =========================================================================
    const state = this.ctx.storage.sql.exec("SELECT total_seats, COALESCE(pruned_seats, 0) as pruned_seats FROM event_state WHERE id = 1").toArray();
    if (state.length === 0) {
      throw new Error("Event not initialized");
    }

    // caps concurrent pending holds per user to prevent a single user from holding an unbounded number of seats across repeated reserveSeat calls without ever paying
    // expires_at > ? excludes rows that have expired but not yet been swept by
    // the DO alarm's cleanup pass — an expired pending hold must not count
    // against the user's active-hold limit while it's waiting to be released.
    const pendingHolds = this.ctx.storage.sql.exec(
      "SELECT COUNT(*) as count FROM reservations WHERE user_id = ? AND status = 'pending' AND expires_at > ?",
      userId,
      Date.now()
    ).toArray();
    const pendingCount = (pendingHolds[0]!.count as number) || 0;
    // Reject-on-duplicate, not auto-replace: chosen for simplicity and
    // predictability over a friendlier "release their old hold and retry"
    // flow. Known trade-off: there is currently no user-facing way to
    // release a held reservation early (see CRITICAL_FINDINGS.md #5), so a
    // user who wants to change their seat count must wait out the 15-minute
    // expiry.
    if (pendingCount >= 1) {
      this.logEvent({ type: 'TOO_MANY_PENDING_HOLDS', userId, reason: 'Pending hold limit reached' });
      throw new Error("TOO_MANY_PENDING_HOLDS");
    }

    const totalSeats = state[0]!.total_seats as number;
    const prunedSeats = (state[0]!.pruned_seats as number) || 0;

    const used = this.ctx.storage.sql.exec("SELECT SUM(seat_count) as used_seats FROM reservations WHERE status = 'pending' OR status = 'confirmed'").toArray();
    const usedSeats = ((used[0]!.used_seats as number) || 0) + prunedSeats;

    const available = totalSeats - usedSeats;

    if (available < seatCount) {
      this.logEvent({ type: 'SOLD_OUT', holdId: '', reason: `Only ${available} seats available` });
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

    this.logEvent({ type: 'RESERVED', holdId: reservationId, userId, seatCount, availableSeats: available - seatCount });
    this.broadcastSeatCount();

    const currentAlarm = await this.ctx.storage.getAlarm();
    if (currentAlarm === null || expiresAt < currentAlarm) {
      await this.ctx.storage.setAlarm(expiresAt);
    }

    return { reservationId, expiresAt };
  }

  async getHold(holdId: string): Promise<{ userId: string; seatCount: number; status: string; expiresAt: number } | null> {
    const holds = this.ctx.storage.sql.exec("SELECT user_id, seat_count, status, expires_at FROM reservations WHERE id = ?", holdId).toArray();
    if (holds.length === 0) {
      return null;
    }

    const hold = holds[0]!;
    return {
      userId: hold.user_id as string,
      seatCount: hold.seat_count as number,
      status: hold.status as string,
      expiresAt: hold.expires_at as number,
    };
  }

  async listConfirmedHolds(since?: number): Promise<{ id: string; userId: string; seatCount: number; expiresAt: number }[]> {
    // Default cutoff to 7 days (168 hours) ago.
    // Derived from the 15-minute hold lifecycle: orphaned holds are confirmed and become eligible for reconciliation
    // within 15 minutes of reservation, swept every 5 minutes by the reconciliation cron (2,016 sweeps in 7 days).
    // Bounding to 7 days prevents unbounded memory/CPU growth on long-running events while ensuring zero unreconciled
    // holds are missed.
    const cutoff = since ?? (Date.now() - 7 * 24 * 60 * 60 * 1000);
    const rows = this.ctx.storage.sql.exec(
      "SELECT id, user_id, seat_count, expires_at FROM reservations WHERE status = 'confirmed' AND expires_at > ?",
      cutoff
    ).toArray();
    return rows.map((row) => ({
      id: row.id as string,
      userId: row.user_id as string,
      seatCount: row.seat_count as number,
      expiresAt: row.expires_at as number,
    }));
  }


  async confirmSeat(holdId: string): Promise<{ userId: string; seatCount: number }> {
    const holds = this.ctx.storage.sql.exec("SELECT user_id, seat_count, status, expires_at FROM reservations WHERE id = ?", holdId).toArray();
    if (holds.length === 0) {
      this.logEvent({ type: 'NOT_FOUND', holdId, reason: 'HOLD_NOT_FOUND' });
      throw new Error('HOLD_NOT_FOUND');
    }
    
    const hold = holds[0]!;
    if (hold.status !== 'pending') {
      this.logEvent({ type: 'ALREADY_USED', holdId, reason: 'HOLD_ALREADY_USED' });
      throw new Error('HOLD_ALREADY_USED');
    }
    
    if ((hold.expires_at as number) < Date.now()) {
      this.logEvent({ type: 'EXPIRED', holdId, reason: 'HOLD_EXPIRED' });
      throw new Error('HOLD_EXPIRED');
    }
    
    this.ctx.storage.sql.exec("UPDATE reservations SET status = 'confirmed' WHERE id = ?", holdId);
    this.logEvent({ type: 'CONFIRMED', holdId, userId: hold.user_id as string, seatCount: hold.seat_count as number });

    this.broadcastSeatCount();

    // Schedule pruning alarm for 7 days past hold expiry if no alarm is scheduled or if pruneAt is earlier
    const pruneAt = (hold.expires_at as number) + 7 * 24 * 60 * 60 * 1000;
    const currentAlarm = await this.ctx.storage.getAlarm();
    if (currentAlarm === null || pruneAt < currentAlarm) {
      await this.ctx.storage.setAlarm(pruneAt);
    }

    return {
      userId: hold.user_id as string,
      seatCount: hold.seat_count as number,
      // Note: eventId is omitted here as it's not stored in the DO (DO is already 1:1 with an event)
    };
  }
  /**
   * =========================================================================
   * STATE MACHINE INVARIANT — REFUND FLOW
   * =========================================================================
   * - 'pending' and 'confirmed' reservations consume seats (count toward usedSeats).
   * - 'released' and 'refunded' reservations do not.
   * - Refunding a 'confirmed' reservation returns its entire seatCount to availability —
   *   not partially, and not via any separate counter adjustment; purely by the status
   *   transition dropping out of the getAvailableSeats() sum, exactly as 'released'
   *   already does for expired pending holds.
   * - A 'refunded' reservation must never be reachable via any code path that treats it
   *   as still-pending or as an unconfirmed sale.
   * - The 'pending → confirmed → refunded' lifecycle and the 'pending → released'
   *   lifecycle are separate paths that must never cross:
   *     - refundSeat() only ever transitions 'confirmed' → 'refunded'.
   *     - releaseSeat() / alarm() only ever transition 'pending' → 'released'.
   *   Neither method gains awareness of the other's states beyond rejecting them cleanly.
   * =========================================================================
   */
  async refundSeat(holdId: string): Promise<void> {
    const holds = this.ctx.storage.sql.exec("SELECT user_id, seat_count, status, expires_at FROM reservations WHERE id = ?", holdId).toArray();
    if (holds.length === 0) {
      this.logEvent({ type: 'NOT_FOUND', holdId, reason: 'HOLD_NOT_FOUND' });
      throw new Error('HOLD_NOT_FOUND');
    }

    const hold = holds[0]!;
    const status = hold.status as string;

    if (status === 'refunded') {
      this.logEvent({ type: 'ALREADY_USED', holdId, reason: 'HOLD_ALREADY_REFUNDED' });
      throw new Error('HOLD_ALREADY_REFUNDED');
    }

    if (status === 'pending') {
      this.logEvent({ type: 'ALREADY_USED', holdId, reason: 'HOLD_NOT_CONFIRMED' });
      throw new Error('HOLD_NOT_CONFIRMED');
    }

    if (status === 'released') {
      this.logEvent({ type: 'ALREADY_USED', holdId, reason: 'HOLD_RELEASED' });
      throw new Error('HOLD_RELEASED');
    }

    if (status !== 'confirmed') {
      this.logEvent({ type: 'ALREADY_USED', holdId, reason: `INVALID_STATUS_${status}` });
      throw new Error(`HOLD_INVALID_STATUS_${status}`);
    }

    this.ctx.storage.sql.exec("UPDATE reservations SET status = 'refunded' WHERE id = ?", holdId);
    this.logEvent({
      type: 'REFUNDED',
      holdId,
      userId: hold.user_id as string,
      seatCount: hold.seat_count as number,
    });

    this.broadcastSeatCount();
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
      this.logEvent({ type: 'RELEASED', holdId });
      this.broadcastSeatCount();
    }
  }

  /**
   * Pruning step that permanently deletes confirmed hold rows older than the 7-day cutoff.
   *
   * Reconciliation window derivation:
   * - Holds expire within 15 minutes of reservation; confirmation occurs during this lifecycle.
   * - The reconciliation cron runs every 5 minutes and only inspects holds past their expiry.
   * - A hold confirmed > 7 days ago has undergone over 2,016 reconciliation sweeps.
   * - Pruning deleted rows frees unbounded SQLite storage growth while updating event_state.pruned_seats
   *   to ensure availability math (totalSeats - usedSeats) is strictly preserved without overselling.
   */
  async pruneConfirmedHolds(cutoff?: number): Promise<number> {
    const threshold = cutoff ?? (Date.now() - 7 * 24 * 60 * 60 * 1000);

    const stats = this.ctx.storage.sql.exec(
      "SELECT COUNT(*) as count, SUM(seat_count) as pruned_seats FROM reservations WHERE status = 'confirmed' AND expires_at <= ?",
      threshold
    ).toArray();
    const count = (stats[0]?.count as number) || 0;
    const prunedSeats = (stats[0]?.pruned_seats as number) || 0;

    if (count > 0) {
      this.ctx.storage.sql.exec(
        "DELETE FROM reservations WHERE status = 'confirmed' AND expires_at <= ?",
        threshold
      );
      this.ctx.storage.sql.exec(
        "UPDATE event_state SET pruned_seats = COALESCE(pruned_seats, 0) + ? WHERE id = 1",
        prunedSeats
      );
    }
    return count;
  }

  async alarm() {
    const now = Date.now();
    
    // 1. Release expired pending holds
    const expired = this.ctx.storage.sql.exec("SELECT id FROM reservations WHERE status = 'pending' AND expires_at <= ?", now).toArray();
    for (const row of expired) {
      this.logEvent({ type: 'EXPIRED', holdId: row.id as string, reason: 'alarm_expiry' });
      await this.releaseSeat(row.id as string);
    }

    // 2. Prune confirmed holds older than 7-day cutoff (168 hours)
    const sevenDaysAgo = now - 7 * 24 * 60 * 60 * 1000;
    await this.pruneConfirmedHolds(sevenDaysAgo);

    // 3. Find next upcoming alarm: earliest of next pending hold expiry or next confirmed hold prune
    const nextPending = this.ctx.storage.sql.exec("SELECT MIN(expires_at) as next_expiry FROM reservations WHERE status = 'pending'").toArray();
    const nextPendingExpiry = (nextPending.length > 0 ? nextPending[0]!.next_expiry : null) as number | null;

    const nextConfirmed = this.ctx.storage.sql.exec("SELECT MIN(expires_at) as min_confirmed FROM reservations WHERE status = 'confirmed'").toArray();
    const minConfirmed = (nextConfirmed.length > 0 ? nextConfirmed[0]!.min_confirmed : null) as number | null;
    const nextPruneExpiry = minConfirmed !== null ? minConfirmed + 7 * 24 * 60 * 60 * 1000 : null;

    let nextAlarm: number | null = null;
    if (nextPendingExpiry !== null && nextPruneExpiry !== null) {
      nextAlarm = Math.min(nextPendingExpiry, nextPruneExpiry);
    } else {
      nextAlarm = nextPendingExpiry ?? nextPruneExpiry;
    }

    if (nextAlarm !== null) {
      await this.ctx.storage.setAlarm(nextAlarm);
    }
  }

  mintTicket(userId: string, orgId: string | null, eventId: string): string {
    const ticket = crypto.randomUUID();

    // Clean up stale tickets before inserting to prevent unbounded growth
    this.ctx.storage.sql.exec(
      "DELETE FROM socket_tickets WHERE expires_at < ?",
      Date.now()
    );

    this.ctx.storage.sql.exec(
      "INSERT INTO socket_tickets (ticket, user_id, org_id, event_id, expires_at) VALUES (?, ?, ?, ?, ?)",
      ticket, userId, orgId, eventId, Date.now() + 30_000
    );

    return ticket;
  }

  redeemTicket(ticket: string, eventId: string): { userId: string; orgId: string | null } {
    const rows = this.ctx.storage.sql.exec(
      "SELECT user_id, org_id, event_id, expires_at FROM socket_tickets WHERE ticket = ?",
      ticket
    ).toArray();

    if (rows.length === 0) {
      throw new Error('TICKET_NOT_FOUND');
    }

    const row = rows[0]!;

    if ((row.expires_at as number) < Date.now()) {
      this.ctx.storage.sql.exec(
        "DELETE FROM socket_tickets WHERE ticket = ?",
        ticket
      );
      throw new Error('TICKET_EXPIRED');
    }

    if ((row.event_id as string) !== eventId) {
      throw new Error('TICKET_WRONG_EVENT');
    }

    // Single-use: delete before returning
    this.ctx.storage.sql.exec(
      "DELETE FROM socket_tickets WHERE ticket = ?",
      ticket
    );

    return { userId: row.user_id as string, orgId: row.org_id as string | null };
  }

  private broadcastSeatCount(): void {
    const available = this.getAvailableSeats() ?? 0;
    const sockets = this.ctx.getWebSockets();
    const message = JSON.stringify({ type: 'seat_count', available });
    for (const ws of sockets) {
      try {
        ws.send(message);
      } catch {
        // Closed or errored socket — skip and continue broadcasting to others
      }
    }
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const ticket = url.searchParams.get('ticket');
    const eventId = url.searchParams.get('eventId');

    if (!ticket || !eventId) {
      return new Response('Missing ticket or eventId', { status: 400 });
    }

    let identity: { userId: string; orgId: string | null };
    try {
      identity = this.redeemTicket(ticket, eventId);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : '';
      if (msg === 'TICKET_NOT_FOUND') return new Response('Invalid ticket', { status: 401 });
      if (msg === 'TICKET_EXPIRED') return new Response('Ticket expired', { status: 401 });
      if (msg === 'TICKET_WRONG_EVENT') return new Response('Invalid ticket', { status: 401 });
      return new Response('Internal error', { status: 500 });
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair) as [WebSocket, WebSocket];

    // Hibernation-safe accept — stores userId as attachment, survives DO sleep
    this.ctx.acceptWebSocket(server, [identity.userId]);

    // Push current seat count immediately so reconnecting clients sync without a roundtrip
    const available = this.getAvailableSeats() ?? 0;
    server.send(JSON.stringify({ type: 'seat_count', available }));

    return new Response(null, { status: 101, webSocket: client });
  }

  webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): void {
    try {
      const raw = JSON.parse(typeof message === 'string' ? message : '');
      const parsed = socketMessageSchema.safeParse(raw);
      if (!parsed.success) return; // Unknown message type — ignore silently
      if (parsed.data.type === 'ping') {
        ws.send(JSON.stringify({ type: 'pong' }));
      }
      const [userId] = (ws as unknown as { attachment: [string] }).attachment;
      void userId;
    } catch {
      // Malformed JSON — ignore
    }
  }

  webSocketClose(_ws: WebSocket, _code: number, _reason: string): void {
  }

  webSocketError(_ws: WebSocket, error: unknown): void {
    console.error('WebSocket error:', error);
    Sentry.captureException(error);
  }
}

export type SeatLedger = SeatLedgerBase;

export const SeatLedger = Sentry.instrumentDurableObjectWithSentry(
  (env: Env) => ({ dsn: env.SENTRY_DSN }),
  SeatLedgerBase
);