import Head from 'next/head';
import Link from 'next/link';
import { createTRPCClient, httpBatchLink } from '@trpc/client';
import type { AppRouter } from '@event-booking/worker/src/router';
import type { GetServerSideProps, InferGetServerSidePropsType } from 'next';
import styles from './home.module.css';

interface PublicEvent {
  id: string;
  name: string;
  date: number;
  totalSeats: number;
  pricePerSeat: number;
  coverImageUrl: string | null;
}

// ---------------------------------------------------------------------------
// getServerSideProps — fetch upcoming events server-side (no auth needed)
// ---------------------------------------------------------------------------
export const getServerSideProps = (async () => {
  const trpc = createTRPCClient<AppRouter>({
    links: [
      httpBatchLink({
        url: process.env.NEXT_PUBLIC_TRPC_URL!,
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
    <div className={styles.page}>
      <Head>
        <title>Event Booking Platform</title>
        <meta name="description" content="Browse and book upcoming events." />
      </Head>

      <header className={styles.header}>
        <h1 className={styles.title}>Upcoming Events</h1>
      </header>

      {events.length === 0 ? (
        <p className={styles.empty}>No upcoming events at the moment. Check back soon!</p>
      ) : (
        <ul className={styles.grid}>
          {events.map((event) => {
            const formattedDate = new Date(event.date).toLocaleDateString('en-GB', {
              weekday: 'short',
              year: 'numeric',
              month: 'short',
              day: 'numeric',
              hour: '2-digit',
  minute: '2-digit',
            });
            const formattedPrice = `£${(event.pricePerSeat / 100).toFixed(2)} per seat`;

            return (
              <li key={event.id} className={styles.card}>
                <Link href={`/events/${event.id}`} className={styles.cardLink}>
                  {event.coverImageUrl ? (
                    <img
                      src={event.coverImageUrl}
                      alt={event.name}
                      className={styles.cardImage}
                    />
                  ) : (
                    <div className={styles.cardImagePlaceholder} aria-hidden="true" />
                  )}
                  <div className={styles.cardBody}>
                    <p className={styles.cardName}>{event.name}</p>
                    <p className={styles.cardMeta}>{formattedDate}</p>
                    <p className={styles.cardPrice}>{formattedPrice}</p>
                  </div>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
