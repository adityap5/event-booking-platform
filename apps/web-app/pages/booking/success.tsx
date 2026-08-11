import Link from 'next/link';
import { useRouter } from 'next/router';
import styles from './booking.module.css';

export default function BookingSuccessPage() {
  const router = useRouter();
  // session_id is set by Stripe as a query param on redirect: ?session_id={CHECKOUT_SESSION_ID}
  const sessionId = typeof router.query.session_id === 'string'
    ? router.query.session_id
    : null;

  return (
    <div className={styles.container}>
      {/* Success icon */}
      <div className={styles.icon}>✓</div>

      <h1 className={styles.heading}>Booking Confirmed!</h1>

      <p className={styles.body}>
        Your booking has been confirmed. You will receive a confirmation email shortly.
      </p>

      {/* Stripe session reference — shown when present */}
      {sessionId && (
        <p className={styles.reference}>Reference: {sessionId}</p>
      )}

      <Link href="/" className={styles.cta}>
        Browse more events
      </Link>
    </div>
  );
}
