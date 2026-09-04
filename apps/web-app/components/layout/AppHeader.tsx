import { OrganizationSwitcher, UserButton } from '@clerk/nextjs';

export function AppHeader() {
  return (
    <header className="flex justify-between items-center mb-8">
      <OrganizationSwitcher
        hidePersonal={true}
        appearance={{
          elements: {
            organizationSwitcherPopoverActionButton__createOrganization: {
              display: 'none',
            },
          },
        }}
      />
      <UserButton />
    </header>
  );
}
