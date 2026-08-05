import { CreateOrganization, useOrganization, useAuth } from '@clerk/nextjs';
import { RequireAuth } from '../../components/RequireAuth';
import Head from 'next/head';
import { useRouter } from 'next/router';
import { useEffect, useState } from 'react';
import styles from './become-organiser.module.css';
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
            router.replace('/dashboard');
          } else {
            setTimeout(poll, 1000);
          }
        } catch (err) {
          setTimeout(poll, 1000);
        }
      };

      poll();
    }
  }, [isLoaded, organization, router, getToken]);

  if (!isLoaded || organization) {
    return (
      <>
        <Head>
          <title>Become an Organiser | Event Booking</title>
        </Head>
        <div className={styles.loadingContainer} role="status" aria-label="Loading">
          <div className={styles.spinner} />
          <p className={styles.loadingText}>
            {isSyncing ? 'Syncing your organization...' : 'Loading…'}
          </p>
        </div>
      </>
    );
  }

  return (
    <RequireAuth>
      <div className={styles.page}>
      <Head>
        <title>Become an Organiser | Event Booking</title>
      </Head>

      <header className={styles.header}>
        <h1 className={styles.title}>Create Your Organization</h1>
        <p className={styles.description}>
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
