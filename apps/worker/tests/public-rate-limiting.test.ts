import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { env } from 'cloudflare:test';
import type { Env } from '../src/index.js';
import { setupTestDb, createTestCaller } from './test-helpers.js';
import { handleUpload } from '../src/handlers/upload.js';
import { handlePublicApi } from '../src/handlers/public-api.js';
import * as apiKeyService from '../src/services/api-key-service.js';
import { TRPCError } from '@trpc/server';

describe('Public Read Procedures & /images/* Rate Limiting', () => {
  let db: Awaited<ReturnType<typeof setupTestDb>>;
  const workerEnv = env as unknown as Env;

  beforeEach(async () => {
    vi.restoreAllMocks();
    db = await setupTestDb(workerEnv.DB);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('shared-bucket proof & IP-keying proof for public read procedures', async () => {
    const ipA = '198.51.100.1';
    const callerIpA = createTestCaller({ env: workerEnv, db, ip: ipA });

    // Seed an event in DB so getPublicEvent has a valid ID to target if needed
    const orgOwnerCaller = createTestCaller({
      env: workerEnv,
      db,
      userId: 'org-owner-seed',
      orgId: 'org-1',
      role: 'organiser',
    });
    const createdEvent = await orgOwnerCaller.createEvent({
      name: 'Rate Limit Test Event',
      date: Date.now() + 86400000,
      totalSeats: 100,
      pricePerSeat: 1000,
    });
    const eventId = createdEvent!.id;

    // 1. Make 60 requests split between listPublicEvents (30 calls) and getAvailableSeats (30 calls) for IP A
    for (let i = 0; i < 30; i++) {
      const publicEvents = await callerIpA.listPublicEvents();
      expect(Array.isArray(publicEvents)).toBe(true);
    }
    for (let i = 0; i < 30; i++) {
      const available = await callerIpA.getAvailableSeats({ eventId });
      expect(typeof available).toBe('number');
    }

    // 2. The 61st request from IP A (calling getPublicEvent) must be rejected with TRPCError TOO_MANY_REQUESTS
    await expect(callerIpA.getPublicEvent({ eventId })).rejects.toThrowError(
      new TRPCError({
        code: 'TOO_MANY_REQUESTS',
        message: 'Too many requests. Please try again shortly.',
      })
    );

    // 3. IP-keying proof: A request from IP B (198.51.100.2) must succeed immediately
    const ipB = '198.51.100.2';
    const callerIpB = createTestCaller({ env: workerEnv, db, ip: ipB });
    const eventForIpB = await callerIpB.getPublicEvent({ eventId });
    expect(eventForIpB.id).toBe(eventId);
  });

  it('image endpoint boundary: allows 120 GET /images/* calls per IP, rejects 121st with 429', async () => {
    const testIp = '203.0.113.1';

    // Make 120 calls to GET /images/non-existent-key with CF-Connecting-IP
    for (let i = 0; i < 120; i++) {
      const req = new Request('https://worker.dev/images/non-existent-cover', {
        method: 'GET',
        headers: { 'CF-Connecting-IP': testIp },
      });
      const res = await handleUpload(req, workerEnv);
      // Returns 404 because key does not exist in R2, but passes rate limiter (allowed: true)
      expect(res?.status).toBe(404);
    }

    // 121st call from the same IP must be blocked by rate limiter with 429
    const req121 = new Request('https://worker.dev/images/non-existent-cover', {
      method: 'GET',
      headers: { 'CF-Connecting-IP': testIp },
    });
    const res121 = await handleUpload(req121, workerEnv);
    expect(res121?.status).toBe(429);
    const body121 = await res121?.text();
    expect(body121).toBe('Too many requests. Please try again shortly.');
  });

  it('missing-header fallback: rate limits requests without CF-Connecting-IP using unknown-ip bucket', async () => {
    // Make 120 GET /images/* requests with NO CF-Connecting-IP header at all
    for (let i = 0; i < 120; i++) {
      const req = new Request('https://worker.dev/images/fallback-check', {
        method: 'GET',
      });
      const res = await handleUpload(req, workerEnv);
      expect(res?.status).toBe(404);
    }

    // 121st request without CF-Connecting-IP header must fall back to 'unknown-ip' and be rate-limited (429)
    const req121 = new Request('https://worker.dev/images/fallback-check', {
      method: 'GET',
    });
    const res121 = await handleUpload(req121, workerEnv);
    expect(res121?.status).toBe(429);
    const body121 = await res121?.text();
    expect(body121).toBe('Too many requests. Please try again shortly.');
  });

  // ── Public API Pre-Authentication IP Rate Limiting ────────────────────────

  describe('Public API Pre-Authentication IP Rate Limiting (GET /api/v1/events)', () => {
    it('invalid API-key burst from one IP: allows up to 300 requests, rejects 301st with 429 and skips authenticateApiKey & D1 lookup', async () => {
      const testIp = '203.0.113.50';
      const authSpy = vi.spyOn(apiKeyService, 'authenticateApiKey');

      // Send initial burst of requests using distinct invalid API keys with valid evbk_ prefix from testIp
      for (let i = 0; i < 5; i++) {
        const req = new Request('https://worker.dev/api/v1/events', {
          method: 'GET',
          headers: {
            Authorization: `Bearer evbk_invalid_random_key_${i}`,
            'CF-Connecting-IP': testIp,
          },
        });
        const res = await handlePublicApi(req, workerEnv);
        // Each request passes IP rate limiter and is rejected by authenticateApiKey with 401
        expect(res?.status).toBe(401);
      }

      // Exactly 5 calls made to authenticateApiKey so far
      expect(authSpy).toHaveBeenCalledTimes(5);

      // Advance the IP's RateLimiter DO to count 299 (294 additional checks)
      const ipLimiter = workerEnv.RATE_LIMITER.get(
        workerEnv.RATE_LIMITER.idFromName(testIp),
      );
      for (let i = 5; i < 299; i++) {
        const check = await ipLimiter.checkLimit('publicApiPreAuth', 300, 60_000);
        expect(check.allowed).toBe(true);
      }

      // The 300th request (boundary) must still be allowed through the IP limiter to authenticateApiKey (returns 401)
      const req300 = new Request('https://worker.dev/api/v1/events', {
        method: 'GET',
        headers: {
          Authorization: 'Bearer evbk_invalid_random_key_299',
          'CF-Connecting-IP': testIp,
        },
      });
      const res300 = await handlePublicApi(req300, workerEnv);
      expect(res300?.status).toBe(401);
      expect(authSpy).toHaveBeenCalledTimes(6); // Incremented from 5 to 6

      // The 301st request from the same IP must be rejected by the IP rate limiter with 429
      const req301 = new Request('https://worker.dev/api/v1/events', {
        method: 'GET',
        headers: {
          Authorization: 'Bearer evbk_invalid_random_key_300',
          'CF-Connecting-IP': testIp,
        },
      });
      const res301 = await handlePublicApi(req301, workerEnv);
      expect(res301?.status).toBe(429);
      const body301 = (await res301?.json()) as { error: string };
      expect(body301).toEqual({ error: 'Too Many Requests' });

      // Crucial security invariant: authenticateApiKey was NOT called on the 301st request
      // (call count remains 6, proving no SHA-256 hash or D1 lookup occurred)
      expect(authSpy).toHaveBeenCalledTimes(6);
    }, 30000);

    it('different IPs are independently bucketed: IP B is not blocked when IP A is exhausted', async () => {
      const ipA = '203.0.113.60';
      const ipB = '203.0.113.61';

      // Exhaust IP A quota via RateLimiter DO
      const limiterStubA = workerEnv.RATE_LIMITER.get(
        workerEnv.RATE_LIMITER.idFromName(ipA),
      );
      for (let i = 0; i < 300; i++) {
        const check = await limiterStubA.checkLimit('publicApiPreAuth', 300, 60_000);
        expect(check.allowed).toBe(true);
      }

      // IP A is now rate-limited on the 301st HTTP request (429)
      const reqA301 = new Request('https://worker.dev/api/v1/events', {
        method: 'GET',
        headers: {
          Authorization: 'Bearer evbk_invalid_key_a_300',
          'CF-Connecting-IP': ipA,
        },
      });
      const resA301 = await handlePublicApi(reqA301, workerEnv);
      expect(resA301?.status).toBe(429);

      // IP B must NOT be blocked — its request passes the IP limiter (returns 401 for invalid key)
      const reqB = new Request('https://worker.dev/api/v1/events', {
        method: 'GET',
        headers: {
          Authorization: 'Bearer evbk_invalid_key_b_1',
          'CF-Connecting-IP': ipB,
        },
      });
      const resB = await handlePublicApi(reqB, workerEnv);
      expect(resB?.status).toBe(401);
    }, 30000);

    it('missing-header fallback: rate limits public API requests without CF-Connecting-IP using unknown-ip bucket', async () => {
      // Exhaust 'unknown-ip' quota via RateLimiter DO
      const unknownLimiter = workerEnv.RATE_LIMITER.get(
        workerEnv.RATE_LIMITER.idFromName('unknown-ip'),
      );
      for (let i = 0; i < 300; i++) {
        const check = await unknownLimiter.checkLimit('publicApiPreAuth', 300, 60_000);
        expect(check.allowed).toBe(true);
      }

      // 301st request without header falls back to 'unknown-ip' and is rate-limited (429)
      const req301 = new Request('https://worker.dev/api/v1/events', {
        method: 'GET',
        headers: {
          Authorization: 'Bearer evbk_invalid_missing_hdr_300',
        },
      });
      const res301 = await handlePublicApi(req301, workerEnv);
      expect(res301?.status).toBe(429);
      const body301 = (await res301?.json()) as { error: string };
      expect(body301).toEqual({ error: 'Too Many Requests' });
    }, 30000);
  });
});

