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
  RATE_LIMITER: DurableObjectNamespace<RateLimiter>; 
};

import { resolveAllowedOrigin, JWT_AUTHORIZED_PARTIES, applyWorkerSecurityHeaders } from './cors.js';

const MAX_BODY_SIZE_BYTES = 102400; // 100KB cap

async function checkBodySize(
  request: Request
): Promise<{ ok: true; request: Request } | { ok: false; response: Response }> {
  if (request.method !== 'POST' || !request.body) {
    return { ok: true, request };
  }

  const contentLength = request.headers.get('content-length');
  if (contentLength !== null) {
    const cl = parseInt(contentLength, 10);
    if (!isNaN(cl) && cl > MAX_BODY_SIZE_BYTES) {
      return {
        ok: false,
        response: new Response('Request body too large.', { status: 413 }),
      };
    }
  }

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      totalBytes += value.byteLength;
      if (totalBytes > MAX_BODY_SIZE_BYTES) {
        await reader.cancel();
        return {
          ok: false,
          response: new Response('Request body too large.', { status: 413 }),
        };
      }
      chunks.push(value);
    }
  }

  const combined = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }

  const reconstructedRequest = new Request(request, {
    body: combined,
  });

  return { ok: true, request: reconstructedRequest };
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const clerkResponse = await handleClerkWebhook(request, env);
    if (clerkResponse) return applyWorkerSecurityHeaders(clerkResponse);

    const stripeResponse = await handleStripeWebhook(request, env);
    if (stripeResponse) return applyWorkerSecurityHeaders(stripeResponse);

    const uploadResponse = await handleUpload(request, env);
    if (uploadResponse) return applyWorkerSecurityHeaders(uploadResponse);

    const wsResponse = await handleWebSocketUpgrade(request, env);
    if (wsResponse) {
      if (wsResponse.status === 101) {
        return wsResponse;
      }
      return applyWorkerSecurityHeaders(wsResponse);
    }

    // Handle CORS preflight requests for tRPC
    if (request.method === 'OPTIONS') {
      const optionsResponse = new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': resolveAllowedOrigin(request),
          'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type, Authorization',
          'Access-Control-Max-Age': '86400',
        },
      });
      return applyWorkerSecurityHeaders(optionsResponse);
    }

    const bodyCheck = await checkBodySize(request);
    if (!bodyCheck.ok) {
      return applyWorkerSecurityHeaders(bodyCheck.response);
    }

    const response = await fetchRequestHandler({
      endpoint: '/trpc',
      req: bodyCheck.request,
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

    // Append CORS, Cache-Control, and Security headers to the tRPC response
    response.headers.set('Access-Control-Allow-Origin', resolveAllowedOrigin(request));
    response.headers.set('Cache-Control', 'no-store');
    applyWorkerSecurityHeaders(response);
    return response;
  },
} satisfies ExportedHandler<Env>;
