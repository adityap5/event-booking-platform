import { useAuth } from '@clerk/nextjs';
import { useRouter } from 'next/router';
import { useEffect } from 'react';

export function RequireAuth({ children }: { children: React.ReactNode }) {
  const { isLoaded, userId } = useAuth();
  const router = useRouter();

  useEffect(() => {
    if (isLoaded && !userId) {
      router.replace('/sign-in?redirect_url=' + encodeURIComponent(router.asPath));
    }
  }, [isLoaded, userId, router]);

  if (!isLoaded || !userId) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', padding: '40px' }}>
        <p>Loading...</p>
      </div>
    );
  }

  return <>{children}</>;
}
