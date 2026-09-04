import Link from 'next/link';
import type { Booking } from '../../types';
import type { DownloadStatus } from '../../hooks/useTicketDownload';

interface BookingCardProps {
  booking: Booking;
  downloadStatus: DownloadStatus;
  onDownload: (bookingId: string) => void;
}

export function BookingCard({ booking, downloadStatus, onDownload }: BookingCardProps) {
  return (
    <li>
      <Link
        href={`/events/${booking.eventId}`}
        className="flex items-start gap-3 p-3 border border-[#e2e2e2] rounded-lg no-underline text-inherit bg-white transition-shadow hover:shadow-[0_2px_10px_rgba(0,0,0,0.08)]"
      >
        {booking.eventCoverImageUrl ? (
          <img
            src={booking.eventCoverImageUrl}
            alt={booking.eventName}
            className="w-[60px] h-[45px] object-cover rounded-[5px] flex-shrink-0"
          />
        ) : (
          <div className="w-[60px] h-[45px] rounded-[5px] flex-shrink-0 bg-gradient-to-br from-[#e8eaf0] to-[#d1d5db]" />
        )}
        <div className="flex flex-col gap-0.5 min-w-0">
          <p className="text-[0.9rem] font-semibold text-[#222] m-0 truncate">{booking.eventName}</p>
          <p className="text-[0.8rem] text-[#666] m-0">
            {new Date(booking.eventDate).toLocaleDateString('en-GB', {
              weekday: 'short',
              year: 'numeric',
              month: 'short',
              day: 'numeric',
              hour: '2-digit',
              minute: '2-digit',
            })}
          </p>
          <p className="text-[0.8rem] text-[#666] m-0">
            {booking.seatCount} seat{booking.seatCount !== 1 ? 's' : ''} booked
          </p>
        </div>
      </Link>
      {/* Download Ticket — authenticated tRPC call; no public R2 URL */}
      <button
        id={`download-ticket-${booking.id}`}
        disabled={downloadStatus === 'loading'}
        onClick={() => onDownload(booking.id)}
        className={`mt-2 px-3.5 py-1.5 text-[0.85rem] text-white border-0 rounded transition-colors ${
          downloadStatus === 'loading'
            ? 'opacity-70 cursor-not-allowed bg-[#0070f3]'
            : downloadStatus === 'error'
            ? 'bg-[#c0392b] hover:bg-[#a93226] cursor-pointer'
            : 'bg-[#0070f3] hover:bg-[#0059c2] cursor-pointer'
        }`}
      >
        {downloadStatus === 'loading'
          ? 'Downloading…'
          : downloadStatus === 'error'
          ? 'Download failed — retry'
          : '⭳ Download Ticket'}
      </button>
    </li>
  );
}
