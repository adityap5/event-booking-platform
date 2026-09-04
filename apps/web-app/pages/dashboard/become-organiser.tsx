import { CreateOrganization, useOrganization, useAuth } from '@clerk/nextjs';
import { RequireAuth } from '../../components/RequireAuth';
import Head from 'next/head';
import { useRouter } from 'next/router';
import { useEffect, useState } from 'react';
import { createAuthenticatedTRPCClient } from '../../lib/trpc';

export default function BecomeOrganiserPage() {
  const { organization, isLoaded } = useOrganization();
  const { getToken } = useAuth();
  const router = useRouter();
  const [isSyncing, setIsSyncing] = useState(false);

  useEffect(() => {
    if (!isLoaded) return;

    if (organization) {
      setIsSyncing(true);
      const trpc = createAuthenticatedTRPCClient(getToken);
      
      const poll = async () => {
        try {
          const synced = await trpc.checkOrgSync.query();
          if (synced) {
            void router.replace('/dashboard');
          } else {
            setTimeout(poll, 1000);
          }
        } catch {
          setTimeout(poll, 1000);
        }
      };

      void poll();
    }
  }, [isLoaded, organization, router, getToken]);

  if (!isLoaded || organization) {
    return (
      <>
        <Head>
          <title>Become an Organiser | Event Booking</title>
        </Head>
        <div className="flex flex-col items-center justify-center min-h-[60vh] gap-4" role="status" aria-label="Loading">
          <div className="w-8 h-8 border-[3px] border-gray-200 border-t-[#0070f3] rounded-full animate-spin" />
          <p className="text-sm text-gray-500">
            {isSyncing ? 'Syncing your organization...' : 'Loading…'}
          </p>
        </div>
      </>
    );
  }

  return (
    <RequireAuth>
      <div className="flex flex-col items-center min-h-screen px-4 py-8 bg-[#fafafa]">
        <Head>
          <title>Become an Organiser | Event Booking</title>
        </Head>

        <header className="mb-8 text-center max-w-[600px]">
          <h1 className="text-[1.75rem] font-bold text-gray-900 mb-3 leading-[1.3]">Create Your Organization</h1>
          <p className="text-base text-gray-500 leading-[1.6] m-0">
            Set up an organization to start creating and managing events on the
            platform. You&apos;ll be the owner and can invite team members later.
          </p>
        </header>

        <CreateOrganization
          afterCreateOrganizationUrl="/dashboard/become-organiser"
          skipInvitationScreen={true}
        />
      </div>
    </RequireAuth>
  );
}
