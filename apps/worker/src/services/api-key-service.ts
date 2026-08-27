import { eq, and, isNull } from 'drizzle-orm';
import type { DrizzleD1Database } from 'drizzle-orm/d1';
import { TRPCError } from '@trpc/server';
import * as schema from '@event-booking/shared';
import { organisationApiKeys } from '@event-booking/shared';

export const API_KEY_PREFIX = 'evbk_';

/**
 * Generates a high-entropy random API key.
 * Format: evbk_ followed by 32 cryptographically secure random bytes (64 hex characters).
 * Uses the Web Crypto API's crypto.getRandomValues().
 */
export function generateRawApiKey(): string {
  const bytes = new Uint8Array(32); // 256 bits of entropy
  crypto.getRandomValues(bytes);
  const randomHex = Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  return `${API_KEY_PREFIX}${randomHex}`;
}

/**
 * Computes a SHA-256 hex digest for an API key.
 * Uses Web Crypto's crypto.subtle.digest().
 */
export async function hashApiKey(rawKey: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(rawKey);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Extracts a safe-to-display prefix from a raw API key (e.g. "evbk_a1b2c3d4...").
 */
export function extractKeyPrefix(rawKey: string): string {
  // Return prefix plus first 8 chars of secret
  const visibleLength = API_KEY_PREFIX.length + 8;
  return `${rawKey.slice(0, visibleLength)}...`;
}

export type ApiKeyInfo = {
  keyPrefix: string;
  createdAt: number;
};

export type AuthenticatedApiKey = {
  keyId: string;
  organisationId: string;
  keyPrefix: string;
};

/**
 * Retrieves information about the active API key for an organisation.
 * Never returns the raw key or the hash.
 */
export async function getActiveApiKeyInfo(
  db: DrizzleD1Database<typeof schema>,
  orgId: string,
): Promise<ApiKeyInfo | null> {
  const [activeKey] = await db
    .select({
      keyPrefix: organisationApiKeys.keyPrefix,
      createdAt: organisationApiKeys.createdAt,
    })
    .from(organisationApiKeys)
    .where(
      and(
        eq(organisationApiKeys.organisationId, orgId),
        isNull(organisationApiKeys.revokedAt),
      ),
    );

  if (!activeKey) return null;

  return {
    keyPrefix: activeKey.keyPrefix,
    createdAt:
      activeKey.createdAt instanceof Date
        ? activeKey.createdAt.getTime()
        : Number(activeKey.createdAt),
  };
}

function isD1UniqueConstraintError(err: unknown): boolean {
  const msg = [
    (err as { message?: string })?.message,
    (err as { cause?: { message?: string } })?.cause?.message,
    (err as { cause?: string })?.cause,
    String(err),
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();

  return (
    msg.includes('unique constraint failed') ||
    msg.includes('unique_constraint') ||
    (msg.includes('d1_error') && msg.includes('unique'))
  );
}

/**
 * Generates the organisation's first active API key.
 * Rejects with CONFLICT if an active key already exists for the organisation.
 * Uses the database-level partial unique index to guarantee that concurrent first-time
 * generation attempts result in exactly one active key without stale key leaks.
 */
export async function generateApiKey(
  db: DrizzleD1Database<typeof schema>,
  orgId: string,
): Promise<{ rawKey: string; keyPrefix: string; createdAt: number }> {
  // Check if an active key already exists
  const existing = await getActiveApiKeyInfo(db, orgId);
  if (existing) {
    throw new TRPCError({
      code: 'CONFLICT',
      message: 'An active API key already exists for this organisation. Use rotateApiKey to replace it.',
    });
  }

  const rawKey = generateRawApiKey();
  const keyHash = await hashApiKey(rawKey);
  const keyPrefix = extractKeyPrefix(rawKey);
  const newId = crypto.randomUUID();
  const now = new Date(Math.floor(Date.now() / 1000) * 1000);

  try {
    await db.insert(organisationApiKeys).values({
      id: newId,
      organisationId: orgId,
      keyHash,
      keyPrefix,
      createdAt: now,
      revokedAt: null,
    });
  } catch (err: unknown) {
    if (isD1UniqueConstraintError(err)) {
      throw new TRPCError({
        code: 'CONFLICT',
        message: 'A concurrent API key operation is in progress. Please try again.',
      });
    }
    throw err;
  }

  return {
    rawKey,
    keyPrefix,
    createdAt: now.getTime(),
  };
}

/**
 * Rotates an active API key using compare-and-swap (CAS) semantics.
 * Requires an existing active key to rotate (rejects with CONFLICT if none exists).
 * Identifies the specific observed active key ID and atomically revokes it while inserting
 * the replacement key in a single D1 batch operation. If the observed key is no longer active
 * (e.g. rotated concurrently by another request), the operation fails with CONFLICT rather than
 * returning a stale/dead key.
 */
export async function rotateApiKey(
  db: DrizzleD1Database<typeof schema>,
  orgId: string,
): Promise<{ rawKey: string; keyPrefix: string; createdAt: number }> {
  const [activeKey] = await db
    .select({ id: organisationApiKeys.id })
    .from(organisationApiKeys)
    .where(
      and(
        eq(organisationApiKeys.organisationId, orgId),
        isNull(organisationApiKeys.revokedAt),
      ),
    );

  if (!activeKey) {
    throw new TRPCError({
      code: 'CONFLICT',
      message: 'No active API key exists for this organisation. Use generateApiKey to create the first key.',
    });
  }

  const rawKey = generateRawApiKey();
  const keyHash = await hashApiKey(rawKey);
  const keyPrefix = extractKeyPrefix(rawKey);
  const newId = crypto.randomUUID();
  const now = new Date(Math.floor(Date.now() / 1000) * 1000);

  const insertStmt = db.insert(organisationApiKeys).values({
    id: newId,
    organisationId: orgId,
    keyHash,
    keyPrefix,
    createdAt: now,
    revokedAt: null,
  });

  // CAS: Target the exact active key ID observed. If another caller already rotated it,
  // this update affects 0 rows, and the subsequent insert fails on the partial unique index
  // (org_api_keys_active_org_idx), rejecting the stale caller atomically.
  const revokeStmt = db
    .update(organisationApiKeys)
    .set({ revokedAt: now })
    .where(
      and(
        eq(organisationApiKeys.id, activeKey.id),
        isNull(organisationApiKeys.revokedAt),
      ),
    );

  try {
    await db.batch([revokeStmt, insertStmt]);
  } catch (err: unknown) {
    if (isD1UniqueConstraintError(err)) {
      throw new TRPCError({
        code: 'CONFLICT',
        message: 'A concurrent API key operation is in progress. Please try again.',
      });
    }
    throw err;
  }

  return {
    rawKey,
    keyPrefix,
    createdAt: now.getTime(),
  };
}

/**
 * Revokes the active API key for an organisation without creating a replacement.
 */
export async function revokeApiKey(
  db: DrizzleD1Database<typeof schema>,
  orgId: string,
): Promise<void> {
  const now = new Date();
  await db
    .update(organisationApiKeys)
    .set({ revokedAt: now })
    .where(
      and(
        eq(organisationApiKeys.organisationId, orgId),
        isNull(organisationApiKeys.revokedAt),
      ),
    );
}

/**
 * Authenticates an incoming raw API key against D1.
 * Hashes the key and queries for an active (non-revoked) key record.
 */
export async function authenticateApiKey(
  db: DrizzleD1Database<typeof schema>,
  rawKey: string,
): Promise<AuthenticatedApiKey | null> {
  if (!rawKey || typeof rawKey !== 'string' || !rawKey.startsWith(API_KEY_PREFIX)) {
    return null;
  }

  const keyHash = await hashApiKey(rawKey);

  const [matchedKey] = await db
    .select({
      id: organisationApiKeys.id,
      organisationId: organisationApiKeys.organisationId,
      keyPrefix: organisationApiKeys.keyPrefix,
    })
    .from(organisationApiKeys)
    .where(
      and(
        eq(organisationApiKeys.keyHash, keyHash),
        isNull(organisationApiKeys.revokedAt),
      ),
    );

  if (!matchedKey) return null;

  return {
    keyId: matchedKey.id,
    organisationId: matchedKey.organisationId,
    keyPrefix: matchedKey.keyPrefix,
  };
}
