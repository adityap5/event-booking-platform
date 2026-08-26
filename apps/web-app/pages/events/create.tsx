import Head from 'next/head';
import Link from 'next/link';
import { useRouter } from 'next/router';
import { useEffect, useRef, useState } from 'react';
import { OrganizationSwitcher, UserButton, useAuth } from '@clerk/nextjs';
import { RequireOrgAuth } from '../../components/RequireOrgAuth';
import { createAuthenticatedTRPCClient } from '../../lib/trpc';
import styles from './create.module.css';

// Upload URL is derived from the tRPC base URL so the worker origin stays in one place.
const UPLOAD_URL = process.env.NEXT_PUBLIC_TRPC_URL!.replace(/\/trpc$/, '') + '/upload/event-cover';
const ALLOWED_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
const MAX_FILE_SIZE = 5 * 1024 * 1024; // 5 MB

export default function CreateEventPage() {
  const router = useRouter();
  const { getToken } = useAuth();

  // ---- Subscription gate state ----
  const [subLoading, setSubLoading] = useState(true);
  const [subscriptionStatus, setSubscriptionStatus] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    async function checkSubscription() {
      try {
        const trpc = createAuthenticatedTRPCClient(getToken);
        const res = await trpc.getSubscriptionStatus.query();
        if (active) {
          setSubscriptionStatus(res.subscriptionStatus);
        }
      } catch {
        if (active) {
          setSubscriptionStatus('inactive');
        }
      } finally {
        if (active) {
          setSubLoading(false);
        }
      }
    }
    void checkSubscription();
    return () => {
      active = false;
    };
  }, [getToken]);

  // ---- Form fields ----
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [date, setDate] = useState('');
  const [totalSeats, setTotalSeats] = useState('');
  const [pricePerSeat, setPricePerSeat] = useState('');

  // ---- Image state ----
  const [imagePreview, setImagePreview] = useState<string | null>(null);
  const [imageUploading, setImageUploading] = useState(false);
  const [imageError, setImageError] = useState<string | null>(null);
  const [tempImageKey, setTempImageKey] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // ---- Submission state ----
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  // Track the live object URL so we can revoke it when it's replaced or on unmount
  const objectUrlRef = useRef<string | null>(null);
  useEffect(() => {
    return () => {
      if (objectUrlRef.current) {
        URL.revokeObjectURL(objectUrlRef.current);
      }
    };
  }, []);

  // ---- Image onChange handler ----
  async function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;

    // Revoke the previous object URL before creating a new one
    if (objectUrlRef.current) {
      URL.revokeObjectURL(objectUrlRef.current);
      objectUrlRef.current = null;
    }

    // Reset previous image state
    setImageError(null);
    setTempImageKey(null);
    setImagePreview(null);

    // Client-side validation (mirrors server-side for fast feedback)
    if (!ALLOWED_TYPES.includes(file.type)) {
      setImageError('Invalid file type. Please select a JPEG, PNG, or WebP image.');
      return;
    }
    if (file.size > MAX_FILE_SIZE) {
      setImageError('File too large. Maximum size is 5 MB.');
      return;
    }

    // Show local preview immediately
    const objectUrl = URL.createObjectURL(file);
    objectUrlRef.current = objectUrl;
    setImagePreview(objectUrl);

    // Upload to worker
    setImageUploading(true);
    try {
      const token = await getToken();
      const formData = new FormData();
      formData.append('file', file);

      const res = await fetch(UPLOAD_URL, {
        method: 'POST',
        headers: {
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: formData,
      });

      if (!res.ok) {
        throw new Error(`Upload failed (${res.status})`);
      }

      const json = await res.json() as { tempImageKey: string };
      setTempImageKey(json.tempImageKey);
    } catch {
      // Non-blocking — show inline message, form remains fully usable
      setImageError('Image upload failed. You can still create the event without a cover image.');
      setTempImageKey(null);
    } finally {
      setImageUploading(false);
    }
  }

  // ---- Submit handler ----
  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitError(null);
    setSubmitting(true);

    try {
      const trpc = createAuthenticatedTRPCClient(getToken);
      await trpc.createEvent.mutate({
        name: name.trim(),
        description: description.trim() || undefined,
        date: new Date(date).getTime(),
        totalSeats: parseInt(totalSeats, 10),
        pricePerSeat: parseInt(pricePerSeat, 10),
        ...(tempImageKey ? { tempImageKey } : {}),
      });
      void router.push('/events/manage');
    } catch (err: unknown) {
      setSubmitError(err instanceof Error ? err.message : 'Failed to create event. Please try again.');
    } finally {
      setSubmitting(false);
    }
  }

  // Submit is blocked only while the image upload is in flight
  const submitDisabled = submitting || imageUploading;

  return (
    <RequireOrgAuth>
      <div className={styles.page}>
        <Head>
          <title>Create Event | Organiser</title>
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

        <h1 className={styles.title}>Create Event</h1>

        {subLoading ? (
          <div style={{ display: 'flex', justifyContent: 'center', padding: '3rem 1rem', color: '#6b7280' }}>
            <p>Checking organisation subscription entitlement…</p>
          </div>
        ) : subscriptionStatus !== 'active' && subscriptionStatus !== 'trialing' ? (
          <div className={styles.subscriptionCard}>
            <div className={styles.subscriptionWarning}>
              <strong>Active subscription required:</strong> Your organisation currently has a <code>{subscriptionStatus ?? 'inactive'}</code> subscription. An active subscription is required to publish and host new events.
            </div>
            <p style={{ color: '#4b5563', lineHeight: 1.6 }}>
              Existing events and bookings are unaffected, but you must subscribe or resolve any payment issues before creating new events.
            </p>
            <div className={styles.subscriptionActions}>
              <Link href="/dashboard/billing" className={styles.subscriptionButton}>
                Go to Billing &amp; Subscription
              </Link>
              <Link href="/dashboard" className={styles.subscriptionSecondaryLink}>
                Back to Dashboard
              </Link>
            </div>
          </div>
        ) : (
          <form className={styles.form} onSubmit={(e) => { void handleSubmit(e); }}>
            {/* Name */}
            <div className={styles.field}>
              <label htmlFor="event-name" className={styles.label}>
                Event name <span className={styles.required}>*</span>
              </label>
              <input
                id="event-name"
                type="text"
              className={styles.input}
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
              maxLength={200}
              placeholder="e.g. Summer Music Festival"
            />
          </div>

          {/* Description */}
          <div className={styles.field}>
            <label htmlFor="event-description" className={styles.label}>
              Description
            </label>
            <textarea
              id="event-description"
              className={styles.textarea}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              maxLength={2000}
              rows={4}
              placeholder="Tell attendees what to expect…"
            />
          </div>

          {/* Date */}
          <div className={styles.field}>
            <label htmlFor="event-date" className={styles.label}>
              Date &amp; time <span className={styles.required}>*</span>
            </label>
            <input
              id="event-date"
              type="datetime-local"
              className={styles.input}
              value={date}
              onChange={(e) => setDate(e.target.value)}
              required
            />
          </div>

          {/* Total seats */}
          <div className={styles.field}>
            <label htmlFor="event-seats" className={styles.label}>
              Total seats <span className={styles.required}>*</span>
            </label>
            <input
              id="event-seats"
              type="number"
              className={styles.input}
              value={totalSeats}
              onChange={(e) => setTotalSeats(e.target.value)}
              required
              min={1}
              max={100000}
              placeholder="e.g. 500"
            />
          </div>

          {/* Price per seat */}
          <div className={styles.field}>
            <label htmlFor="event-price" className={styles.label}>
              Price per seat (in pence) <span className={styles.required}>*</span>
            </label>
            <input
              id="event-price"
              type="number"
              className={styles.input}
              value={pricePerSeat}
              onChange={(e) => setPricePerSeat(e.target.value)}
              required
              min={0}
              placeholder="e.g. 1500 for £15.00"
            />
          </div>

          {/* Cover image */}
          <div className={styles.field}>
            <label htmlFor="event-cover" className={styles.label}>
              Cover image <span className={styles.optional}>(optional)</span>
            </label>

            {imagePreview && (
              <img
                src={imagePreview}
                alt="Cover preview"
                className={styles.preview}
              />
            )}

            <div className={styles.fileRow}>
              <input
                id="event-cover"
                ref={fileInputRef}
                type="file"
                accept="image/jpeg,image/png,image/webp"
                className={styles.fileInput}
                onChange={(e) => { void handleFileChange(e); }}
                disabled={imageUploading}
              />
              {imageUploading && (
                <span className={styles.uploadingBadge}>Uploading…</span>
              )}
            </div>

            {imageError && (
              <p className={styles.fieldError}>{imageError}</p>
            )}
          </div>

          {/* Submit error */}
          {submitError && (
            <p className={styles.submitError}>{submitError}</p>
          )}

          {/* Actions */}
          <div className={styles.actions}>
            <button
              type="submit"
              className={styles.submitButton}
              disabled={submitDisabled}
            >
              {submitting ? 'Creating…' : imageUploading ? 'Waiting for upload…' : 'Create Event'}
            </button>
          </div>
        </form>
        )}
      </div>
    </RequireOrgAuth>
  );
}
