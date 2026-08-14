import { DurableObject } from "cloudflare:workers";
import type { Env } from "./index.js";
import { z } from 'zod';

const socketMessageSchema = z.object({
  type: z.enum(['ping']),
});

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
    type: 'RESERVED' | 'CONFIRMED' | 'RELEASED' | 'EXPIRED' | 'ALREADY_USED' | 'NOT_FOUND' | 'SOLD_OUT'
    holdId: string
    eventId?: string
    userId?: string
    seatCount?: number
    availableSeats?: number
    reason?: string
  }): void {
    try {
      console.log(JSON.stringify({ ts: Date.now(), ...event }));
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
      throw new Error("TOO_MANY_PENDING_HOLDS");
    }

    const totalSeats = state[0]!.total_seats as number;

    const used = this.ctx.storage.sql.exec("SELECT SUM(seat_count) as used_seats FROM reservations WHERE status = 'pending' OR status = 'confirmed'").toArray();
    const usedSeats = (used[0]!.used_seats as number) || 0;

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
      this.logEvent({ type: 'RELEASED', holdId });
      this.broadcastSeatCount();
    }
  }

  async alarm() {
    const now = Date.now();
    
    const expired = this.ctx.storage.sql.exec("SELECT id FROM reservations WHERE status = 'pending' AND expires_at <= ?", now).toArray();
    for (const row of expired) {
      this.logEvent({ type: 'EXPIRED', holdId: row.id as string, reason: 'alarm_expiry' });
      await this.releaseSeat(row.id as string);
    }

    // Find the next upcoming expiration
    const next = this.ctx.storage.sql.exec("SELECT MIN(expires_at) as next_expiry FROM reservations WHERE status = 'pending'").toArray();
    const nextExpiry = (next.length > 0 ? next[0]!.next_expiry : null) as number | null;

    if (nextExpiry) {
      await this.ctx.storage.setAlarm(nextExpiry);
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

  webSocketClose(_ws: WebSocket, code: number, reason: string): void {
    console.log('WebSocket closed', { code, reason });
  }

  webSocketError(_ws: WebSocket, error: unknown): void {
    console.error('WebSocket error:', error);
  }
}