import { useEffect, useState, useRef } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/router';
import { useAuth } from '@clerk/nextjs';
import { createAuthenticatedTRPCClient } from '../../lib/trpc';
import styles from './booking.module.css';

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
    <div className={styles.container}>
      <h1 className={styles.heading}>Booking Cancelled</h1>

      <p className={styles.bodyLarge}>
        Your booking was not completed. No payment has been taken.
      </p>

      {releaseStatus === 'releasing' && (
        <p className={styles.body} style={{ color: '#555' }}>
          Releasing held seats…
        </p>
      )}

      {releaseStatus === 'released' && (
        <p className={styles.body} style={{ color: '#27ae60', fontWeight: 500 }}>
          Your held seats have been released back to general availability.
        </p>
      )}

      {releaseStatus === 'error' && errorMessage && (
        <p className={styles.body} style={{ color: '#666', fontSize: '0.9rem' }}>
          {errorMessage === 'Cannot release a confirmed booking'
            ? 'This booking is already confirmed.'
            : 'Seat hold status updated.'}
        </p>
      )}

      <div style={{ marginTop: '2rem', display: 'flex', gap: '1rem', justifyContent: 'center', flexWrap: 'wrap' }}>
        {eventId && (
          <Link href={`/events/${eventId}`} className={styles.cta}>
            Back to event
          </Link>
        )}
        <Link href="/" className={styles.cta} style={eventId ? { backgroundColor: '#f0f0f0', color: '#333' } : undefined}>
          Browse all events
        </Link>
      </div>
    </div>
  );
}
