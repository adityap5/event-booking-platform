import { useRouter } from 'next/router';
import { useEffect, useRef, useState } from 'react';
import { useAuth } from '@clerk/nextjs';
import { createAuthenticatedTRPCClient } from '../../lib/trpc';

// Upload URL is derived from the tRPC base URL so the worker origin stays in one place.
const UPLOAD_URL = process.env.NEXT_PUBLIC_TRPC_URL!.replace(/\/trpc$/, '') + '/upload/event-cover';
const ALLOWED_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
const MAX_FILE_SIZE = 5 * 1024 * 1024; // 5 MB

export function EventForm() {
  const router = useRouter();
  const { getToken } = useAuth();

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

      const json = (await res.json()) as { tempImageKey: string };
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
    <form className="flex flex-col gap-6" onSubmit={(e) => { void handleSubmit(e); }}>
      {/* Name */}
      <div className="flex flex-col gap-1.5">
        <label htmlFor="event-name" className="text-[0.9rem] font-semibold text-[#333]">
          Event name <span className="text-[#c0392b] ml-0.5">*</span>
        </label>
        <input
          id="event-name"
          type="text"
          className="px-3 py-2.5 text-[0.95rem] border border-gray-300 rounded-md bg-white text-gray-900 w-full transition-colors focus:outline-none focus:border-[#0070f3] focus:ring-2 focus:ring-[#0070f3]/20"
          value={name}
          onChange={(e) => setName(e.target.value)}
          required
          maxLength={200}
          placeholder="e.g. Summer Music Festival"
        />
      </div>

      {/* Description */}
      <div className="flex flex-col gap-1.5">
        <label htmlFor="event-description" className="text-[0.9rem] font-semibold text-[#333]">
          Description
        </label>
        <textarea
          id="event-description"
          className="px-3 py-2.5 text-[0.95rem] border border-gray-300 rounded-md bg-white text-gray-900 w-full resize-y min-h-[96px] font-sans transition-colors focus:outline-none focus:border-[#0070f3] focus:ring-2 focus:ring-[#0070f3]/20"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          maxLength={2000}
          rows={4}
          placeholder="Tell attendees what to expect…"
        />
      </div>

      {/* Date */}
      <div className="flex flex-col gap-1.5">
        <label htmlFor="event-date" className="text-[0.9rem] font-semibold text-[#333]">
          Date &amp; time <span className="text-[#c0392b] ml-0.5">*</span>
        </label>
        <input
          id="event-date"
          type="datetime-local"
          className="px-3 py-2.5 text-[0.95rem] border border-gray-300 rounded-md bg-white text-gray-900 w-full transition-colors focus:outline-none focus:border-[#0070f3] focus:ring-2 focus:ring-[#0070f3]/20"
          value={date}
          onChange={(e) => setDate(e.target.value)}
          required
        />
      </div>

      {/* Total seats */}
      <div className="flex flex-col gap-1.5">
        <label htmlFor="event-seats" className="text-[0.9rem] font-semibold text-[#333]">
          Total seats <span className="text-[#c0392b] ml-0.5">*</span>
        </label>
        <input
          id="event-seats"
          type="number"
          className="px-3 py-2.5 text-[0.95rem] border border-gray-300 rounded-md bg-white text-gray-900 w-full transition-colors focus:outline-none focus:border-[#0070f3] focus:ring-2 focus:ring-[#0070f3]/20"
          value={totalSeats}
          onChange={(e) => setTotalSeats(e.target.value)}
          required
          min={1}
          max={100000}
          placeholder="e.g. 500"
        />
      </div>

      {/* Price per seat */}
      <div className="flex flex-col gap-1.5">
        <label htmlFor="event-price" className="text-[0.9rem] font-semibold text-[#333]">
          Price per seat (in pence) <span className="text-[#c0392b] ml-0.5">*</span>
        </label>
        <input
          id="event-price"
          type="number"
          className="px-3 py-2.5 text-[0.95rem] border border-gray-300 rounded-md bg-white text-gray-900 w-full transition-colors focus:outline-none focus:border-[#0070f3] focus:ring-2 focus:ring-[#0070f3]/20"
          value={pricePerSeat}
          onChange={(e) => setPricePerSeat(e.target.value)}
          required
          min={0}
          placeholder="e.g. 1500 for £15.00"
        />
      </div>

      {/* Cover image */}
      <div className="flex flex-col gap-1.5">
        <label htmlFor="event-cover" className="text-[0.9rem] font-semibold text-[#333]">
          Cover image <span className="text-[#888] font-normal text-[0.85rem]">(optional)</span>
        </label>

        {imagePreview && (
          <img
            src={imagePreview}
            alt="Cover preview"
            className="w-full max-w-[320px] h-[180px] object-cover rounded-lg border border-[#e2e2e2] mb-2"
          />
        )}

        <div className="flex items-center gap-3">
          <input
            id="event-cover"
            ref={fileInputRef}
            type="file"
            accept="image/jpeg,image/png,image/webp"
            className="text-[0.9rem] text-[#333] disabled:opacity-50 disabled:cursor-not-allowed"
            onChange={(e) => { void handleFileChange(e); }}
            disabled={imageUploading}
          />
          {imageUploading && (
            <span className="text-[0.82rem] text-[#0070f3] bg-[#e8f0fe] px-2.5 py-1 rounded-full font-medium whitespace-nowrap">
              Uploading…
            </span>
          )}
        </div>

        {imageError && (
          <p className="text-[0.85rem] text-[#c0392b] m-0">{imageError}</p>
        )}
      </div>

      {/* Submit error */}
      {submitError && (
        <p className="text-[0.9rem] text-[#c0392b] m-0 px-4 py-3 bg-red-50 border border-red-200 rounded-md">
          {submitError}
        </p>
      )}

      {/* Actions */}
      <div className="flex justify-end">
        <button
          type="submit"
          className="px-6 py-2.5 text-[0.95rem] font-semibold bg-[#0070f3] hover:bg-[#0059c2] text-white border-none rounded-md cursor-pointer transition-all disabled:opacity-55 disabled:cursor-not-allowed"
          disabled={submitDisabled}
        >
          {submitting ? 'Creating…' : imageUploading ? 'Waiting for upload…' : 'Create Event'}
        </button>
      </div>
    </form>
  );
}
