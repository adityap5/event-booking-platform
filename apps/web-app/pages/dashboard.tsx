import { useAuth, useOrganization } from '@clerk/nextjs';
import { RequireAuth } from '../components/RequireAuth';
import { AppHeader } from '../components/layout/AppHeader';
import { OrganiserDashboard } from '../components/dashboard/OrganiserDashboard';
import { AttendeeDashboard } from '../components/dashboard/AttendeeDashboard';

export default function DashboardPage() {
  const { userId, orgId } = useAuth();
  const { organization, isLoaded } = useOrganization();

  return (
    <RequireAuth>
      <div className="p-8 font-sans">
        <AppHeader />

        <h1 className="text-2xl font-bold mb-1">Dashboard</h1>
        <p className="text-gray-600 mb-4">User ID: {userId}</p>

        {!isLoaded ? null : organization ? (
          <OrganiserDashboard organizationName={organization.name} orgId={orgId} />
        ) : (
          <AttendeeDashboard />
        )}
      </div>
    </RequireAuth>
  );
}
