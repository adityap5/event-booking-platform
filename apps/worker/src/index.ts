import { fetchRequestHandler } from '@trpc/server/adapters/fetch';
import { createContext } from '@event-booking/trpc';
import { appRouter } from './router.js';

export { SeatLedger } from "./seat-ledger.js";

export type Env = {
  CLERK_JWT_KEY: string;
};

const ALLOWED_ORIGIN = 'http://localhost:3000';

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    // Handle CORS preflight requests
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
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
          authorizedParties: [ALLOWED_ORIGIN, 'http://localhost:3000'],
        }),
    });

    // Append CORS headers to the tRPC response
    response.headers.set('Access-Control-Allow-Origin', ALLOWED_ORIGIN);
    return response;
  },
} satisfies ExportedHandler<Env>;
