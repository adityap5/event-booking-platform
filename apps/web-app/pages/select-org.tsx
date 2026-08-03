import { OrganizationList } from '@clerk/nextjs';

/**
 * Org selection page — users land here when they're signed in but
 * don't have an active organization. The OrganizationList component
 * lets them create a new org or join an existing one.
 */
export default function SelectOrgPage() {
  return (
    <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', minHeight: '100vh' }}>
      <OrganizationList
        afterCreateOrganizationUrl="/dashboard"
        afterSelectOrganizationUrl="/dashboard"
      />
    </div>
  );
}
