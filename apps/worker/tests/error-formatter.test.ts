import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import type { Env } from '../src/index.js';
import { setupTestDb } from './test-helpers.js';
import { TRPCError } from '@trpc/server';
import { router, publicProcedure, isExpectedAppErrorCode } from '@event-booking/trpc';

import { fetchRequestHandler } from '@trpc/server/adapters/fetch';

describe('A5: errorFormatter unexpected error message sanitization', () => {
  let db: Awaited<ReturnType<typeof setupTestDb>>;
  const workerEnv = env as unknown as Env;

  beforeEach(async () => {
    db = await setupTestDb(workerEnv.DB);
  });

  it('verifies isExpectedAppErrorCode classifies expected codes vs internal errors', () => {
    expect(isExpectedAppErrorCode('UNAUTHORIZED')).toBe(true);
    expect(isExpectedAppErrorCode('FORBIDDEN')).toBe(true);
    expect(isExpectedAppErrorCode('NOT_FOUND')).toBe(true);
    expect(isExpectedAppErrorCode('CONFLICT')).toBe(true);
    expect(isExpectedAppErrorCode('PRECONDITION_FAILED')).toBe(true);
    expect(isExpectedAppErrorCode('TOO_MANY_REQUESTS')).toBe(true);
    expect(isExpectedAppErrorCode('BAD_REQUEST')).toBe(true);

    expect(isExpectedAppErrorCode('INTERNAL_SERVER_ERROR')).toBe(false);
    expect(isExpectedAppErrorCode('TIMEOUT')).toBe(false);
  });

  it('sanitizes unexpected procedure exception into "Internal server error" without leaking exception message over HTTP', async () => {
    const testRouter = router({
      failingProcedure: publicProcedure.query(() => {
        throw new Error('FATAL: raw database connection failed at postgres://user:secretpass@internal:5432');
      }),
      deliberateProcedure: publicProcedure.query(() => {
        throw new TRPCError({
          code: 'PRECONDITION_FAILED',
          message: 'Safe user-facing explanation',
        });
      }),
    });

    // 1. Unexpected exception: message MUST be sanitized to 'Internal server error'
    const reqFailing = new Request('https://worker.dev/trpc/failingProcedure', {
      method: 'GET',
    });

    const resFailing = await fetchRequestHandler({
      endpoint: '/trpc',
      req: reqFailing,
      router: testRouter,
      createContext: () => ({
        userId: 'test-user',
        orgId: undefined,
        role: undefined,
        ip: '127.0.0.1',
        db,
        env: workerEnv,
      }),
    });

    expect(resFailing.status).toBe(500);
    const bodyFailing = (await resFailing.json()) as any;
    expect(bodyFailing.error.message).toBe('Internal server error');
    expect(bodyFailing.error.data.code).toBe('INTERNAL_SERVER_ERROR');
    expect(JSON.stringify(bodyFailing)).not.toContain('secretpass');
    expect(JSON.stringify(bodyFailing)).not.toContain('postgres://');

    // 2. Deliberate TRPCError: custom user-facing message is preserved
    const reqDeliberate = new Request('https://worker.dev/trpc/deliberateProcedure', {
      method: 'GET',
    });

    const resDeliberate = await fetchRequestHandler({
      endpoint: '/trpc',
      req: reqDeliberate,
      router: testRouter,
      createContext: () => ({
        userId: 'test-user',
        orgId: undefined,
        role: undefined,
        ip: '127.0.0.1',
        db,
        env: workerEnv,
      }),
    });

    expect(resDeliberate.status).toBe(412);
    const bodyDeliberate = (await resDeliberate.json()) as any;
    expect(bodyDeliberate.error.message).toBe('Safe user-facing explanation');
    expect(bodyDeliberate.error.data.code).toBe('PRECONDITION_FAILED');
  });
});
