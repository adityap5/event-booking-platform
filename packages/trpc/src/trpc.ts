import { initTRPC, TRPCError } from '@trpc/server';
import type { Context } from './context.js';
import { authorizeOrganiserAccess } from '@event-booking/permissions';

const t = initTRPC.context<Context>().create();

export const router = t.router;
export const publicProcedure = t.procedure;

const isAuthed = t.middleware(({ next, ctx }) => {
  if (!ctx.userId) {
    throw new TRPCError({ code: 'UNAUTHORIZED' });
  }
  return next({
    ctx: {
      userId: ctx.userId,
      orgId: ctx.orgId,
      role: ctx.role,
    },
  });
});

export const protectedProcedure = t.procedure.use(isAuthed);

/**
 * Middleware factory that enforces organiser access to a specific resource.
 * MUST be chained AFTER .input() in the procedure builder so that `input` is parsed.
 *
 * @param getResourceOrgId A callback to extract or fetch the target org ID for the current request.
 */
export const enforceOrganiserAccess = <TInput>(
  getResourceOrgId: (opts: { input: TInput; ctx: Context }) => Promise<string | null> | string | null
) => {
  return t.middleware(async ({ next, ctx, input }) => {
    // 1. Fetch or extract the target resource's organisation ID
    // Because this middleware is .use()'d after .input(), `input` here is fully parsed and typed!
    
    const resourceOrgId = await getResourceOrgId({ input: input as TInput, ctx });

    if (!resourceOrgId) {
      throw new TRPCError({
        code: 'NOT_FOUND',
        message: 'Resource not found',
      });
    }

    if (!ctx.userId) {
      throw new TRPCError({
        code: 'UNAUTHORIZED',
      });
    }

    // 2. Delegate to the shared permissions package to verify access
    authorizeOrganiserAccess(
      { userId: ctx.userId, orgId: ctx.orgId, role: ctx.role }, 
      resourceOrgId
    );

    return next({ ctx });
  });
};
