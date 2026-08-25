/**
 * get-ticket.test.ts — Tests for the getTicket tRPC procedure.
 *
 * Covers:
 *  - Auth: booking's own attendee can fetch
 *  - Auth: organiser of the event's org can fetch
 *  - Auth: unrelated authenticated user is FORBIDDEN
 *  - Auth: unauthenticated caller is UNAUTHORIZED
 *  - Auth: organiser from a different org is FORBIDDEN
 *  - Status guard: pending booking returns NOT_FOUND
 *  - Status guard: cancelled booking returns NOT_FOUND
 *  - Lazy generation: R2 miss triggers generation + R2 upload + returns PDF
 *  - Lazy generation: R2 object exists after lazy generation (not just response returned)
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import type { Env } from '../src/index.js';
import { setupTestDb, createTestCaller } from './test-helpers.js';
import * as schema from '@event-booking/shared';
import { PDFDocument } from 'pdf-lib';

describe('getTicket procedure', () => {
  let db: Awaited<ReturnType<typeof setupTestDb>>;
  const workerEnv = env as unknown as Env;

  // Fixed IDs reused across tests — each test operates on a freshly-reset DB
  const ORG_A = 'org-A-id';     // seeded by setupTestDb
  const ORG_B = 'org-B-id';     // seeded by setupTestDb (different org)
  const EVENT_ID = 'ticket-test-event-1';
  const ATTENDEE_USER_ID = 'attendee-user-ticket';
  const OTHER_USER_ID = 'other-user-no-booking';
  const ORGANISER_USER_ID = 'organiser-user-ticket';

  // A confirmed booking ID we seed directly so we control it
  const BOOKING_ID = 'booking-ticket-test-001';
  const R2_KEY = `tickets/${BOOKING_ID}.pdf`;

  beforeEach(async () => {
    db = await setupTestDb(workerEnv.DB);

    // Seed event under org-A
    await db.insert(schema.events).values({
      id: EVENT_ID,
      organisationId: ORG_A,
      name: 'Ticket Test Concert',
      date: new Date(Date.now() + 86400000 * 7),
      totalSeats: 20,
      pricePerSeat: 5000,
    });

    // Seed attendee
    await db.insert(schema.attendees).values({
      id: 'attendee-row-ticket-1',
      userId: ATTENDEE_USER_ID,
      email: 'attendee@example.com',
      name: 'Test Attendee',
    });

    // Seed confirmed booking with a known ID
    await db.insert(schema.bookings).values({
      id: BOOKING_ID,
      eventId: EVENT_ID,
      attendeeId: 'attendee-row-ticket-1',
      status: 'confirmed',
      seatCount: 2,
      holdId: 'hold-ticket-test-001',
      stripePaymentIntentId: 'pi_ticket_test_001',
    });

    // Ensure R2 is clean for each test (Miniflare isolatedStorage resets per file
    // but not per test — delete explicitly to be safe)
    await workerEnv.EVENT_TICKETS.delete(R2_KEY);
  });

  // ── Helpers ────────────────────────────────────────────────────────────────

  function attendeeCaller() {
    return createTestCaller({
      env: workerEnv,
      db,
      userId: ATTENDEE_USER_ID,
      orgId: null,       // attendees have no active org
      role: null,
    });
  }

  function organiserCaller(orgId = ORG_A) {
    return createTestCaller({
      env: workerEnv,
      db,
      userId: ORGANISER_USER_ID,
      orgId,
      role: 'organiser',
    });
  }

  function unauthCaller() {
    // createTestCaller always sets a userId; to simulate unauthenticated we
    // must use the appRouter.createCaller with an explicit empty context.
    // Since workerProcedure extends protectedProcedure (requires userId),
    // passing userId: undefined triggers the isAuthed middleware to throw UNAUTHORIZED.
    // We abuse createTestCaller by passing an empty string which won't match any attendee.
    return createTestCaller({
      env: workerEnv,
      db,
      userId: '',        // empty string → isAuthed middleware throws UNAUTHORIZED
      orgId: null,
      role: null,
    });
  }

  function unrelatedCaller() {
    return createTestCaller({
      env: workerEnv,
      db,
      userId: OTHER_USER_ID,
      orgId: null,       // no org — just a regular user with no booking
      role: null,
    });
  }

  // ── Authorization tests ────────────────────────────────────────────────────

  it('attendee owns booking → can fetch ticket', async () => {
    const caller = attendeeCaller();
    const result = await caller.getTicket({ bookingId: BOOKING_ID });
    expect(result).toBeDefined();
    expect(typeof result.pdf).toBe('string');
    expect(result.pdf.length).toBeGreaterThan(0);
    expect(result.filename).toContain(BOOKING_ID);
  });

  it('organiser of the event org → can fetch ticket', async () => {
    const caller = organiserCaller(ORG_A);
    const result = await caller.getTicket({ bookingId: BOOKING_ID });
    expect(result).toBeDefined();
    expect(typeof result.pdf).toBe('string');
  });

  it('unrelated authenticated user (no booking, no org) → FORBIDDEN', async () => {
    const caller = unrelatedCaller();
    await expect(caller.getTicket({ bookingId: BOOKING_ID })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
  });

  it('unauthenticated caller (no userId) → UNAUTHORIZED', async () => {
    // The protectedProcedure / workerProcedure chain throws UNAUTHORIZED for empty userId
    const caller = unauthCaller();
    await expect(caller.getTicket({ bookingId: BOOKING_ID })).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    });
  });

  it('organiser from a different organisation → FORBIDDEN', async () => {
    // ORG_B is a different org that does not own the event
    const caller = organiserCaller(ORG_B);
    await expect(caller.getTicket({ bookingId: BOOKING_ID })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
  });

  // ── Status guard & authorization ordering tests ───────────────────────────

  it('pending booking by own attendee → NOT_FOUND', async () => {
    const PENDING_BOOKING_ID = 'booking-pending-ticket-test';
    await db.insert(schema.bookings).values({
      id: PENDING_BOOKING_ID,
      eventId: EVENT_ID,
      attendeeId: 'attendee-row-ticket-1',
      status: 'pending',
      seatCount: 1,
      holdId: 'hold-pending-001',
      stripePaymentIntentId: null,
    });

    const caller = attendeeCaller();
    await expect(caller.getTicket({ bookingId: PENDING_BOOKING_ID })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  it('cancelled booking by own attendee → NOT_FOUND', async () => {
    const CANCELLED_BOOKING_ID = 'booking-cancelled-ticket-test';
    await db.insert(schema.bookings).values({
      id: CANCELLED_BOOKING_ID,
      eventId: EVENT_ID,
      attendeeId: 'attendee-row-ticket-1',
      status: 'cancelled',
      seatCount: 1,
      holdId: 'hold-cancelled-001',
      stripePaymentIntentId: null,
    });

    const caller = attendeeCaller();
    await expect(caller.getTicket({ bookingId: CANCELLED_BOOKING_ID })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  it('pending booking by unrelated user → FORBIDDEN (authorization before status guard)', async () => {
    const PENDING_BOOKING_ID = 'booking-pending-unauth-test';
    await db.insert(schema.bookings).values({
      id: PENDING_BOOKING_ID,
      eventId: EVENT_ID,
      attendeeId: 'attendee-row-ticket-1',
      status: 'pending',
      seatCount: 1,
      holdId: 'hold-pending-002',
      stripePaymentIntentId: null,
    });

    const caller = unrelatedCaller();
    await expect(caller.getTicket({ bookingId: PENDING_BOOKING_ID })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });

    const orgBCaller = organiserCaller(ORG_B);
    await expect(orgBCaller.getTicket({ bookingId: PENDING_BOOKING_ID })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
  });

  it('cancelled booking by unrelated user → FORBIDDEN (authorization before status guard)', async () => {
    const CANCELLED_BOOKING_ID = 'booking-cancelled-unauth-test';
    await db.insert(schema.bookings).values({
      id: CANCELLED_BOOKING_ID,
      eventId: EVENT_ID,
      attendeeId: 'attendee-row-ticket-1',
      status: 'cancelled',
      seatCount: 1,
      holdId: 'hold-cancelled-002',
      stripePaymentIntentId: null,
    });

    const caller = unrelatedCaller();
    await expect(caller.getTicket({ bookingId: CANCELLED_BOOKING_ID })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });

    const orgBCaller = organiserCaller(ORG_B);
    await expect(orgBCaller.getTicket({ bookingId: CANCELLED_BOOKING_ID })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
  });

  // ── Lazy generation tests ──────────────────────────────────────────────────

  it('R2 miss → PDF generated lazily, valid base64 PDF returned', async () => {
    // Confirm R2 is empty (set up by beforeEach)
    expect(await workerEnv.EVENT_TICKETS.get(R2_KEY)).toBeNull();

    const caller = attendeeCaller();
    const result = await caller.getTicket({ bookingId: BOOKING_ID });

    expect(result).toBeDefined();
    expect(typeof result.pdf).toBe('string');
    expect(result.pdf.length).toBeGreaterThan(0);

    // Decode and verify the returned bytes are a valid PDF
    const binaryStr = atob(result.pdf);
    const bytes = new Uint8Array(binaryStr.length);
    for (let i = 0; i < binaryStr.length; i++) bytes[i] = binaryStr.charCodeAt(i);
    await expect(PDFDocument.load(bytes)).resolves.not.toThrow();
  });

  it('R2 miss → after lazy generation, R2 object exists at tickets/{bookingId}.pdf', async () => {
    // Confirm R2 is empty (set up by beforeEach)
    expect(await workerEnv.EVENT_TICKETS.get(R2_KEY)).toBeNull();

    const caller = attendeeCaller();
    await caller.getTicket({ bookingId: BOOKING_ID });

    // Assert the R2 object was created — not just that a response came back
    const stored = await workerEnv.EVENT_TICKETS.get(R2_KEY);
    expect(stored).not.toBeNull();

    // Verify the stored object is a parseable PDF
    const bytes = new Uint8Array(await stored!.arrayBuffer());
    await expect(PDFDocument.load(bytes)).resolves.not.toThrow();
  });

  it('R2 hit → returns PDF from R2 without regenerating', async () => {
    // Pre-upload a PDF to R2 to simulate the webhook-time generation path
    const { generateTicketPdf } = await import('../src/ticket-pdf.js');
    const prebuiltBytes = await generateTicketPdf({
      attendeeName: 'Pre-built Attendee',
      eventName: 'Pre-built Event',
      eventDate: Date.now() + 86400000,
      seatCount: 1,
      bookingId: BOOKING_ID,
    });
    await workerEnv.EVENT_TICKETS.put(R2_KEY, prebuiltBytes, {
      httpMetadata: { contentType: 'application/pdf' },
    });

    const caller = attendeeCaller();
    const result = await caller.getTicket({ bookingId: BOOKING_ID });

    // Response should be the pre-built PDF (same byte count)
    const binaryStr = atob(result.pdf);
    expect(binaryStr.length).toBe(prebuiltBytes.length);
  });

  it('non-existent bookingId → NOT_FOUND', async () => {
    const caller = attendeeCaller();
    await expect(caller.getTicket({ bookingId: 'does-not-exist' })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });
});
