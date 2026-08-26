import { drizzle } from 'drizzle-orm/d1';
import * as schema from '@event-booking/shared';
import type { Env } from '../index.js';
import { authenticateApiKey } from '../services/api-key-service.js';
import {
  listOrgPublicEvents,
  getOrgPublicEvent,
} from '../services/public-events-service.js';
import { logStructured } from '../logger.js';

const PUBLIC_API_CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type',
  'Access-Control-Max-Age': '86400',
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
    },
  });
}

/**
 * Raw HTTP handler for the public, API-key-authenticated event listings API.
 * Routes:
 *   - GET /api/v1/events
 *   - GET /api/v1/events/:id
 *   - OPTIONS /api/v1/events*
 */
export async function handlePublicApi(
  request: Request,
  env: Env,
): Promise<Response | null> {
  const url = new URL(request.url);
  const pathname = url.pathname;

  // Only handle routes starting with /api/v1/events
  if (!pathname.startsWith('/api/v1/events')) {
    return null;
  }

  // Handle permissive CORS preflight for all public API routes
  if (request.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: PUBLIC_API_CORS_HEADERS,
    });
  }

  // Only GET is supported for this read-only API
  if (request.method !== 'GET') {
    return jsonResponse({ error: 'Method Not Allowed' }, 405);
  }

  // Extract and parse Authorization header
  const authHeader = request.headers.get('Authorization');
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return jsonResponse({ error: 'Unauthorized' }, 401);
  }

  const rawKey = authHeader.slice(7).trim();
  if (!rawKey) {
    return jsonResponse({ error: 'Unauthorized' }, 401);
  }

  const db = drizzle(env.DB, { schema });

  try {
    // Authenticate the API key against D1
    const auth = await authenticateApiKey(db, rawKey);
    if (!auth) {
      // Generic unauthorized response for missing/invalid/revoked keys
      return jsonResponse({ error: 'Unauthorized' }, 401);
    }

    // Rate limit per active keyId using RateLimiter Durable Object (300 requests / 60 seconds)
    const rateLimiter = env.RATE_LIMITER.get(env.RATE_LIMITER.idFromName(auth.keyId));
    const { allowed } = await rateLimiter.checkLimit('publicApi', 300, 60_000);
    if (!allowed) {
      logStructured({
        category: 'rate_limit_rejection',
        action: 'publicApi',
        keyType: 'apiKey',
      });
      return jsonResponse({ error: 'Too Many Requests' }, 429);
    }

    // Route 1: GET /api/v1/events (list)
    if (pathname === '/api/v1/events' || pathname === '/api/v1/events/') {
      const limitParam = url.searchParams.get('limit');
      const offsetParam = url.searchParams.get('offset');

      const limit = limitParam !== null ? parseInt(limitParam, 10) : 50;
      const offset = offsetParam !== null ? parseInt(offsetParam, 10) : 0;

      const result = await listOrgPublicEvents(db, auth.organisationId, {
        limit: isNaN(limit) ? 50 : limit,
        offset: isNaN(offset) ? 0 : offset,
      });

      return jsonResponse(result, 200);
    }

    // Route 2: GET /api/v1/events/:id (single event)
    const match = pathname.match(/^\/api\/v1\/events\/([^/]+)$/);
    if (match && match[1]) {
      const eventId = match[1];
      const event = await getOrgPublicEvent(db, env, auth.organisationId, eventId);

      if (!event) {
        // Generic 404 whether event does not exist OR belongs to another organisation
        return jsonResponse({ error: 'Not Found' }, 404);
      }

      return jsonResponse(event, 200);
    }

    return jsonResponse({ error: 'Not Found' }, 404);
  } catch (err: unknown) {
    // Return generic 500 without leaking DB errors, stack traces, or credentials
    console.error('[Public API Error]:', err);
    return jsonResponse({ error: 'Internal Server Error' }, 500);
  }
}
