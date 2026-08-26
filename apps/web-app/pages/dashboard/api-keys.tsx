import Head from 'next/head';
import Link from 'next/link';
import { useState, useEffect, useCallback } from 'react';
import { OrganizationSwitcher, UserButton, useAuth, useOrganization } from '@clerk/nextjs';
import { RequireOrgAuth } from '../../components/RequireOrgAuth';
import { createAuthenticatedTRPCClient } from '../../lib/trpc';
import styles from './api-keys.module.css';

// Public API URL is derived from NEXT_PUBLIC_TRPC_URL so the worker origin stays in one place
const workerBaseUrl = (process.env.NEXT_PUBLIC_TRPC_URL ?? '').replace(/\/trpc$/, '');
const eventsApiUrl = `${workerBaseUrl}/api/v1/events`;

type ApiKeyInfo = {
  keyPrefix: string;
  createdAt: number;
};

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

      <div className={styles.page}>
        <header className={styles.header}>
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

        <Link href="/dashboard" className={styles.backLink}>
          ← Back to Dashboard
        </Link>

        <h1 className={styles.title}>Public API Keys</h1>
        <p className={styles.subtitle}>
          Manage organisation-scoped API keys for embedding event listings on external websites and integrations.
        </p>

        {error && <div className={styles.errorBanner}>{error}</div>}
        {actionError && <div className={styles.errorBanner}>{actionError}</div>}

        {/* Reveal-Once Banner */}
        {revealedKey && (
          <div className={styles.revealBanner}>
            <div className={styles.revealTitle}>
              ⚠️ Save your API Key Now
            </div>
            <p className={styles.revealWarning}>
              This is the only time the full API key will be displayed. Copy it and store it in a secure location.
            </p>
            <div className={styles.secretBox}>
              <span className={styles.secretKey}>{revealedKey}</span>
              <button
                type="button"
                onClick={handleCopy}
                className={styles.copyButton}
                id="copy-api-key-button"
              >
                {copied ? '✓ Copied' : 'Copy Key'}
              </button>
            </div>
          </div>
        )}

        {/* Key Status Card */}
        <div className={styles.card}>
          <div className={styles.statusHeader}>
            <div className={styles.statusTitle}>Active API Key</div>
            {loading ? (
              <span className={styles.badgeNone}>Loading…</span>
            ) : keyInfo ? (
              <span className={styles.badgeActive}>● Active</span>
            ) : (
              <span className={styles.badgeNone}>No Active Key</span>
            )}
          </div>

          {!loading && keyInfo ? (
            <div>
              <div className={styles.keyDetails}>
                <span className={styles.keyLabel}>Key Prefix:</span>
                <span className={styles.keyValue}>{keyInfo.keyPrefix}</span>

                <span className={styles.keyLabel}>Created:</span>
                <span className={styles.keyValue}>
                  {new Date(keyInfo.createdAt).toLocaleDateString('en-GB', {
                    year: 'numeric',
                    month: 'short',
                    day: 'numeric',
                    hour: '2-digit',
                    minute: '2-digit',
                  })}
                </span>
              </div>

              <div className={styles.actionsRow}>
                <button
                  type="button"
                  onClick={() => handleGenerateOrRotate(true)}
                  disabled={actionLoading}
                  className={styles.secondaryButton}
                  id="rotate-api-key-button"
                >
                  {actionLoading ? 'Rotating…' : 'Rotate API Key'}
                </button>

                <button
                  type="button"
                  onClick={() => setShowRevokeConfirm(true)}
                  disabled={actionLoading}
                  className={styles.dangerButton}
                  id="revoke-api-key-button"
                >
                  Revoke Key
                </button>
              </div>

              {showRevokeConfirm && (
                <div className={styles.confirmDialog}>
                  <div className={styles.confirmTitle}>Revoke API Key?</div>
                  <p className={styles.confirmText}>
                    Any external website or integration currently using this API key will immediately stop working. This action cannot be undone.
                  </p>
                  <div className={styles.actionsRow}>
                    <button
                      type="button"
                      onClick={handleRevoke}
                      disabled={actionLoading}
                      className={styles.dangerButton}
                      id="confirm-revoke-button"
                    >
                      {actionLoading ? 'Revoking…' : 'Yes, Revoke Key'}
                    </button>
                    <button
                      type="button"
                      onClick={() => setShowRevokeConfirm(false)}
                      disabled={actionLoading}
                      className={styles.secondaryButton}
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              )}
            </div>
          ) : !loading && (
            <div>
              <p style={{ color: '#4b5563', marginBottom: '1.5rem', fontSize: '0.95rem' }}>
                Your organisation does not have an active API key. Generate one to access the public read-only events API.
              </p>
              <button
                type="button"
                onClick={() => handleGenerateOrRotate(false)}
                disabled={actionLoading}
                className={styles.primaryButton}
                id="generate-api-key-button"
              >
                {actionLoading ? 'Generating…' : 'Generate API Key'}
              </button>
            </div>
          )}
        </div>

        {/* Integration Documentation Card */}
        <div className={styles.card}>
          <div className={styles.docsTitle}>API Quickstart</div>
          <p style={{ color: '#4b5563', fontSize: '0.9rem', marginBottom: '1rem' }}>
            Use your API key as a Bearer token in the <code>Authorization</code> header. All requests return JSON scoped exclusively to {organization?.name ?? 'your organisation'}.
          </p>

          <h4 style={{ fontSize: '0.95rem', fontWeight: 600, marginBottom: '0.5rem' }}>List Upcoming Events</h4>
          <pre className={styles.codeSnippet}>
{`curl -X GET "${eventsApiUrl}?limit=50&offset=0" \\
  -H "Authorization: Bearer <your_api_key>"`}
          </pre>

          <h4 style={{ fontSize: '0.95rem', fontWeight: 600, marginBottom: '0.5rem', marginTop: '1rem' }}>Get Single Event (With Live Seats)</h4>
          <pre className={styles.codeSnippet}>
{`curl -X GET "${eventsApiUrl}/<event_id>" \\
  -H "Authorization: Bearer <your_api_key>"`}
          </pre>
        </div>
      </div>
    </RequireOrgAuth>
  );
}
