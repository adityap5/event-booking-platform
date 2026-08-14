import { describe, it, expect, beforeEach } from 'vitest';
import { env, runInDurableObject } from 'cloudflare:test';
import type { Env } from '../src/index.js';
import { setupTestDb } from './test-helpers.js';
import { handleStripeWebhook } from '../src/handlers/stripe-webhook.js';
import Stripe from 'stripe';
import * as schema from '@event-booking/shared';
import type { SeatLedger } from '../src/seat-ledger.js';

describe('handleStripeWebhook HTTP handler', () => {
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

  it('signature verification: returns 400 for missing or invalid signature header', async () => {
    // Missing header
    const reqNoSig = new Request('https://worker.dev/stripe/webhook', {
      method: 'POST',
      body: JSON.stringify({ type: 'ping' }),
    });
    const resNoSig = await handleStripeWebhook(reqNoSig, workerEnv);
    expect(resNoSig?.status).toBe(400);

    // Invalid signature
    const reqBadSig = new Request('https://worker.dev/stripe/webhook', {
      method: 'POST',
      headers: { 'stripe-signature': 't=123,v1=invalid_sig' },
      body: JSON.stringify({ type: 'ping' }),
    });
    const resBadSig = await handleStripeWebhook(reqBadSig, workerEnv);
    expect(resBadSig?.status).toBe(400);
  });

  it('HTTP mapping: payment_intent.succeeded confirmed outcome returns 200', async () => {
    const eventId = 'webhook-event-1';
    const userId = 'webhook-user-1';

    await db.insert(schema.events).values({
      id: eventId,
      organisationId: 'org-1',
      name: 'Webhook Event',
      date: new Date(Date.now() + 86400000),
      totalSeats: 10,
      pricePerSeat: 1000,
    });

    await db.insert(schema.attendees).values({
      id: 'webhook-attendee-1',
      userId,
      email: 'webhook@example.com',
      name: 'Webhook Attendee',
    });

    const stub = workerEnv.SEAT_LEDGER.get(workerEnv.SEAT_LEDGER.idFromName(eventId));
    await stub.initialize(10);
    const hold = await stub.reserveSeat(userId, 1);

    const payload = {
      id: 'evt_test_1',
      type: 'payment_intent.succeeded',
      data: {
        object: {
          id: 'pi_webhook_test',
          amount_received: 1000,
          metadata: {
            holdId: hold.reservationId,
            eventId,
          },
        },
      },
    };

    const req = await createSignedRequest(payload);
    const res = await handleStripeWebhook(req, workerEnv);
    expect(res?.status).toBe(200);
  });

  it('HTTP mapping: orphaned_hold outcome returns 500 status for Stripe retry', async () => {
    const eventId = 'webhook-event-orphaned';
    const orphanedHoldId = 'webhook-orphaned-hold';

    await db.insert(schema.events).values({
      id: eventId,
      organisationId: 'org-1',
      name: 'Webhook Orphaned Event',
      date: new Date(Date.now() + 86400000),
      totalSeats: 10,
      pricePerSeat: 1000,
    });

    const stub = workerEnv.SEAT_LEDGER.get(workerEnv.SEAT_LEDGER.idFromName(eventId));
    await stub.initialize(10);

    // Insert reservation with status = 'confirmed' in DO, but NO booking row in D1
    await runInDurableObject(stub, (instance: SeatLedger) => {
      (instance as any).ctx.storage.sql.exec(
        "INSERT INTO reservations (id, user_id, seat_count, expires_at, status) VALUES (?, ?, ?, ?, 'confirmed')",
        orphanedHoldId,
        'user-orphaned',
        1,
        Date.now() + 900000
      );
    });

    const payload = {
      id: 'evt_test_orphaned',
      type: 'payment_intent.succeeded',
      data: {
        object: {
          id: 'pi_webhook_orphaned',
          amount_received: 1000,
          metadata: {
            holdId: orphanedHoldId,
            eventId,
          },
        },
      },
    };

    const req = await createSignedRequest(payload);
    const res = await handleStripeWebhook(req, workerEnv);
    expect(res?.status).toBe(500);
    const text = await res?.text();
    expect(text).toContain('Orphaned hold — needs reconciliation');
  });
});
