import {
  useAuth,
  useOrganization,
  OrganizationSwitcher,
  UserButton,
} from '@clerk/nextjs';
import { RequireAuth } from '../components/RequireAuth';
import { useEffect, useState, useCallback } from 'react';
import Link from 'next/link';
import { createAuthenticatedTRPCClient } from '../lib/trpc';
import styles from './dashboard.module.css';

export default function DashboardPage() {
  const { userId, orgId, getToken } = useAuth();
  const { organization, isLoaded } = useOrganization();

  // ---- My Bookings (attendee view only) ----
  type Booking = {
    id: string;
    seatCount: number;
    eventId: string;
    eventName: string;
    eventDate: number;
    eventCoverImageUrl: string | null;
  };
  const [bookings, setBookings] = useState<Booking[] | null>(null);
  const [bookingsLoading, setBookingsLoading] = useState(true);
  const [bookingsError, setBookingsError] = useState<string | null>(null);
  // Tracks per-booking download state: 'idle' | 'loading' | 'error'
  const [downloadState, setDownloadState] = useState<Record<string, 'idle' | 'loading' | 'error'>>({});

  const handleDownloadTicket = useCallback(async (bookingId: string) => {
    setDownloadState(prev => ({ ...prev, [bookingId]: 'loading' }));
    try {
      const trpc = createAuthenticatedTRPCClient(getToken);
      const result = await trpc.getTicket.query({ bookingId });
      // Decode base64 PDF and trigger browser download
      const binary = atob(result.pdf);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      const blob = new Blob([bytes], { type: 'application/pdf' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = result.filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      setDownloadState(prev => ({ ...prev, [bookingId]: 'idle' }));
    } catch {
      setDownloadState(prev => ({ ...prev, [bookingId]: 'error' }));
    }
  // getToken is a stable Clerk reference
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    // Guard covers three states that useOrganization can be in:
    //   isLoaded = false  → Clerk is still initialising; don't fetch yet
    //   isLoaded = true, organization = object → user is an organiser; skip bookings
    //   isLoaded = true, organization = null   → user is an attendee; fetch bookings
    if (!isLoaded || organization) return;
    let cancelled = false;
    const trpc = createAuthenticatedTRPCClient(getToken);
    trpc.listMyBookings.query()
      .then((data) => { if (!cancelled) setBookings(data); })
      .catch((err: unknown) => {
        if (!cancelled) setBookingsError(err instanceof Error ? err.message : 'Failed to load bookings');
      })
      .finally(() => { if (!cancelled) setBookingsLoading(false); });
    return () => { cancelled = true; };
  // getToken is a stable Clerk reference — safe to omit from deps
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isLoaded, organization]);

  return (
    <RequireAuth>
      <div style={{ padding: '2rem' }}>
      <header
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          marginBottom: '2rem',
        }}
      >
        <OrganizationSwitcher
          hidePersonal={true}
          appearance={{
            elements: {
              organizationSwitcherPopoverActionButton__createOrganization: {
                display: 'none',
              },
            },
          }}
        />
        <UserButton />
      </header>

      <h1>Dashboard</h1>
      <p>User ID: {userId}</p>
      
      {organization ? (
        // Organiser View
        <div style={{ marginTop: '2rem', padding: '1.5rem', border: '1px solid #eaeaea', borderRadius: '8px' }}>
          <h2>Welcome Organiser!</h2>
          <p>Organization: {organization.name} ({orgId})</p>
          <div style={{ display: 'flex', gap: '1rem', marginTop: '1rem', flexWrap: 'wrap' }}>
            <Link href="/events/create" style={{ display: 'inline-block', padding: '0.5rem 1rem', fontSize: '1rem', backgroundColor: '#0070f3', color: 'white', textDecoration: 'none', borderRadius: '4px', fontWeight: 500 }}>
              Create Event
            </Link>
            <Link href="/dashboard/billing" style={{ display: 'inline-block', padding: '0.5rem 1rem', fontSize: '1rem', backgroundColor: '#f3f4f6', color: '#1f2937', textDecoration: 'none', borderRadius: '4px', fontWeight: 500, border: '1px solid #d1d5db' }}>
              Billing &amp; Subscription
            </Link>
            <Link href="/dashboard/api-keys" style={{ display: 'inline-block', padding: '0.5rem 1rem', fontSize: '1rem', backgroundColor: '#f3f4f6', color: '#1f2937', textDecoration: 'none', borderRadius: '4px', fontWeight: 500, border: '1px solid #d1d5db' }}>
              API Keys
            </Link>
          </div>
        </div>
      ) : (
        // Attendee View
        <div style={{ marginTop: '2rem' }}>
          <h2>Welcome Attendee!</h2>
          <p style={{ color: '#666', marginBottom: '1.5rem' }}>You do not have an active organization.</p>
          
          <div style={{ display: 'flex', gap: '2rem', flexWrap: 'wrap' }}>
            {/* Upgrade to Organiser Card */}
            <div style={{ padding: '1.5rem', border: '1px solid #0070f3', borderRadius: '8px', flex: '1', minWidth: '250px' }}>
              <h3>Want to host your own events?</h3>
              <p>Create an organization to start managing and listing events.</p>
              <Link href="/dashboard/become-organiser" style={{ display: 'inline-block', marginTop: '1rem', padding: '0.5rem 1rem', backgroundColor: '#0070f3', color: 'white', textDecoration: 'none', borderRadius: '4px' }}>
                List Your Event
              </Link>
            </div>

            {/* My Bookings section */}
            <div className={styles.bookingsSection}>
              <h3 className={styles.bookingsTitle}>My Bookings</h3>

              {bookingsLoading && (
                <p className={styles.bookingsState}>Loading your bookings…</p>
              )}

              {!bookingsLoading && bookingsError && (
                <p className={styles.bookingsError}>{bookingsError}</p>
              )}

              {!bookingsLoading && !bookingsError && bookings !== null && bookings.length === 0 && (
                <>
                  <p className={styles.bookingsState}>You haven&apos;t booked any events yet.</p>
                  <Link href="/" className={styles.emptyLink}>Browse upcoming events</Link>
                </>
              )}

              {!bookingsLoading && !bookingsError && bookings !== null && bookings.length > 0 && (
                <ul className={styles.bookingList}>
                  {bookings.map((booking) => (
                    <li key={booking.id}>
                      <Link href={`/events/${booking.eventId}`} className={styles.bookingCard}>
                        {booking.eventCoverImageUrl ? (
                          <img
                            src={booking.eventCoverImageUrl}
                            alt={booking.eventName}
                            className={styles.bookingImage}
                          />
                        ) : (
                          <div className={styles.bookingImagePlaceholder} />
                        )}
                        <div className={styles.bookingInfo}>
                          <p className={styles.bookingName}>{booking.eventName}</p>
                          <p className={styles.bookingMeta}>
                            {new Date(booking.eventDate).toLocaleDateString('en-GB', {
                              weekday: 'short', year: 'numeric', month: 'short', day: 'numeric',hour: '2-digit',
  minute: '2-digit',
                            })}
                          </p>
                          <p className={styles.bookingMeta}>
                            {booking.seatCount} seat{booking.seatCount !== 1 ? 's' : ''} booked
                          </p>
                        </div>
                      </Link>
                      {/* Download Ticket — authenticated tRPC call; no public R2 URL */}
                      <button
                        id={`download-ticket-${booking.id}`}
                        disabled={downloadState[booking.id] === 'loading'}
                        onClick={() => handleDownloadTicket(booking.id)}
                        style={{
                          marginTop: '0.5rem',
                          padding: '0.4rem 0.9rem',
                          fontSize: '0.85rem',
                          backgroundColor: downloadState[booking.id] === 'error' ? '#c0392b' : '#0070f3',
                          color: 'white',
                          border: 'none',
                          borderRadius: '4px',
                          cursor: downloadState[booking.id] === 'loading' ? 'not-allowed' : 'pointer',
                          opacity: downloadState[booking.id] === 'loading' ? 0.7 : 1,
                        }}
                      >
                        {downloadState[booking.id] === 'loading'
                          ? 'Downloading…'
                          : downloadState[booking.id] === 'error'
                          ? 'Download failed — retry'
                          : '⭳ Download Ticket'}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        </div>
      )}
      </div>
    </RequireAuth>
  );
}
