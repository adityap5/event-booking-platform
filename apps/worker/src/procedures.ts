import { protectedProcedure, publicProcedure } from '@event-booking/trpc';
import { TRPCError } from '@trpc/server';
import type { R2Bucket, DurableObjectId } from '@cloudflare/workers-types';
import { logStructured } from './logger.js';

export interface WorkerEnv {
  CLERK_SECRET_KEY: string;
  STRIPE_SECRET_KEY: string;
  STRIPE_WEBHOOK_SECRET: string;
  // Public deployed URLs — sourced from wrangler.jsonc vars so a URL change
  // requires updating only wrangler.jsonc, not source files.
  WORKER_URL: string;
  WEB_APP_URL: string;
  SEAT_LEDGER: {
    idFromName: (name: string) => DurableObjectId;
    get: (id: DurableObjectId) => {
      getAvailableSeats: () => Promise<number | null>;
      initialize: (seats: number) => Promise<void>;
      reserveSeat: (userId: string, seats: number) => Promise<{ reservationId: string; expiresAt: number }>;
      confirmSeat: (holdId: string) => Promise<{ userId: string; seatCount: number }>;
      releaseSeat: (holdId: string) => Promise<void>;
      getHold: (holdId: string) => Promise<{ userId: string; seatCount: number; status: string; expiresAt: number } | null>;
      listConfirmedHolds: (since?: number) => Promise<{ id: string; userId: string; seatCount: number; expiresAt: number }[]>;
      mintTicket: (userId: string, orgId: string | null, eventId: string) => Promise<string>;
    };
  };
  EVENT_CACHE: {
    get: (key: string) => Promise<string | null>;
    put: (key: string, value: string, opts?: { expirationTtl?: number }) => Promise<void>;
    delete: (key: string) => Promise<void>;
  };
  RATE_LIMITER: {
    idFromName: (name: string) => DurableObjectId;
    get: (id: DurableObjectId) => {
      checkLimit: (action: string, limit: number, windowMs: number) => Promise<{ allowed: boolean; remaining: number }>;
    };
  };
  EVENT_COVERS: R2Bucket;
  /** Private bucket for generated PDF tickets — access gated by authenticated getTicket procedure. */
  EVENT_TICKETS: R2Bucket;
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

export const publicWorkerProcedure = publicProcedure.use(async ({ next, ctx }) => {
  const env = ctx.env as WorkerEnv;
  const ip = ctx.ip ?? 'unknown-ip';

  // Shared rate limit across all unauthenticated public tRPC procedures ('publicRead').
  // Uses a single combined budget (60 req / 60s per IP) so clients rotating between endpoints
  // cannot multiply their allowed quota.
  const rateLimiter = env.RATE_LIMITER.get(env.RATE_LIMITER.idFromName(ip));
  const { allowed } = await rateLimiter.checkLimit('publicRead', 60, 60_000);
  if (!allowed) {
    logStructured({
      category: 'rate_limit_rejection',
      action: 'publicRead',
      keyType: 'ip',
    });
    throw new TRPCError({
      code: 'TOO_MANY_REQUESTS',
      message: 'Too many requests. Please try again shortly.',
    });
  }

  return next({
    ctx: {
      ...ctx,
      env,
    }
  });
});
