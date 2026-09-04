interface SubscriptionStatusCardProps {
  status: string;
  hasStripeCustomer: boolean;
  actionLoading: boolean;
  actionError: string | null;
  onSubscribe: () => void;
  onManageBilling: () => void;
}

export function SubscriptionStatusCard({
  status,
  hasStripeCustomer,
  actionLoading,
  actionError,
  onSubscribe,
  onManageBilling,
}: SubscriptionStatusCardProps) {
  const isEntitled = status === 'active' || status === 'trialing';
  const canSubscribe = status === 'inactive' || status === 'canceled';

  function renderStatusBadge() {
    const base = 'inline-flex items-center px-3.5 py-1 rounded-full text-[0.875rem] font-semibold capitalize border';
    switch (status) {
      case 'active':
        return <span className={`${base} bg-emerald-50 text-emerald-800 border-emerald-200`}>Active</span>;
      case 'trialing':
        return <span className={`${base} bg-blue-50 text-blue-800 border-blue-200`}>Trialing</span>;
      case 'inactive':
        return <span className={`${base} bg-gray-100 text-gray-600 border-gray-200`}>Inactive</span>;
      case 'canceled':
        return <span className={`${base} bg-red-50 text-red-800 border-red-200`}>Canceled</span>;
      case 'past_due':
        return <span className={`${base} bg-amber-50 text-amber-800 border-amber-200`}>Past Due</span>;
      case 'unpaid':
        return <span className={`${base} bg-red-50 text-red-800 border-red-200`}>Unpaid</span>;
      case 'incomplete':
        return <span className={`${base} bg-amber-50 text-amber-800 border-amber-200`}>Incomplete</span>;
      case 'paused':
        return <span className={`${base} bg-amber-50 text-amber-800 border-amber-200`}>Paused</span>;
      default:
        return <span className={`${base} bg-gray-100 text-gray-600 border-gray-200`}>{status}</span>;
    }
  }

  function renderStatusDetails() {
    const descClass = 'text-gray-600 text-[0.95rem] leading-[1.6] mb-6';
    const alertBase = 'p-4 sm:p-5 rounded-lg mb-6 text-[0.9rem] leading-[1.5] border';
    const alertWarn = `${alertBase} bg-amber-50 border-amber-200 text-amber-800`;
    const alertDanger = `${alertBase} bg-red-50 border-red-200 text-red-800`;

    switch (status) {
      case 'active':
        return (
          <p className={descClass}>
            Your organisation has an active subscription. You have full access to create and manage events.
          </p>
        );
      case 'trialing':
        return (
          <p className={descClass}>
            Your organisation is currently in a subscription trial period. You have full access to create and manage events.
          </p>
        );
      case 'inactive':
        return (
          <p className={descClass}>
            An active organisation subscription is required to create new events. Subscribe now to get started.
          </p>
        );
      case 'canceled':
        return (
          <>
            <div className={alertDanger}>
              Your subscription has been canceled. Existing events and bookings remain active, but you cannot publish new events until you resubscribe.
            </div>
            <p className={descClass}>
              Subscribe again to restore event creation permissions.
            </p>
          </>
        );
      case 'past_due':
        return (
          <>
            <div className={alertWarn}>
              <strong>Payment issue detected:</strong> Your latest subscription payment attempt failed. Please update your payment method in the Billing Portal to maintain access.
            </div>
            <p className={descClass}>
              Event creation is paused until billing is resolved.
            </p>
          </>
        );
      case 'unpaid':
        return (
          <>
            <div className={alertDanger}>
              <strong>Subscription unpaid:</strong> Payment retries have been exhausted. Please open the Billing Portal to update your payment details and reactivate your subscription.
            </div>
            <p className={descClass}>
              Event creation is blocked until outstanding invoices are settled.
            </p>
          </>
        );
      case 'incomplete':
        return (
          <>
            <div className={alertWarn}>
              <strong>Subscription setup incomplete:</strong> Initial payment or required verification is pending. Please complete billing setup in the portal.
            </div>
            <p className={descClass}>
              Event creation will unlock once payment setup completes successfully.
            </p>
          </>
        );
      case 'paused':
        return (
          <>
            <div className={alertWarn}>
              <strong>Subscription paused:</strong> Your subscription is currently paused. Please visit the Billing Portal to resume.
            </div>
            <p className={descClass}>
              Event creation is paused while the subscription is inactive.
            </p>
          </>
        );
      default:
        return (
          <p className={descClass}>
            Current subscription status: {status}.
          </p>
        );
    }
  }

  return (
    <div className="bg-white border border-gray-200 rounded-xl p-8 shadow-sm">
      <div className="flex justify-between items-center mb-6 pb-6 border-b border-gray-100">
        <span className="text-[1.125rem] font-semibold text-gray-700">Subscription Status</span>
        {renderStatusBadge()}
      </div>

      {renderStatusDetails()}

      {actionError && (
        <p className="text-red-600 bg-red-50 border border-red-200 px-4 py-3 rounded-lg mt-4 text-[0.9rem]">
          {actionError}
        </p>
      )}

      <div className="flex gap-4 items-center flex-wrap">
        {canSubscribe && (
          <button
            id="subscribe-button"
            className="bg-[#0070f3] hover:bg-[#0051b3] text-white border-0 px-6 py-3 text-[0.95rem] font-semibold rounded-lg cursor-pointer transition duration-150 disabled:opacity-60 disabled:cursor-not-allowed"
            onClick={onSubscribe}
            disabled={actionLoading}
          >
            {actionLoading ? 'Redirecting to Checkout…' : status === 'canceled' ? 'Resubscribe' : 'Subscribe Now'}
          </button>
        )}

        {hasStripeCustomer && (
          <button
            id="manage-billing-button"
            className={
              isEntitled
                ? 'bg-[#0070f3] hover:bg-[#0051b3] text-white border-0 px-6 py-3 text-[0.95rem] font-semibold rounded-lg cursor-pointer transition duration-150 disabled:opacity-60 disabled:cursor-not-allowed'
                : 'bg-gray-100 hover:bg-gray-200 text-gray-800 border border-gray-300 px-6 py-3 text-[0.95rem] font-semibold rounded-lg cursor-pointer transition duration-150 disabled:opacity-60 disabled:cursor-not-allowed'
            }
            onClick={onManageBilling}
            disabled={actionLoading}
          >
            {actionLoading ? 'Opening Portal…' : 'Manage Subscription & Invoices'}
          </button>
        )}
      </div>
    </div>
  );
}
