import { InferGetServerSidePropsType } from 'next';
import Head from 'next/head';
import { requireOrgAuth } from '../../../lib/requireOrgAuth';
import { OrganizationSwitcher, UserButton } from '@clerk/nextjs';

export const getServerSideProps = requireOrgAuth(async (ctx) => {
  const { orgId } = ctx;
  const dummyServerData = `Loaded 3 events for organization ${orgId}`;

  return {
    props: {
      serverData: dummyServerData,
    },
  };
});

type Props = InferGetServerSidePropsType<typeof getServerSideProps>;

export default function ManageEventsPage({ userId, orgId, serverData }: Props) {
  return (
    <div style={{ padding: '2rem' }}>
      <Head>
        <title>Manage Events | Organiser View</title>
      </Head>

      <header
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          marginBottom: '2rem',
        }}
      >
        <OrganizationSwitcher hidePersonal={true} />
        <UserButton />
      </header>

      <h1>Manage Your Events</h1>
      <p style={{ color: '#666', marginBottom: '2rem' }}>
        This page is strictly accessible only to users with an active organization.
      </p>
      
      <div style={{ padding: '1.5rem', backgroundColor: '#f5f5f5', borderRadius: '8px' }}>
        <h3>Injected Props</h3>
        <p><strong>User ID:</strong> {userId}</p>
        <p><strong>Org ID:</strong> {orgId}</p>
        <p><strong>Server Data:</strong> {serverData}</p>
      </div>
    </div>
  );
}
