import {
  useAuth,
  useOrganization,
  OrganizationSwitcher,
  UserButton,
} from '@clerk/nextjs';
import { getAuth } from '@clerk/nextjs/server';
import { GetServerSideProps } from 'next';
import { useState } from 'react';
import Link from 'next/link';
import { createAuthenticatedTRPCClient } from '../lib/trpc';

export default function DashboardPage() {
  const { userId, orgId, getToken } = useAuth();
  const { organization } = useOrganization();
  const [whoamiResult, setWhoamiResult] = useState<string>('');
  const [loading, setLoading] = useState(false);

  const handleFetchToken = async () => {
    const token = await getToken();
    console.log('Clerk JWT:', token);
  };

  const handleTestTrpc = async () => {
    setLoading(true);
    setWhoamiResult('Loading...');
    try {
      const trpc = createAuthenticatedTRPCClient(getToken);
      // Hovering over `whoami.query` proves type inference works!
      const result = await trpc.whoami.query();
      setWhoamiResult(JSON.stringify(result, null, 2));
    } catch (error: any) {
      setWhoamiResult('Error: ' + error.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={{ padding: '2rem' }}>
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

      <h1>Dashboard</h1>
      <p>User ID: {userId}</p>
      
      {organization ? (
        // Organiser View
        <div style={{ marginTop: '2rem', padding: '1.5rem', border: '1px solid #eaeaea', borderRadius: '8px' }}>
          <h2>Welcome Organiser!</h2>
          <p>Organization: {organization.name} ({orgId})</p>
          <button style={{ padding: '0.5rem 1rem', fontSize: '1rem', marginTop: '1rem', cursor: 'not-allowed', backgroundColor: '#e0e0e0', color: '#666', border: 'none', borderRadius: '4px' }} disabled>
            Create Event (Coming Soon)
          </button>
        </div>
      ) : (
        // Attendee View
        <div style={{ marginTop: '2rem' }}>
          <h2>Welcome Attendee!</h2>
          <p style={{ color: '#666', marginBottom: '1.5rem' }}>You do not have an active organization.</p>
          
          <div style={{ display: 'flex', gap: '2rem', flexWrap: 'wrap' }}>
            {/* Upgrade to Organiser Card */}
            <div style={{ padding: '1.5rem', border: '1px solid #0070f3', borderRadius: '8px', flex: '1', minWidth: '250px' }}>
              <h3>Want to host your own events?</h3>
              <p>Create an organization to start managing and listing events.</p>
              <Link href="/dashboard/become-organiser" style={{ display: 'inline-block', marginTop: '1rem', padding: '0.5rem 1rem', backgroundColor: '#0070f3', color: 'white', textDecoration: 'none', borderRadius: '4px' }}>
                List Your Event
              </Link>
            </div>

            {/* Dummy Event Card */}
            <div style={{ padding: '1.5rem', border: '1px solid #eaeaea', borderRadius: '8px', flex: '1', minWidth: '250px' }}>
              <h3>Upcoming Event: Summer Music Fest</h3>
              <p>August 15th, 2026 - Central Park</p>
              <button style={{ padding: '0.5rem 1rem', marginTop: '1rem', cursor: 'not-allowed', backgroundColor: '#e0e0e0', color: '#666', border: 'none', borderRadius: '4px' }} disabled>
                Book Ticket (Coming Soon)
              </button>
            </div>
          </div>
        </div>
      )}

      <div style={{ marginTop: '3rem', paddingTop: '2rem', borderTop: '1px solid #eaeaea' }}>
        <h3>Developer Tools</h3>
        <div style={{ marginTop: '1rem', display: 'flex', gap: '1rem' }}>
          <button onClick={handleFetchToken}>Log JWT to Console</button>
          <button onClick={handleTestTrpc} disabled={loading}>
            Test tRPC whoami
          </button>
        </div>

        {whoamiResult && (
          <pre
            style={{
              marginTop: '1rem',
              padding: '1rem',
              backgroundColor: '#f5f5f5',
              borderRadius: '4px',
              color: '#333',
              overflowX: 'auto',
            }}
          >
            {whoamiResult}
          </pre>
        )}
      </div>
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
