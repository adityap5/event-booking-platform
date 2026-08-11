import Link from 'next/link';
import styles from './booking.module.css';

export default function BookingCancelledPage() {
  return (
    <div className={styles.container}>
      <h1 className={styles.heading}>Booking Cancelled</h1>

      <p className={styles.bodyLarge}>
        Your booking was not completed. No payment has been taken.
      </p>

      <Link href="/" className={styles.cta}>
        Back to events
      </Link>
    </div>
  );
}
