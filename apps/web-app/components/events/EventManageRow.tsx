import { useState } from 'react';
import { useAuth } from '@clerk/nextjs';
import { createAuthenticatedTRPCClient } from '../../lib/trpc';
import { useSeatCount } from '../../hooks/useSeatCount';
import type { OrgEvent, AttendeeRow } from '../../types';
import { AttendeeList } from './AttendeeList';

export function EventManageRow({ id, name, date, totalSeats, pricePerSeat, coverImageUrl }: OrgEvent) {
  const { getToken } = useAuth();
  const available = useSeatCount(id);

  const [expanded, setExpanded] = useState(false);
  const [attendees, setAttendees] = useState<AttendeeRow[] | null>(null);
  const [loadingAttendees, setLoadingAttendees] = useState(false);
  const [attendeesError, setAttendeesError] = useState<string | null>(null);

  const handleToggle = () => {
    if (!expanded && attendees === null) {
      setLoadingAttendees(true);
      const trpc = createAuthenticatedTRPCClient(getToken);
      trpc.getEventAttendees.query({ eventId: id })
        .then(setAttendees)
        .catch((err: unknown) => setAttendeesError(err instanceof Error ? err.message : 'Error loading attendees'))
        .finally(() => setLoadingAttendees(false));
    }
    setExpanded(!expanded);
  };

  const formattedDate = new Date(date).toLocaleDateString('en-GB', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });

  const formattedPrice = `£${(pricePerSeat / 100).toFixed(2)} per seat`;

  return (
    <div className="flex gap-4 items-start p-5 border border-[#e2e2e2] rounded-lg bg-white">
      {coverImageUrl && (
        <img src={coverImageUrl} alt={name} className="w-24 h-[72px] object-cover rounded-md flex-shrink-0" />
      )}
      <div className="flex flex-col gap-1 flex-1">
        <p className="text-[1.1rem] font-semibold text-[#222] m-0">{name}</p>
        <p className="text-sm text-[#666] m-0">{formattedDate}</p>
        <p className="text-sm text-[#666] m-0">{formattedPrice}</p>
        <p className={`text-sm m-0 font-medium ${available === 0 ? 'text-[#c0392b]' : 'text-[#27ae60]'}`}>
          Available: {available !== null ? `${available} / ${totalSeats}` : 'Loading…'}
        </p>

        <button
          onClick={handleToggle}
          className="bg-transparent border-0 text-[#0070f3] hover:text-[#0059c2] text-[0.9rem] font-medium pt-2 pb-0 px-0 m-0 cursor-pointer underline text-left"
        >
          {expanded ? 'Hide attendees' : 'View attendees'}
        </button>

        {expanded && (
          <AttendeeList
            loading={loadingAttendees}
            error={attendeesError}
            attendees={attendees}
          />
        )}
      </div>
    </div>
  );
}
