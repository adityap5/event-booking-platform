import { DurableObject } from 'cloudflare:workers';
import type { Env } from './index.js';

/**
 * RateLimiter — Durable Object for per-user, per-action rate limiting.
 *
 * One instance per userId (keyed via env.RATE_LIMITER.idFromName(userId)).
 * Uses DO SQLite for atomic, synchronous counter operations — no KV or
 * external state needed. Window resets are lazy: stale windows are replaced
 * on the first request after windowMs has elapsed.
 */
export class RateLimiter extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);

    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS rate_windows (
        action TEXT PRIMARY KEY,
        count INTEGER NOT NULL DEFAULT 0,
        window_start INTEGER NOT NULL
      );
    `);
  }

  /**
   * Check whether the caller is within the rate limit for a given action.
   *
   * Synchronous — DO SQLite ops are synchronous so no async/await is needed.
   *
   * @param action   Identifier for the action being rate-limited (e.g. 'reserveSeat')
   * @param limit    Maximum number of allowed calls per window
   * @param windowMs Window duration in milliseconds
   */
  checkLimit(
    action: string,
    limit: number,
    windowMs: number,
  ): { allowed: boolean; remaining: number } {
    const now = Date.now();

    const rows = this.ctx.storage.sql
      .exec(
        'SELECT count, window_start FROM rate_windows WHERE action = ?',
        action,
      )
      .toArray();

    // No row or window has expired — start a fresh window with count = 1
    if (rows.length === 0 || now - (rows[0]!.window_start as number) > windowMs) {
      this.ctx.storage.sql.exec(
        'INSERT OR REPLACE INTO rate_windows (action, count, window_start) VALUES (?, 1, ?)',
        action,
        now,
      );
      return { allowed: true, remaining: limit - 1 };
    }

    // Within the active window
    const count = rows[0]!.count as number;

    if (count >= limit) {
      return { allowed: false, remaining: 0 };
    }

    this.ctx.storage.sql.exec(
      'UPDATE rate_windows SET count = count + 1 WHERE action = ?',
      action,
    );

    return { allowed: true, remaining: limit - count - 1 };
  }
}

export { RateLimiter as default };
