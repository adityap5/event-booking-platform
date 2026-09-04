interface ApiKeyRevealBannerProps {
  revealedKey: string;
  copied: boolean;
  onCopy: () => void;
}

export function ApiKeyRevealBanner({ revealedKey, copied, onCopy }: ApiKeyRevealBannerProps) {
  return (
    <div className="bg-amber-50 border border-amber-200 rounded-lg p-5 mb-6">
      <div className="font-semibold text-amber-800 mb-2 flex items-center gap-2">
        ⚠️ Save your API Key Now
      </div>
      <p className="text-sm text-amber-900 mb-4">
        This is the only time the full API key will be displayed. Copy it and store it in a secure location.
      </p>
      <div className="flex items-center gap-3 bg-white border border-gray-300 rounded-md px-4 py-3">
        <span className="font-mono text-[0.95rem] font-semibold text-gray-800 break-all flex-1">{revealedKey}</span>
        <button
          type="button"
          onClick={onCopy}
          className="px-3.5 py-1.5 bg-[#0070f3] hover:bg-[#005bb5] text-white border-0 rounded text-[0.85rem] font-medium cursor-pointer whitespace-nowrap transition-colors"
          id="copy-api-key-button"
        >
          {copied ? '✓ Copied' : 'Copy Key'}
        </button>
      </div>
    </div>
  );
}
