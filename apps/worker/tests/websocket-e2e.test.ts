import { describe, it, expect, beforeEach } from 'vitest';
import { SELF, env, runInDurableObject } from 'cloudflare:test';
import type { Env } from '../src/index.js';
import type { SeatLedger } from '../src/seat-ledger.js';
import { setupTestDb } from './test-helpers.js';

/**
 * WebSocket Upgrade End-to-End Integration Tests
 *
 * Test Harness Capabilities & Scope in @cloudflare/vitest-pool-workers:
 * ---------------------------------------------------------------------
 * 1. WHAT IS TESTABLE:
 *    - Full HTTP routing pipeline from `index.ts` -> `handleWebSocketUpgrade` -> `SeatLedger` DO -> `Response`.
 *    - RFC 6455 HTTP upgrade negotiation resulting in HTTP 101 Switching Protocols.
 *    - Origin header validation / CSWSH defense allowlisting and rejections (403).
 *    - Ticket single-use validation (subsequent requests rejected with 401).
 *    - Expired ticket validation (401 Ticket expired).
 *    - EventId mismatch validation (401 Invalid ticket).
 *    - Missing query parameter validation (400).
 *    - Runtime security response header behavior (101 protocol bypass vs 4xx header inclusion).
 *    - Client-side WebSocket handle inspection: `res.webSocket` is exposed on 101 responses by workerd,
 *      allowing calling `res.webSocket.accept()` and receiving the DO's initial seat count push.
 *
 * 2. WHAT IS NOT COVERED / TEST HARNESS LIMITATIONS:
 *    - Standard browser `new WebSocket('wss://...')` browser client networking (which does not run in V8 isolates).
 *    - Long-lived persistent TCP connection drops or network partition re-connections.
 */

describe('WebSocket Upgrade End-to-End Handshake (/ws)', () => {
  const workerEnv = env as unknown as Env;

  const validOrigin = 'https://event-booking-web.aditya29.workers.dev';
  const disallowedOrigin = 'https://malicious-attacker-site.com';

  beforeEach(async () => {
    await setupTestDb(workerEnv.DB);
  });

  it('1. Successful upgrade: valid ticket + matching eventId + allowed Origin yields 101 response and pushes initial seat count', async () => {
    const eventId = 'e2e-ws-event-success';
    const stub = workerEnv.SEAT_LEDGER.get(workerEnv.SEAT_LEDGER.idFromName(eventId));
    await stub.initialize(50);

    const ticket = await stub.mintTicket('user-ws-success', 'test-org-1', eventId);

    // Dispatch full HTTP WebSocket upgrade request through the worker edge pipeline
    const res = await SELF.fetch(`https://worker.dev/ws?eventId=${eventId}&ticket=${ticket}`, {
      method: 'GET',
      headers: {
        'Upgrade': 'websocket',
        'Origin': validOrigin,
      },
    });

    // 1. Assert 101 Switching Protocols status
    expect(res.status).toBe(101);

    // 2. Assert client-side WebSocket is attached to the Response in workerd runtime
    const clientWs = res.webSocket;
    expect(clientWs).toBeDefined();

    if (clientWs) {
      clientWs.accept();

      // Listen for the immediate initial push from the DO (server.send({ type: 'seat_count', available: 50 }))
      const initialMessagePromise = new Promise<{ type: string; available: number }>((resolve) => {
        clientWs.addEventListener('message', (event) => {
          try {
            const data = JSON.parse(event.data as string);
            resolve(data);
          } catch {
            // ignore
          }
        });
      });

      const msg = await initialMessagePromise;
      expect(msg).toEqual({ type: 'seat_count', available: 50 });
      clientWs.close();
    }
  });

  it('2. Security headers exemption: 101 response bypasses security headers; 4xx error responses include them', async () => {
    const eventId = 'e2e-ws-headers-check';
    const stub = workerEnv.SEAT_LEDGER.get(workerEnv.SEAT_LEDGER.idFromName(eventId));
    await stub.initialize(20);
    const ticket = await stub.mintTicket('user-ws-headers', 'test-org-1', eventId);

    // 101 Upgrade response
    const res101 = await SELF.fetch(`https://worker.dev/ws?eventId=${eventId}&ticket=${ticket}`, {
      method: 'GET',
      headers: {
        'Upgrade': 'websocket',
        'Origin': validOrigin,
      },
    });

    expect(res101.status).toBe(101);
    // Security headers must be omitted on 101 due to immutable header guards in workerd
    expect(res101.headers.get('X-Content-Type-Options')).toBeNull();
    expect(res101.headers.get('Referrer-Policy')).toBeNull();
    expect(res101.headers.get('Strict-Transport-Security')).toBeNull();
    expect(res101.headers.get('Content-Security-Policy')).toBeNull();

    // 400 Rejection response (missing ticket)
    const res400 = await SELF.fetch(`https://worker.dev/ws?eventId=${eventId}`, {
      method: 'GET',
      headers: {
        'Upgrade': 'websocket',
      },
    });

    expect(res400.status).toBe(400);
    expect(res400.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(res400.headers.get('Referrer-Policy')).toBe('strict-origin-when-cross-origin');
    expect(res400.headers.get('Strict-Transport-Security')).toBe('max-age=15552000; includeSubDomains');
    expect(res400.headers.get('Content-Security-Policy')).toBe("frame-ancestors 'none'");
  });

  it('3. Ticket single-use enforcement: reusing an already-redeemed ticket fails through the full HTTP path', async () => {
    const eventId = 'e2e-ws-single-use';
    const stub = workerEnv.SEAT_LEDGER.get(workerEnv.SEAT_LEDGER.idFromName(eventId));
    await stub.initialize(15);

    const ticket = await stub.mintTicket('user-single-use', 'test-org-1', eventId);

    // First attempt consumes the ticket and succeeds with 101
    const resFirst = await SELF.fetch(`https://worker.dev/ws?eventId=${eventId}&ticket=${ticket}`, {
      method: 'GET',
      headers: {
        'Upgrade': 'websocket',
        'Origin': validOrigin,
      },
    });
    expect(resFirst.status).toBe(101);

    // Second attempt with the SAME ticket is rejected with 401 Invalid ticket
    const resSecond = await SELF.fetch(`https://worker.dev/ws?eventId=${eventId}&ticket=${ticket}`, {
      method: 'GET',
      headers: {
        'Upgrade': 'websocket',
        'Origin': validOrigin,
      },
    });

    expect(resSecond.status).toBe(401);
    const body = await resSecond.text();
    expect(body).toBe('Invalid ticket');
    expect(resSecond.headers.get('X-Content-Type-Options')).toBe('nosniff');
  });

  it('4. Expired ticket rejection: tickets past their 30-second TTL are rejected through the full HTTP path', async () => {
    const eventId = 'e2e-ws-expired-ticket';
    const stub = workerEnv.SEAT_LEDGER.get(workerEnv.SEAT_LEDGER.idFromName(eventId));
    await stub.initialize(10);

    const ticket = await stub.mintTicket('user-expired', 'test-org-1', eventId);

    // Manually expire the ticket inside the DO SQLite storage
    await runInDurableObject(stub, (instance: SeatLedger) => {
      (instance as any).ctx.storage.sql.exec(
        'UPDATE socket_tickets SET expires_at = ? WHERE ticket = ?',
        Date.now() - 5_000,
        ticket,
      );
    });

    const res = await SELF.fetch(`https://worker.dev/ws?eventId=${eventId}&ticket=${ticket}`, {
      method: 'GET',
      headers: {
        'Upgrade': 'websocket',
        'Origin': validOrigin,
      },
    });

    expect(res.status).toBe(401);
    const body = await res.text();
    expect(body).toBe('Ticket expired');
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
  });

  it('5. Event ID mismatch rejection: ticket minted for Event A presented against Event B is rejected', async () => {
    const eventIdA = 'e2e-ws-event-A';
    const eventIdB = 'e2e-ws-event-B';

    const stubA = workerEnv.SEAT_LEDGER.get(workerEnv.SEAT_LEDGER.idFromName(eventIdA));
    const stubB = workerEnv.SEAT_LEDGER.get(workerEnv.SEAT_LEDGER.idFromName(eventIdB));
    await stubA.initialize(10);
    await stubB.initialize(10);

    // Mint ticket for Event A
    const ticketA = await stubA.mintTicket('user-mismatch', 'test-org-1', eventIdA);

    // Present ticketA against Event B's DO endpoint
    const res = await SELF.fetch(`https://worker.dev/ws?eventId=${eventIdB}&ticket=${ticketA}`, {
      method: 'GET',
      headers: {
        'Upgrade': 'websocket',
        'Origin': validOrigin,
      },
    });

    expect(res.status).toBe(401);
    const body = await res.text();
    expect(body).toBe('Invalid ticket');
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
  });

  it('6. Origin validation & CSWSH defense: unauthorized Origin rejected with 403; absent Origin allowed for tooling', async () => {
    const eventId = 'e2e-ws-origin-check';
    const stub = workerEnv.SEAT_LEDGER.get(workerEnv.SEAT_LEDGER.idFromName(eventId));
    await stub.initialize(10);

    // Disallowed browser origin
    const ticket1 = await stub.mintTicket('user-origin-1', 'test-org-1', eventId);
    const resForbidden = await SELF.fetch(`https://worker.dev/ws?eventId=${eventId}&ticket=${ticket1}`, {
      method: 'GET',
      headers: {
        'Upgrade': 'websocket',
        'Origin': disallowedOrigin,
      },
    });

    expect(resForbidden.status).toBe(403);
    const bodyForbidden = await resForbidden.text();
    expect(bodyForbidden).toBe('Invalid origin');
    expect(resForbidden.headers.get('X-Content-Type-Options')).toBe('nosniff');

    // Absent origin (e.g. non-browser automated test, CLI, or backend proxy)
    const ticket2 = await stub.mintTicket('user-origin-2', 'test-org-1', eventId);
    const resNoOrigin = await SELF.fetch(`https://worker.dev/ws?eventId=${eventId}&ticket=${ticket2}`, {
      method: 'GET',
      headers: {
        'Upgrade': 'websocket',
      },
    });

    expect(resNoOrigin.status).toBe(101);
  });
});
