import Head from 'next/head';
import Link from 'next/link';
import { useState, useEffect, useCallback } from 'react';
import { useAuth, useOrganization } from '@clerk/nextjs';
import { RequireOrgAuth } from '../../components/RequireOrgAuth';
import { AppHeader } from '../../components/layout/AppHeader';
import { ApiKeyRevealBanner } from '../../components/dashboard/ApiKeyRevealBanner';
import { ApiKeyCard } from '../../components/dashboard/ApiKeyCard';
import { ApiQuickstartDocs } from '../../components/dashboard/ApiQuickstartDocs';
import { createAuthenticatedTRPCClient } from '../../lib/trpc';
import type { ApiKeyInfo } from '../../types';

// Public API URL is derived from NEXT_PUBLIC_TRPC_URL so the worker origin stays in one place
const workerBaseUrl = (process.env.NEXT_PUBLIC_TRPC_URL ?? '').replace(/\/trpc$/, '');
const eventsApiUrl = `${workerBaseUrl}/api/v1/events`;

export default function ApiKeysPage() {
  const { getToken } = useAuth();
  const { organization } = useOrganization();

  const [loading, setLoading] = useState(true);
  const [keyInfo, setKeyInfo] = useState<ApiKeyInfo | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Transient state for reveal-once raw key
  const [revealedKey, setRevealedKey] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  // Mutation states
  const [actionLoading, setActionLoading] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [showRevokeConfirm, setShowRevokeConfirm] = useState(false);

  const fetchKeyInfo = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const trpc = createAuthenticatedTRPCClient(getToken);
      const res = await trpc.getApiKeyInfo.query();
      setKeyInfo(res);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to load API key information.');
    } finally {
      setLoading(false);
    }
  }, [getToken]);

  useEffect(() => {
    void fetchKeyInfo();
  }, [fetchKeyInfo]);

  async function handleGenerateOrRotate(isRotate: boolean) {
    setActionLoading(true);
    setActionError(null);
    try {
      const trpc = createAuthenticatedTRPCClient(getToken);
      const res = isRotate
        ? await trpc.rotateApiKey.mutate()
        : await trpc.generateApiKey.mutate();

      // Show the raw key once
      setRevealedKey(res.rawKey);
      setCopied(false);
      setKeyInfo({
        keyPrefix: res.keyPrefix,
        createdAt: res.createdAt,
      });
      setShowRevokeConfirm(false);
    } catch (err: unknown) {
      setActionError(
        err instanceof Error ? err.message : 'Failed to generate API key. Please try again.',
      );
    } finally {
      setActionLoading(false);
    }
  }

  async function handleRevoke() {
    setActionLoading(true);
    setActionError(null);
    try {
      const trpc = createAuthenticatedTRPCClient(getToken);
      await trpc.revokeApiKey.mutate();
      setKeyInfo(null);
      setRevealedKey(null);
      setShowRevokeConfirm(false);
    } catch (err: unknown) {
      setActionError(
        err instanceof Error ? err.message : 'Failed to revoke API key. Please try again.',
      );
    } finally {
      setActionLoading(false);
    }
  }

  async function handleCopy() {
    if (!revealedKey) return;
    try {
      await navigator.clipboard.writeText(revealedKey);
      setCopied(true);
      setTimeout(() => setCopied(false), 2500);
    } catch {
      // Fallback
    }
  }

  return (
    <RequireOrgAuth>
      <Head>
        <title>API Keys — Dashboard</title>
      </Head>

      <div className="max-w-[800px] mx-auto px-6 py-8 font-sans text-gray-900">
        <AppHeader />

        <Link href="/dashboard" className="inline-flex items-center gap-2 text-gray-600 hover:text-gray-900 no-underline text-[0.9rem] font-medium mb-6 transition-colors">
          ← Back to Dashboard
        </Link>

        <h1 className="text-[2rem] font-bold tracking-tight mb-2">Public API Keys</h1>
        <p className="text-gray-500 text-base mb-8">
          Manage organisation-scoped API keys for embedding event listings on external websites and integrations.
        </p>

        {error && <div className="bg-red-50 border border-red-200 text-red-800 px-4 py-3 rounded-md mb-4 text-[0.9rem]">{error}</div>}
        {actionError && <div className="bg-red-50 border border-red-200 text-red-800 px-4 py-3 rounded-md mb-4 text-[0.9rem]">{actionError}</div>}

        {/* Reveal-Once Banner */}
        {revealedKey && (
          <ApiKeyRevealBanner
            revealedKey={revealedKey}
            copied={copied}
            onCopy={() => { void handleCopy(); }}
          />
        )}

        {/* Key Status Card */}
        <ApiKeyCard
          loading={loading}
          keyInfo={keyInfo}
          actionLoading={actionLoading}
          showRevokeConfirm={showRevokeConfirm}
          onGenerateOrRotate={(isRotate) => { void handleGenerateOrRotate(isRotate); }}
          onRevoke={() => { void handleRevoke(); }}
          onShowRevokeConfirm={setShowRevokeConfirm}
        />

        {/* Integration Documentation Card */}
        <ApiQuickstartDocs
          eventsApiUrl={eventsApiUrl}
          organizationName={organization?.name ?? 'your organisation'}
        />
      </div>
    </RequireOrgAuth>
  );
}
