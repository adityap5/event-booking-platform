import Head from 'next/head';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { useAuth } from '@clerk/nextjs';
import { RequireOrgAuth } from '../../../components/RequireOrgAuth';
import { AppHeader } from '../../../components/layout/AppHeader';
import { EventManageRow } from '../../../components/events/EventManageRow';
import { createAuthenticatedTRPCClient } from '../../../lib/trpc';
import type { OrgEvent } from '../../../types';

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
      <div className="p-8 font-sans">
        <Head>
          <title>Manage Events | Organiser View</title>
        </Head>

        <AppHeader />

        <h1 className="text-[1.75rem] font-bold text-[#333] mb-6">Manage Your Events</h1>

        {loading && (
          <p className="text-[#555] mt-4">Loading your events…</p>
        )}

        {!loading && error && (
          <p className="text-[#c0392b] mt-4">Error: {error}</p>
        )}

        {!loading && !error && events !== null && events.length === 0 && (
          <div className="p-8 border border-dashed border-[#ccc] rounded-lg text-center text-[#666]">
            <p>You haven&apos;t created any events yet.</p>
            <Link href="/dashboard" className="inline-block mt-4 px-5 py-2.5 bg-[#0070f3] hover:bg-[#0059c2] text-white no-underline rounded-md text-[0.9rem] font-medium transition-colors">
              Go to Dashboard
            </Link>
          </div>
        )}

        {!loading && !error && events !== null && events.length > 0 && (
          <div className="flex flex-col gap-4">
            {events.map((event) => (
              <EventManageRow key={event.id} {...event} />
            ))}
          </div>
        )}
      </div>
    </RequireOrgAuth>
  );
}
