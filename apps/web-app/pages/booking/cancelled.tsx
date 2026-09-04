import { useEffect, useState, useRef } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/router';
import { useAuth } from '@clerk/nextjs';
import { createAuthenticatedTRPCClient } from '../../lib/trpc';

export default function BookingCancelledPage() {
  const router = useRouter();
  const { isLoaded, isSignedIn, getToken } = useAuth();

  const [releaseStatus, setReleaseStatus] = useState<'idle' | 'releasing' | 'released' | 'error'>('idle');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const executedHoldsRef = useRef<Set<string>>(new Set());

  const holdId = typeof router.query.holdId === 'string' ? router.query.holdId : null;
  const eventId = typeof router.query.eventId === 'string' ? router.query.eventId : null;

  useEffect(() => {
    // Only proceed when router is ready, auth state has loaded, user is signed in,
    // and both query parameters are explicitly present
    if (!router.isReady || !isLoaded || !isSignedIn || !holdId || !eventId) {
      return;
    }

    // Ensure releaseHold executes at most once per holdId + eventId
    const holdKey = `${eventId}:${holdId}`;
    if (executedHoldsRef.current.has(holdKey)) {
      return;
    }
    executedHoldsRef.current.add(holdKey);

    setReleaseStatus('releasing');

    const trpc = createAuthenticatedTRPCClient(getToken);

    void trpc.releaseHold
      .mutate({ holdId, eventId })
      .then(() => {
        setReleaseStatus('released');
        try {
          // Only remove sessionStorage if the stored hold matches this exact holdId
          const storedHoldId = sessionStorage.getItem(`pending_hold_${eventId}`);
          if (storedHoldId === holdId) {
            sessionStorage.removeItem(`pending_hold_${eventId}`);
          }
        } catch {
          // Ignore storage access errors
        }
      })
      .catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : 'Could not release hold';
        setReleaseStatus('error');
        setErrorMessage(msg);
      });
  }, [router.isReady, isLoaded, isSignedIn, holdId, eventId, getToken]);

  return (
    <div className="max-w-[560px] my-16 mx-auto px-4 py-8 font-sans text-center">
      <h1 className="text-[2rem] font-bold mb-4 text-[#333]">Booking Cancelled</h1>

      <p className="text-[#555] leading-[1.6] mb-8">
        Your booking was not completed. No payment has been taken.
      </p>

      {releaseStatus === 'releasing' && (
        <p className="text-[#555] leading-[1.6] mb-6">
          Releasing held seats…
        </p>
      )}

      {releaseStatus === 'released' && (
        <p className="text-[#27ae60] font-medium leading-[1.6] mb-6">
          Your held seats have been released back to general availability.
        </p>
      )}

      {releaseStatus === 'error' && errorMessage && (
        <p className="text-[#666] text-[0.9rem] leading-[1.6] mb-6">
          {errorMessage === 'Cannot release a confirmed booking'
            ? 'This booking is already confirmed.'
            : 'Seat hold status updated.'}
        </p>
      )}

      <div className="mt-8 flex gap-4 justify-center flex-wrap">
        {eventId && (
          <Link href={`/events/${eventId}`} className="inline-block px-6 py-3 bg-[#0070f3] hover:bg-[#0059c2] text-white no-underline rounded-md font-medium transition-colors">
            Back to event
          </Link>
        )}
        <Link
          href="/"
          className={`inline-block px-6 py-3 no-underline rounded-md font-medium transition-colors ${
            eventId ? 'bg-[#f0f0f0] hover:bg-[#e4e4e4] text-[#333]' : 'bg-[#0070f3] hover:bg-[#0059c2] text-white'
          }`}
        >
          Browse all events
        </Link>
      </div>
    </div>
  );
}
