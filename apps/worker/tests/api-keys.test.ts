import { describe, it, expect, beforeEach } from 'vitest';
import { SELF, env } from 'cloudflare:test';
import type { Env } from '../src/index.js';
import { setupTestDb, createTestCaller } from './test-helpers.js';
import { hashApiKey, API_KEY_PREFIX, generateApiKey } from '../src/services/api-key-service.js';
import { events, organisationApiKeys } from '@event-booking/shared';
import { eq, and, isNull } from 'drizzle-orm';
import { TRPCError } from '@trpc/server';

describe('API Key Lifecycle & Public Read-Only API', () => {
  const workerEnv = env as unknown as Env;

  beforeEach(async () => {
    await setupTestDb(workerEnv.DB);
  });

  describe('1. Organiser API Key Management (tRPC)', () => {
    it('generates a raw API key once, stores SHA-256 hash in D1, and key prefix', async () => {
      const db = await setupTestDb(workerEnv.DB);
      const caller = createTestCaller({
        env: workerEnv,
        db,
        userId: 'owner-1',
        orgId: 'test-org-1',
        role: 'organiser',
      });

      const res = await caller.generateApiKey();
      expect(res.rawKey).toBeDefined();
      expect(res.rawKey.startsWith(API_KEY_PREFIX)).toBe(true);
      expect(res.keyPrefix).toBeDefined();
      expect(res.keyPrefix.startsWith(API_KEY_PREFIX)).toBe(true);
      expect(res.keyPrefix.endsWith('...')).toBe(true);
      expect(res.createdAt).toBeTypeOf('number');

      // Assert directly against D1 database row
      const [row] = await db
        .select()
        .from(organisationApiKeys)
        .where(
          and(
            eq(organisationApiKeys.organisationId, 'test-org-1'),
            isNull(organisationApiKeys.revokedAt),
          ),
        );

      expect(row).toBeDefined();
      // Raw key must NEVER be stored in the database
      expect(row!.keyHash).not.toBe(res.rawKey);
      // Stored hash must match SHA-256 of the raw key
      const expectedHash = await hashApiKey(res.rawKey);
      expect(row!.keyHash).toBe(expectedHash);
      expect(row!.keyPrefix).toBe(res.keyPrefix);
    });

    it('getApiKeyInfo returns prefix and creation date, never the raw key or hash', async () => {
      const db = await setupTestDb(workerEnv.DB);
      const caller = createTestCaller({
        env: workerEnv,
        db,
        userId: 'owner-1',
        orgId: 'test-org-1',
        role: 'organiser',
      });

      // No key generated yet
      const beforeGen = await caller.getApiKeyInfo();
      expect(beforeGen).toBeNull();

      const genRes = await caller.generateApiKey();
      const info = await caller.getApiKeyInfo();

      expect(info).not.toBeNull();
      expect(info?.keyPrefix).toBe(genRes.keyPrefix);
      expect(info?.createdAt).toBe(genRes.createdAt);
      // Verify secrecy: no rawKey or keyHash fields
      expect((info as any).rawKey).toBeUndefined();
      expect((info as any).keyHash).toBeUndefined();
      expect((info as any).hash).toBeUndefined();
    });

    it('rotating API key revokes the existing active key and generates a replacement', async () => {
      const db = await setupTestDb(workerEnv.DB);
      const caller = createTestCaller({
        env: workerEnv,
        db,
        userId: 'owner-1',
        orgId: 'test-org-1',
        role: 'organiser',
      });

      const firstKey = await caller.generateApiKey();
      const rotatedKey = await caller.rotateApiKey();

      expect(rotatedKey.rawKey).not.toBe(firstKey.rawKey);

      // Verify in D1: first key has revoked_at set, rotated key has revoked_at IS NULL
      const rows = await db
        .select()
        .from(organisationApiKeys)
        .where(eq(organisationApiKeys.organisationId, 'test-org-1'));

      expect(rows.length).toBe(2);
      const activeRows = rows.filter((r) => r.revokedAt === null);
      const revokedRows = rows.filter((r) => r.revokedAt !== null);

      expect(activeRows.length).toBe(1);
      expect(revokedRows.length).toBe(1);

      const expectedFirstHash = await hashApiKey(firstKey.rawKey);
      const expectedRotatedHash = await hashApiKey(rotatedKey.rawKey);

      expect(revokedRows[0]!.keyHash).toBe(expectedFirstHash);
      expect(activeRows[0]!.keyHash).toBe(expectedRotatedHash);

      // Old key is rejected by the public API
      const oldKeyReq = new Request('https://worker.dev/api/v1/events', {
        headers: { Authorization: `Bearer ${firstKey.rawKey}` },
      });
      const oldKeyRes = await SELF.fetch(oldKeyReq);
      expect(oldKeyRes.status).toBe(401);

      // New key is accepted
      const newKeyReq = new Request('https://worker.dev/api/v1/events', {
        headers: { Authorization: `Bearer ${rotatedKey.rawKey}` },
      });
      const newKeyRes = await SELF.fetch(newKeyReq);
      expect(newKeyRes.status).toBe(200);
    });

    it('revoking API key soft-deletes the key and leaves org with no active key', async () => {
      const db = await setupTestDb(workerEnv.DB);
      const caller = createTestCaller({
        env: workerEnv,
        db,
        userId: 'owner-1',
        orgId: 'test-org-1',
        role: 'organiser',
      });

      const genRes = await caller.generateApiKey();
      await caller.revokeApiKey();

      const info = await caller.getApiKeyInfo();
      expect(info).toBeNull();

      // Public API rejects revoked key
      const req = new Request('https://worker.dev/api/v1/events', {
        headers: { Authorization: `Bearer ${genRes.rawKey}` },
      });
      const res = await SELF.fetch(req);
      expect(res.status).toBe(401);
      const body = (await res.json()) as { error: string };
      expect(body.error).toBe('Unauthorized');
    });

    it('enforces organiser role on all key-management procedures', async () => {
      const db = await setupTestDb(workerEnv.DB);

      // Non-organiser caller (e.g. attendee)
      const attendeeCaller = createTestCaller({
        env: workerEnv,
        db,
        userId: 'user-attendee-1',
        orgId: 'test-org-1',
        role: 'attendee',
      });

      await expect(attendeeCaller.generateApiKey()).rejects.toThrow(TRPCError);
      await expect(attendeeCaller.rotateApiKey()).rejects.toThrow(TRPCError);
      await expect(attendeeCaller.revokeApiKey()).rejects.toThrow(TRPCError);
      await expect(attendeeCaller.getApiKeyInfo()).rejects.toThrow(TRPCError);

      // Caller without an active organisation
      const noOrgCaller = createTestCaller({
        env: workerEnv,
        db,
        userId: 'user-no-org',
        orgId: null,
        role: null,
      });

      await expect(noOrgCaller.generateApiKey()).rejects.toThrow(TRPCError);
      await expect(noOrgCaller.rotateApiKey()).rejects.toThrow(TRPCError);
      await expect(noOrgCaller.revokeApiKey()).rejects.toThrow(TRPCError);
      await expect(noOrgCaller.getApiKeyInfo()).rejects.toThrow(TRPCError);
    });

    it('rotateApiKey rejects with CONFLICT if no active key exists', async () => {
      const db = await setupTestDb(workerEnv.DB);
      const caller = createTestCaller({
        env: workerEnv,
        db,
        userId: 'owner-1',
        orgId: 'test-org-1',
        role: 'organiser',
      });

      // Attempting to rotate when no active key exists must fail with CONFLICT
      await expect(caller.rotateApiKey()).rejects.toThrow(
        expect.objectContaining({
          code: 'CONFLICT',
          message: expect.stringContaining('No active API key exists'),
        }),
      );
    });

    it('generateApiKey rejects with CONFLICT if an active key already exists', async () => {
      const db = await setupTestDb(workerEnv.DB);
      const caller = createTestCaller({
        env: workerEnv,
        db,
        userId: 'owner-1',
        orgId: 'test-org-1',
        role: 'organiser',
      });

      // First generation succeeds
      const first = await caller.generateApiKey();
      expect(first.rawKey).toBeDefined();

      // Second generation attempt rejects with CONFLICT (must use rotateApiKey instead)
      await expect(caller.generateApiKey()).rejects.toThrow(
        expect.objectContaining({
          code: 'CONFLICT',
          message: expect.stringContaining('already exists'),
        }),
      );
    });

    it('handles concurrent first-time generateApiKey calls: exactly one succeeds, stale callers rejected with CONFLICT, active hash matches fulfilled rawKey', async () => {
      const db = await setupTestDb(workerEnv.DB);
      const caller = createTestCaller({
        env: workerEnv,
        db,
        userId: 'owner-1',
        orgId: 'test-org-1',
        role: 'organiser',
      });

      // Run multiple simultaneous first-time generateApiKey calls
      const promises = [
        caller.generateApiKey(),
        caller.generateApiKey(),
        caller.generateApiKey(),
      ];

      const results = await Promise.allSettled(promises);

      // Query the active key in D1
      const activeRows = await db
        .select()
        .from(organisationApiKeys)
        .where(
          and(
            eq(organisationApiKeys.organisationId, 'test-org-1'),
            isNull(organisationApiKeys.revokedAt),
          ),
        );

      // Invariant: Exactly one active key exists in D1
      expect(activeRows.length).toBe(1);
      const activeKeyRow = activeRows[0]!;

      const fulfilled = results.filter(
        (r): r is PromiseFulfilledResult<{ rawKey: string; keyPrefix: string; createdAt: number }> =>
          r.status === 'fulfilled',
      );
      const rejected = results.filter(
        (r): r is PromiseRejectedResult => r.status === 'rejected',
      );

      // Exactly ONE caller must succeed (no multiple successful callers returning dead keys)
      expect(fulfilled.length).toBe(1);
      expect(rejected.length).toBe(2);

      // The fulfilled caller's rawKey hash MUST equal the active row's keyHash in D1
      const winningRawKey = fulfilled[0]!.value.rawKey;
      const winningHash = await hashApiKey(winningRawKey);
      expect(winningHash).toBe(activeKeyRow.keyHash);

      // Every rejected promise MUST be a clean TRPCError CONFLICT without leaking internal DB error text
      for (const rej of rejected) {
        expect(rej.reason).toBeInstanceOf(TRPCError);
        const trpcErr = rej.reason as TRPCError;
        expect(trpcErr.code).toBe('CONFLICT');
        expect(trpcErr.message).not.toContain('SQLITE');
        expect(trpcErr.message).not.toContain('D1_ERROR');
      }
    });

    it('handles concurrent rotateApiKey calls: exactly one succeeds, stale callers rejected with CONFLICT, active hash matches fulfilled rawKey', async () => {
      const db = await setupTestDb(workerEnv.DB);
      const caller = createTestCaller({
        env: workerEnv,
        db,
        userId: 'owner-1',
        orgId: 'test-org-1',
        role: 'organiser',
      });

      // Establish initial active key K0
      const initialKey = await caller.generateApiKey();
      expect(initialKey.rawKey).toBeDefined();

      // Run multiple simultaneous rotateApiKey calls against the same active key K0
      const promises = [
        caller.rotateApiKey(),
        caller.rotateApiKey(),
        caller.rotateApiKey(),
      ];

      const results = await Promise.allSettled(promises);

      // Query the active key in D1
      const activeRows = await db
        .select()
        .from(organisationApiKeys)
        .where(
          and(
            eq(organisationApiKeys.organisationId, 'test-org-1'),
            isNull(organisationApiKeys.revokedAt),
          ),
        );

      // Invariant: Exactly one active key exists in D1
      expect(activeRows.length).toBe(1);
      const activeKeyRow = activeRows[0]!;

      const fulfilled = results.filter(
        (r): r is PromiseFulfilledResult<{ rawKey: string; keyPrefix: string; createdAt: number }> =>
          r.status === 'fulfilled',
      );
      const rejected = results.filter(
        (r): r is PromiseRejectedResult => r.status === 'rejected',
      );

      // Exactly ONE caller must succeed in rotating the observed key
      expect(fulfilled.length).toBe(1);
      expect(rejected.length).toBe(2);

      // The fulfilled caller's rawKey hash MUST equal the active row's keyHash in D1
      const winningRawKey = fulfilled[0]!.value.rawKey;
      const winningHash = await hashApiKey(winningRawKey);
      expect(winningHash).toBe(activeKeyRow.keyHash);

      // The initial key K0 must be revoked
      const initialHash = await hashApiKey(initialKey.rawKey);
      const [initialRow] = await db
        .select()
        .from(organisationApiKeys)
        .where(eq(organisationApiKeys.keyHash, initialHash));
      expect(initialRow?.revokedAt).not.toBeNull();

      // Every rejected caller receives a clean CONFLICT error
      for (const rej of rejected) {
        expect(rej.reason).toBeInstanceOf(TRPCError);
        const trpcErr = rej.reason as TRPCError;
        expect(trpcErr.code).toBe('CONFLICT');
        expect(trpcErr.message).not.toContain('SQLITE');
        expect(trpcErr.message).not.toContain('D1_ERROR');
      }

      // Public API authenticates the winning rotated key and rejects the initial key
      const winningApiRes = await SELF.fetch(
        new Request('https://worker.dev/api/v1/events', {
          headers: { Authorization: `Bearer ${winningRawKey}` },
        }),
      );
      expect(winningApiRes.status).toBe(200);

      const staleApiRes = await SELF.fetch(
        new Request('https://worker.dev/api/v1/events', {
          headers: { Authorization: `Bearer ${initialKey.rawKey}` },
        }),
      );
      expect(staleApiRes.status).toBe(401);
    });
  });

  describe('2. Public Read-Only API (GET /api/v1/events)', () => {
    let org1ApiKey: string;
    let org2ApiKey: string;

    beforeEach(async () => {
      const db = await setupTestDb(workerEnv.DB);

      // Seed API keys for two distinct organisations
      const org1Res = await generateApiKey(db, 'test-org-1');
      org1ApiKey = org1Res.rawKey;

      const org2Res = await generateApiKey(db, 'org-1');
      org2ApiKey = org2Res.rawKey;

      // Seed events for org 1: 2 future events, 1 past event
      const futureDate1 = new Date(Date.now() + 86400000 * 2);
      const futureDate2 = new Date(Date.now() + 86400000 * 5);
      const pastDate = new Date(Date.now() - 86400000 * 2);

      await db.insert(events).values([
        {
          id: 'org1-evt-future-1',
          organisationId: 'test-org-1',
          name: 'Org 1 Tech Talk',
          description: 'A great tech talk',
          date: futureDate1,
          totalSeats: 100,
          pricePerSeat: 1500,
          coverImageUrl: 'https://cdn.example.com/cover1.jpg',
        },
        {
          id: 'org1-evt-future-2',
          organisationId: 'test-org-1',
          name: 'Org 1 Workshop',
          description: 'Hands on workshop',
          date: futureDate2,
          totalSeats: 50,
          pricePerSeat: 3000,
          coverImageUrl: null,
        },
        {
          id: 'org1-evt-past',
          organisationId: 'test-org-1',
          name: 'Org 1 Past Conference',
          description: 'Last week conference',
          date: pastDate,
          totalSeats: 200,
          pricePerSeat: 5000,
          coverImageUrl: null,
        },
        // Seed event for org 2: 1 future event
        {
          id: 'org2-evt-future',
          organisationId: 'org-1',
          name: 'Org 2 Music Fest',
          description: 'Live music',
          date: futureDate1,
          totalSeats: 500,
          pricePerSeat: 2500,
          coverImageUrl: 'https://cdn.example.com/cover2.jpg',
        },
      ]);
    });

    it('returns only the authenticated organisation future events, excluding other organisations and past events', async () => {
      const req = new Request('https://worker.dev/api/v1/events', {
        headers: { Authorization: `Bearer ${org1ApiKey}` },
      });

      const res = await SELF.fetch(req);
      expect(res.status).toBe(200);
      expect(res.headers.get('Content-Type')).toContain('application/json');

      const data = (await res.json()) as {
        events: Array<{ id: string; name: string; date: number; totalSeats: number; pricePerSeat: number; coverImageUrl: string | null }>;
        pagination: { limit: number; offset: number; hasMore: boolean };
      };

      expect(data.events.length).toBe(2);
      const ids = data.events.map((e) => e.id);
      expect(ids).toContain('org1-evt-future-1');
      expect(ids).toContain('org1-evt-future-2');
      // Must not contain past event
      expect(ids).not.toContain('org1-evt-past');
      // Must not contain other organisation's event
      expect(ids).not.toContain('org2-evt-future');

      // Public safe fields only — no DO fanout, no availableSeats in list
      expect((data.events[0] as any).availableSeats).toBeUndefined();
      expect(data.events[0]!.id).toBe('org1-evt-future-1');
      expect(data.events[0]!.name).toBe('Org 1 Tech Talk');
      expect(data.events[0]!.totalSeats).toBe(100);
      expect(data.events[0]!.pricePerSeat).toBe(1500);
      expect(data.events[0]!.coverImageUrl).toBe('https://cdn.example.com/cover1.jpg');

      // Assert that org2's key returns org2's events only
      const reqOrg2 = new Request('https://worker.dev/api/v1/events', {
        headers: { Authorization: `Bearer ${org2ApiKey}` },
      });
      const resOrg2 = await SELF.fetch(reqOrg2);
      const dataOrg2 = (await resOrg2.json()) as any;
      expect(dataOrg2.events.length).toBe(1);
      expect(dataOrg2.events[0]!.id).toBe('org2-evt-future');
    });

    it('supports pagination parameters (limit, offset, hasMore) and clamps max limit to 100', async () => {
      // Test limit = 1
      const req1 = new Request('https://worker.dev/api/v1/events?limit=1&offset=0', {
        headers: { Authorization: `Bearer ${org1ApiKey}` },
      });
      const res1 = await SELF.fetch(req1);
      const data1 = (await res1.json()) as any;
      expect(data1.events.length).toBe(1);
      expect(data1.pagination.hasMore).toBe(true);
      expect(data1.pagination.limit).toBe(1);
      expect(data1.pagination.offset).toBe(0);

      // Test offset = 1
      const req2 = new Request('https://worker.dev/api/v1/events?limit=1&offset=1', {
        headers: { Authorization: `Bearer ${org1ApiKey}` },
      });
      const res2 = await SELF.fetch(req2);
      const data2 = (await res2.json()) as any;
      expect(data2.events.length).toBe(1);
      expect(data2.events[0].id).toBe('org1-evt-future-2');
      expect(data2.pagination.hasMore).toBe(false);

      // Test limit clamping: requesting 500 is clamped to 100
      const req3 = new Request('https://worker.dev/api/v1/events?limit=500&offset=0', {
        headers: { Authorization: `Bearer ${org1ApiKey}` },
      });
      const res3 = await SELF.fetch(req3);
      const data3 = (await res3.json()) as any;
      expect(data3.pagination.limit).toBe(100);
    });

    it('rejects missing or malformed Authorization header with generic 401 Unauthorized', async () => {
      // Missing header
      const reqNoAuth = new Request('https://worker.dev/api/v1/events');
      const resNoAuth = await SELF.fetch(reqNoAuth);
      expect(resNoAuth.status).toBe(401);
      expect(await resNoAuth.json()).toEqual({ error: 'Unauthorized' });

      // Malformed header (Basic instead of Bearer)
      const reqBasic = new Request('https://worker.dev/api/v1/events', {
        headers: { Authorization: 'Basic dXNlcjpwYXNz' },
      });
      const resBasic = await SELF.fetch(reqBasic);
      expect(resBasic.status).toBe(401);
      expect(await resBasic.json()).toEqual({ error: 'Unauthorized' });

      // Invalid / fabricated Bearer token
      const reqInvalid = new Request('https://worker.dev/api/v1/events', {
        headers: { Authorization: 'Bearer evbk_fake_key_1234567890abcdef' },
      });
      const resInvalid = await SELF.fetch(reqInvalid);
      expect(resInvalid.status).toBe(401);
      expect(await resInvalid.json()).toEqual({ error: 'Unauthorized' });
    });
  });

  describe('3. Single Event API (GET /api/v1/events/:id)', () => {
    let org1ApiKey: string;

    beforeEach(async () => {
      const db = await setupTestDb(workerEnv.DB);
      const org1Res = await generateApiKey(db, 'test-org-1');
      org1ApiKey = org1Res.rawKey;

      const futureDate = new Date(Date.now() + 86400000 * 2);
      const pastDate = new Date(Date.now() - 86400000 * 2);

      await db.insert(events).values([
        {
          id: 'org1-single-event',
          organisationId: 'test-org-1',
          name: 'Special Showcase',
          description: 'Detailed description of the showcase',
          date: futureDate,
          totalSeats: 50,
          pricePerSeat: 2000,
          coverImageUrl: 'https://cdn.example.com/showcase.jpg',
        },
        {
          id: 'org1-past-event',
          organisationId: 'test-org-1',
          name: 'Past Showcase',
          description: 'Showcase from last month',
          date: pastDate,
          totalSeats: 30,
          pricePerSeat: 1000,
          coverImageUrl: null,
        },
        {
          id: 'org2-secret-event',
          organisationId: 'org-1',
          name: 'Other Org Secret Event',
          description: 'Top secret',
          date: futureDate,
          totalSeats: 10,
          pricePerSeat: 9900,
          coverImageUrl: null,
        },
      ]);
    });

    it('returns event details composed with live availableSeats from SeatLedger DO', async () => {
      const req = new Request('https://worker.dev/api/v1/events/org1-single-event', {
        headers: { Authorization: `Bearer ${org1ApiKey}` },
      });

      const res = await SELF.fetch(req);
      expect(res.status).toBe(200);
      const data = (await res.json()) as any;

      expect(data.id).toBe('org1-single-event');
      expect(data.name).toBe('Special Showcase');
      expect(data.description).toBe('Detailed description of the showcase');
      expect(data.totalSeats).toBe(50);
      expect(data.availableSeats).toBe(50); // Uninitialized DO falls back to totalSeats
      expect(data.pricePerSeat).toBe(2000);
      expect(data.coverImageUrl).toBe('https://cdn.example.com/showcase.jpg');
      expect(data.organisationId).toBe('test-org-1');
    });

    it('allows returning past events belonging to the authenticated organisation', async () => {
      const req = new Request('https://worker.dev/api/v1/events/org1-past-event', {
        headers: { Authorization: `Bearer ${org1ApiKey}` },
      });

      const res = await SELF.fetch(req);
      expect(res.status).toBe(200);
      const data = (await res.json()) as any;
      expect(data.id).toBe('org1-past-event');
      expect(data.name).toBe('Past Showcase');
    });

    it('returns indistinguishable 404 for non-existent event and other organisation event', async () => {
      // Non-existent ID
      const reqNonExistent = new Request('https://worker.dev/api/v1/events/non-existent-uuid-1234', {
        headers: { Authorization: `Bearer ${org1ApiKey}` },
      });
      const resNonExistent = await SELF.fetch(reqNonExistent);
      expect(resNonExistent.status).toBe(404);
      const bodyNonExistent = await resNonExistent.json();

      // Other organisation's event ID
      const reqOtherOrg = new Request('https://worker.dev/api/v1/events/org2-secret-event', {
        headers: { Authorization: `Bearer ${org1ApiKey}` },
      });
      const resOtherOrg = await SELF.fetch(reqOtherOrg);
      expect(resOtherOrg.status).toBe(404);
      const bodyOtherOrg = await resOtherOrg.json();

      // Assert bodies and statuses are exactly identical (preventing org enumeration)
      expect(bodyNonExistent).toEqual({ error: 'Not Found' });
      expect(bodyOtherOrg).toEqual({ error: 'Not Found' });
      expect(bodyOtherOrg).toEqual(bodyNonExistent);
    });
  });

  describe('4. Permissive CORS & Route Isolation', () => {
    it('returns permissive Access-Control-Allow-Origin: * on OPTIONS preflight for public API', async () => {
      const req = new Request('https://worker.dev/api/v1/events', {
        method: 'OPTIONS',
      });
      const res = await SELF.fetch(req);
      expect(res.status).toBe(204);
      expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*');
      expect(res.headers.get('Access-Control-Allow-Methods')).toContain('GET');
      expect(res.headers.get('Access-Control-Allow-Methods')).toContain('OPTIONS');
      expect(res.headers.get('Access-Control-Allow-Headers')).toContain('Authorization');
    });

    it('returns Access-Control-Allow-Origin: * on GET /api/v1/events', async () => {
      const db = await setupTestDb(workerEnv.DB);
      const { rawKey } = await generateApiKey(db, 'test-org-1');

      const req = new Request('https://worker.dev/api/v1/events', {
        headers: { Authorization: `Bearer ${rawKey}` },
      });
      const res = await SELF.fetch(req);
      expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*');
    });

    it('preserves restricted application CORS for tRPC and does not expose *', async () => {
      const req = new Request('https://worker.dev/trpc/listPublicEvents', {
        method: 'OPTIONS',
        headers: { Origin: 'https://malicious-site.com' },
      });
      const res = await SELF.fetch(req);
      // Restricted origin should not be *
      expect(res.headers.get('Access-Control-Allow-Origin')).not.toBe('*');
      expect(res.headers.get('Access-Control-Allow-Origin')).toBe('https://event-booking-web.aditya29.workers.dev');
    });
  });

  describe('5. Rate Limiting on Public API', () => {
    it('rate limits public API requests per API key (300 req / 60s)', async () => {
      const db = await setupTestDb(workerEnv.DB);
      const { rawKey } = await generateApiKey(db, 'test-org-1');

      // The limit is 300; let's verify that when checkLimit returns allowed: false, 429 is returned
      // We can directly exhaust or simulate by making requests
      const [keyRow] = await db
        .select()
        .from(organisationApiKeys)
        .where(eq(organisationApiKeys.organisationId, 'test-org-1'));

      expect(keyRow).toBeDefined();

      const limiterStub = workerEnv.RATE_LIMITER.get(
        workerEnv.RATE_LIMITER.idFromName(keyRow!.id),
      );

      // Await all 300 calls and assert every single call is allowed with correct remaining quota
      for (let i = 0; i < 300; i++) {
        const check = await limiterStub.checkLimit('publicApi', 300, 60_000);
        expect(check.allowed).toBe(true);
        expect(check.remaining).toBe(300 - 1 - i);
      }

      // 301st request should be rejected with 429
      const req = new Request('https://worker.dev/api/v1/events', {
        headers: { Authorization: `Bearer ${rawKey}` },
      });
      const res = await SELF.fetch(req);
      expect(res.status).toBe(429);
      const body = (await res.json()) as { error: string };
      expect(body.error).toBe('Too Many Requests');
    }, 25000);
  });
});
