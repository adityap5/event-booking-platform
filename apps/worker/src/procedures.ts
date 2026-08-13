import { protectedProcedure, publicProcedure } from '@event-booking/trpc';
import type { R2Bucket } from '@cloudflare/workers-types';

export interface WorkerEnv {
  CLERK_SECRET_KEY: string;
  STRIPE_SECRET_KEY: string;
  STRIPE_WEBHOOK_SECRET: string;  
  SEAT_LEDGER: {
    idFromName: (name: string) => any;
    get: (id: any) => {
      getAvailableSeats: () => Promise<number | null>;
      initialize: (seats: number) => Promise<void>;
      reserveSeat: (userId: string, seats: number) => Promise<{ reservationId: string; expiresAt: number }>;
      confirmSeat: (holdId: string) => Promise<{ userId: string; seatCount: number }>;
      releaseSeat: (holdId: string) => Promise<void>;
      mintTicket: (userId: string, orgId: string | null, eventId: string) => Promise<string>;
    };
  };
  EVENT_CACHE: {
    get: (key: string) => Promise<string | null>;
    put: (key: string, value: string, opts?: { expirationTtl?: number }) => Promise<void>;
    delete: (key: string) => Promise<void>;
  };
  RATE_LIMITER: {
    idFromName: (name: string) => any;
    get: (id: any) => {
      checkLimit: (action: string, limit: number, windowMs: number) => Promise<{ allowed: boolean; remaining: number }>;
    };
  };
  EVENT_COVERS: R2Bucket;
}

// Create a worker-specific procedure that strongly types the environment
export const workerProcedure = protectedProcedure.use(({ next, ctx }) => {
  return next({
    ctx: {
      ...ctx,
      env: ctx.env as WorkerEnv,
    }
  });
});

export const publicWorkerProcedure = publicProcedure.use(({ next, ctx }) => {
  return next({
    ctx: {
      ...ctx,
      env: ctx.env as WorkerEnv,
    }
  });
});
