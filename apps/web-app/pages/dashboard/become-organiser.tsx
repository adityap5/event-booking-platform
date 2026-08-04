import { CreateOrganization, useOrganization } from '@clerk/nextjs';
import { getAuth } from '@clerk/nextjs/server';
import { GetServerSideProps } from 'next';
import Head from 'next/head';
import { useRouter } from 'next/router';
import { useEffect } from 'react';
import styles from './become-organiser.module.css';

export default function BecomeOrganiserPage() {
  const { organization, isLoaded } = useOrganization();
  const router = useRouter();

  useEffect(() => {
    if (!isLoaded) return;

    if (organization) {
      router.replace('/dashboard');
    }
  }, [isLoaded, organization, router]);

  if (!isLoaded || organization) {
    return (
      <>
        <Head>
          <title>Become an Organiser | Event Booking</title>
        </Head>
        <div className={styles.loadingContainer} role="status" aria-label="Loading">
          <div className={styles.spinner} />
          <p className={styles.loadingText}>
            {organization ? 'Redirecting to dashboard…' : 'Loading…'}
          </p>
        </div>
      </>
    );
  }

  return (
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
        afterCreateOrganizationUrl="/dashboard"
        skipInvitationScreen={true}
      />
    </div>
  );
}

export const getServerSideProps: GetServerSideProps = async (ctx) => {
  const { userId } = getAuth(ctx.req);

  if (!userId) {
    return {
      redirect: {
        destination: '/sign-in?redirect_url=' + encodeURIComponent(ctx.resolvedUrl),
        permanent: false,
      },
    };
  }

  return { props: {} };
};
