import { requireOrganiserRole } from '@event-booking/permissions';
import { workerProcedure } from '../procedures.js';
import {
  createOrRotateApiKey,
  getActiveApiKeyInfo,
  revokeApiKey,
} from '../services/api-key-service.js';

export const apiKeysRouter = {
  /**
   * Generates a new API key for the caller's active organisation.
   * If an active key already exists, it is revoked first.
   * Returns the raw key exactly once.
   */
  generateApiKey: workerProcedure.mutation(async ({ ctx }) => {
    const orgId = requireOrganiserRole(ctx, 'organiser');
    return await createOrRotateApiKey(ctx.db, orgId);
  }),

  /**
   * Rotates the API key for the caller's active organisation.
   * Revokes the existing active key and generates a new one.
   * Returns the raw key exactly once.
   */
  rotateApiKey: workerProcedure.mutation(async ({ ctx }) => {
    const orgId = requireOrganiserRole(ctx, 'organiser');
    return await createOrRotateApiKey(ctx.db, orgId);
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
