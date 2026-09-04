import { useState, useEffect } from 'react';
import { useAuth, SignInButton } from '@clerk/nextjs';
import { createAuthenticatedTRPCClient } from '../../lib/trpc';

interface BookingWidgetProps {
  eventId: string;
}

export function BookingWidget({ eventId }: BookingWidgetProps) {
  const { isSignedIn, getToken } = useAuth();

  const [seatCount, setSeatCount] = useState(1);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pendingHoldId, setPendingHoldId] = useState<string | null>(null);
  const [hasHoldConflict, setHasHoldConflict] = useState(false);

  // Initialize stored holdId on mount if available in session
  useEffect(() => {
    try {
      const stored = sessionStorage.getItem(`pending_hold_${eventId}`);
      if (stored) {
        setPendingHoldId(stored);
      }
    } catch {
      // Ignore storage access errors
    }
  }, [eventId]);

  const handleBook = async () => {
    setLoading(true);
    setError(null);
    setHasHoldConflict(false);
    try {
      const trpc = createAuthenticatedTRPCClient(getToken);

      await trpc.ensureAttendee.mutate();

      const { reservationId } = await trpc.reserveSeat.mutate({
        eventId,
        seatCount,
      });

      // Save holdId so user can release & retry if they abandon checkout
      try {
        sessionStorage.setItem(`pending_hold_${eventId}`, reservationId);
      } catch {
        // Ignore storage access errors
      }
      setPendingHoldId(reservationId);

      const { sessionUrl } = await trpc.createCheckoutSession.mutate({
        holdId: reservationId,
        eventId,
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
          holdIdToRelease = sessionStorage.getItem(`pending_hold_${eventId}`);
        } catch {
          // Ignore
        }
      }

      if (holdIdToRelease) {
        // Step 1: releaseHold MUST succeed before proceeding
        await trpc.releaseHold.mutate({
          eventId,
          holdId: holdIdToRelease,
        });

        // Step 2: Clear old hold reference only after releaseHold succeeds
        try {
          const stored = sessionStorage.getItem(`pending_hold_${eventId}`);
          if (stored === holdIdToRelease) {
            sessionStorage.removeItem(`pending_hold_${eventId}`);
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
        eventId,
        seatCount,
      });

      try {
        sessionStorage.setItem(`pending_hold_${eventId}`, reservationId);
      } catch {
        // Ignore
      }
      setPendingHoldId(reservationId);

      const { sessionUrl } = await trpc.createCheckoutSession.mutate({
        holdId: reservationId,
        eventId,
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

  if (!isSignedIn) {
    return (
      <div>
        <SignInButton>
          <button className="px-6 py-3 text-base bg-[#0070f3] hover:bg-[#0059c2] text-white border-none rounded-md cursor-pointer transition-colors">
            Sign in to book
          </button>
        </SignInButton>
      </div>
    );
  }

  return (
    <div>
      {/* Seat count selector */}
      <label htmlFor="seat-count" className="block mb-2 font-medium">
        Number of seats
      </label>
      <select
        id="seat-count"
        value={seatCount}
        onChange={(e) => setSeatCount(Number(e.target.value))}
        disabled={loading}
        className="px-3 py-2 text-base rounded-md border border-[#ccc] mb-4 block bg-white"
      >
        {Array.from({ length: 10 }, (_, i) => i + 1).map((n) => (
          <option key={n} value={n}>{n}</option>
        ))}
      </select>

      {/* Book button */}
      <button
        onClick={() => { void handleBook(); }}
        disabled={loading}
        className={`px-6 py-3 text-base text-white border-none rounded-md transition-colors ${
          loading ? 'bg-[#999] cursor-not-allowed' : 'bg-[#0070f3] hover:bg-[#0059c2] cursor-pointer'
        }`}
      >
        {loading ? 'Processing…' : 'Book Ticket'}
      </button>

      {/* Error & actionable retry */}
      {error && (
        <div className="mt-4">
          <p className={`text-[#c0392b] ${hasHoldConflict ? 'mb-2' : 'mb-0'}`}>{error}</p>
          {hasHoldConflict && (
            <div className="mt-2">
              <p className="text-[#555] text-[0.9rem] mb-3">
                You have an unconfirmed reservation from a previous attempt.
              </p>
              {pendingHoldId ? (
                <button
                  onClick={() => { void handleReleaseAndRetry(); }}
                  disabled={loading}
                  className={`px-4 py-2 text-[0.9rem] text-white border-none rounded-md transition-colors ${
                    loading ? 'bg-[#999] cursor-not-allowed' : 'bg-[#e74c3c] hover:bg-[#c0392b] cursor-pointer'
                  }`}
                >
                  {loading ? 'Releasing…' : 'Release previous hold & retry'}
                </button>
              ) : (
                <p className="text-[#777] text-[0.85rem]">
                  Pending holds expire automatically after 15 minutes.
                </p>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
