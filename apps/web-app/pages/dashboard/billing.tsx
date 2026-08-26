import Head from 'next/head';
import Link from 'next/link';
import { useState, useEffect, useCallback } from 'react';
import { OrganizationSwitcher, UserButton, useAuth, useOrganization } from '@clerk/nextjs';
import { RequireOrgAuth } from '../../components/RequireOrgAuth';
import { createAuthenticatedTRPCClient } from '../../lib/trpc';
import styles from './billing.module.css';

type SubscriptionData = {
  subscriptionStatus: string;
  hasStripeCustomer: boolean;
};

export default function BillingPage() {
  const { getToken } = useAuth();
  const { organization } = useOrganization();

  const [loading, setLoading] = useState(true);
  const [data, setData] = useState<SubscriptionData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [actionLoading, setActionLoading] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const fetchStatus = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const trpc = createAuthenticatedTRPCClient(getToken);
      const res = await trpc.getSubscriptionStatus.query();
      setData(res);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to load subscription status.');
    } finally {
      setLoading(false);
    }
  }, [getToken]);

  useEffect(() => {
    void fetchStatus();
  }, [fetchStatus]);

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

  const isEntitled = status === 'active' || status === 'trialing';
  const canSubscribe = status === 'inactive' || status === 'canceled';

  function renderStatusBadge() {
    switch (status) {
      case 'active':
        return <span className={`${styles.badge} ${styles.badgeActive}`}>Active</span>;
      case 'trialing':
        return <span className={`${styles.badge} ${styles.badgeTrialing}`}>Trialing</span>;
      case 'inactive':
        return <span className={`${styles.badge} ${styles.badgeInactive}`}>Inactive</span>;
      case 'canceled':
        return <span className={`${styles.badge} ${styles.badgeCanceled}`}>Canceled</span>;
      case 'past_due':
        return <span className={`${styles.badge} ${styles.badgeWarning}`}>Past Due</span>;
      case 'unpaid':
        return <span className={`${styles.badge} ${styles.badgeDanger}`}>Unpaid</span>;
      case 'incomplete':
        return <span className={`${styles.badge} ${styles.badgeWarning}`}>Incomplete</span>;
      case 'paused':
        return <span className={`${styles.badge} ${styles.badgeWarning}`}>Paused</span>;
      default:
        return <span className={`${styles.badge} ${styles.badgeInactive}`}>{status}</span>;
    }
  }

  function renderStatusDetails() {
    switch (status) {
      case 'active':
        return (
          <p className={styles.statusDescription}>
            Your organisation has an active subscription. You have full access to create and manage events.
          </p>
        );
      case 'trialing':
        return (
          <p className={styles.statusDescription}>
            Your organisation is currently in a subscription trial period. You have full access to create and manage events.
          </p>
        );
      case 'inactive':
        return (
          <p className={styles.statusDescription}>
            An active organisation subscription is required to create new events. Subscribe now to get started.
          </p>
        );
      case 'canceled':
        return (
          <>
            <div className={`${styles.alertBox} ${styles.alertDanger}`}>
              Your subscription has been canceled. Existing events and bookings remain active, but you cannot publish new events until you resubscribe.
            </div>
            <p className={styles.statusDescription}>
              Subscribe again to restore event creation permissions.
            </p>
          </>
        );
      case 'past_due':
        return (
          <>
            <div className={`${styles.alertBox} ${styles.alertWarning}`}>
              <strong>Payment issue detected:</strong> Your latest subscription payment attempt failed. Please update your payment method in the Billing Portal to maintain access.
            </div>
            <p className={styles.statusDescription}>
              Event creation is paused until billing is resolved.
            </p>
          </>
        );
      case 'unpaid':
        return (
          <>
            <div className={`${styles.alertBox} ${styles.alertDanger}`}>
              <strong>Subscription unpaid:</strong> Payment retries have been exhausted. Please open the Billing Portal to update your payment details and reactivate your subscription.
            </div>
            <p className={styles.statusDescription}>
              Event creation is blocked until outstanding invoices are settled.
            </p>
          </>
        );
      case 'incomplete':
        return (
          <>
            <div className={`${styles.alertBox} ${styles.alertWarning}`}>
              <strong>Subscription setup incomplete:</strong> Initial payment or required verification is pending. Please complete billing setup in the portal.
            </div>
            <p className={styles.statusDescription}>
              Event creation will unlock once payment setup completes successfully.
            </p>
          </>
        );
      case 'paused':
        return (
          <>
            <div className={`${styles.alertBox} ${styles.alertWarning}`}>
              <strong>Subscription paused:</strong> Your subscription is currently paused. Please visit the Billing Portal to resume.
            </div>
            <p className={styles.statusDescription}>
              Event creation is paused while the subscription is inactive.
            </p>
          </>
        );
      default:
        return (
          <p className={styles.statusDescription}>
            Current subscription status: {status}.
          </p>
        );
    }
  }

  return (
    <RequireOrgAuth>
      <div className={styles.page}>
        <Head>
          <title>Organisation Billing &amp; Subscription</title>
        </Head>

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
          &larr; Back to Dashboard
        </Link>

        <h1 className={styles.title}>Billing &amp; Subscription</h1>
        <p className={styles.subtitle}>
          Manage your subscription and payment details for {organization?.name ?? 'your organisation'}.
        </p>

        {loading ? (
          <div className={styles.loadingContainer}>
            <div className={styles.spinner} />
            <p>Loading subscription details…</p>
          </div>
        ) : error ? (
          <div className={styles.card}>
            <p className={styles.errorMessage}>{error}</p>
            <button className={styles.secondaryButton} onClick={() => void fetchStatus()} style={{ marginTop: '1rem' }}>
              Retry
            </button>
          </div>
        ) : (
          <div className={styles.card}>
            <div className={styles.statusHeader}>
              <span className={styles.statusTitle}>Subscription Status</span>
              {renderStatusBadge()}
            </div>

            {renderStatusDetails()}

            {actionError && <p className={styles.errorMessage}>{actionError}</p>}

            <div className={styles.actionSection}>
              {canSubscribe && (
                <button
                  id="subscribe-button"
                  className={styles.primaryButton}
                  onClick={() => void handleSubscribe()}
                  disabled={actionLoading}
                >
                  {actionLoading ? 'Redirecting to Checkout…' : status === 'canceled' ? 'Resubscribe' : 'Subscribe Now'}
                </button>
              )}

              {hasStripeCustomer && (
                <button
                  id="manage-billing-button"
                  className={isEntitled ? styles.primaryButton : styles.secondaryButton}
                  onClick={() => void handleManageBilling()}
                  disabled={actionLoading}
                >
                  {actionLoading ? 'Opening Portal…' : 'Manage Subscription &amp; Invoices'}
                </button>
              )}
            </div>
          </div>
        )}
      </div>
    </RequireOrgAuth>
  );
}
