import { useState, useEffect, useRef, useCallback } from 'react';
import { useAuth } from '@clerk/nextjs';
import { createAuthenticatedTRPCClient } from '../lib/trpc';

// ---------------------------------------------------------------------------
// useSeatCount — live seat count via WebSocket (signed-in users only)
// ---------------------------------------------------------------------------

// WebSocket URL is derived from the tRPC base URL: same origin, wss:// protocol, /ws path.
// This keeps the worker origin in one place (NEXT_PUBLIC_TRPC_URL in .env.local / wrangler vars)
// so a URL change requires updating only one value, not two.
const WS_URL = process.env.NEXT_PUBLIC_TRPC_URL!
  .replace(/\/trpc$/, '')
  .replace(/^https:/, 'wss:')
  + '/ws';

export function useSeatCount(eventId: string): number | null {
  const { isSignedIn, getToken } = useAuth();
  const [count, setCount] = useState<number | null>(null);
  const cancelledRef = useRef(false);
  const socketRef = useRef<WebSocket | null>(null);

  const connect = useCallback(async () => {
    if (cancelledRef.current || !isSignedIn) return;

    // Mint a short-lived ticket via tRPC, then open the WebSocket
    let ticket: string;
    try {
      const trpc = createAuthenticatedTRPCClient(getToken);
      const result = await trpc.createSocketTicket.mutate({ eventId });
      ticket = result.ticket;
    } catch {
      // Retry after backoff if ticket minting fails
      if (!cancelledRef.current) {
        setTimeout(() => { void connect(); }, 5000);
      }
      return;
    }

    if (cancelledRef.current) return;

    const ws = new WebSocket(`${WS_URL}?ticket=${encodeURIComponent(ticket)}&eventId=${encodeURIComponent(eventId)}`);
    socketRef.current = ws;

    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data as string) as { type: string; available?: number };
        if (data.type === 'seat_count' && typeof data.available === 'number') {
          setCount(data.available);
        }
      } catch {
        // Ignore malformed messages
      }
    };

    ws.onclose = () => {
      if (!cancelledRef.current) {
        setTimeout(() => { void connect(); }, 3000);
      }
    };

    ws.onerror = () => {
      ws.close();
      if (!cancelledRef.current) {
        setTimeout(() => { void connect(); }, 5000);
      }
    };
  }, [isSignedIn, getToken, eventId]);

  useEffect(() => {
    cancelledRef.current = false;

    if (isSignedIn) {
      void connect();
    }

    return () => {
      cancelledRef.current = true;
      if (socketRef.current) {
        socketRef.current.close();
        socketRef.current = null;
      }
    };
  }, [isSignedIn, connect]);

  return count;
}
