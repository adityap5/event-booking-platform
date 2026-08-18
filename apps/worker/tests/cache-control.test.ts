import { describe, it, expect, beforeEach, vi } from 'vitest';
import { SELF, env } from 'cloudflare:test';
import type { Env } from '../src/index.js';
import { setupTestDb } from './test-helpers.js';

vi.mock('@clerk/backend', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@clerk/backend')>();
  return {
    ...actual,
    verifyToken: vi.fn(async (token: string) => {
      if (token.startsWith('valid-test-token')) {
        const sub = 'user_cache_test_123';
        return {
          sub,
          o: {
            id: 'test-org-1',
            rol: 'org:admin',
            slg: 'test-org-1',
          },
        };
      }
      throw new Error('Invalid token');
    }),
  };
});

describe('Cache-Control: no-store on tRPC Responses', () => {
  const workerEnv = env as unknown as Env;

  beforeEach(async () => {
    await setupTestDb(workerEnv.DB);
  });

  it('1. Successful tRPC call to a public procedure returns Cache-Control: no-store', async () => {
    const res = await SELF.fetch('https://worker.dev/trpc/listPublicEvents', {
      method: 'GET',
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
  });

  it('2. Authenticated tRPC procedure call returns Cache-Control: no-store', async () => {
    const res = await SELF.fetch('https://worker.dev/trpc/listOrgEvents', {
      method: 'GET',
      headers: {
        'Authorization': 'Bearer valid-test-token-cache',
      },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
  });

  it('3. tRPC error response (Zod validation failure) returns Cache-Control: no-store', async () => {
    // Pass invalid input type (number instead of string for eventId) to trigger Zod validation error (400)
    const invalidInput = encodeURIComponent(JSON.stringify({ eventId: 123 }));
    const res = await SELF.fetch(`https://worker.dev/trpc/getAvailableSeats?input=${invalidInput}`, {
      method: 'GET',
    });

    expect(res.status).toBe(400);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
  });

  it('4. R2 image route response (GET /images/*) is unaffected and does not return no-store', async () => {
    const res = await SELF.fetch('https://worker.dev/images/non-existent-cover', {
      method: 'GET',
    });

    expect(res.status).toBe(404);
    expect(res.headers.get('Cache-Control')).not.toBe('no-store');
  });

  it('5. 413 response from body-size-limit check is unaffected by tRPC Cache-Control header addition', async () => {
    const res = await SELF.fetch('https://worker.dev/trpc/events.getById?batch=1', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': '102401',
      },
      body: JSON.stringify({ json: { id: '123' } }),
    });

    expect(res.status).toBe(413);
    const text = await res.text();
    expect(text).toBe('Request body too large.');
    expect(res.headers.get('Cache-Control')).toBeNull();
  });

  it('6. tRPC GET procedure response receives Cache-Control: no-store', async () => {
    const res = await SELF.fetch('https://worker.dev/trpc/listPublicEvents', {
      method: 'GET',
    });

    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
  });
});
