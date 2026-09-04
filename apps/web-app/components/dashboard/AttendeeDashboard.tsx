import Link from 'next/link';
import { useEffect, useState } from 'react';
import { useAuth } from '@clerk/nextjs';
import { createAuthenticatedTRPCClient } from '../../lib/trpc';
import { useTicketDownload } from '../../hooks/useTicketDownload';
import type { Booking } from '../../types';
import { BookingCard } from './BookingCard';

export function AttendeeDashboard() {
  const { getToken } = useAuth();
  const [bookings, setBookings] = useState<Booking[] | null>(null);
  const [bookingsLoading, setBookingsLoading] = useState(true);
  const [bookingsError, setBookingsError] = useState<string | null>(null);

  const { downloadState, handleDownloadTicket } = useTicketDownload();

  useEffect(() => {
    let cancelled = false;
    const trpc = createAuthenticatedTRPCClient(getToken);
    trpc.listMyBookings.query()
      .then((data) => {
        if (!cancelled) setBookings(data);
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setBookingsError(err instanceof Error ? err.message : 'Failed to load bookings');
        }
      })
      .finally(() => {
        if (!cancelled) setBookingsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  // getToken is a stable Clerk reference — safe to omit from deps
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="mt-8">
      <h2 className="text-xl font-bold mb-1">Welcome Attendee!</h2>
      <p className="text-gray-500 mb-6">You do not have an active organization.</p>

      <div className="flex gap-8 flex-wrap">
        {/* Upgrade to Organiser Card */}
        <div className="p-6 border border-[#0070f3] rounded-lg flex-1 min-w-[250px]">
          <h3 className="text-lg font-semibold mb-2">Want to host your own events?</h3>
          <p className="text-gray-600 mb-4">Create an organization to start managing and listing events.</p>
          <Link
            href="/dashboard/become-organiser"
            className="inline-block px-4 py-2 bg-[#0070f3] hover:bg-[#0059c2] text-white no-underline rounded transition-colors"
          >
            List Your Event
          </Link>
        </div>

        {/* My Bookings section */}
        <div className="flex-1 min-w-[250px]">
          <h3 className="text-base font-semibold text-[#333] mb-3">My Bookings</h3>

          {bookingsLoading && (
            <p className="text-[0.9rem] text-[#666]">Loading your bookings…</p>
          )}

          {!bookingsLoading && bookingsError && (
            <p className="text-[0.9rem] text-[#c0392b]">{bookingsError}</p>
          )}

          {!bookingsLoading && !bookingsError && bookings !== null && bookings.length === 0 && (
            <>
              <p className="text-[0.9rem] text-[#666]">You haven&apos;t booked any events yet.</p>
              <Link href="/" className="inline-block mt-2 text-[#0070f3] hover:underline text-[0.9rem] no-underline">
                Browse upcoming events
              </Link>
            </>
          )}

          {!bookingsLoading && !bookingsError && bookings !== null && bookings.length > 0 && (
            <ul className="list-none m-0 p-0 flex flex-col gap-3">
              {bookings.map((booking) => (
                <BookingCard
                  key={booking.id}
                  booking={booking}
                  downloadStatus={downloadState[booking.id] ?? 'idle'}
                  onDownload={handleDownloadTicket}
                />
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
