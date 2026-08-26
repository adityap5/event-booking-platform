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

/**
 * Atomically revokes any current active key for the organisation and creates a replacement.
 * Uses an atomic D1 batch operation (db.batch()) to perform the revoke and insert.
 * Returns the raw key exactly once.
 */
export async function createOrRotateApiKey(
  db: DrizzleD1Database<typeof schema>,
  orgId: string,
): Promise<{ rawKey: string; keyPrefix: string; createdAt: number }> {
  const rawKey = generateRawApiKey();
  const keyHash = await hashApiKey(rawKey);
  const keyPrefix = extractKeyPrefix(rawKey);
  const newId = crypto.randomUUID();
  const now = new Date(Math.floor(Date.now() / 1000) * 1000);

  // Prepare batch statements:
  // 1. Revoke existing active keys for this org
  // 2. Insert the new active key
  const revokeStmt = db
    .update(organisationApiKeys)
    .set({ revokedAt: now })
    .where(
      and(
        eq(organisationApiKeys.organisationId, orgId),
        isNull(organisationApiKeys.revokedAt),
      ),
    );

  const insertStmt = db.insert(organisationApiKeys).values({
    id: newId,
    organisationId: orgId,
    keyHash,
    keyPrefix,
    createdAt: now,
    revokedAt: null,
  });

  // Execute as an atomic D1 batch operation
  try {
    await db.batch([revokeStmt, insertStmt]);
  } catch (err: unknown) {
    const errStr = err instanceof Error ? err.message : String(err);
    if (
      errStr.includes('UNIQUE constraint') ||
      errStr.includes('D1_ERROR') ||
      errStr.includes('constraint failed')
    ) {
      throw new TRPCError({
        code: 'CONFLICT',
        message: 'A concurrent API key operation is in progress. Please try again.',
        cause: err,
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
