import { fetchRequestHandler } from '@trpc/server/adapters/fetch';
import { createContext } from '@event-booking/trpc';
import { appRouter } from './router.js';
import { drizzle } from 'drizzle-orm/d1';
import * as schema from '@event-booking/shared';

import { SeatLedger } from "./seat-ledger.js";
import { RateLimiter } from "./rate-limiter.js";
export { SeatLedger, RateLimiter };

import { handleClerkWebhook } from './handlers/clerk-webhook.js';
import { handleStripeWebhook } from './handlers/stripe-webhook.js';
import { handleUpload } from './handlers/upload.js';
import { handleWebSocketUpgrade } from './handlers/websocket.js';

export type Env = {
  CLERK_SECRET_KEY: string;
  CLERK_JWT_KEY: string;
  CLERK_WEBHOOK_SECRET: string;
  STRIPE_SECRET_KEY: string;
  STRIPE_WEBHOOK_SECRET: string;
  DB: D1Database;
  SEAT_LEDGER: DurableObjectNamespace<SeatLedger>;
  EVENT_COVERS: R2Bucket;        
  EVENT_CACHE: KVNamespace;  
  RATE_LIMITER: DurableObjectNamespace; 
};

import { resolveAllowedOrigin, JWT_AUTHORIZED_PARTIES } from './cors.js';

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const clerkResponse = await handleClerkWebhook(request, env);
    if (clerkResponse) return clerkResponse;

    const stripeResponse = await handleStripeWebhook(request, env);
    if (stripeResponse) return stripeResponse;

    const uploadResponse = await handleUpload(request, env);
    if (uploadResponse) return uploadResponse;

    const wsResponse = await handleWebSocketUpgrade(request, env);
    if (wsResponse) return wsResponse;

    // Handle CORS preflight requests for tRPC
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': resolveAllowedOrigin(request),
          'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type, Authorization',
          'Access-Control-Max-Age': '86400',
        },
      });
    }

    const response = await fetchRequestHandler({
      endpoint: '/trpc',
      req: request,
      router: appRouter,
      createContext: (opts) =>
        createContext({
          ...opts,
          clerkJwtKey: env.CLERK_JWT_KEY,
          authorizedParties: JWT_AUTHORIZED_PARTIES,
          db: drizzle(env.DB, { schema }),
          env,
        }),
    });

    // Append CORS headers to the tRPC response
    response.headers.set('Access-Control-Allow-Origin', resolveAllowedOrigin(request));
    return response;
  },
} satisfies ExportedHandler<Env>;
