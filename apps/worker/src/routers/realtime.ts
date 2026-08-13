import { z } from 'zod';
import { events } from '@event-booking/shared';
import { eq } from 'drizzle-orm';
import { TRPCError } from '@trpc/server';
import { workerProcedure } from '../procedures.js';

export const realtimeRouter = {
  createSocketTicket: workerProcedure
    .input(z.object({ eventId: z.string() }))
    .mutation(async ({ input, ctx }) => {
      const stub = ctx.env.SEAT_LEDGER.get(ctx.env.SEAT_LEDGER.idFromName(input.eventId));

      const available = await stub.getAvailableSeats();
      if (available === null) {
        const [event] = await ctx.db.select({ totalSeats: events.totalSeats })
          .from(events)
          .where(eq(events.id, input.eventId));
          
        if (!event) throw new TRPCError({ code: 'NOT_FOUND', message: 'Event not found' });
        
        await stub.initialize(event.totalSeats);
      }

      const ticket = await stub.mintTicket(ctx.userId, ctx.orgId ?? null, input.eventId);
      return { ticket };
    }),
};
