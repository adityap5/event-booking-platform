import type { Env } from '../index.js';

export async function handleWebSocketUpgrade(request: Request, env: Env): Promise<Response | null> {
  const url = new URL(request.url);
  
  if (url.pathname === '/ws' && request.headers.get('Upgrade') === 'websocket') {
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
