import { requireOrganiserRole } from '@event-booking/permissions';
import { workerProcedure } from '../procedures.js';
import {
  generateApiKey,
  rotateApiKey,
  getActiveApiKeyInfo,
  revokeApiKey,
} from '../services/api-key-service.js';

export const apiKeysRouter = {
  /**
   * Generates the organisation's first active API key.
   * Rejects with CONFLICT if an active key already exists (must use rotateApiKey).
   * Returns the raw key exactly once.
   */
  generateApiKey: workerProcedure.mutation(async ({ ctx }) => {
    const orgId = requireOrganiserRole(ctx, 'organiser');
    return await generateApiKey(ctx.db, orgId);
  }),

  /**
   * Rotates the API key for the caller's active organisation using CAS semantics.
   * Atomically revokes the observed active key and generates a replacement.
   * If a concurrent rotation occurs, rejects with CONFLICT to prevent returning a stale key.
   * Returns the raw key exactly once.
   */
  rotateApiKey: workerProcedure.mutation(async ({ ctx }) => {
    const orgId = requireOrganiserRole(ctx, 'organiser');
    return await rotateApiKey(ctx.db, orgId);
  }),

  /**
   * Revokes the active API key for the caller's active organisation.
   */
  revokeApiKey: workerProcedure.mutation(async ({ ctx }) => {
    const orgId = requireOrganiserRole(ctx, 'organiser');
    await revokeApiKey(ctx.db, orgId);
    return { success: true };
  }),

  /**
   * Retrieves non-sensitive metadata about the active API key (prefix, creation date).
   * Returns null if no active key exists. Never returns raw key or hash.
   */
  getApiKeyInfo: workerProcedure.query(async ({ ctx }) => {
    const orgId = requireOrganiserRole(ctx, 'organiser');
    return await getActiveApiKeyInfo(ctx.db, orgId);
  }),
};
