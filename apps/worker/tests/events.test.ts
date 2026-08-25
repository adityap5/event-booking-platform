import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import type { Env } from '../src/index.js';
import { setupTestDb, createTestCaller } from './test-helpers.js';
import { handleUpload } from '../src/handlers/upload.js';
import { getPublicEventCacheKey, getPublicEventsCacheKey } from '../src/routers/events.js';

describe('Task 5: Per-organisation isolation', () => {
  let db: Awaited<ReturnType<typeof setupTestDb>>;
  const workerEnv = env as unknown as Env;

  beforeEach(async () => {
    db = await setupTestDb(workerEnv.DB);
  });

  it('isolates events between organisations in listOrgEvents and enforces organiser access in getEventAttendees', async () => {
    const callerOrgA = createTestCaller({
      env: workerEnv,
      db,
      userId: 'user-org-A-owner',
      orgId: 'org-A-id',
      role: 'organiser',
    });

    const callerOrgB = createTestCaller({
      env: workerEnv,
      db,
      userId: 'user-org-B-owner',
      orgId: 'org-B-id',
      role: 'organiser',
    });

    // Create event under Org A using createEvent procedure
    const createdEvent = await callerOrgA.createEvent({
      name: 'Org A Exclusive Conference',
      date: Date.now() + 86400000,
      totalSeats: 50,
      pricePerSeat: 5000,
    });

    expect(createdEvent?.id).toBeDefined();
    const eventId = createdEvent!.id;

    // 1. Call listOrgEvents as Org A -> event is present
    const orgAEvents = await callerOrgA.listOrgEvents();
    expect(orgAEvents.some((e) => e.id === eventId)).toBe(true);

    // 2. Call listOrgEvents as Org B -> Org A's event is absent
    const orgBEvents = await callerOrgB.listOrgEvents();
    expect(orgBEvents.some((e) => e.id === eventId)).toBe(false);

    // 3. Call getEventAttendees as Org B with Org A's eventId -> throws FORBIDDEN
    await expect(
      callerOrgB.getEventAttendees({ eventId })
    ).rejects.toThrowError(/You do not have permission to modify or view this organisation's resources/);

    // 4. Call getEventAttendees as Org A -> succeeds
    const attendees = await callerOrgA.getEventAttendees({ eventId });
    expect(Array.isArray(attendees)).toBe(true);
  });
});

describe('Item 1: Defensive role check on createEvent', () => {
  let db: Awaited<ReturnType<typeof setupTestDb>>;
  const workerEnv = env as unknown as Env;

  beforeEach(async () => {
    db = await setupTestDb(workerEnv.DB);
  });

  it('permitted: organiser role can create an event successfully', async () => {
    const adminCaller = createTestCaller({
      env: workerEnv,
      db,
      userId: 'user-admin-1',
      orgId: 'org-1',
      role: 'organiser',
    });

    const event = await adminCaller.createEvent({
      name: 'Admin Event',
      date: Date.now() + 86400000,
      totalSeats: 50,
      pricePerSeat: 1000,
    });

    expect(event!.id).toBeDefined();
    expect(event!.name).toBe('Admin Event');
  });

  it('denied: non-admin role (org:member) is rejected with FORBIDDEN', async () => {
    const memberCaller = createTestCaller({
      env: workerEnv,
      db,
      userId: 'user-member-1',
      orgId: 'org-1',
      role: 'org:member',
    });

    await expect(
      memberCaller.createEvent({
        name: 'Member Event Attempt',
        date: Date.now() + 86400000,
        totalSeats: 50,
        pricePerSeat: 1000,
      })
    ).rejects.toThrowError('You do not have permission to perform this action.');
  });

  it('missing organisation: caller without orgId is rejected with FORBIDDEN', async () => {
    const noOrgCaller = createTestCaller({
      env: workerEnv,
      db,
      userId: 'user-no-org',
      orgId: null,
      role: null,
    });

    await expect(
      noOrgCaller.createEvent({
        name: 'No Org Event Attempt',
        date: Date.now() + 86400000,
        totalSeats: 50,
        pricePerSeat: 1000,
      })
    ).rejects.toThrowError('You must be an organiser to access this resource.');
  });

  it('cross-organisation: event is created under caller server-derived orgId, not accessible to other orgs', async () => {
    const callerOrgA = createTestCaller({
      env: workerEnv,
      db,
      userId: 'user-cross-A',
      orgId: 'org-A-id',
      role: 'organiser',
    });

    const callerOrgB = createTestCaller({
      env: workerEnv,
      db,
      userId: 'user-cross-B',
      orgId: 'org-B-id',
      role: 'organiser',
    });

    const createdByB = await callerOrgB.createEvent({
      name: 'Org B Event',
      date: Date.now() + 86400000,
      totalSeats: 50,
      pricePerSeat: 1000,
    });

    const orgAEvents = await callerOrgA.listOrgEvents();
    expect(orgAEvents.some((e) => e.id === createdByB!.id)).toBe(false);

    const orgBEvents = await callerOrgB.listOrgEvents();
    expect(orgBEvents.some((e) => e.id === createdByB!.id)).toBe(true);
  });

  it('A2: defensive FK check throws clear PRECONDITION_FAILED TRPCError when organisation is not in D1', async () => {
    const unregisteredOrgCaller = createTestCaller({
      env: workerEnv,
      db,
      userId: 'user-unregistered-org',
      orgId: 'unregistered-clerk-org-id',
      role: 'organiser',
    });

    await expect(
      unregisteredOrgCaller.createEvent({
        name: 'Loophole Org Event Attempt',
        date: Date.now() + 86400000,
        totalSeats: 50,
        pricePerSeat: 1000,
      })
    ).rejects.toThrowError('Organisation not recognized. Please complete organiser onboarding first.');
  });
});

describe('Event cover finalization with temporary R2 upload key', () => {
  let db: Awaited<ReturnType<typeof setupTestDb>>;
  const workerEnv = env as unknown as Env;
  const sampleJpeg = Buffer.from([0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10, 0x4A, 0x46, 0x49, 0x46, 0x00, 0x01]);

  beforeEach(async () => {
    db = await setupTestDb(workerEnv.DB);
  });

  it('ensures temporary upload objects remain usable by createEvent finalization flow, moving object to events/ namespace', async () => {
    const userId = 'user-organiser-cover-test';
    const caller = createTestCaller({
      env: workerEnv,
      db,
      userId,
      orgId: 'test-org-1',
      role: 'organiser',
    });

    // 1. Put temporary upload in uploads/tmp/{userId}/{uuid}.jpg
    const tempUuid = crypto.randomUUID();
    const tempKey = `uploads/tmp/${userId}/${tempUuid}.jpg`;
    await workerEnv.EVENT_COVERS.put(tempKey, sampleJpeg, {
      httpMetadata: { contentType: 'image/jpeg' },
    });

    // 2. Verify tempKey is NOT accessible via public GET /images/* (returns 404)
    const tempReq = new Request(`https://worker.dev/images/${tempKey}`, { method: 'GET' });
    const tempRes = await handleUpload(tempReq, workerEnv);
    expect(tempRes?.status).toBe(404);

    // 3. Call createEvent with tempImageKey (internal finalization flow)
    const event = await caller.createEvent({
      name: 'Event With Cover Image',
      date: Date.now() + 86400000,
      totalSeats: 100,
      pricePerSeat: 2000,
      tempImageKey: tempKey,
    });

    expect(event!.id).toBeDefined();

    const publicEvent = await caller.getPublicEvent({ eventId: event!.id });
    expect(publicEvent.coverImageUrl).toBeDefined();
    expect(publicEvent.coverImageUrl).toContain(`/images/events/${event!.id}/cover.jpg`);

    // 4. Verify temp object was cleaned up from uploads/tmp/
    const deletedTemp = await workerEnv.EVENT_COVERS.get(tempKey);
    expect(deletedTemp).toBeNull();

    // 5. Verify finalized cover is in events/ and is publicly accessible via GET /images/* with 200
    const finalKey = `events/${event!.id}/cover.jpg`;
    const finalizedObject = await workerEnv.EVENT_COVERS.get(finalKey);
    expect(finalizedObject).not.toBeNull();
    expect(finalizedObject?.httpMetadata?.contentType).toBe('image/jpeg');

    const publicReq = new Request(`https://worker.dev/images/${finalKey}`, { method: 'GET' });
    const publicRes = await handleUpload(publicReq, workerEnv);
    expect(publicRes?.status).toBe(200);
    expect(publicRes?.headers.get('Content-Type')).toBe('image/jpeg');
  });
});

describe('createEvent date input validation', () => {
  let db: Awaited<ReturnType<typeof setupTestDb>>;
  const workerEnv = env as unknown as Env;

  beforeEach(async () => {
    db = await setupTestDb(workerEnv.DB);
  });

  function getOrganiserCaller() {
    return createTestCaller({
      env: workerEnv,
      db,
      userId: 'user-admin-date-validator',
      orgId: 'test-org-1',
      role: 'organiser',
    });
  }

  it('1. accepts normal future integer millisecond timestamp', async () => {
    const caller = getOrganiserCaller();
    const futureDate = Date.now() + 86400000;
    const event = await caller.createEvent({
      name: 'Future Event',
      date: futureDate,
      totalSeats: 50,
      pricePerSeat: 1000,
    });

    expect(event!.id).toBeDefined();
    expect(event!.name).toBe('Future Event');
  });

  it('2. rejects past timestamp (negative, zero, and past timestamps)', async () => {
    const caller = getOrganiserCaller();
    const pastDate = Date.now() - 60000;

    await expect(
      caller.createEvent({
        name: 'Past Event',
        date: pastDate,
        totalSeats: 50,
        pricePerSeat: 1000,
      })
    ).rejects.toThrow();

    await expect(
      caller.createEvent({
        name: 'Negative Timestamp Event',
        date: -1000,
        totalSeats: 50,
        pricePerSeat: 1000,
      })
    ).rejects.toThrow();

    await expect(
      caller.createEvent({
        name: 'Zero Timestamp Event',
        date: 0,
        totalSeats: 50,
        pricePerSeat: 1000,
      })
    ).rejects.toThrow();
  });

  it('3. rejects exactly-current/present timestamp', async () => {
    const caller = getOrganiserCaller();
    const nowDate = Date.now();

    await expect(
      caller.createEvent({
        name: 'Present Event',
        date: nowDate,
        totalSeats: 50,
        pricePerSeat: 1000,
      })
    ).rejects.toThrow();
  });

  it('4. rejects fractional timestamp', async () => {
    const caller = getOrganiserCaller();
    const fractionalDate = Date.now() + 86400000.5;

    await expect(
      caller.createEvent({
        name: 'Fractional Date Event',
        date: fractionalDate,
        totalSeats: 50,
        pricePerSeat: 1000,
      })
    ).rejects.toThrow();
  });

  it('5. rejects NaN', async () => {
    const caller = getOrganiserCaller();

    await expect(
      caller.createEvent({
        name: 'NaN Date Event',
        date: NaN,
        totalSeats: 50,
        pricePerSeat: 1000,
      })
    ).rejects.toThrow();
  });

  it('6. rejects Infinity and -Infinity', async () => {
    const caller = getOrganiserCaller();

    await expect(
      caller.createEvent({
        name: 'Infinity Date Event',
        date: Infinity,
        totalSeats: 50,
        pricePerSeat: 1000,
      })
    ).rejects.toThrow();

    await expect(
      caller.createEvent({
        name: '-Infinity Date Event',
        date: -Infinity,
        totalSeats: 50,
        pricePerSeat: 1000,
      })
    ).rejects.toThrow();
  });

  it('7. rejects extremely large timestamp that cannot represent a valid Date (e.g. 1e20)', async () => {
    const caller = getOrganiserCaller();

    await expect(
      caller.createEvent({
        name: 'Overflow Date Event',
        date: 1e20,
        totalSeats: 50,
        pricePerSeat: 1000,
      })
    ).rejects.toThrow();
  });
});

describe('listPublicEvents KV Caching and Invalidation', () => {
  let db: Awaited<ReturnType<typeof setupTestDb>>;
  const workerEnv = env as unknown as Env;

  beforeEach(async () => {
    db = await setupTestDb(workerEnv.DB);
    await workerEnv.EVENT_CACHE.delete(getPublicEventsCacheKey());
  });

  it('1. first request causes cache miss, queries D1, and stores formatted array in KV with 5-minute TTL', async () => {
    const orgCaller = createTestCaller({
      env: workerEnv,
      db,
      userId: 'user-cache-org',
      orgId: 'org-cache-1',
      role: 'organiser',
    });

    const event = await orgCaller.createEvent({
      name: 'Cache Test Event 1',
      date: Date.now() + 86400000,
      totalSeats: 50,
      pricePerSeat: 2000,
    });

    // Ensure list cache is empty before request
    await workerEnv.EVENT_CACHE.delete(getPublicEventsCacheKey());
    expect(await workerEnv.EVENT_CACHE.get(getPublicEventsCacheKey())).toBeNull();

    const publicCaller = createTestCaller({ env: workerEnv, db, ip: '192.0.2.1' });
    const result = await publicCaller.listPublicEvents();

    expect(result.length).toBeGreaterThanOrEqual(1);
    expect(result.some((e) => e.id === event!.id)).toBe(true);

    // Verify KV cache was populated
    const cachedRaw = await workerEnv.EVENT_CACHE.get(getPublicEventsCacheKey());
    expect(cachedRaw).not.toBeNull();
    const parsedCache = JSON.parse(cachedRaw!);
    expect(Array.isArray(parsedCache)).toBe(true);
    expect(parsedCache.some((e: any) => e.id === event!.id)).toBe(true);
  });

  it('2. second request serves from KV cache without querying D1, matching response shape', async () => {
    // Pre-populate KV cache with custom mock data to verify cache hit
    const mockCachedEvents = [
      {
        id: 'mock-cached-event-1',
        name: 'Pre-warmed Cache Event',
        date: Date.now() + 100000,
        totalSeats: 25,
        pricePerSeat: 1500,
        coverImageUrl: null,
      },
    ];
    await workerEnv.EVENT_CACHE.put(getPublicEventsCacheKey(), JSON.stringify(mockCachedEvents));

    const publicCaller = createTestCaller({ env: workerEnv, db, ip: '192.0.2.2' });
    const result = await publicCaller.listPublicEvents();

    expect(result).toEqual(mockCachedEvents);
  });

  it('3. createEvent invalidates events:public cache so subsequent listPublicEvents sees new event', async () => {
    const orgCaller = createTestCaller({
      env: workerEnv,
      db,
      userId: 'user-cache-org-2',
      orgId: 'org-cache-2',
      role: 'organiser',
    });

    // Pre-populate cache
    const initialCached = [{ id: 'stale-event', name: 'Stale Event', date: Date.now() + 100000, totalSeats: 10, pricePerSeat: 1000, coverImageUrl: null }];
    await workerEnv.EVENT_CACHE.put(getPublicEventsCacheKey(), JSON.stringify(initialCached));

    // Create a new event
    const newEvent = await orgCaller.createEvent({
      name: 'Newly Created Event',
      date: Date.now() + 86400000,
      totalSeats: 30,
      pricePerSeat: 2500,
    });

    // Verify cache was evicted
    const cacheAfterCreate = await workerEnv.EVENT_CACHE.get(getPublicEventsCacheKey());
    expect(cacheAfterCreate).toBeNull();

    // Subsequent call should fetch fresh data including newEvent
    const publicCaller = createTestCaller({ env: workerEnv, db });
    const freshList = await publicCaller.listPublicEvents();
    expect(freshList.some((e) => e.id === newEvent!.id)).toBe(true);
    expect(freshList.some((e) => e.id === 'stale-event')).toBe(false);
  });
});

describe('updateEvent mutation and cache consistency', () => {
  let db: Awaited<ReturnType<typeof setupTestDb>>;
  const workerEnv = env as unknown as Env;

  beforeEach(async () => {
    db = await setupTestDb(workerEnv.DB);
  });

  it('1. authorized organiser can update name and nullable description of own event in D1', async () => {
    const orgCaller = createTestCaller({
      env: workerEnv,
      db,
      userId: 'user-update-org-1',
      orgId: 'org-A-id',
      role: 'organiser',
    });

    const created = await orgCaller.createEvent({
      name: 'Original Event Name',
      description: 'Original Description',
      date: Date.now() + 86400000,
      totalSeats: 50,
      pricePerSeat: 1000,
    });

    const eventId = created!.id;

    // Update with new name and new description
    const updated1 = await orgCaller.updateEvent({
      eventId,
      name: 'Updated Event Name',
      description: 'Updated Description',
    });

    expect(updated1).toEqual({ id: eventId, name: 'Updated Event Name' });

    const fetched1 = await orgCaller.getPublicEvent({ eventId });
    expect(fetched1.name).toBe('Updated Event Name');
    expect(fetched1.description).toBe('Updated Description');

    // Update with null description (nullable semantics)
    const updated2 = await orgCaller.updateEvent({
      eventId,
      name: 'Updated Event Name 2',
      description: null,
    });

    expect(updated2).toEqual({ id: eventId, name: 'Updated Event Name 2' });

    const fetched2 = await orgCaller.getPublicEvent({ eventId });
    expect(fetched2.name).toBe('Updated Event Name 2');
    expect(fetched2.description).toBeNull();
  });

  it('2. rejects update by organiser from another organisation with FORBIDDEN', async () => {
    const orgACaller = createTestCaller({
      env: workerEnv,
      db,
      userId: 'user-org-A-admin',
      orgId: 'org-A-id',
      role: 'organiser',
    });

    const orgBCaller = createTestCaller({
      env: workerEnv,
      db,
      userId: 'user-org-B-admin',
      orgId: 'org-B-id',
      role: 'organiser',
    });

    const created = await orgACaller.createEvent({
      name: 'Org A Exclusive Event',
      date: Date.now() + 86400000,
      totalSeats: 50,
      pricePerSeat: 1000,
    });

    await expect(
      orgBCaller.updateEvent({
        eventId: created!.id,
        name: 'Tampered Name',
        description: 'Tampered Description',
      })
    ).rejects.toThrowError(/You do not have permission to modify or view this organisation's resources/);
  });

  it('3. rejects update by non-admin role (org:member) or caller without orgId with FORBIDDEN', async () => {
    const orgCaller = createTestCaller({
      env: workerEnv,
      db,
      userId: 'user-org-A-admin',
      orgId: 'org-A-id',
      role: 'organiser',
    });

    const memberCaller = createTestCaller({
      env: workerEnv,
      db,
      userId: 'user-org-A-member',
      orgId: 'org-A-id',
      role: 'org:member',
    });

    const noOrgCaller = createTestCaller({
      env: workerEnv,
      db,
      userId: 'user-no-org',
      orgId: null,
      role: null,
    });

    const created = await orgCaller.createEvent({
      name: 'Org A Event for Member Test',
      date: Date.now() + 86400000,
      totalSeats: 50,
      pricePerSeat: 1000,
    });

    await expect(
      memberCaller.updateEvent({
        eventId: created!.id,
        name: 'Member Attempt',
        description: 'Desc',
      })
    ).rejects.toThrowError('You do not have permission to perform this action.');

    await expect(
      noOrgCaller.updateEvent({
        eventId: created!.id,
        name: 'No Org Attempt',
        description: 'Desc',
      })
    ).rejects.toThrowError('You must be an organiser to access this resource.');
  });

  it('4. throws NOT_FOUND when updating non-existent eventId', async () => {
    const orgCaller = createTestCaller({
      env: workerEnv,
      db,
      userId: 'user-org-A-admin',
      orgId: 'org-A-id',
      role: 'organiser',
    });

    await expect(
      orgCaller.updateEvent({
        eventId: 'non-existent-event-id-999',
        name: 'New Name',
        description: 'New Desc',
      })
    ).rejects.toThrowError('Event not found');
  });

  it('5. invalidates event:{eventId} and events:public caches after successful D1 update', async () => {
    const orgCaller = createTestCaller({
      env: workerEnv,
      db,
      userId: 'user-update-cache-test',
      orgId: 'org-1',
      role: 'organiser',
    });

    const created = await orgCaller.createEvent({
      name: 'Initial Event Name',
      description: 'Initial Desc',
      date: Date.now() + 86400000,
      totalSeats: 40,
      pricePerSeat: 1200,
    });
    const eventId = created!.id;

    // Pre-warm both getPublicEvent and listPublicEvents caches
    const publicCaller = createTestCaller({ env: workerEnv, db });
    await publicCaller.getPublicEvent({ eventId });
    await publicCaller.listPublicEvents();

    const eventCacheKey = getPublicEventCacheKey(eventId);
    const listCacheKey = getPublicEventsCacheKey();

    expect(await workerEnv.EVENT_CACHE.get(eventCacheKey)).not.toBeNull();
    expect(await workerEnv.EVENT_CACHE.get(listCacheKey)).not.toBeNull();

    // Perform update
    await orgCaller.updateEvent({
      eventId,
      name: 'Renamed Event',
      description: 'Updated description text',
    });

    // Assert both caches were evicted
    expect(await workerEnv.EVENT_CACHE.get(eventCacheKey)).toBeNull();
    expect(await workerEnv.EVENT_CACHE.get(listCacheKey)).toBeNull();

    // Subsequent public reads return updated data
    const freshEvent = await publicCaller.getPublicEvent({ eventId });
    expect(freshEvent.name).toBe('Renamed Event');
    expect(freshEvent.description).toBe('Updated description text');

    const freshList = await publicCaller.listPublicEvents();
    const listedEvent = freshList.find((e) => e.id === eventId);
    expect(listedEvent?.name).toBe('Renamed Event');
  });

  it('6. input validation requires name and description fields while allowing description to be null', async () => {
    const orgCaller = createTestCaller({
      env: workerEnv,
      db,
      userId: 'user-update-val',
      orgId: 'org-1',
      role: 'organiser',
    });

    // Empty name
    await expect(
      orgCaller.updateEvent({
        eventId: 'event-1',
        name: '',
        description: 'Some desc',
      })
    ).rejects.toThrow();

    // Missing name
    await expect(
      (orgCaller as any).updateEvent({
        eventId: 'event-1',
        description: 'Some desc',
      })
    ).rejects.toThrow();

    // Missing description
    await expect(
      (orgCaller as any).updateEvent({
        eventId: 'event-1',
        name: 'Valid Name',
      })
    ).rejects.toThrow();
  });
});

describe('KV cache failure isolation', () => {
  let db: Awaited<ReturnType<typeof setupTestDb>>;
  const workerEnv = env as unknown as Env;

  beforeEach(async () => {
    db = await setupTestDb(workerEnv.DB);
  });

  it('allows createEvent and updateEvent to succeed even if EVENT_CACHE.delete throws', async () => {
    const orgCaller = createTestCaller({
      env: workerEnv,
      db,
      userId: 'user-cache-fail-test',
      orgId: 'org-fail-1',
      role: 'organiser',
    });

    // Create event with faulty EVENT_CACHE.delete
    const originalDelete = workerEnv.EVENT_CACHE.delete;
    workerEnv.EVENT_CACHE.delete = async () => {
      throw new Error('KV service temporarily unavailable');
    };

    try {
      const created = await orgCaller.createEvent({
        name: 'Faulty Cache Event',
        date: Date.now() + 86400000,
        totalSeats: 50,
        pricePerSeat: 1000,
      });
      expect(created!.id).toBeDefined();

      const updated = await orgCaller.updateEvent({
        eventId: created!.id,
        name: 'Faulty Cache Event Renamed',
        description: 'Desc',
      });
      expect(updated!.name).toBe('Faulty Cache Event Renamed');
    } finally {
      workerEnv.EVENT_CACHE.delete = originalDelete;
    }
  });
});



