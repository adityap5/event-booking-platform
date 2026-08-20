import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import type { Env } from '../src/index.js';
import { setupTestDb, createTestCaller } from './test-helpers.js';

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
