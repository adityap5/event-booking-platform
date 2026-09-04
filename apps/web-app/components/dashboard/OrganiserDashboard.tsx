import Link from 'next/link';

interface OrganiserDashboardProps {
  organizationName: string;
  orgId: string | null | undefined;
}

export function OrganiserDashboard({ organizationName, orgId }: OrganiserDashboardProps) {
  return (
    <div className="mt-8 p-6 border border-[#eaeaea] rounded-lg">
      <h2 className="text-xl font-bold mb-2">Welcome Organiser!</h2>
      <p className="text-gray-700">Organization: {organizationName} ({orgId})</p>
      <div className="flex gap-4 mt-4 flex-wrap">
        <Link
          href="/events/create"
          className="inline-block px-4 py-2 text-base bg-[#0070f3] hover:bg-[#0059c2] text-white no-underline rounded font-medium transition-colors"
        >
          Create Event
        </Link>
        <Link
          href="/events/manage"
          className="inline-block px-4 py-2 text-base bg-gray-100 hover:bg-gray-200 text-gray-800 no-underline rounded font-medium border border-gray-300 transition-colors"
        >
          Manage Events
        </Link>
        <Link
          href="/dashboard/billing"
          className="inline-block px-4 py-2 text-base bg-gray-100 hover:bg-gray-200 text-gray-800 no-underline rounded font-medium border border-gray-300 transition-colors"
        >
          Billing &amp; Subscription
        </Link>
        <Link
          href="/dashboard/api-keys"
          className="inline-block px-4 py-2 text-base bg-gray-100 hover:bg-gray-200 text-gray-800 no-underline rounded font-medium border border-gray-300 transition-colors"
        >
          API Keys
        </Link>
      </div>
    </div>
  );
}
