import { useState, useEffect } from 'react';
import { useAuth } from '@clerk/nextjs';
import { createTRPCClient, httpBatchLink } from '@trpc/client';
import { getCloudflareContext } from '@opennextjs/cloudflare';
import { useSeatCount } from '../../hooks/useSeatCount';
import { EventDetails } from '../../components/events/EventDetails';
import { BookingWidget } from '../../components/events/BookingWidget';
import type { AppRouter } from '@event-booking/worker/src/router';
import type { GetServerSideProps, InferGetServerSidePropsType } from 'next';
import type { EventData } from '../../types';

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
  const { isSignedIn } = useAuth();

  // Live seat count (WebSocket — authenticated users only; called exactly once per page)
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

  return (
    <div className="max-w-[680px] mx-auto px-4 py-8 font-sans">
      <EventDetails event={event} availableSeats={displayedCount} />
      <BookingWidget eventId={event.id} availableSeats={displayedCount} />
    </div>
  );
}
