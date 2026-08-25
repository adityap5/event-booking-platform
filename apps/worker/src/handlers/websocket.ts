import type { Env } from '../index.js';
import { CORS_ALLOWED_ORIGINS } from '../cors.js';

export async function handleWebSocketUpgrade(request: Request, env: Env): Promise<Response | null> {
  const url = new URL(request.url);
  
  if (url.pathname === '/ws' && request.headers.get('Upgrade') === 'websocket') {
    // ── Cross-Site WebSocket Hijacking (CSWSH) Defense ───────────────────────
    // WebSocket upgrades bypass standard browser CORS preflights and restrictions.
    // While socket tickets are single-use and minted via Bearer-authenticated tRPC calls,
    // Bearer protection is incidental (browsers do not send Authorization headers cross-origin).
    // If socket or session authentication ever migrates to ambient credentials (e.g. cookies),
    // an attacker's website could initiate a WebSocket upgrade using the victim's credentials.
    //
    // Validating the `Origin` header against `CORS_ALLOWED_ORIGINS` provides explicit CSWSH defense.
    //
    // Why absent-Origin is allowed:
    // Browsers unconditionally and unforgeably attach the `Origin` header to all WebSocket upgrade requests.
    // Non-browser callers (such as automated tests, health checkers, or server-to-server tools)
    // frequently omit the `Origin` header. Allowing absent Origin preserves interoperability for
    // non-browser environments while strictly enforcing origin safety for all browser clients.
    const origin = request.headers.get('Origin');
    if (origin !== null && !CORS_ALLOWED_ORIGINS.includes(origin)) {
      return new Response('Invalid origin', { status: 403 });
    }

    const eventId = url.searchParams.get('eventId');
    if (!eventId) {
      return new Response('Missing eventId', { status: 400 });
    }

    const id = env.SEAT_LEDGER.idFromName(eventId);
    const stub = env.SEAT_LEDGER.get(id) as DurableObjectStub;
    return stub.fetch(request);
  }
  
  return null;
}

