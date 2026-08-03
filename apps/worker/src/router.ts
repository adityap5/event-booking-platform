import { router, protectedProcedure } from '@event-booking/trpc';

export const appRouter = router({
  whoami: protectedProcedure.query(({ ctx }) => {
    return {
      userId: ctx.userId,
      orgId: ctx.orgId,
      role: ctx.role,
    };
  }),
});

export type AppRouter = typeof appRouter;
