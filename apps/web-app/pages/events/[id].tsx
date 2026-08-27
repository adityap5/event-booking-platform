import { useState, useEffect } from 'react';
import { useAuth, SignInButton } from '@clerk/nextjs';
import { createTRPCClient, httpBatchLink } from '@trpc/client';
import { getCloudflareContext } from '@opennextjs/cloudflare';
import { createAuthenticatedTRPCClient } from '../../lib/trpc';
import { useSeatCount } from '../../hooks/useSeatCount';
import type { AppRouter } from '@event-booking/worker/src/router';
import type { GetServerSideProps, InferGetServerSidePropsType } from 'next';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface EventData {
  id: string;
  name: string;
  description: string | null;
  date: number;
  totalSeats: number;
  pricePerSeat: number;
  coverImageUrl: string | null;
  organisationId: string;
}

// ---------------------------------------------------------------------------
// getServerSideProps — fetch static event data server-side (no auth needed)
// ---------------------------------------------------------------------------

export const getServerSideProps = (async (context) => {
  const eventId = context.params?.id as string;

  // Note: getCloudflareContext() may throw or return undefined outside of the deployed Workers runtime (e.g., during local next dev).
  const { env } = getCloudflareContext();

  // Public tRPC client — no auth header, runs in Workers runtime (no Node APIs)
  const trpc = createTRPCClient<AppRouter>({
    links: [
      httpBatchLink({
        url: 'https://internal/trpc',
        fetch: (input, init) => env.WORKER_SERVICE.fetch(input as string, init as RequestInit),
      }),
    ],
  });

  try {
    const event = await trpc.getPublicEvent.query({ eventId });
    return { props: { event } };
  } catch (err: unknown) {
    // tRPC surfaces NOT_FOUND as a TRPCClientError with data.code === 'NOT_FOUND'
    const code = (err as { data?: { code?: string } })?.data?.code;
    if (code === 'NOT_FOUND') {
      return { notFound: true };
    }
    throw err;
  }
}) satisfies GetServerSideProps<{ event: EventData }>;


// ---------------------------------------------------------------------------
// EventPage component
// ---------------------------------------------------------------------------

export default function EventPage({
  event,
}: InferGetServerSidePropsType<typeof getServerSideProps>) {
  const { isSignedIn, getToken } = useAuth();

  // Live seat count (WebSocket — authenticated users only)
  const wsCount = useSeatCount(event.id);

  // Fallback seat count for unauthenticated users (one-shot HTTP fetch)
  const [publicCount, setPublicCount] = useState<number | null>(null);

  useEffect(() => {
    if (isSignedIn) return; // WebSocket takes over once signed in

    const trpc = createTRPCClient<AppRouter>({
      links: [httpBatchLink({ url: process.env.NEXT_PUBLIC_TRPC_URL! })],
    });

    void trpc.getAvailableSeats.query({ eventId: event.id }).then((n) => {
      setPublicCount(n);
    });
  }, [isSignedIn, event.id]);

  // Displayed seat count: WebSocket when signed in, HTTP fallback otherwise
  const displayedCount = isSignedIn ? wsCount : publicCount;

  // Booking state
  const [seatCount, setSeatCount] = useState(1);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pendingHoldId, setPendingHoldId] = useState<string | null>(null);
  const [hasHoldConflict, setHasHoldConflict] = useState(false);

  // Initialize stored holdId on mount if available in session
  useEffect(() => {
    try {
      const stored = sessionStorage.getItem(`pending_hold_${event.id}`);
      if (stored) {
        setPendingHoldId(stored);
      }
    } catch {
      // Ignore storage access errors
    }
  }, [event.id]);

  const handleBook = async () => {
    setLoading(true);
    setError(null);
    setHasHoldConflict(false);
    try {
      const trpc = createAuthenticatedTRPCClient(getToken);

      await trpc.ensureAttendee.mutate();

      const { reservationId } = await trpc.reserveSeat.mutate({
        eventId: event.id,
        seatCount,
      });

      // Save holdId so user can release & retry if they abandon checkout
      try {
        sessionStorage.setItem(`pending_hold_${event.id}`, reservationId);
      } catch {
        // Ignore storage access errors
      }
      setPendingHoldId(reservationId);

      const { sessionUrl } = await trpc.createCheckoutSession.mutate({
        holdId: reservationId,
        eventId: event.id,
      });

      if (sessionUrl) {
        window.location.href = sessionUrl;
      } else {
        setError('Could not create checkout session');
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Something went wrong';
      if (msg === 'TOO_MANY_PENDING_HOLDS' || msg.includes('TOO_MANY_PENDING_HOLDS')) {
        setHasHoldConflict(true);
        setError('You already have a pending hold for this event.');
      } else {
        setError(msg);
      }
    } finally {
      setLoading(false);
    }
  };

  const handleReleaseAndRetry = async () => {
    setLoading(true);
    setError(null);
    try {
      const trpc = createAuthenticatedTRPCClient(getToken);
      let holdIdToRelease = pendingHoldId;
      if (!holdIdToRelease) {
        try {
          holdIdToRelease = sessionStorage.getItem(`pending_hold_${event.id}`);
        } catch {
          // Ignore
        }
      }

      if (holdIdToRelease) {
        // Step 1: releaseHold MUST succeed before proceeding
        await trpc.releaseHold.mutate({
          eventId: event.id,
          holdId: holdIdToRelease,
        });

        // Step 2: Clear old hold reference only after releaseHold succeeds
        try {
          const stored = sessionStorage.getItem(`pending_hold_${event.id}`);
          if (stored === holdIdToRelease) {
            sessionStorage.removeItem(`pending_hold_${event.id}`);
          }
        } catch {
          // Ignore storage access errors
        }
        setPendingHoldId(null);
      }

      setHasHoldConflict(false);

      // Retry reservation with currently selected seatCount
      await trpc.ensureAttendee.mutate();
      const { reservationId } = await trpc.reserveSeat.mutate({
        eventId: event.id,
        seatCount,
      });

      try {
        sessionStorage.setItem(`pending_hold_${event.id}`, reservationId);
      } catch {
        // Ignore
      }
      setPendingHoldId(reservationId);

      const { sessionUrl } = await trpc.createCheckoutSession.mutate({
        holdId: reservationId,
        eventId: event.id,
      });

      if (sessionUrl) {
        window.location.href = sessionUrl;
      } else {
        setError('Could not create checkout session');
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Something went wrong';
      if (msg === 'TOO_MANY_PENDING_HOLDS' || msg.includes('TOO_MANY_PENDING_HOLDS')) {
        setHasHoldConflict(true);
        setError('You already have a pending hold for this event.');
      } else {
        setError(msg);
      }
    } finally {
      setLoading(false);
    }
  };

  const formattedDate = new Date(event.date).toLocaleDateString('en-GB', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });

  const formattedPrice = `£${(event.pricePerSeat / 100).toFixed(2)} per seat`;

  return (
    <div style={{ maxWidth: '680px', margin: '0 auto', padding: '2rem 1rem', fontFamily: 'sans-serif' }}>
      {/* Cover image */}
      {event.coverImageUrl && (
        <img
          src={event.coverImageUrl}
          alt={event.name}
          style={{ width: '100%', maxHeight: '340px', objectFit: 'cover', borderRadius: '8px', marginBottom: '1.5rem' }}
        />
      )}

      {/* Event name */}
      <h1 style={{ fontSize: '2rem', fontWeight: 700, marginBottom: '0.5rem' }}>{event.name}</h1>

      {/* Date & price */}
      <p style={{ color: '#555', marginBottom: '0.25rem' }}>{formattedDate}</p>
      <p style={{ color: '#555', marginBottom: '1.25rem' }}>{formattedPrice}</p>

      {/* Description */}
      {event.description && (
        <p style={{ marginBottom: '1.5rem', lineHeight: 1.6 }}>{event.description}</p>
      )}

      {/* Live seat count */}
      <p style={{ fontWeight: 600, marginBottom: '1.5rem' }}>
        Available seats:{' '}
        <span style={{ color: displayedCount === 0 ? '#c0392b' : '#27ae60' }}>
          {displayedCount !== null ? displayedCount : 'Loading…'}
        </span>
      </p>

      {/* Booking section */}
      {!isSignedIn ? (
        <div>
          <SignInButton>
            <button
              style={{
                padding: '0.75rem 1.5rem',
                fontSize: '1rem',
                backgroundColor: '#0070f3',
                color: 'white',
                border: 'none',
                borderRadius: '6px',
                cursor: 'pointer',
              }}
            >
              Sign in to book
            </button>
          </SignInButton>
        </div>
      ) : (
        <div>
          {/* Seat count selector */}
          <label htmlFor="seat-count" style={{ display: 'block', marginBottom: '0.5rem', fontWeight: 500 }}>
            Number of seats
          </label>
          <select
            id="seat-count"
            value={seatCount}
            onChange={(e) => setSeatCount(Number(e.target.value))}
            disabled={loading}
            style={{
              padding: '0.5rem 0.75rem',
              fontSize: '1rem',
              borderRadius: '6px',
              border: '1px solid #ccc',
              marginBottom: '1rem',
              display: 'block',
            }}
          >
            {Array.from({ length: 10 }, (_, i) => i + 1).map((n) => (
              <option key={n} value={n}>{n}</option>
            ))}
          </select>

          {/* Book button */}
          <button
            onClick={() => { void handleBook(); }}
            disabled={loading}
            style={{
              padding: '0.75rem 1.5rem',
              fontSize: '1rem',
              backgroundColor: loading ? '#999' : '#0070f3',
              color: 'white',
              border: 'none',
              borderRadius: '6px',
              cursor: loading ? 'not-allowed' : 'pointer',
              transition: 'background-color 0.2s',
            }}
          >
            {loading ? 'Processing…' : 'Book Ticket'}
          </button>

          {/* Error & actionable retry */}
          {error && (
            <div style={{ marginTop: '1rem' }}>
              <p style={{ color: '#c0392b', marginBottom: hasHoldConflict ? '0.5rem' : '0' }}>{error}</p>
              {hasHoldConflict && (
                <div style={{ marginTop: '0.5rem' }}>
                  <p style={{ color: '#555', fontSize: '0.9rem', marginBottom: '0.75rem' }}>
                    You have an unconfirmed reservation from a previous attempt.
                  </p>
                  {pendingHoldId ? (
                    <button
                      onClick={() => { void handleReleaseAndRetry(); }}
                      disabled={loading}
                      style={{
                        padding: '0.5rem 1rem',
                        fontSize: '0.9rem',
                        backgroundColor: '#e74c3c',
                        color: 'white',
                        border: 'none',
                        borderRadius: '6px',
                        cursor: loading ? 'not-allowed' : 'pointer',
                      }}
                    >
                      {loading ? 'Releasing…' : 'Release previous hold & retry'}
                    </button>
                  ) : (
                    <p style={{ color: '#777', fontSize: '0.85rem' }}>
                      Pending holds expire automatically after 15 minutes.
                    </p>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
