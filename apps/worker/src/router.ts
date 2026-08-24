import { router } from '@event-booking/trpc';
import { miscRouter } from './routers/misc.js';
import { eventsRouter } from './routers/events.js';
import { bookingsRouter } from './routers/bookings.js';
import { paymentsRouter } from './routers/payments.js';
import { realtimeRouter } from './routers/realtime.js';
import { ticketsRouter } from './routers/tickets.js';

export const appRouter = router({
  ...miscRouter,
  ...eventsRouter,
  ...bookingsRouter,
  ...paymentsRouter,
  ...realtimeRouter,
  ...ticketsRouter,
});

export type AppRouter = typeof appRouter;
