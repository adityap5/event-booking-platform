import type { ApiKeyInfo } from '../../types';

interface ApiKeyCardProps {
  loading: boolean;
  keyInfo: ApiKeyInfo | null;
  actionLoading: boolean;
  showRevokeConfirm: boolean;
  onGenerateOrRotate: (isRotate: boolean) => void;
  onRevoke: () => void;
  onShowRevokeConfirm: (show: boolean) => void;
}

export function ApiKeyCard({
  loading,
  keyInfo,
  actionLoading,
  showRevokeConfirm,
  onGenerateOrRotate,
  onRevoke,
  onShowRevokeConfirm,
}: ApiKeyCardProps) {
  return (
    <div className="bg-white border border-gray-200 rounded-xl p-8 shadow-sm mb-8">
      <div className="flex justify-between items-center mb-6 pb-6 border-b border-gray-100">
        <div className="text-xl font-semibold">Active API Key</div>
        {loading ? (
          <span className="inline-flex items-center px-3 py-1 bg-gray-100 text-gray-600 border border-gray-200 rounded-full text-[0.85rem] font-semibold">Loading…</span>
        ) : keyInfo ? (
          <span className="inline-flex items-center px-3 py-1 bg-emerald-50 text-emerald-800 border border-emerald-200 rounded-full text-[0.85rem] font-semibold">● Active</span>
        ) : (
          <span className="inline-flex items-center px-3 py-1 bg-gray-100 text-gray-600 border border-gray-200 rounded-full text-[0.85rem] font-semibold">No Active Key</span>
        )}
      </div>

      {!loading && keyInfo ? (
        <div>
          <div className="grid grid-cols-[140px_1fr] gap-x-4 gap-y-3 mb-6 text-[0.95rem]">
            <span className="text-gray-500 font-medium">Key Prefix:</span>
            <span className="font-mono text-gray-900 font-semibold">{keyInfo.keyPrefix}</span>

            <span className="text-gray-500 font-medium">Created:</span>
            <span className="font-mono text-gray-900 font-semibold">
              {new Date(keyInfo.createdAt).toLocaleDateString('en-GB', {
                year: 'numeric',
                month: 'short',
                day: 'numeric',
                hour: '2-digit',
                minute: '2-digit',
              })}
            </span>
          </div>

          <div className="flex gap-4 flex-wrap items-center">
            <button
              type="button"
              onClick={() => onGenerateOrRotate(true)}
              disabled={actionLoading}
              className="px-5 py-2.5 bg-gray-100 hover:bg-gray-200 text-gray-800 border border-gray-300 rounded-md text-[0.95rem] font-medium cursor-pointer transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
              id="rotate-api-key-button"
            >
              {actionLoading ? 'Rotating…' : 'Rotate API Key'}
            </button>

            <button
              type="button"
              onClick={() => onShowRevokeConfirm(true)}
              disabled={actionLoading}
              className="px-5 py-2.5 bg-red-100 hover:bg-red-200 text-red-800 border border-red-200 rounded-md text-[0.95rem] font-medium cursor-pointer transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
              id="revoke-api-key-button"
            >
              Revoke Key
            </button>
          </div>

          {showRevokeConfirm && (
            <div className="bg-rose-50 border border-rose-100 rounded-lg p-5 mt-5">
              <div className="font-semibold text-rose-800 mb-2">Revoke API Key?</div>
              <p className="text-sm text-rose-900 mb-4">
                Any external website or integration currently using this API key will immediately stop working. This action cannot be undone.
              </p>
              <div className="flex gap-4 flex-wrap items-center">
                <button
                  type="button"
                  onClick={onRevoke}
                  disabled={actionLoading}
                  className="px-5 py-2.5 bg-red-100 hover:bg-red-200 text-red-800 border border-red-200 rounded-md text-[0.95rem] font-medium cursor-pointer transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
                  id="confirm-revoke-button"
                >
                  {actionLoading ? 'Revoking…' : 'Yes, Revoke Key'}
                </button>
                <button
                  type="button"
                  onClick={() => onShowRevokeConfirm(false)}
                  disabled={actionLoading}
                  className="px-5 py-2.5 bg-gray-100 hover:bg-gray-200 text-gray-800 border border-gray-300 rounded-md text-[0.95rem] font-medium cursor-pointer transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
                >
                  Cancel
                </button>
              </div>
            </div>
          )}
        </div>
      ) : !loading && (
        <div>
          <p className="text-gray-600 mb-6 text-[0.95rem]">
            Your organisation does not have an active API key. Generate one to access the public read-only events API.
          </p>
          <button
            type="button"
            onClick={() => onGenerateOrRotate(false)}
            disabled={actionLoading}
            className="px-5 py-2.5 bg-[#0070f3] hover:bg-[#005bb5] text-white border-0 rounded-md text-[0.95rem] font-medium cursor-pointer transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
            id="generate-api-key-button"
          >
            {actionLoading ? 'Generating…' : 'Generate API Key'}
          </button>
        </div>
      )}
    </div>
  );
}
