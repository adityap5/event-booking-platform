import type { EventData } from '../../types';

interface EventDetailsProps {
  event: EventData;
  availableSeats: number | null;
}

export function EventDetails({ event, availableSeats }: EventDetailsProps) {
  const formattedDate = new Date(event.date).toLocaleDateString('en-GB', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });

  const formattedPrice = `£${(event.pricePerSeat / 100).toFixed(2)} per seat`;

  return (
    <>
      {/* Cover image */}
      {event.coverImageUrl && (
        <img
          src={event.coverImageUrl}
          alt={event.name}
          className="w-full max-h-[340px] object-cover rounded-lg mb-6"
        />
      )}

      {/* Event name */}
      <h1 className="text-[2rem] font-bold mb-2">
        {event.name}
      </h1>

      {/* Date & price */}
      <p className="text-[#555] mb-1">{formattedDate}</p>
      <p className="text-[#555] mb-5">{formattedPrice}</p>

      {/* Description */}
      {event.description && (
        <p className="mb-6 leading-[1.6]">{event.description}</p>
      )}

      {/* Live seat count */}
      <p className="font-semibold mb-6">
        Available seats:{' '}
        <span className={availableSeats === 0 ? 'text-[#c0392b]' : 'text-[#27ae60]'}>
          {availableSeats !== null ? availableSeats : 'Loading…'}
        </span>
      </p>
    </>
  );
}
