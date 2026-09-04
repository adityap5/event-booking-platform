import Head from 'next/head';
import { RequireOrgAuth } from '../../components/RequireOrgAuth';
import { AppHeader } from '../../components/layout/AppHeader';
import { SubscriptionWarning } from '../../components/events/SubscriptionWarning';
import { EventForm } from '../../components/events/EventForm';
import { useSubscriptionStatus } from '../../hooks/useSubscriptionStatus';

export default function CreateEventPage() {
  const { loading: subLoading, subscriptionStatus } = useSubscriptionStatus();

  return (
    <RequireOrgAuth>
      <div className="max-w-[680px] mx-auto p-8 font-sans">
        <Head>
          <title>Create Event | Organiser</title>
        </Head>

        <AppHeader />

        <h1 className="text-[1.75rem] font-bold text-[#333] mb-7">Create Event</h1>

        {subLoading ? (
          <div className="flex justify-center px-4 py-12 text-gray-500">
            <p>Checking organisation subscription entitlement…</p>
          </div>
        ) : subscriptionStatus !== 'active' && subscriptionStatus !== 'trialing' ? (
          <SubscriptionWarning subscriptionStatus={subscriptionStatus} />
        ) : (
          <EventForm />
        )}
      </div>
    </RequireOrgAuth>
  );
}
