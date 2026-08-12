import {
  useAuth,
  useOrganization,
  OrganizationSwitcher,
  UserButton,
} from '@clerk/nextjs';
import { RequireAuth } from '../components/RequireAuth';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { createAuthenticatedTRPCClient } from '../lib/trpc';
import styles from './dashboard.module.css';

export default function DashboardPage() {
  const { userId, orgId, getToken } = useAuth();
  const { organization, isLoaded } = useOrganization();
  const [whoamiResult, setWhoamiResult] = useState<string>('');
  const [loading, setLoading] = useState(false);

  const handleFetchToken = async () => {
    const token = await getToken();
    console.log('Clerk JWT:', token);
  };

  const handleTestTrpc = async () => {
    setLoading(true);
    setWhoamiResult('Loading...');
    try {
      const trpc = createAuthenticatedTRPCClient(getToken);
      // Hovering over `whoami.query` proves type inference works!
      const result = await trpc.whoami.query();
      setWhoamiResult(JSON.stringify(result, null, 2));
    } catch (error: any) {
      setWhoamiResult('Error: ' + error.message);
    } finally {
      setLoading(false);
    }
  };

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
        <OrganizationSwitcher hidePersonal={true} />
        <UserButton />
      </header>

      <h1>Dashboard</h1>
      <p>User ID: {userId}</p>
      
      {organization ? (
        // Organiser View
        <div style={{ marginTop: '2rem', padding: '1.5rem', border: '1px solid #eaeaea', borderRadius: '8px' }}>
          <h2>Welcome Organiser!</h2>
          <p>Organization: {organization.name} ({orgId})</p>
          <Link href="/events/create" style={{ display: 'inline-block', marginTop: '1rem', padding: '0.5rem 1rem', fontSize: '1rem', backgroundColor: '#0070f3', color: 'white', textDecoration: 'none', borderRadius: '4px', fontWeight: 500 }}>
            Create Event
          </Link>
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
                              weekday: 'short', year: 'numeric', month: 'short', day: 'numeric',
                            })}
                          </p>
                          <p className={styles.bookingMeta}>
                            {booking.seatCount} seat{booking.seatCount !== 1 ? 's' : ''} booked
                          </p>
                        </div>
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        </div>
      )}

      <div style={{ marginTop: '3rem', paddingTop: '2rem', borderTop: '1px solid #eaeaea' }}>
        <h3>Developer Tools</h3>
        <div style={{ marginTop: '1rem', display: 'flex', gap: '1rem' }}>
          <button onClick={handleFetchToken}>Log JWT to Console</button>
          <button onClick={handleTestTrpc} disabled={loading}>
            Test tRPC whoami
          </button>
        </div>

        {whoamiResult && (
          <pre
            style={{
              marginTop: '1rem',
              padding: '1rem',
              backgroundColor: '#f5f5f5',
              borderRadius: '4px',
              color: '#333',
              overflowX: 'auto',
            }}
          >
            {whoamiResult}
          </pre>
        )}
      </div>
      </div>
    </RequireAuth>
  );
}
