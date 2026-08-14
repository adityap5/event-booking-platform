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
      role: 'org:admin',
    });

    const callerOrgB = createTestCaller({
      env: workerEnv,
      db,
      userId: 'user-org-B-owner',
      orgId: 'org-B-id',
      role: 'org:admin',
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
