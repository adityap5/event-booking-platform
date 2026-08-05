import { router, protectedProcedure, enforceOrganiserAccess } from '@event-booking/trpc';
import { z } from 'zod';
import * as schema from '@event-booking/shared';
import { events } from '@event-booking/shared';
import { eq } from 'drizzle-orm';

export const appRouter = router({
  whoami: protectedProcedure.query(({ ctx }) => {
    return {
      userId: ctx.userId,
      orgId: ctx.orgId,
      role: ctx.role,
    };
  }),

  getEvent: protectedProcedure
    .input(z.object({ eventId: z.string() }))
    .use(enforceOrganiserAccess<{ eventId: string }>(async ({ input, ctx }) => {
      const db = ctx.db; 
      const [event] = await db.select().from(events).where(eq(events.id, input.eventId));
      return event?.organisationId || null;
    }))
    .query(async ({ input, ctx }) => {
      const db = ctx.db;
      const [event] = await db.select().from(events).where(eq(events.id, input.eventId));
      return { name: event?.name };
    }),

  checkOrgSync: protectedProcedure.query(async ({ ctx }) => {
    if (!ctx.orgId) return false;
    const db = ctx.db;
    const [org] = await db.select().from(schema.organisations).where(eq(schema.organisations.id, ctx.orgId));
    return !!org;
  }),
});

export type AppRouter = typeof appRouter;
