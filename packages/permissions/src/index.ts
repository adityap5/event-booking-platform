/**
 * Authorisation logic for the event-booking platform.
 *
 * IMPORTANT: This package must remain compatible with Cloudflare Workers.
 * Do not import any Node.js-only or browser-only APIs.
 */

import { TRPCError } from '@trpc/server';

export interface AuthContext {
  userId: string;
  orgId?: string | null;
  role?: string | null;
}

/**
 * Reusable authorization helper that compares the authenticated context
 * against a resource's known organisation ID.
 */
export function authorizeOrganiserAccess(ctx: AuthContext, resourceOrgId: string) {
  // If the user has no orgId (e.g. they are just a standard attendee),
  // they shouldn't even be accessing organiser resources. We handle this as a standard 403.
  if (!ctx.orgId) {
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'You must be an organiser to access this resource.',
    });
  }

  // If they have an orgId, it must explicitly match the resource's organisationId.
  if (ctx.orgId !== resourceOrgId) {
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'You do not have permission to modify or view this organisation\'s resources.',
    });
  }

  // Optional: add more checks for specific roles (e.g. 'admin' vs 'member') here if needed
  return true;
}

/**
 * Ensures the caller has an active organisation in their context.
 * Use this for actions scoped to "my own organisation" with no separate target resource
 * to compare against (e.g. listing my org's events, creating an event under my org).
 */
export function requireActiveOrganisation(ctx: AuthContext): string {
  if (!ctx.orgId) {
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'You must be an organiser to access this resource.',
    });
  }
  return ctx.orgId;
}

/**
 * Ensures the caller has an active organisation in their context AND holds a specific role.
 * Use this for sensitive management actions (e.g. creating events) restricted to specific org roles (e.g. 'organiser').
 */
export function requireOrganiserRole(ctx: AuthContext, requiredRole: string): string {
  if (!ctx.orgId) {
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'You must be an organiser to access this resource.',
    });
  }
  if (ctx.role !== requiredRole) {
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'You do not have permission to perform this action.',
    });
  }
  return ctx.orgId;
}
