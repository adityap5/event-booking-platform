import { describe, it, expect, beforeEach, vi } from 'vitest';
import { SELF, env } from 'cloudflare:test';
import type { Env } from '../src/index.js';
import { setupTestDb } from './test-helpers.js';
import { Webhook } from 'svix';
import Stripe from 'stripe';

vi.mock('@clerk/backend', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@clerk/backend')>();
  return {
    ...actual,
    verifyToken: vi.fn(async (token: string) => {
      if (token.startsWith('valid-test-token')) {
        const sub = 'user_sec_test_123';
        return {
          sub,
          o: {
            id: 'test-org-1',
            rol: 'organiser',
            slg: 'test-org-1',
          },
        };
      }
      throw new Error('Invalid token');
    }),
  };
});

describe('Worker Security Response Headers Coverage', () => {
  const workerEnv = env as unknown as Env;

  const clerkSecret = 'whsec_' + Buffer.from('12345678901234567890123456789012').toString('base64');
  const stripeSecret = 'whsec_test_stripe_123';
  const stripeSecretKey = 'sk_test_mock';

  const stripe = new Stripe(stripeSecretKey, {
    httpClient: Stripe.createFetchHttpClient(),
  });

  beforeEach(async () => {
    await setupTestDb(workerEnv.DB);
    (workerEnv as any).CLERK_WEBHOOK_SECRET = clerkSecret;
    (workerEnv as any).STRIPE_WEBHOOK_SECRET = stripeSecret;
    (workerEnv as any).STRIPE_SECRET_KEY = stripeSecretKey;
  });

  async function createSignedClerkRequest(payload: object): Promise<Request> {
    const rawBody = JSON.stringify(payload);
    const wh = new Webhook(clerkSecret);
    const msgId = 'msg_' + crypto.randomUUID();
    const timestamp = new Date();
    const signature = wh.sign(msgId, timestamp, rawBody);

    return new Request('https://worker.dev/api/webhooks/clerk', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'svix-id': msgId,
        'svix-timestamp': Math.floor(timestamp.getTime() / 1000).toString(),
        'svix-signature': signature,
      },
      body: rawBody,
    });
  }

  async function createSignedStripeRequest(payload: object): Promise<Request> {
    const rawBody = JSON.stringify(payload);
    const signature = await stripe.webhooks.generateTestHeaderStringAsync({
      payload: rawBody,
      secret: stripeSecret,
    });

    return new Request('https://worker.dev/stripe/webhook', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'stripe-signature': signature,
      },
      body: rawBody,
    });
  }

  it('1. Normal tRPC response includes all four security headers', async () => {
    const res = await SELF.fetch('https://worker.dev/trpc/listPublicEvents', {
      method: 'GET',
    });

    expect(res.status).toBe(200);
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(res.headers.get('Referrer-Policy')).toBe('strict-origin-when-cross-origin');
    expect(res.headers.get('Strict-Transport-Security')).toBe('max-age=15552000; includeSubDomains');
    expect(res.headers.get('Content-Security-Policy')).toBe("frame-ancestors 'none'");
  });

  it('2. R2 image route response includes security headers while preserving Cache-Control', async () => {
    const res = await SELF.fetch('https://worker.dev/images/non-existent-cover', {
      method: 'GET',
    });

    expect(res.status).toBe(404);
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(res.headers.get('Referrer-Policy')).toBe('strict-origin-when-cross-origin');
    expect(res.headers.get('Strict-Transport-Security')).toBe('max-age=15552000; includeSubDomains');
    expect(res.headers.get('Content-Security-Policy')).toBe("frame-ancestors 'none'");
    expect(res.headers.get('Cache-Control')).not.toBe('no-store');
  });

  it('3. handleWebSocketUpgrade 400 error case returns all four security headers', async () => {
    // Calling /ws without eventId query param triggers 400 "Missing eventId" (locally constructed)
    const res = await SELF.fetch('https://worker.dev/ws', {
      method: 'GET',
      headers: {
        'Upgrade': 'websocket',
      },
    });

    expect(res.status).toBe(400);
    const text = await res.text();
    expect(text).toBe('Missing eventId');
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(res.headers.get('Referrer-Policy')).toBe('strict-origin-when-cross-origin');
    expect(res.headers.get('Strict-Transport-Security')).toBe('max-age=15552000; includeSubDomains');
    expect(res.headers.get('Content-Security-Policy')).toBe("frame-ancestors 'none'");
  });

  it('3b. handleWebSocketUpgrade with eventId present but ticket missing returns 400 from DO with security headers (not 500)', async () => {
    // Calling /ws with eventId but no ticket reaches the DO stub and returns 400 "Missing ticket or eventId".
    // Proves applyWorkerSecurityHeaders correctly handles responses with immutable headers from DO stubs without throwing TypeError / 500.
    const eventId = 'ws-test-event-missing-ticket';
    const stub = workerEnv.SEAT_LEDGER.get(workerEnv.SEAT_LEDGER.idFromName(eventId));
    await stub.initialize(10);

    const res = await SELF.fetch(`https://worker.dev/ws?eventId=${eventId}`, {
      method: 'GET',
      headers: {
        'Upgrade': 'websocket',
      },
    });

    expect(res.status).toBe(400);
    const text = await res.text();
    expect(text).toBe('Missing ticket or eventId');
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(res.headers.get('Referrer-Policy')).toBe('strict-origin-when-cross-origin');
    expect(res.headers.get('Strict-Transport-Security')).toBe('max-age=15552000; includeSubDomains');
    expect(res.headers.get('Content-Security-Policy')).toBe("frame-ancestors 'none'");
  });

  it('4. handleWebSocketUpgrade 101 upgrade case returns 101 Switching Protocols response from Durable Object without security headers', async () => {
    const eventId = 'ws-test-event-headers';
    const stub = workerEnv.SEAT_LEDGER.get(workerEnv.SEAT_LEDGER.idFromName(eventId));
    await stub.initialize(10);
    const ticket = await stub.mintTicket('user-sec-1', 'test-org-1', eventId);

    const res = await SELF.fetch(`https://worker.dev/ws?eventId=${eventId}&ticket=${ticket}`, {
      method: 'GET',
      headers: {
        'Upgrade': 'websocket',
      },
    });

    expect(res.status).toBe(101);

    // INTENTIONAL PROTOCOL EXCEPTION DOCUMENTATION:
    // Live Durable Object `stub.fetch()` 101 WebSocket upgrade responses carry immutable header guards (`Guard: "immutable"`)
    // in workerd. Calling `.headers.set()` on a 101 Response object returned by stub.fetch() throws `TypeError: Can't modify immutable headers.`.
    // Therefore, index.ts's `wsResponse.status === 101` branch deliberately returns the response unmodified without wrapping.
    // We explicitly assert below that security response headers are absent (null) on the 101 upgrade response, which is the correct
    // and intentional outcome under RFC 6455 / workerd runtime rules.
    expect(res.headers.get('X-Content-Type-Options')).toBeNull();
    expect(res.headers.get('Referrer-Policy')).toBeNull();
    expect(res.headers.get('Strict-Transport-Security')).toBeNull();
    expect(res.headers.get('Content-Security-Policy')).toBeNull();
  });

  it('4b. handleWebSocketUpgrade with mismatched Origin header is rejected with 403 even with valid ticket', async () => {
    const eventId = 'ws-test-event-origin-mismatch';
    const stub = workerEnv.SEAT_LEDGER.get(workerEnv.SEAT_LEDGER.idFromName(eventId));
    await stub.initialize(10);
    const ticket = await stub.mintTicket('user-sec-origin', 'test-org-1', eventId);

    const res = await SELF.fetch(`https://worker.dev/ws?eventId=${eventId}&ticket=${ticket}`, {
      method: 'GET',
      headers: {
        'Upgrade': 'websocket',
        'Origin': 'https://evil-attacker-website.com',
      },
    });

    expect(res.status).toBe(403);
    const text = await res.text();
    expect(text).toBe('Invalid origin');
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(res.headers.get('Referrer-Policy')).toBe('strict-origin-when-cross-origin');
    expect(res.headers.get('Strict-Transport-Security')).toBe('max-age=15552000; includeSubDomains');
    expect(res.headers.get('Content-Security-Policy')).toBe("frame-ancestors 'none'");
  });

  it('4c. handleWebSocketUpgrade with valid Origin header from CORS_ALLOWED_ORIGINS succeeds with 101', async () => {
    const eventId = 'ws-test-event-valid-origin';
    const stub = workerEnv.SEAT_LEDGER.get(workerEnv.SEAT_LEDGER.idFromName(eventId));
    await stub.initialize(10);
    const ticket = await stub.mintTicket('user-sec-valid-origin', 'test-org-1', eventId);

    const res = await SELF.fetch(`https://worker.dev/ws?eventId=${eventId}&ticket=${ticket}`, {
      method: 'GET',
      headers: {
        'Upgrade': 'websocket',
        'Origin': 'https://event-booking-web.aditya29.workers.dev',
      },
    });

    expect(res.status).toBe(101);
  });

  it('5. checkBodySize 413 response returns security headers without altering status code or body', async () => {
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
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(res.headers.get('Referrer-Policy')).toBe('strict-origin-when-cross-origin');
    expect(res.headers.get('Strict-Transport-Security')).toBe('max-age=15552000; includeSubDomains');
    expect(res.headers.get('Content-Security-Policy')).toBe("frame-ancestors 'none'");
  });

  it('6. handleClerkWebhook error (400) and success (200) paths return security headers', async () => {
    // 400 error path: missing svix headers
    const req400 = new Request('https://worker.dev/api/webhooks/clerk', {
      method: 'POST',
      body: JSON.stringify({ type: 'test' }),
    });
    const res400 = await SELF.fetch(req400);

    expect(res400.status).toBe(400);
    expect(res400.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(res400.headers.get('Referrer-Policy')).toBe('strict-origin-when-cross-origin');
    expect(res400.headers.get('Strict-Transport-Security')).toBe('max-age=15552000; includeSubDomains');
    expect(res400.headers.get('Content-Security-Policy')).toBe("frame-ancestors 'none'");

    // 200 success path: validly signed webhook for unhandled event type ('user.updated')
    const req200 = await createSignedClerkRequest({ type: 'user.updated', data: {} });
    const res200 = await SELF.fetch(req200);

    expect(res200.status).toBe(200);
    expect(res200.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(res200.headers.get('Referrer-Policy')).toBe('strict-origin-when-cross-origin');
    expect(res200.headers.get('Strict-Transport-Security')).toBe('max-age=15552000; includeSubDomains');
    expect(res200.headers.get('Content-Security-Policy')).toBe("frame-ancestors 'none'");
  });

  it('7. handleStripeWebhook error (400) and acknowledgment (200) paths return security headers', async () => {
    // 400 error path: missing stripe-signature header
    const req400 = new Request('https://worker.dev/stripe/webhook', {
      method: 'POST',
      body: JSON.stringify({ type: 'test' }),
    });
    const res400 = await SELF.fetch(req400);

    expect(res400.status).toBe(400);
    expect(res400.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(res400.headers.get('Referrer-Policy')).toBe('strict-origin-when-cross-origin');
    expect(res400.headers.get('Strict-Transport-Security')).toBe('max-age=15552000; includeSubDomains');
    expect(res400.headers.get('Content-Security-Policy')).toBe("frame-ancestors 'none'");

    // 200 acknowledgment path: validly signed webhook for unhandled event type ('ping')
    const req200 = await createSignedStripeRequest({ id: 'evt_ping_sec_test', type: 'ping', data: { object: {} } });
    const res200 = await SELF.fetch(req200);

    expect(res200.status).toBe(200);
    expect(res200.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(res200.headers.get('Referrer-Policy')).toBe('strict-origin-when-cross-origin');
    expect(res200.headers.get('Strict-Transport-Security')).toBe('max-age=15552000; includeSubDomains');
    expect(res200.headers.get('Content-Security-Policy')).toBe("frame-ancestors 'none'");
  });
});
