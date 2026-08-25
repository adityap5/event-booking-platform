import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { env, runInDurableObject } from 'cloudflare:test';
import type { Env } from '../src/index.js';
import workerExport from '../src/index.js';
import { setupTestDb } from './test-helpers.js';
import * as schema from '@event-booking/shared';
import { eq } from 'drizzle-orm';
import { runReconciliation } from '../src/reconciliation.js';
import { handleStripeWebhook } from '../src/handlers/stripe-webhook.js';
import * as integrations from '../src/integrations.js';
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
    vi.restoreAllMocks();
    db = await setupTestDb(workerEnv.DB);
    (workerEnv as any).STRIPE_SECRET_KEY = stripeSecretKey;
    (workerEnv as any).STRIPE_WEBHOOK_SECRET = webhookSecret;
  });

  afterEach(() => {
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
      const userId = 'audit-user-failed';

      await db.insert(schema.attendees).values({
        id: 'attendee-test-failed',
        userId,
        email: 'user-failed@example.com',
        name: 'Failed User',
      });

      await db.insert(schema.events).values({
        id: eventId,
        organisationId: 'test-org-1',
        name: 'Audit Event Failed',
        date: new Date(),
        totalSeats: 10,
        pricePerSeat: 5000,
      });

      await db.insert(schema.bookings).values({
        id: 'booking-test-failed-id',
        eventId,
        attendeeId: 'attendee-test-failed',
        status: 'pending',
        holdId,
        seatCount: 1,
      });

      const stub = workerEnv.SEAT_LEDGER.get(workerEnv.SEAT_LEDGER.idFromName(eventId));
      await stub.initialize(10);
      await runInDurableObject(stub, (instance: SeatLedger) => {
        (instance as any).ctx.storage.sql.exec(
          "INSERT INTO reservations (id, user_id, seat_count, expires_at, status) VALUES (?, ?, ?, ?, 'pending')",
          holdId,
          userId,
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

      // Verify booking status was updated to cancelled
      const [booking] = await db
        .select()
        .from(schema.bookings)
        .where(eq(schema.bookings.holdId, holdId));
      expect(booking).toBeDefined();
      expect(booking?.status).toBe('cancelled');

      // Verify DO hold was released
      const holdState = await stub.getHold(holdId);
      expect(holdState?.status).toBe('released');

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

    describe('Failure isolation on audit-log write errors', () => {
      it('confirmed outcome: returns 200 and dispatches integrations even when audit_log insert throws', async () => {
        const eventId = 'audit-fail-event-confirmed';
        const holdId = 'audit-fail-hold-confirmed';
        const userId = 'audit-fail-user-confirmed';

        await db.insert(schema.attendees).values({
          id: 'attendee-fail-confirmed',
          userId,
          email: 'user-confirmed@example.com',
          name: 'Confirmed User',
        });

        await db.insert(schema.events).values({
          id: eventId,
          organisationId: 'test-org-1',
          name: 'Audit Failure Confirmed Event',
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
            userId,
            2,
            Date.now() + 60000
          );
        });

        const emailSpy = vi.spyOn(integrations, 'dispatchEmailConfirmation');
        const calendarSpy = vi.spyOn(integrations, 'dispatchCalendarInvite');
        const sentrySpy = vi.spyOn(Sentry, 'captureMessage');

        // Force D1 audit_log insertion to fail
        const originalPrepare = workerEnv.DB.prepare.bind(workerEnv.DB);
        vi.spyOn(workerEnv.DB, 'prepare').mockImplementation((query: string) => {
          if (query.toLowerCase().includes('insert into') && query.toLowerCase().includes('audit_log')) {
            throw new Error('Simulated D1 audit_log write failure');
          }
          return originalPrepare(query);
        });

        const payload = {
          id: 'evt_test_confirmed_fail',
          type: 'payment_intent.succeeded',
          data: {
            object: {
              id: 'pi_test_fail_123',
              amount_received: 10000,
              metadata: {
                holdId,
                eventId,
              },
            },
          },
        };

        const request = await createSignedRequest(payload);
        const response = await handleStripeWebhook(request, workerEnv);

        // Webhook must still return 200
        expect(response?.status).toBe(200);

        // Booking row must exist in D1
        const [booking] = await db
          .select()
          .from(schema.bookings)
          .where(eq(schema.bookings.holdId, holdId));
        expect(booking).toBeDefined();
        expect(booking?.status).toBe('confirmed');

        // Integrations must have run despite audit_log write failure
        expect(emailSpy).toHaveBeenCalledTimes(1);
        expect(calendarSpy).toHaveBeenCalledTimes(1);

        // Sentry warning must be logged for the audit failure
        expect(sentrySpy).toHaveBeenCalledWith(
          'Failed to write audit_log for booking_confirmed',
          expect.objectContaining({
            level: 'warning',
            extra: expect.objectContaining({ holdId, eventId }),
          })
        );
      });

      it('hold_expired outcome: returns 200 and releases DO hold even when audit_log insert throws', async () => {
        const eventId = 'audit-fail-event-expired';
        const holdId = 'audit-fail-hold-expired';

        await db.insert(schema.events).values({
          id: eventId,
          organisationId: 'test-org-1',
          name: 'Audit Failure Expired Event',
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
            'user-exp-fail',
            1,
            Date.now() - 10000 // expired
          );
        });

        const sentrySpy = vi.spyOn(Sentry, 'captureMessage');

        const originalPrepare = workerEnv.DB.prepare.bind(workerEnv.DB);
        vi.spyOn(workerEnv.DB, 'prepare').mockImplementation((query: string) => {
          if (query.toLowerCase().includes('insert into') && query.toLowerCase().includes('audit_log')) {
            throw new Error('Simulated D1 audit_log write failure');
          }
          return originalPrepare(query);
        });

        const payload = {
          id: 'evt_test_exp_fail',
          type: 'payment_intent.succeeded',
          data: {
            object: {
              id: 'pi_test_exp_fail',
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

        // Assert DO hold was released by the webhook handler
        const holdState = await stub.getHold(holdId);
        expect(holdState?.status).toBe('released');

        expect(sentrySpy).toHaveBeenCalledWith(
          'Failed to write audit_log for hold_expired',
          expect.objectContaining({
            level: 'warning',
            extra: expect.objectContaining({ holdId, eventId }),
          })
        );
      });

      it('payment_failed outcome: returns 200 and cancels booking even when audit_log insert throws', async () => {
        const eventId = 'audit-fail-event-failed';
        const holdId = 'audit-fail-hold-failed';
        const userId = 'audit-fail-user-failed';

        await db.insert(schema.attendees).values({
          id: 'attendee-fail-failed',
          userId,
          email: 'user-failed@example.com',
          name: 'Failed Payment User',
        });

        await db.insert(schema.events).values({
          id: eventId,
          organisationId: 'test-org-1',
          name: 'Audit Failure Payment Failed Event',
          date: new Date(),
          totalSeats: 10,
          pricePerSeat: 5000,
        });

        await db.insert(schema.bookings).values({
          id: 'booking-fail-failed-id',
          eventId,
          attendeeId: 'attendee-fail-failed',
          status: 'pending',
          holdId,
          seatCount: 1,
        });

        const stub = workerEnv.SEAT_LEDGER.get(workerEnv.SEAT_LEDGER.idFromName(eventId));
        await stub.initialize(10);
        await runInDurableObject(stub, (instance: SeatLedger) => {
          (instance as any).ctx.storage.sql.exec(
            "INSERT INTO reservations (id, user_id, seat_count, expires_at, status) VALUES (?, ?, ?, ?, 'pending')",
            holdId,
            userId,
            1,
            Date.now() + 60000
          );
        });

        const sentrySpy = vi.spyOn(Sentry, 'captureMessage');

        const originalPrepare = workerEnv.DB.prepare.bind(workerEnv.DB);
        vi.spyOn(workerEnv.DB, 'prepare').mockImplementation((query: string) => {
          if (query.toLowerCase().includes('insert into') && query.toLowerCase().includes('audit_log')) {
            throw new Error('Simulated D1 audit_log write failure');
          }
          return originalPrepare(query);
        });

        const payload = {
          id: 'evt_test_failed_fail',
          type: 'payment_intent.payment_failed',
          data: {
            object: {
              id: 'pi_test_failed_fail',
              metadata: {
                holdId,
                eventId,
              },
            },
          },
        };

        const request = await createSignedRequest(payload);
        const response = await handleStripeWebhook(request, workerEnv);

        // Assert webhook returned 200
        expect(response?.status).toBe(200);

        // Assert booking status in D1 is updated to cancelled
        const [booking] = await db
          .select()
          .from(schema.bookings)
          .where(eq(schema.bookings.holdId, holdId));
        expect(booking).toBeDefined();
        expect(booking?.status).toBe('cancelled');

        // Assert DO hold was released
        const holdState = await stub.getHold(holdId);
        expect(holdState?.status).toBe('released');

        // Assert Sentry warning was captured for failed audit log insert
        expect(sentrySpy).toHaveBeenCalledWith(
          'Failed to write audit_log for payment_failed',
          expect.objectContaining({
            level: 'warning',
            extra: expect.objectContaining({ holdId, eventId }),
          })
        );
      });

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

    it('failure isolation: reconciliation continues past audit_log failure on first orphan and detects second orphan', async () => {
      const eventId = 'reconcile-event-two-orphans';
      const holdId1 = 'reconcile-hold-orphan-1';
      const holdId2 = 'reconcile-hold-orphan-2';

      await db.insert(schema.events).values({
        id: eventId,
        organisationId: 'test-org-1',
        name: 'Reconciliation Two Orphans Event',
        date: new Date(),
        totalSeats: 10,
        pricePerSeat: 5000,
      });

      const stub = workerEnv.SEAT_LEDGER.get(workerEnv.SEAT_LEDGER.idFromName(eventId));
      await stub.initialize(10);

      // Insert two confirmed orphaned holds in DO
      await runInDurableObject(stub, (instance: SeatLedger) => {
        (instance as any).ctx.storage.sql.exec(
          "INSERT INTO reservations (id, user_id, seat_count, expires_at, status) VALUES (?, ?, ?, ?, 'confirmed'), (?, ?, ?, ?, 'confirmed')",
          holdId1,
          'user-orphan-1',
          1,
          Date.now() - 30000,
          holdId2,
          'user-orphan-2',
          2,
          Date.now() - 30000
        );
      });

      const sentrySpy = vi.spyOn(Sentry, 'captureMessage');

      // Make the first audit_log insert fail, allow subsequent ones
      let auditLogWrites = 0;
      const originalPrepare = workerEnv.DB.prepare.bind(workerEnv.DB);
      vi.spyOn(workerEnv.DB, 'prepare').mockImplementation((query: string) => {
        if (query.toLowerCase().includes('insert into') && query.toLowerCase().includes('audit_log')) {
          auditLogWrites++;
          if (auditLogWrites === 1) {
            throw new Error('Simulated D1 audit_log write failure on orphan 1');
          }
        }
        return originalPrepare(query);
      });

      const summary = await runReconciliation(workerEnv);

      // Both orphans must be detected
      expect(summary.orphansDetected).toBe(2);

      // Sentry error alerts must be sent for BOTH orphans
      expect(sentrySpy).toHaveBeenCalledWith(
        'Reconciliation: ORPHANED HOLD detected',
        expect.objectContaining({
          level: 'error',
          extra: expect.objectContaining({ holdId: holdId1 }),
        })
      );
      expect(sentrySpy).toHaveBeenCalledWith(
        'Reconciliation: ORPHANED HOLD detected',
        expect.objectContaining({
          level: 'error',
          extra: expect.objectContaining({ holdId: holdId2 }),
        })
      );

      // Sentry warning must be sent for the failed audit_log write on orphan 1
      expect(sentrySpy).toHaveBeenCalledWith(
        'Failed to write audit_log for reconciliation_orphan_detected',
        expect.objectContaining({
          level: 'warning',
          extra: expect.objectContaining({ holdId: holdId1 }),
        })
      );

      // Second orphan's audit_log row must be written successfully
      const auditRows = await db
        .select()
        .from(schema.auditLog)
        .where(eq(schema.auditLog.holdId, holdId2));

      expect(auditRows).toHaveLength(1);
      expect(auditRows[0]?.eventType).toBe('reconciliation_orphan_detected');
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

    it('A3: excludes events older than 7-day cutoff from reconciliation query', async () => {
      const oldEventId = 'reconcile-event-too-old';
      const recentEventId = 'reconcile-event-in-window';

      // Old event 8 days ago
      await db.insert(schema.events).values({
        id: oldEventId,
        organisationId: 'test-org-1',
        name: 'Old Event (8 days ago)',
        date: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000),
        totalSeats: 10,
        pricePerSeat: 5000,
      });

      // Recent event in future
      await db.insert(schema.events).values({
        id: recentEventId,
        organisationId: 'test-org-1',
        name: 'Recent Event (in window)',
        date: new Date(Date.now() + 86400000),
        totalSeats: 10,
        pricePerSeat: 5000,
      });

      const stubOld = workerEnv.SEAT_LEDGER.get(workerEnv.SEAT_LEDGER.idFromName(oldEventId));
      await stubOld.initialize(10);
      const stubRecent = workerEnv.SEAT_LEDGER.get(workerEnv.SEAT_LEDGER.idFromName(recentEventId));
      await stubRecent.initialize(10);

      // Create an orphan on the old event and an orphan on the recent event
      await runInDurableObject(stubOld, (instance: SeatLedger) => {
        (instance as any).ctx.storage.sql.exec(
          "INSERT INTO reservations (id, user_id, seat_count, expires_at, status) VALUES (?, ?, ?, ?, 'confirmed')",
          'orphan-old-event',
          'user-old',
          1,
          Date.now() - 30000
        );
      });

      await runInDurableObject(stubRecent, (instance: SeatLedger) => {
        (instance as any).ctx.storage.sql.exec(
          "INSERT INTO reservations (id, user_id, seat_count, expires_at, status) VALUES (?, ?, ?, ?, 'confirmed')",
          'orphan-recent-event',
          'user-recent',
          1,
          Date.now() - 30000
        );
      });

      const summary = await runReconciliation(workerEnv);

      // Only recentEventId is checked (oldEventId is filtered out at D1 query level)
      expect(summary.checkedEvents).toBe(1);
      expect(summary.orphansDetected).toBe(1);

      // Only recent orphan's audit_log was written
      const oldAudit = await db
        .select()
        .from(schema.auditLog)
        .where(eq(schema.auditLog.holdId, 'orphan-old-event'));
      expect(oldAudit).toHaveLength(0);

      const recentAudit = await db
        .select()
        .from(schema.auditLog)
        .where(eq(schema.auditLog.holdId, 'orphan-recent-event'));
      expect(recentAudit).toHaveLength(1);
    });

    it('A3: batch fault isolation: failure in one event DO does not prevent remaining events from being reconciled', async () => {
      const eventFaulty = 'reconcile-event-faulty';
      const eventHealthy = 'reconcile-event-healthy-batch';

      await db.insert(schema.events).values({
        id: eventFaulty,
        organisationId: 'test-org-1',
        name: 'Faulty DO Event',
        date: new Date(Date.now() + 86400000),
        totalSeats: 10,
        pricePerSeat: 5000,
      });

      await db.insert(schema.events).values({
        id: eventHealthy,
        organisationId: 'test-org-1',
        name: 'Healthy DO Event',
        date: new Date(Date.now() + 86400000),
        totalSeats: 10,
        pricePerSeat: 5000,
      });

      const stubHealthy = workerEnv.SEAT_LEDGER.get(workerEnv.SEAT_LEDGER.idFromName(eventHealthy));
      await stubHealthy.initialize(10);
      await runInDurableObject(stubHealthy, (instance: SeatLedger) => {
        (instance as any).ctx.storage.sql.exec(
          "INSERT INTO reservations (id, user_id, seat_count, expires_at, status) VALUES (?, ?, ?, ?, 'confirmed')",
          'orphan-healthy-batch',
          'user-healthy',
          2,
          Date.now() - 30000
        );
      });

      // Mock SEAT_LEDGER.get to throw for eventFaulty
      const originalGet = workerEnv.SEAT_LEDGER.get.bind(workerEnv.SEAT_LEDGER);
      const getSpy = vi.spyOn(workerEnv.SEAT_LEDGER, 'get').mockImplementation((id) => {
        if (id.toString() === workerEnv.SEAT_LEDGER.idFromName(eventFaulty).toString()) {
          return {
            listConfirmedHolds: async () => {
              throw new Error('Durable Object unreachable for faulty event');
            },
          } as any;
        }
        return originalGet(id);
      });

      const summary = await runReconciliation(workerEnv);

      // Faulty event fails gracefully, healthy event orphan is detected
      expect(summary.checkedEvents).toBe(2);
      expect(summary.orphansDetected).toBe(1);

      const auditRows = await db
        .select()
        .from(schema.auditLog)
        .where(eq(schema.auditLog.holdId, 'orphan-healthy-batch'));
      expect(auditRows).toHaveLength(1);

      getSpy.mockRestore();
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
