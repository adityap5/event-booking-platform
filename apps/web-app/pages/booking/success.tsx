import Link from 'next/link';
import { useRouter } from 'next/router';

export default function BookingSuccessPage() {
  const router = useRouter();
  // session_id is set by Stripe as a query param on redirect: ?session_id={CHECKOUT_SESSION_ID}
  const sessionId = typeof router.query.session_id === 'string'
    ? router.query.session_id
    : null;

  return (
    <div className="max-w-[560px] my-16 mx-auto px-4 py-8 font-sans text-center">
      {/* Success icon */}
      <div className="w-16 h-16 rounded-full bg-[#27ae60] text-white text-[2rem] leading-[64px] mx-auto mb-6">✓</div>

      <h1 className="text-[2rem] font-bold mb-4 text-[#333]">Booking Confirmed!</h1>

      <p className="text-[#555] leading-[1.6] mb-6">
        Your booking has been confirmed. You will receive a confirmation email shortly.
      </p>

      {/* Stripe session reference — shown when present */}
      {sessionId && (
        <p className="text-[0.8rem] text-[#999] mb-8 break-all">Reference: {sessionId}</p>
      )}

      <Link href="/" className="inline-block px-6 py-3 bg-[#0070f3] hover:bg-[#0059c2] text-white no-underline rounded-md font-medium transition-colors">
        Browse more events
      </Link>
    </div>
  );
}
