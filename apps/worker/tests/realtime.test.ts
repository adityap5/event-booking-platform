import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import type { Env } from '../src/index.js';
import { setupTestDb, createTestCaller } from './test-helpers.js';

describe('realtimeRouter.createSocketTicket', () => {
  let db: Awaited<ReturnType<typeof setupTestDb>>;
  const workerEnv = env as unknown as Env;

  beforeEach(async () => {
    db = await setupTestDb(workerEnv.DB);
  });

  it('rate limit boundary: permits 10 createSocketTicket calls per user, 11th rejected with TOO_MANY_REQUESTS', async () => {
    const callerUserA = createTestCaller({
      env: workerEnv,
      db,
      userId: 'user-ticket-limit-A',
    });

    const fakeEventId = 'non-existent-event-ticket';

    // First 10 calls for User A pass rate limit check (fail on event NOT_FOUND)
    for (let i = 0; i < 10; i++) {
      await expect(
        callerUserA.createSocketTicket({ eventId: fakeEventId })
      ).rejects.toThrowError(/Event not found/);
    }

    // 11th call for User A is rejected with TOO_MANY_REQUESTS by RateLimiter
    await expect(
      callerUserA.createSocketTicket({ eventId: fakeEventId })
    ).rejects.toThrowError('Too many requests. Please try again shortly.');
  });

  it('rate limit per-user isolation: User B is not blocked when User A hits rate limit', async () => {
    const callerUserA = createTestCaller({
      env: workerEnv,
      db,
      userId: 'user-ticket-iso-A',
    });

    const callerUserB = createTestCaller({
      env: workerEnv,
      db,
      userId: 'user-ticket-iso-B',
    });

    const fakeEventId = 'non-existent-event-ticket-iso';

    // User A consumes all 10 rate limit slots
    for (let i = 0; i < 10; i++) {
      await expect(
        callerUserA.createSocketTicket({ eventId: fakeEventId })
      ).rejects.toThrowError(/Event not found/);
    }

    // 11th call for User A is rate limited
    await expect(
      callerUserA.createSocketTicket({ eventId: fakeEventId })
    ).rejects.toThrowError('Too many requests. Please try again shortly.');

    // User B is NOT rate-limited (fails with Event not found instead of TOO_MANY_REQUESTS)
    await expect(
      callerUserB.createSocketTicket({ eventId: fakeEventId })
    ).rejects.toThrowError(/Event not found/);
  });
});
