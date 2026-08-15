import { describe, it, expect, beforeEach, vi } from 'vitest';
import { env } from 'cloudflare:test';
import type { Env } from '../src/index.js';
import { setupTestDb } from './test-helpers.js';
import { handleClerkWebhook } from '../src/handlers/clerk-webhook.js';
import { Webhook } from 'svix';
import * as schema from '@event-booking/shared';
import { eq } from 'drizzle-orm';

describe('handleClerkWebhook HTTP handler', () => {
  let db: Awaited<ReturnType<typeof setupTestDb>>;
  const workerEnv = env as unknown as Env;

  // 32-byte secret encoded in base64 as expected by Svix (whsec_ prefix)
  const webhookSecret = 'whsec_' + Buffer.from('12345678901234567890123456789012').toString('base64');

  beforeEach(async () => {
    db = await setupTestDb(workerEnv.DB);
    vi.restoreAllMocks();
  });

  /**
   * Helper function using Svix's native `Webhook.prototype.sign` method
   * to construct a validly-signed HTTP Request object.
   */
  async function createSignedWebhookRequest(payload: object): Promise<Request> {
    const rawBody = JSON.stringify(payload);
    const wh = new Webhook(webhookSecret);
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

  it('Owner conflict: returns 200, leaves original org unchanged, inserts no new row, and logs [ORG_OWNER_CONFLICT]', async () => {
    const existingOrgId = 'seeded-org-100';
    const ownerId = 'clerk-user-owner-100';

    // Seed initial org for ownerId
    await db.insert(schema.organisations).values({
      id: existingOrgId,
      name: 'Initial Org',
      ownerId: ownerId,
    });

    const conflictingOrgId = 'clerk-org-conflict-200';
    const payload = {
      type: 'organization.created',
      data: {
        id: conflictingOrgId,
        name: 'Second Org',
        created_by: ownerId,
        created_at: Date.now(),
      },
    };

    const req = await createSignedWebhookRequest(payload);
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const testEnv: Env = {
      ...workerEnv,
      CLERK_WEBHOOK_SECRET: webhookSecret,
    };
    const res = await handleClerkWebhook(req, testEnv);

    expect(res?.status).toBe(200);

    // Verify original organisation row is unchanged in D1
    const [existingOrg] = await db
      .select()
      .from(schema.organisations)
      .where(eq(schema.organisations.id, existingOrgId));
    expect(existingOrg).toBeDefined();
    expect(existingOrg?.name).toBe('Initial Org');
    expect(existingOrg?.ownerId).toBe(ownerId);

    // Verify no new row was inserted for conflicting org ID
    const [conflictingOrg] = await db
      .select()
      .from(schema.organisations)
      .where(eq(schema.organisations.id, conflictingOrgId));
    expect(conflictingOrg).toBeUndefined();

    // Verify console.error captured [ORG_OWNER_CONFLICT] with existingOrgId, newOrgId, and ownerId
    expect(consoleSpy).toHaveBeenCalledWith(
      '[ORG_OWNER_CONFLICT]',
      expect.objectContaining({
        existingOrgId: existingOrgId,
        newOrgId: conflictingOrgId,
        ownerId: ownerId,
      })
    );
  });

  it('Unrelated DB error: passing null for not-null name column triggers NOT NULL failure and returns 500', async () => {
    // Force a non-owner-conflict database error by passing null for the NOT NULL `name` column.
    // SQLite enforces NOT NULL on organisations.name, throwing a D1_ERROR: NOT NULL constraint failed,
    // which is distinct from the owner_id UNIQUE constraint conflict.
    const payload: Record<string, unknown> = {
      type: 'organization.created',
      data: {
        id: 'org-invalid-name',
        name: null,
        created_by: 'owner-unique-999',
        created_at: Date.now(),
      },
    };

    const req = await createSignedWebhookRequest(payload);
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const testEnv: Env = {
      ...workerEnv,
      CLERK_WEBHOOK_SECRET: webhookSecret,
    };
    const res = await handleClerkWebhook(req, testEnv);

    expect(res?.status).toBe(500);
    const body = await res?.text();
    expect(body).toBe('Database error');
    expect(consoleSpy).toHaveBeenCalledWith('Error inserting organisation to DB:', expect.anything());
  });
});
