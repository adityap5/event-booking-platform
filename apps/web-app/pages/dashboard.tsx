import {
  useAuth,
  useOrganization,
  OrganizationSwitcher,
  UserButton,
} from '@clerk/nextjs';
import { useState } from 'react';
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
        <OrganizationSwitcher />
        <UserButton />
      </header>

      <h1>Dashboard</h1>
      <p>User ID: {userId}</p>
      <p>
        Organization: {organization?.name ?? 'None selected'} ({orgId ?? 'n/a'})
      </p>

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
            color: '#333'
          }}
        >
          {whoamiResult}
        </pre>
      )}
    </div>
  );
}
