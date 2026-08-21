import { describe, it, expect, beforeEach, vi } from 'vitest';
import { env, runInDurableObject } from 'cloudflare:test';
import type { Env } from '../src/index.js';
import workerExport from '../src/index.js';
import { setupTestDb } from './test-helpers.js';
import * as schema from '@event-booking/shared';
import { eq } from 'drizzle-orm';
import { runReconciliation } from '../src/reconciliation.js';
import { handleStripeWebhook } from '../src/handlers/stripe-webhook.js';
import Stripe from 'stripe';
import * as Sentry from '@sentry/cloudflare';
import type { SeatLedger } from '../src/seat-ledger.js';

describe('Day 7: Audit Log & Reconciliation Tests', () => {
  let db: Awaited<ReturnType<typeof setupTestDb>>;
  const workerEnv = env as unknown as Env;
  const stripeSecretKey = 'sk_test_mock';
  const webhookSecret = 'whsec_test_secret_123';

  const stripe = new Stripe(stripeSecretKey, {
    httpClient: Stripe.createFetchHttpClient(),
  });

  beforeEach(async () => {
    db = await setupTestDb(workerEnv.DB);
    (workerEnv as any).STRIPE_SECRET_KEY = stripeSecretKey;
    (workerEnv as any).STRIPE_WEBHOOK_SECRET = webhookSecret;
    vi.restoreAllMocks();
  });

  async function createSignedRequest(payload: object, secret: string = webhookSecret): Promise<Request> {
    const rawBody = JSON.stringify(payload);
    const signature = await stripe.webhooks.generateTestHeaderStringAsync({
      payload: rawBody,
      secret,
    });

    return new Request('https://worker.dev/stripe/webhook', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'stripe-signature': signature,
      },
      body: rawBody,
    });
  }

  describe('1. Audit log writes from webhook layer', () => {
    it('writes audit_log row on booking_confirmed outcome', async () => {
      const eventId = 'audit-test-event-1';
      const holdId = 'audit-test-hold-1';
      const userId = 'audit-user-1';

      // Seed attendee and event
      await db.insert(schema.attendees).values({
        id: 'attendee-1',
        userId,
        email: 'user1@example.com',
        name: 'User One',
      });

      await db.insert(schema.events).values({
        id: eventId,
        organisationId: 'test-org-1',
        name: 'Audit Event 1',
        date: new Date(),
        totalSeats: 10,
        pricePerSeat: 5000,
      });

      // DO state setup
      const stub = workerEnv.SEAT_LEDGER.get(workerEnv.SEAT_LEDGER.idFromName(eventId));
      await stub.initialize(10);
      await runInDurableObject(stub, (instance: SeatLedger) => {
        (instance as any).ctx.storage.sql.exec(
          "INSERT INTO reservations (id, user_id, seat_count, expires_at, status) VALUES (?, ?, ?, ?, 'pending')",
          holdId,
          userId,
          2,
          Date.now() + 60000
        );
      });

      const payload = {
        id: 'evt_test_success',
        type: 'payment_intent.succeeded',
        data: {
          object: {
            id: 'pi_test_success_123',
            amount_received: 10000, // 2 * 5000
            metadata: {
              holdId,
              eventId,
            },
          },
        },
      };

      const request = await createSignedRequest(payload);
      const response = await handleStripeWebhook(request, workerEnv);
      expect(response?.status).toBe(200);

      // Verify audit_log row was written
      const auditRows = await db
        .select()
        .from(schema.auditLog)
        .where(eq(schema.auditLog.holdId, holdId));

      expect(auditRows).toHaveLength(1);
      expect(auditRows[0]?.eventType).toBe('booking_confirmed');
      expect(auditRows[0]?.bookingEventId).toBe(eventId);
      expect(auditRows[0]?.userId).toBe(userId);
      const detail = JSON.parse(auditRows[0]?.detail ?? '{}');
      expect(detail.seatCount).toBe(2);
      expect(detail.amountReceivedPence).toBe(10000);
    });

    it('writes audit_log row on payment_intent.payment_failed (explicit release)', async () => {
      const eventId = 'audit-test-event-failed';
      const holdId = 'audit-test-hold-failed';

      await db.insert(schema.events).values({
        id: eventId,
        organisationId: 'test-org-1',
        name: 'Audit Event Failed',
        date: new Date(),
        totalSeats: 10,
        pricePerSeat: 5000,
      });

      const stub = workerEnv.SEAT_LEDGER.get(workerEnv.SEAT_LEDGER.idFromName(eventId));
      await stub.initialize(10);
      await runInDurableObject(stub, (instance: SeatLedger) => {
        (instance as any).ctx.storage.sql.exec(
          "INSERT INTO reservations (id, user_id, seat_count, expires_at, status) VALUES (?, ?, ?, ?, 'pending')",
          holdId,
          'user-failed',
          1,
          Date.now() + 60000
        );
      });

      const payload = {
        id: 'evt_test_failed',
        type: 'payment_intent.payment_failed',
        data: {
          object: {
            id: 'pi_test_failed_123',
            metadata: {
              holdId,
              eventId,
            },
          },
        },
      };

      const request = await createSignedRequest(payload);
      const response = await handleStripeWebhook(request, workerEnv);
      expect(response?.status).toBe(200);

      const auditRows = await db
        .select()
        .from(schema.auditLog)
        .where(eq(schema.auditLog.holdId, holdId));

      expect(auditRows).toHaveLength(1);
      expect(auditRows[0]?.eventType).toBe('hold_released_explicit');
      expect(auditRows[0]?.bookingEventId).toBe(eventId);
      const detail = JSON.parse(auditRows[0]?.detail ?? '{}');
      expect(detail.reason).toBe('payment_failed');
    });

    it('writes audit_log row on HOLD_EXPIRED explicit release in webhook handler', async () => {
      const eventId = 'audit-test-event-expired';
      const holdId = 'audit-test-hold-expired';

      await db.insert(schema.events).values({
        id: eventId,
        organisationId: 'test-org-1',
        name: 'Audit Event Expired',
        date: new Date(),
        totalSeats: 10,
        pricePerSeat: 5000,
      });

      const stub = workerEnv.SEAT_LEDGER.get(workerEnv.SEAT_LEDGER.idFromName(eventId));
      await stub.initialize(10);
      // Hold is expired in the DO
      await runInDurableObject(stub, (instance: SeatLedger) => {
        (instance as any).ctx.storage.sql.exec(
          "INSERT INTO reservations (id, user_id, seat_count, expires_at, status) VALUES (?, ?, ?, ?, 'pending')",
          holdId,
          'user-exp',
          1,
          Date.now() - 10000 // already expired
        );
      });

      const payload = {
        id: 'evt_test_exp',
        type: 'payment_intent.succeeded',
        data: {
          object: {
            id: 'pi_test_exp_123',
            amount_received: 5000,
            metadata: {
              holdId,
              eventId,
            },
          },
        },
      };

      const request = await createSignedRequest(payload);
      const response = await handleStripeWebhook(request, workerEnv);
      expect(response?.status).toBe(200);

      const auditRows = await db
        .select()
        .from(schema.auditLog)
        .where(eq(schema.auditLog.holdId, holdId));

      expect(auditRows).toHaveLength(1);
      expect(auditRows[0]?.eventType).toBe('hold_released_explicit');
      const detail = JSON.parse(auditRows[0]?.detail ?? '{}');
      expect(detail.reason).toBe('hold_expired');
    });

    it('confirms alarm-driven release does NOT write to D1 audit_log (boundary protection)', async () => {
      const eventId = 'audit-test-event-alarm';
      const holdId = 'audit-test-hold-alarm';

      const stub = workerEnv.SEAT_LEDGER.get(workerEnv.SEAT_LEDGER.idFromName(eventId));
      await stub.initialize(10);
      await runInDurableObject(stub, (instance: SeatLedger) => {
        (instance as any).ctx.storage.sql.exec(
          "INSERT INTO reservations (id, user_id, seat_count, expires_at, status) VALUES (?, ?, ?, ?, 'pending')",
          holdId,
          'user-alarm',
          1,
          Date.now() - 5000
        );
      });

      // Trigger DO alarm directly via runInDurableObject
      await runInDurableObject(stub, async (instance: SeatLedger) => {
        await instance.alarm();
      });

      // Verify no audit log row was written
      const auditRows = await db
        .select()
        .from(schema.auditLog)
        .where(eq(schema.auditLog.holdId, holdId));

      expect(auditRows).toHaveLength(0);
    });
  });

  describe('2. Reconciliation job execution & orphan detection', () => {
    it('detects orphaned confirmed hold past expiry, writes audit_log, alerts Sentry, and DOES NOT write D1 booking', async () => {
      const eventId = 'reconcile-event-orphan';
      const holdId = 'reconcile-hold-orphan';
      const userId = 'user-orphan-1';

      await db.insert(schema.events).values({
        id: eventId,
        organisationId: 'test-org-1',
        name: 'Reconciliation Orphan Event',
        date: new Date(),
        totalSeats: 10,
        pricePerSeat: 5000,
      });

      const stub = workerEnv.SEAT_LEDGER.get(workerEnv.SEAT_LEDGER.idFromName(eventId));
      await stub.initialize(10);

      // Insert confirmed hold into DO directly with expired timestamp (simulating orphaned hold)
      await runInDurableObject(stub, (instance: SeatLedger) => {
        (instance as any).ctx.storage.sql.exec(
          "INSERT INTO reservations (id, user_id, seat_count, expires_at, status) VALUES (?, ?, ?, ?, 'confirmed')",
          holdId,
          userId,
          3,
          Date.now() - 30000 // expired
        );
      });

      const captureMessageSpy = vi.spyOn(Sentry, 'captureMessage');

      const summary = await runReconciliation(workerEnv);

      expect(summary.checkedEvents).toBeGreaterThanOrEqual(1);
      expect(summary.orphansDetected).toBe(1);

      // Verify audit_log row written
      const auditRows = await db
        .select()
        .from(schema.auditLog)
        .where(eq(schema.auditLog.holdId, holdId));

      expect(auditRows).toHaveLength(1);
      expect(auditRows[0]?.eventType).toBe('reconciliation_orphan_detected');
      expect(auditRows[0]?.bookingEventId).toBe(eventId);
      expect(auditRows[0]?.userId).toBe(userId);
      const detail = JSON.parse(auditRows[0]?.detail ?? '{}');
      expect(detail.seatCount).toBe(3);

      // Verify Sentry alert was sent with level error
      expect(captureMessageSpy).toHaveBeenCalledWith(
        'Reconciliation: ORPHANED HOLD detected',
        expect.objectContaining({
          level: 'error',
          extra: expect.objectContaining({
            holdId,
            eventId,
            userId,
            seatCount: 3,
          }),
        })
      );

      // Verify NO booking row was written to D1 (alert-only)
      const bookingsRows = await db
        .select()
        .from(schema.bookings)
        .where(eq(schema.bookings.holdId, holdId));

      expect(bookingsRows).toHaveLength(0);
    });

    it('takes no action for DO-confirmed hold WITH matching D1 booking', async () => {
      const eventId = 'reconcile-event-healthy';
      const holdId = 'reconcile-hold-healthy';
      const userId = 'user-healthy-1';

      await db.insert(schema.attendees).values({
        id: 'attendee-healthy',
        userId,
        email: 'healthy@example.com',
        name: 'Healthy Attendee',
      });

      await db.insert(schema.events).values({
        id: eventId,
        organisationId: 'test-org-1',
        name: 'Reconciliation Healthy Event',
        date: new Date(),
        totalSeats: 10,
        pricePerSeat: 5000,
      });

      await db.insert(schema.bookings).values({
        id: 'booking-healthy',
        eventId,
        attendeeId: 'attendee-healthy',
        status: 'confirmed',
        holdId,
        seatCount: 2,
      });

      const stub = workerEnv.SEAT_LEDGER.get(workerEnv.SEAT_LEDGER.idFromName(eventId));
      await stub.initialize(10);

      await runInDurableObject(stub, (instance: SeatLedger) => {
        (instance as any).ctx.storage.sql.exec(
          "INSERT INTO reservations (id, user_id, seat_count, expires_at, status) VALUES (?, ?, ?, ?, 'confirmed')",
          holdId,
          userId,
          2,
          Date.now() - 30000
        );
      });

      const captureMessageSpy = vi.spyOn(Sentry, 'captureMessage');

      const summary = await runReconciliation(workerEnv);
      expect(summary.orphansDetected).toBe(0);
      expect(captureMessageSpy).not.toHaveBeenCalled();

      const auditRows = await db
        .select()
        .from(schema.auditLog)
        .where(eq(schema.auditLog.holdId, holdId));

      expect(auditRows).toHaveLength(0);
    });

    it('takes no action for unexpired holds (expires_at >= Date.now())', async () => {
      const eventId = 'reconcile-event-unexpired';
      const holdId = 'reconcile-hold-unexpired';
      const userId = 'user-unexpired-1';

      await db.insert(schema.events).values({
        id: eventId,
        organisationId: 'test-org-1',
        name: 'Reconciliation Unexpired Event',
        date: new Date(),
        totalSeats: 10,
        pricePerSeat: 5000,
      });

      const stub = workerEnv.SEAT_LEDGER.get(workerEnv.SEAT_LEDGER.idFromName(eventId));
      await stub.initialize(10);

      // Confirmed hold whose original expiresAt is still in the future
      await runInDurableObject(stub, (instance: SeatLedger) => {
        (instance as any).ctx.storage.sql.exec(
          "INSERT INTO reservations (id, user_id, seat_count, expires_at, status) VALUES (?, ?, ?, ?, 'confirmed')",
          holdId,
          userId,
          2,
          Date.now() + 60000 // unexpired
        );
      });

      const summary = await runReconciliation(workerEnv);
      expect(summary.orphansDetected).toBe(0);

      const auditRows = await db
        .select()
        .from(schema.auditLog)
        .where(eq(schema.auditLog.holdId, holdId));

      expect(auditRows).toHaveLength(0);
    });

    it('takes no action for pending holds', async () => {
      const eventId = 'reconcile-event-pending';
      const holdId = 'reconcile-hold-pending';

      await db.insert(schema.events).values({
        id: eventId,
        organisationId: 'test-org-1',
        name: 'Reconciliation Pending Event',
        date: new Date(),
        totalSeats: 10,
        pricePerSeat: 5000,
      });

      const stub = workerEnv.SEAT_LEDGER.get(workerEnv.SEAT_LEDGER.idFromName(eventId));
      await stub.initialize(10);

      await runInDurableObject(stub, (instance: SeatLedger) => {
        (instance as any).ctx.storage.sql.exec(
          "INSERT INTO reservations (id, user_id, seat_count, expires_at, status) VALUES (?, ?, ?, ?, 'pending')",
          holdId,
          'user-pending',
          2,
          Date.now() + 60000
        );
      });

      const summary = await runReconciliation(workerEnv);
      expect(summary.orphansDetected).toBe(0);
    });
  });

  describe('3. Scheduled handler wiring in index.ts', () => {
    it('executes scheduled handler exported from index.ts', async () => {
      expect(typeof workerExport.scheduled).toBe('function');

      const mockController = {
        cron: '*/5 * * * *',
        scheduledTime: Date.now(),
        noRetry: () => {},
      };

      const mockCtx = {
        waitUntil: vi.fn(),
        passThroughOnException: vi.fn(),
      };

      await (workerExport.scheduled as any)(mockController, workerEnv, mockCtx);
    });
  });
});
