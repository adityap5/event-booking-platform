import { useState, useEffect } from 'react';
import { useAuth, SignInButton } from '@clerk/nextjs';
import { createTRPCClient, httpBatchLink } from '@trpc/client';
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

  // Public tRPC client — no auth header, runs in Workers runtime (no Node APIs)
  const trpc = createTRPCClient<AppRouter>({
    links: [
      httpBatchLink({
        url: process.env.NEXT_PUBLIC_TRPC_URL!,
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

  const handleBook = async () => {
    setLoading(true);
    setError(null);
    try {
      const trpc = createAuthenticatedTRPCClient(getToken);

      await trpc.ensureAttendee.mutate();

      const { reservationId } = await trpc.reserveSeat.mutate({
        eventId: event.id,
        seatCount,
      });

      const { sessionUrl } = await trpc.createCheckoutSession.mutate({
        holdId: reservationId,
        eventId: event.id,
        seatCount,
      });

      if (sessionUrl) {
        window.location.href = sessionUrl;
      } else {
        setError('Could not create checkout session');
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Something went wrong';
      setError(msg);
    } finally {
      setLoading(false);
    }
  };

  const formattedDate = new Date(event.date).toLocaleDateString('en-GB', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
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

          {/* Error */}
          {error && (
            <p style={{ color: '#c0392b', marginTop: '1rem' }}>{error}</p>
          )}
        </div>
      )}
    </div>
  );
}
