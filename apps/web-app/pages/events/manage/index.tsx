import Head from 'next/head';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { OrganizationSwitcher, UserButton, useAuth } from '@clerk/nextjs';
import { RequireOrgAuth } from '../../../components/RequireOrgAuth';
import { createAuthenticatedTRPCClient } from '../../../lib/trpc';
import { useSeatCount } from '../../../hooks/useSeatCount';
import styles from './manage.module.css';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface OrgEvent {
  id: string;
  name: string;
  date: number;
  totalSeats: number;
  pricePerSeat: number;
  coverImageUrl: string | null;
}

// ---------------------------------------------------------------------------
// EventManageRow — only component allowed to call useSeatCount per event
// (Rules of Hooks: hooks cannot be called inside .map())
// ---------------------------------------------------------------------------

function EventManageRow({ id, name, date, totalSeats, pricePerSeat, coverImageUrl }: OrgEvent) {
  const available = useSeatCount(id);

  const formattedDate = new Date(date).toLocaleDateString('en-GB', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });

  const formattedPrice = `£${(pricePerSeat / 100).toFixed(2)} per seat`;

  return (
    <div className={styles.row}>
      {coverImageUrl && (
        <img src={coverImageUrl} alt={name} className={styles.rowImage} />
      )}
      <div className={styles.rowInfo}>
        <p className={styles.rowName}>{name}</p>
        <p className={styles.rowMeta}>{formattedDate}</p>
        <p className={styles.rowMeta}>{formattedPrice}</p>
        <p className={available === 0 ? styles.rowSeatsLow : styles.rowSeats}>
          Available: {available !== null ? `${available} / ${totalSeats}` : 'Loading…'}
        </p>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// ManageEventsPage
// ---------------------------------------------------------------------------

export default function ManageEventsPage() {
  const { getToken } = useAuth();

  const [events, setEvents] = useState<OrgEvent[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    const trpc = createAuthenticatedTRPCClient(getToken);
    trpc.listOrgEvents.query()
      .then((data) => {
        if (!cancelled) setEvents(data);
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Failed to load events');
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  // getToken is a stable Clerk reference — safe to list as a dep
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <RequireOrgAuth>
      <div className={styles.page}>
        <Head>
          <title>Manage Events | Organiser View</title>
        </Head>

        <header className={styles.header}>
          <OrganizationSwitcher hidePersonal={true} />
          <UserButton />
        </header>

        <h1 className={styles.title}>Manage Your Events</h1>

        {loading && (
          <p className={styles.stateMessage}>Loading your events…</p>
        )}

        {!loading && error && (
          <p className={styles.errorMessage}>Error: {error}</p>
        )}

        {!loading && !error && events !== null && events.length === 0 && (
          <div className={styles.emptyState}>
            <p>You haven&apos;t created any events yet.</p>
            <Link href="/dashboard" className={styles.emptyLink}>
              Go to Dashboard
            </Link>
          </div>
        )}

        {!loading && !error && events !== null && events.length > 0 && (
          <div className={styles.list}>
            {events.map((event) => (
              <EventManageRow key={event.id} {...event} />
            ))}
          </div>
        )}
      </div>
    </RequireOrgAuth>
  );
}
