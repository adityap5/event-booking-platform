import { useAuth } from '@clerk/nextjs';
import { useRouter } from 'next/router';
import { useEffect } from 'react';

export function RequireOrgAuth({ children }: { children: React.ReactNode }) {
  const { isLoaded, userId, orgId } = useAuth();
  const router = useRouter();

  useEffect(() => {
    if (isLoaded) {
      if (!userId) {
        router.replace('/sign-in?redirect_url=' + encodeURIComponent(router.asPath));
      } else if (!orgId) {
        router.replace('/dashboard');
      }
    }
  }, [isLoaded, userId, orgId, router]);

  if (!isLoaded || !userId || !orgId) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', padding: '40px' }}>
        <p>Loading...</p>
      </div>
    );
  }

  return <>{children}</>;
}
