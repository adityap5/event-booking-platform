import Link from 'next/link';

interface SubscriptionWarningProps {
  subscriptionStatus: string | null;
}

export function SubscriptionWarning({ subscriptionStatus }: SubscriptionWarningProps) {
  return (
    <div className="bg-white border border-gray-200 rounded-xl p-8 shadow-sm mt-4">
      <div className="bg-amber-50 border border-amber-200 text-amber-800 px-5 py-4 rounded-lg mb-6 text-[0.95rem] leading-[1.5]">
        <strong>Active subscription required:</strong> Your organisation currently has a{' '}
        <code>{subscriptionStatus ?? 'inactive'}</code> subscription. An active subscription is required to publish and host new events.
      </div>
      <p className="text-gray-600 leading-[1.6]">
        Existing events and bookings are unaffected, but you must subscribe or resolve any payment issues before creating new events.
      </p>
      <div className="flex gap-4 items-center mt-6">
        <Link
          href="/dashboard/billing"
          className="inline-block bg-[#0070f3] hover:bg-[#0051b3] text-white no-underline px-6 py-3 text-[0.95rem] font-semibold rounded-lg transition duration-150"
        >
          Go to Billing &amp; Subscription
        </Link>
        <Link
          href="/dashboard"
          className="inline-block text-gray-600 hover:text-gray-900 no-underline text-[0.95rem] font-medium px-4 py-3"
        >
          Back to Dashboard
        </Link>
      </div>
    </div>
  );
}
