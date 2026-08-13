import { protectedProcedure } from '@event-booking/trpc';
import * as schema from '@event-booking/shared';
import { eq } from 'drizzle-orm';

export const miscRouter = {
  whoami: protectedProcedure.query(({ ctx }) => {
    return {
      userId: ctx.userId,
      orgId: ctx.orgId,
      role: ctx.role,
    };
  }),

  checkOrgSync: protectedProcedure.query(async ({ ctx }) => {
    if (!ctx.orgId) return false;
    const db = ctx.db;
    const [org] = await db.select().from(schema.organisations).where(eq(schema.organisations.id, ctx.orgId));
    return !!org;
  }),
};
