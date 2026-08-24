import { drizzle, DrizzleD1Database } from 'drizzle-orm/d1';
import * as schema from '@event-booking/shared';
import { appRouter } from '../src/router.js';
import type { Env } from '../src/index.js';
import type { Context } from '@event-booking/trpc';
import m0 from '../migrations/0000_high_giant_girl.sql?raw';
import m1 from '../migrations/0001_white_korath.sql?raw';
import m2 from '../migrations/0002_lyrical_retro_girl.sql?raw';
import m3 from '../migrations/0003_kind_ikaris.sql?raw';

/**
 * Initializes the D1 database tables in Miniflare test environment
 * by applying the actual migration files from disk in order.
 */
export async function setupTestDb(d1: D1Database): Promise<DrizzleD1Database<typeof schema>> {
  // Drop tables in reverse foreign-key order to ensure a clean state per test
  await d1.prepare('DROP TABLE IF EXISTS audit_log;').run();
  await d1.prepare('DROP TABLE IF EXISTS bookings;').run();
  await d1.prepare('DROP TABLE IF EXISTS events;').run();
  await d1.prepare('DROP TABLE IF EXISTS attendees;').run();
  await d1.prepare('DROP TABLE IF EXISTS organisations;').run();

  const migrations = [m0, m1, m2, m3];

  for (const migration of migrations) {
    const statements = migration.split('--> statement-breakpoint');
    for (const stmt of statements) {
      const trimmed = stmt.trim();
      if (trimmed) {
        await d1.prepare(trimmed).run();
      }
    }
  }

  // Seed default organisations so FK constraints on events(organisation_id) pass
  await d1.prepare(
    "INSERT INTO organisations (id, name, owner_id) VALUES ('test-org-1', 'Test Org 1', 'owner-1'), ('org-1', 'Org 1', 'owner-2'), ('org-A-id', 'Org A', 'owner-A'), ('org-B-id', 'Org B', 'owner-B'), ('org-cache-1', 'Org Cache 1', 'owner-C1'), ('org-cache-2', 'Org Cache 2', 'owner-C2'), ('org-fail-1', 'Org Fail 1', 'owner-F1') ON CONFLICT(id) DO NOTHING"
  ).run();

  return drizzle(d1, { schema });
}

export interface TestCallerOptions {
  env: Env;
  db: DrizzleD1Database<typeof schema>;
  userId?: string;
  orgId?: string | null;
  role?: string | null;
  ip?: string;
}

/**
 * Builds a hand-crafted context and tRPC caller bypassing Clerk createContext.
 * Does not mutate the caller-supplied opts.env object.
 */
export function createTestCaller(opts: TestCallerOptions): ReturnType<typeof appRouter.createCaller> {
  const env: Env = {
    ...opts.env,
    STRIPE_SECRET_KEY: opts.env.STRIPE_SECRET_KEY || 'sk_test_mock',
    STRIPE_WEBHOOK_SECRET: opts.env.STRIPE_WEBHOOK_SECRET || 'whsec_test_secret_123',
  };

  const ctx: Context = {
    userId: opts.userId ?? 'test-user-1',
    orgId: opts.orgId === null ? undefined : (opts.orgId ?? 'test-org-1'),
    role: opts.role === null ? undefined : (opts.role ?? 'organiser'),
    ip: opts.ip ?? '127.0.0.1',
    db: opts.db,
    env,
  };

  return appRouter.createCaller(ctx);
}

export interface InterceptedStripeRequest {
  url: string;
  method: string;
  body: string;
  headers: Record<string, string>;
}

/**
 * Intercepts outbound HTTP fetch calls targeting api.stripe.com.
 * Only intercepts requests matching api.stripe.com, forwarding all other requests to global fetch.
 */
export function mockStripeNetworkCall(
  mockResponseBody: Record<string, unknown> = {
    id: 'cs_test_mock_session_id',
    url: 'https://checkout.stripe.com/pay/cs_test_mock_session_id',
  },
  mockStatus = 200
) {
  const originalFetch = globalThis.fetch;
  const interceptedRequests: InterceptedStripeRequest[] = [];

  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const urlString = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;

    if (urlString.includes('api.stripe.com')) {
      const method = init?.method ?? 'GET';
      const body = init?.body ? String(init.body) : '';
      const headers: Record<string, string> = {};
      if (init?.headers) {
        if (init.headers instanceof Headers) {
          init.headers.forEach((v, k) => {
            headers[k] = v;
          });
        } else if (Array.isArray(init.headers)) {
          for (const [k, v] of init.headers) {
            headers[k] = v;
          }
        } else {
          Object.assign(headers, init.headers);
        }
      }

      interceptedRequests.push({
        url: urlString,
        method,
        body,
        headers,
      });

      return new Response(JSON.stringify(mockResponseBody), {
        status: mockStatus,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    return originalFetch(input, init);
  };

  return {
    interceptedRequests,
    restore: () => {
      globalThis.fetch = originalFetch;
    },
  };
}
