import Link from 'next/link';
import type { PublicEvent } from '../../types';

interface EventCardProps {
  event: PublicEvent;
}

export function EventCard({ event }: EventCardProps) {
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
    <li className="border border-[#e2e2e2] rounded-[10px] overflow-hidden bg-white transition duration-150 hover:shadow-[0_4px_16px_rgba(0,0,0,0.09)] hover:-translate-y-0.5">
      <Link href={`/events/${event.id}`} className="block text-inherit no-underline h-full">
        {event.coverImageUrl ? (
          <img
            src={event.coverImageUrl}
            alt={event.name}
            className="w-full h-40 object-cover block"
          />
        ) : (
          <div className="w-full h-40 bg-gradient-to-br from-[#e8eaf0] to-[#d1d5db]" aria-hidden="true" />
        )}
        <div className="p-4 flex flex-col gap-[0.3rem]">
          <p className="text-base font-semibold text-[#222] m-0 leading-[1.35]">{event.name}</p>
          <p className="text-[0.85rem] text-[#666] m-0">{formattedDate}</p>
          <p className="text-[0.85rem] text-[#0059c2] font-medium m-0">{formattedPrice}</p>
        </div>
      </Link>
    </li>
  );
}
