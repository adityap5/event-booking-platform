import { describe, it, expect } from 'vitest';
import { env, runInDurableObject } from 'cloudflare:test';
import type { Env } from '../src/index.js';
import type { RateLimiter } from '../src/rate-limiter.js';

describe('RateLimiter Durable Object — Direct Unit Tests', () => {
  const workerEnv = env as unknown as Env;

  // Helper to get a typed DO stub by instance name
  function getRateLimiterStub(name: string) {
    const id = workerEnv.RATE_LIMITER.idFromName(name);
    return workerEnv.RATE_LIMITER.get(id);
  }

  describe('Sliding window rollover', () => {
    it('counts requests against current window just under boundary, and resets after windowMs has elapsed', async () => {
      const stub = getRateLimiterStub('test-user-rollover');
      const action = 'reserveSeat';
      const limit = 5;
      const windowMs = 60_000; // 60 seconds

      // 1. Initial request starts a new window (count = 1)
      const first = await stub.checkLimit(action, limit, windowMs);
      expect(first).toEqual({ allowed: true, remaining: 4 });

      // Inspect DB state directly inside DO
      const initialRow = await runInDurableObject(stub, (instance: RateLimiter) => {
        const rows = (instance as any).ctx.storage.sql
          .exec('SELECT count, window_start FROM rate_windows WHERE action = ?', action)
          .toArray();
        return rows[0] as { count: number; window_start: number };
      });
      expect(initialRow.count).toBe(1);

      // 2. Simulate time passing just UNDER windowMs (e.g. 59,900ms elapsed)
      await runInDurableObject(stub, (instance: RateLimiter) => {
        // Set window_start so that (Date.now() - window_start) is within windowMs
        (instance as any).ctx.storage.sql.exec(
          'UPDATE rate_windows SET window_start = ? WHERE action = ?',
          Date.now() - 59_900,
          action,
        );
      });

      // Second request within window increments count to 2
      const second = await stub.checkLimit(action, limit, windowMs);
      expect(second).toEqual({ allowed: true, remaining: 3 });

      const updatedRow = await runInDurableObject(stub, (instance: RateLimiter) => {
        const rows = (instance as any).ctx.storage.sql
          .exec('SELECT count, window_start FROM rate_windows WHERE action = ?', action)
          .toArray();
        return rows[0] as { count: number; window_start: number };
      });
      expect(updatedRow.count).toBe(2);

      // 3. Simulate window expiry (e.g. 60,001ms elapsed)
      await runInDurableObject(stub, (instance: RateLimiter) => {
        (instance as any).ctx.storage.sql.exec(
          'UPDATE rate_windows SET window_start = ? WHERE action = ?',
          Date.now() - 60_001,
          action,
        );
      });

      // Third request after window expiry starts a FRESH window with count = 1
      const third = await stub.checkLimit(action, limit, windowMs);
      expect(third).toEqual({ allowed: true, remaining: 4 });

      const resetRow = await runInDurableObject(stub, (instance: RateLimiter) => {
        const rows = (instance as any).ctx.storage.sql
          .exec('SELECT count, window_start FROM rate_windows WHERE action = ?', action)
          .toArray();
        return rows[0] as { count: number; window_start: number };
      });
      expect(resetRow.count).toBe(1);
    });
  });

  describe('Limit enforcement and non-mutating rejection', () => {
    it('allows requests up to the limit, rejects subsequent calls without incrementing count, and resets upon rollover', async () => {
      const stub = getRateLimiterStub('test-user-limits');
      const action = 'uploadEventCover';
      const limit = 3;
      const windowMs = 10_000;

      // 1. Request 1/3
      const r1 = await stub.checkLimit(action, limit, windowMs);
      expect(r1).toEqual({ allowed: true, remaining: 2 });

      // 2. Request 2/3
      const r2 = await stub.checkLimit(action, limit, windowMs);
      expect(r2).toEqual({ allowed: true, remaining: 1 });

      // 3. Request 3/3 (last allowed)
      const r3 = await stub.checkLimit(action, limit, windowMs);
      expect(r3).toEqual({ allowed: true, remaining: 0 });

      // 4. Request 4 (rejected — limit reached)
      const r4 = await stub.checkLimit(action, limit, windowMs);
      expect(r4).toEqual({ allowed: false, remaining: 0 });

      // 5. Request 5 (rejected again)
      const r5 = await stub.checkLimit(action, limit, windowMs);
      expect(r5).toEqual({ allowed: false, remaining: 0 });

      // Assert that rejected requests did NOT increment count beyond limit in DB
      const dbCount = await runInDurableObject(stub, (instance: RateLimiter) => {
        const rows = (instance as any).ctx.storage.sql
          .exec('SELECT count FROM rate_windows WHERE action = ?', action)
          .toArray();
        return rows[0]!.count as number;
      });
      expect(dbCount).toBe(3);

      // 6. Simulate window expiration
      await runInDurableObject(stub, (instance: RateLimiter) => {
        (instance as any).ctx.storage.sql.exec(
          'UPDATE rate_windows SET window_start = ? WHERE action = ?',
          Date.now() - 10_500,
          action,
        );
      });

      // 7. Request succeeds again after reset
      const r6 = await stub.checkLimit(action, limit, windowMs);
      expect(r6).toEqual({ allowed: true, remaining: 2 });
    });
  });

  describe('Key isolation across actions within the same DO instance', () => {
    it('maintains independent rate windows and counts for different actions on the same user DO instance', async () => {
      const stub = getRateLimiterStub('test-user-isolation');
      const actionA = 'reserveSeat';
      const actionB = 'createEvent';
      const actionC = 'createCheckoutSession';

      const limitA = 2;
      const limitB = 5;
      const windowMs = 60_000;

      // Exhaust action A quota (2 calls)
      const a1 = await stub.checkLimit(actionA, limitA, windowMs);
      expect(a1).toEqual({ allowed: true, remaining: 1 });

      const a2 = await stub.checkLimit(actionA, limitA, windowMs);
      expect(a2).toEqual({ allowed: true, remaining: 0 });

      const a3 = await stub.checkLimit(actionA, limitA, windowMs);
      expect(a3).toEqual({ allowed: false, remaining: 0 });

      // Action B on the same DO instance is completely unaffected and has full quota
      const b1 = await stub.checkLimit(actionB, limitB, windowMs);
      expect(b1).toEqual({ allowed: true, remaining: 4 });

      const b2 = await stub.checkLimit(actionB, limitB, windowMs);
      expect(b2).toEqual({ allowed: true, remaining: 3 });

      // Action C is untouched
      const c1 = await stub.checkLimit(actionC, 10, windowMs);
      expect(c1).toEqual({ allowed: true, remaining: 9 });

      // Action A remains blocked
      const a4 = await stub.checkLimit(actionA, limitA, windowMs);
      expect(a4).toEqual({ allowed: false, remaining: 0 });

      // Verify all three distinct action rows in SQLite
      const rows = await runInDurableObject(stub, (instance: RateLimiter) => {
        return (instance as any).ctx.storage.sql
          .exec('SELECT action, count FROM rate_windows ORDER BY action ASC')
          .toArray() as Array<{ action: string; count: number }>;
      });

      expect(rows).toEqual([
        { action: 'createCheckoutSession', count: 1 },
        { action: 'createEvent', count: 2 },
        { action: 'reserveSeat', count: 2 },
      ]);
    });
  });

  describe('Concurrent increments serialization', () => {
    it('correctly serializes 20 concurrent checkLimit calls with zero lost updates', async () => {
      const stub = getRateLimiterStub('test-user-concurrency');
      const action = 'concurrentAction';
      const limit = 25;
      const windowMs = 60_000;

      // Fire 20 parallel calls simultaneously
      const results = await Promise.all(
        Array.from({ length: 20 }, () => stub.checkLimit(action, limit, windowMs))
      );

      // All 20 calls should succeed since limit is 25
      const allowedCount = results.filter((r) => r.allowed).length;
      expect(allowedCount).toBe(20);

      // Remaining counts should contain distinct values from 24 down to 5
      const remainings = results.map((r) => r.remaining).sort((a, b) => b - a);
      expect(remainings[0]).toBe(24);
      expect(remainings[remainings.length - 1]).toBe(5);

      // Check DB row has exactly count = 20
      const finalCount = await runInDurableObject(stub, (instance: RateLimiter) => {
        const rows = (instance as any).ctx.storage.sql
          .exec('SELECT count FROM rate_windows WHERE action = ?', action)
          .toArray();
        return rows[0]!.count as number;
      });
      expect(finalCount).toBe(20);

      // Now fire 10 more concurrent calls when remaining quota is 5 (5 succeed, 5 rejected)
      const secondBatch = await Promise.all(
        Array.from({ length: 10 }, () => stub.checkLimit(action, limit, windowMs))
      );

      const secondAllowed = secondBatch.filter((r) => r.allowed).length;
      const secondRejected = secondBatch.filter((r) => !r.allowed).length;
      expect(secondAllowed).toBe(5);
      expect(secondRejected).toBe(5);

      // Final DB count should cap at limit 25
      const cappedCount = await runInDurableObject(stub, (instance: RateLimiter) => {
        const rows = (instance as any).ctx.storage.sql
          .exec('SELECT count FROM rate_windows WHERE action = ?', action)
          .toArray();
        return rows[0]!.count as number;
      });
      expect(cappedCount).toBe(25);
    });
  });
});
