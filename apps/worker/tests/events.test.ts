import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import type { Env } from '../src/index.js';
import { setupTestDb, createTestCaller } from './test-helpers.js';
import { handleUpload } from '../src/handlers/upload.js';

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


