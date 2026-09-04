import type { AttendeeRow } from '../../types';

interface AttendeeListProps {
  loading: boolean;
  error: string | null;
  attendees: AttendeeRow[] | null;
}

export function AttendeeList({ loading, error, attendees }: AttendeeListProps) {
  return (
    <div className="mt-4 pt-4 border-t border-[#eaeaea]">
      {loading && <p className="text-sm text-[#666] m-0">Loading attendees…</p>}
      {!loading && error && <p className="text-sm text-[#c0392b] m-0">{error}</p>}
      {!loading && !error && attendees !== null && attendees.length === 0 && (
        <p className="text-sm text-[#666] m-0">No confirmed bookings yet.</p>
      )}
      {!loading && !error && attendees !== null && attendees.length > 0 && (
        <ul className="list-none m-0 p-0 flex flex-col gap-2">
          {attendees.map((a) => (
            <li key={a.id} className="flex justify-between p-3 bg-gray-50 border border-gray-200 rounded-md text-sm items-center">
              <div>
                <span className="font-medium text-gray-900">{a.attendeeName}</span>
                <span className="text-gray-500 ml-2">({a.attendeeEmail})</span>
              </div>
              <span className="text-gray-700 font-medium">
                {a.seatCount} seat{a.seatCount !== 1 ? 's' : ''}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
