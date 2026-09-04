import Head from 'next/head';
import { createTRPCClient, httpBatchLink } from '@trpc/client';
import { getCloudflareContext } from '@opennextjs/cloudflare';
import type { AppRouter } from '@event-booking/worker/src/router';
import type { GetServerSideProps, InferGetServerSidePropsType } from 'next';
import type { PublicEvent } from '../types';
import { EventCard } from '../components/events/EventCard';

// ---------------------------------------------------------------------------
// getServerSideProps — fetch upcoming events server-side (no auth needed)
// ---------------------------------------------------------------------------
export const getServerSideProps = (async () => {
  // Note: getCloudflareContext() may throw or return undefined outside of the deployed Workers runtime (e.g., during local next dev).
  const { env } = getCloudflareContext();

  const trpc = createTRPCClient<AppRouter>({
    links: [
      httpBatchLink({
        url: 'https://internal/trpc',
        fetch: (input, init) => env.WORKER_SERVICE.fetch(input as string, init as RequestInit),
      }),
    ],
  });

  const events = await trpc.listPublicEvents.query();
  return { props: { events } };
}) satisfies GetServerSideProps<{ events: PublicEvent[] }>;

export default function HomePage({
  events,
}: InferGetServerSidePropsType<typeof getServerSideProps>) {
  return (
    <div className="max-w-[900px] mx-auto px-6 py-8 font-sans">
      <Head>
        <title>Event Booking Platform</title>
        <meta name="description" content="Browse and book upcoming events." />
      </Head>

      <header className="mb-8 border-b border-[#e2e2e2] pb-4">
        <h1 className="text-[1.75rem] font-bold text-[#222] m-0">Upcoming Events</h1>
      </header>

      {events.length === 0 ? (
        <p className="p-8 border border-dashed border-[#ccc] rounded-lg text-center text-[#666] mt-4">
          No upcoming events at the moment. Check back soon!
        </p>
      ) : (
        <ul className="list-none m-0 p-0 grid grid-cols-[repeat(auto-fill,minmax(260px,1fr))] gap-5">
          {events.map((event) => (
            <EventCard key={event.id} event={event} />
          ))}
        </ul>
      )}
    </div>
  );
}