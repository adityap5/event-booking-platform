import Head from 'next/head';
import Link from 'next/link';
import { useState } from 'react';
import { useAuth, useOrganization } from '@clerk/nextjs';
import { RequireOrgAuth } from '../../components/RequireOrgAuth';
import { AppHeader } from '../../components/layout/AppHeader';
import { SubscriptionStatusCard } from '../../components/dashboard/SubscriptionStatusCard';
import { useSubscriptionStatus } from '../../hooks/useSubscriptionStatus';
import { createAuthenticatedTRPCClient } from '../../lib/trpc';

export default function BillingPage() {
  const { getToken } = useAuth();
  const { organization } = useOrganization();

  const { loading, data, error, refetch } = useSubscriptionStatus();
  const [actionLoading, setActionLoading] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  async function handleSubscribe() {
    setActionLoading(true);
    setActionError(null);
    try {
      const trpc = createAuthenticatedTRPCClient(getToken);
      const res = await trpc.createSubscriptionCheckout.mutate();
      if (res?.sessionUrl) {
        window.location.href = res.sessionUrl;
      } else {
        throw new Error('No checkout URL returned from server.');
      }
    } catch (err: unknown) {
      setActionError(err instanceof Error ? err.message : 'Failed to start subscription checkout.');
      setActionLoading(false);
    }
  }

  async function handleManageBilling() {
    setActionLoading(true);
    setActionError(null);
    try {
      const trpc = createAuthenticatedTRPCClient(getToken);
      const res = await trpc.createBillingPortalSession.mutate();
      if (res?.sessionUrl) {
        window.location.href = res.sessionUrl;
      } else {
        throw new Error('No billing portal URL returned from server.');
      }
    } catch (err: unknown) {
      setActionError(err instanceof Error ? err.message : 'Failed to open billing portal.');
      setActionLoading(false);
    }
  }

  const status = data?.subscriptionStatus ?? 'inactive';
  const hasStripeCustomer = data?.hasStripeCustomer ?? false;

  return (
    <RequireOrgAuth>
      <div className="max-w-[800px] mx-auto px-6 py-8 font-sans text-gray-900">
        <Head>
          <title>Organisation Billing &amp; Subscription</title>
        </Head>

        <AppHeader />

        <Link href="/dashboard" className="inline-flex items-center gap-2 text-gray-600 hover:text-gray-900 no-underline text-[0.9rem] font-medium mb-6 transition-colors">
          &larr; Back to Dashboard
        </Link>

        <h1 className="text-[2rem] font-bold tracking-tight mb-2">Billing &amp; Subscription</h1>
        <p className="text-gray-500 text-base mb-8">
          Manage your subscription and payment details for {organization?.name ?? 'your organisation'}.
        </p>

        {loading ? (
          <div className="flex flex-col items-center justify-center py-16 px-8 gap-4">
            <div className="w-8 h-8 border-[3px] border-gray-200 border-t-[#0070f3] rounded-full animate-spin" />
            <p>Loading subscription details…</p>
          </div>
        ) : error ? (
          <div className="bg-white border border-gray-200 rounded-xl p-8 shadow-sm">
            <p className="text-red-600 bg-red-50 border border-red-200 px-4 py-3 rounded-lg text-[0.9rem]">{error}</p>
            <button
              className="px-6 py-3 text-[0.95rem] font-semibold bg-gray-100 hover:bg-gray-200 text-gray-800 border border-gray-300 rounded-lg cursor-pointer transition duration-150 mt-4"
              onClick={() => void refetch()}
            >
              Retry
            </button>
          </div>
        ) : (
          <SubscriptionStatusCard
            status={status}
            hasStripeCustomer={hasStripeCustomer}
            actionLoading={actionLoading}
            actionError={actionError}
            onSubscribe={() => { void handleSubscribe(); }}
            onManageBilling={() => { void handleManageBilling(); }}
          />
        )}
      </div>
    </RequireOrgAuth>
  );
}
