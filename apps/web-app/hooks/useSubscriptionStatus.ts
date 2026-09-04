import { useState, useEffect, useCallback } from 'react';
import { useAuth } from '@clerk/nextjs';
import { createAuthenticatedTRPCClient } from '../lib/trpc';
import type { SubscriptionData } from '../types';

export function useSubscriptionStatus() {
  const { getToken } = useAuth();
  const [loading, setLoading] = useState(true);
  const [data, setData] = useState<SubscriptionData | null>(null);
  const [error, setError] = useState<string | null>(null);

  const fetchStatus = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const trpc = createAuthenticatedTRPCClient(getToken);
      const res = await trpc.getSubscriptionStatus.query();
      setData(res);
      return res;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Failed to load subscription status.';
      setError(msg);
      return null;
    } finally {
      setLoading(false);
    }
  }, [getToken]);

  useEffect(() => {
    void fetchStatus();
  }, [fetchStatus]);

  return {
    loading,
    data,
    subscriptionStatus: data?.subscriptionStatus ?? (error ? 'inactive' : null),
    error,
    refetch: fetchStatus,
  };
}
