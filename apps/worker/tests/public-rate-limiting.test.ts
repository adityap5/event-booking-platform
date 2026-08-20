import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import type { Env } from '../src/index.js';
import { setupTestDb, createTestCaller } from './test-helpers.js';
import { handleUpload } from '../src/handlers/upload.js';
import { TRPCError } from '@trpc/server';

describe('Public Read Procedures & /images/* Rate Limiting', () => {
  let db: Awaited<ReturnType<typeof setupTestDb>>;
  const workerEnv = env as unknown as Env;

  beforeEach(async () => {
    db = await setupTestDb(workerEnv.DB);
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
});
