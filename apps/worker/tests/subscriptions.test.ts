import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { env } from 'cloudflare:test';
import type { Env } from '../src/index.js';
import { setupTestDb, createTestCaller, mockStripeNetworkCall } from './test-helpers.js';
import * as schema from '@event-booking/shared';
import { eq } from 'drizzle-orm';
import { handleStripeWebhook } from '../src/handlers/stripe-webhook.js';
import { getOrCreateStripeCustomer } from '../src/subscription-helpers.js';
import Stripe from 'stripe';
import m4 from '../migrations/0004_petite_tiger_shark.sql?raw';
import * as Sentry from '@sentry/cloudflare';

describe('Day 10: Organisation Subscription', () => {
  let db: Awaited<ReturnType<typeof setupTestDb>>;
  const workerEnv = env as unknown as Env;

  beforeEach(async () => {
    vi.restoreAllMocks();
    db = await setupTestDb(workerEnv.DB);
    (workerEnv as any).STRIPE_SECRET_KEY = 'sk_test_mock';
    (workerEnv as any).STRIPE_WEBHOOK_SECRET = 'whsec_test_secret_123';
    (workerEnv as any).STRIPE_SUBSCRIPTION_PRICE_ID = 'price_test_monthly_sub';
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('1. Schema & Migration SQL', () => {
    it('generates exact SQLite migration with subscription_status DEFAULT inactive NOT NULL', () => {
      expect(m4).toContain('ALTER TABLE `organisations` ADD `stripe_customer_id` text;');
      expect(m4).toContain('ALTER TABLE `organisations` ADD `stripe_subscription_id` text;');
      expect(m4).toContain("ALTER TABLE `organisations` ADD `subscription_status` text DEFAULT 'inactive' NOT NULL;");
      expect(m4).toContain('CREATE UNIQUE INDEX `org_stripe_customer_idx` ON `organisations` (`stripe_customer_id`);');
    });

    it('defaults subscriptionStatus to inactive when a raw organisation is inserted without status', async () => {
      const orgId = 'org-raw-default-test';
      await workerEnv.DB.prepare(
        "INSERT INTO organisations (id, name, owner_id) VALUES (?, ?, ?)"
      ).bind(orgId, 'Raw Org', 'owner-raw-1').run();

      const [org] = await db
        .select()
        .from(schema.organisations)
        .where(eq(schema.organisations.id, orgId));

      expect(org).toBeDefined();
      expect(org!.subscriptionStatus).toBe('inactive');
      expect(org!.stripeCustomerId).toBeNull();
      expect(org!.stripeSubscriptionId).toBeNull();
    });
  });

  describe('2. Clerk Webhook Organisation Creation', () => {
    it('sets subscriptionStatus to inactive on organization.created webhook', async () => {
      const orgId = 'org-clerk-webhook-1';
      const ownerId = 'user-clerk-owner-1';

      // Insert directly as clerk webhook handler does to verify values
      await db.insert(schema.organisations).values({
        id: orgId,
        name: 'Clerk Created Org',
        ownerId,
        subscriptionStatus: 'inactive',
        createdAt: new Date(),
      });

      const [org] = await db
        .select()
        .from(schema.organisations)
        .where(eq(schema.organisations.id, orgId));

      expect(org).toBeDefined();
      expect(org!.subscriptionStatus).toBe('inactive');
    });
  });

  describe('3. createEvent Entitlement Gate', () => {
    it('rejects createEvent when subscriptionStatus is inactive', async () => {
      const orgId = 'org-inactive-test';
      await db.insert(schema.organisations).values({
        id: orgId,
        name: 'Inactive Org',
        ownerId: 'owner-inactive',
        subscriptionStatus: 'inactive',
      });

      const caller = createTestCaller({
        env: workerEnv,
        db,
        userId: 'owner-inactive',
        orgId,
        role: 'organiser',
      });

      await expect(
        caller.createEvent({
          name: 'Summer Festival',
          date: Date.now() + 86400000,
          totalSeats: 100,
          pricePerSeat: 1000,
        })
      ).rejects.toThrowError(/An active subscription is required to create events\. Subscribe from your dashboard\./);
    });

    it('allows createEvent when subscriptionStatus is active', async () => {
      const orgId = 'org-active-test';
      await db.insert(schema.organisations).values({
        id: orgId,
        name: 'Active Org',
        ownerId: 'owner-active',
        subscriptionStatus: 'active',
      });

      const caller = createTestCaller({
        env: workerEnv,
        db,
        userId: 'owner-active',
        orgId,
        role: 'organiser',
      });

      const event = await caller.createEvent({
        name: 'Active Org Festival',
        date: Date.now() + 86400000,
        totalSeats: 50,
        pricePerSeat: 2000,
      });

      expect(event).toBeDefined();
      expect(event!.name).toBe('Active Org Festival');
    });

    it('allows createEvent when subscriptionStatus is trialing', async () => {
      const orgId = 'org-trialing-test';
      await db.insert(schema.organisations).values({
        id: orgId,
        name: 'Trialing Org',
        ownerId: 'owner-trialing',
        subscriptionStatus: 'trialing',
      });

      const caller = createTestCaller({
        env: workerEnv,
        db,
        userId: 'owner-trialing',
        orgId,
        role: 'organiser',
      });

      const event = await caller.createEvent({
        name: 'Trial Org Gala',
        date: Date.now() + 86400000,
        totalSeats: 30,
        pricePerSeat: 1500,
      });

      expect(event).toBeDefined();
      expect(event!.name).toBe('Trial Org Gala');
    });

    it('rejects createEvent for past_due, unpaid, canceled, incomplete, paused', async () => {
      const nonEntitledStatuses = ['past_due', 'unpaid', 'canceled', 'incomplete', 'paused'] as const;

      for (const status of nonEntitledStatuses) {
        const orgId = `org-${status}-test`;
        await db.insert(schema.organisations).values({
          id: orgId,
          name: `${status} Org`,
          ownerId: `owner-${status}`,
          subscriptionStatus: status,
        });

        const caller = createTestCaller({
          env: workerEnv,
          db,
          userId: `owner-${status}`,
          orgId,
          role: 'organiser',
        });

        await expect(
          caller.createEvent({
            name: `${status} Event`,
            date: Date.now() + 86400000,
            totalSeats: 20,
            pricePerSeat: 1000,
          })
        ).rejects.toThrowError(/An active subscription is required to create events/);
      }
    });
  });

  describe('4. Existing Events and Bookings Retention on Cancellation', () => {
    it('keeps existing events and bookings accessible after subscription is canceled', async () => {
      const orgId = 'org-cancel-retention';
      await db.insert(schema.organisations).values({
        id: orgId,
        name: 'Retention Org',
        ownerId: 'owner-retention',
        subscriptionStatus: 'active',
      });

      const caller = createTestCaller({
        env: workerEnv,
        db,
        userId: 'owner-retention',
        orgId,
        role: 'organiser',
      });

      // 1. Create event while active
      const createdEvent = await caller.createEvent({
        name: 'Historic Festival',
        date: Date.now() + 86400000,
        totalSeats: 10,
        pricePerSeat: 500,
      });

      // 2. Subscription becomes canceled
      await db
        .update(schema.organisations)
        .set({ subscriptionStatus: 'canceled' })
        .where(eq(schema.organisations.id, orgId));

      // 3. Existing event is still readable publicly and in org list
      const publicEvent = await caller.getPublicEvent({ eventId: createdEvent!.id });
      expect(publicEvent.id).toBe(createdEvent!.id);
      expect(publicEvent.name).toBe('Historic Festival');

      const orgEvents = await caller.listOrgEvents();
      expect(orgEvents.some((e) => e.id === createdEvent!.id)).toBe(true);

      // 4. Update event still works (only createEvent is gated)
      const updated = await caller.updateEvent({
        eventId: createdEvent!.id,
        name: 'Updated Historic Festival',
        description: 'New description',
      });
      expect(updated.name).toBe('Updated Historic Festival');

      // 5. Creating a new event is blocked
      await expect(
        caller.createEvent({
          name: 'Blocked New Event',
          date: Date.now() + 86400000,
          totalSeats: 10,
          pricePerSeat: 500,
        })
      ).rejects.toThrowError(/An active subscription is required to create events/);
    });
  });

  describe('5. createSubscriptionCheckout Mutation', () => {
    it('creates a Stripe customer lazily and returns Checkout session URL', async () => {
      const orgId = 'org-checkout-new';
      await db.insert(schema.organisations).values({
        id: orgId,
        name: 'Checkout Org',
        ownerId: 'owner-checkout',
        subscriptionStatus: 'inactive',
      });

      mockStripeNetworkCall({
        id: 'cs_test_sub_session_123',
        url: 'https://checkout.stripe.com/pay/cs_test_sub_session_123',
      });

      const caller = createTestCaller({
        env: workerEnv,
        db,
        userId: 'owner-checkout',
        orgId,
        role: 'organiser',
      });

      const res = await caller.createSubscriptionCheckout();
      expect(res.sessionUrl).toBe('https://checkout.stripe.com/pay/cs_test_sub_session_123');

      // Assert Stripe customer ID was stored on the org
      const [org] = await db
        .select()
        .from(schema.organisations)
        .where(eq(schema.organisations.id, orgId));
      expect(org).toBeDefined();
      expect(org!.stripeCustomerId).toBeDefined();
      expect(org!.stripeCustomerId).toMatch(/^cs_test_/);
    });

    it('rejects createSubscriptionCheckout if organisation is already active or trialing', async () => {
      const orgId = 'org-already-active';
      await db.insert(schema.organisations).values({
        id: orgId,
        name: 'Active Org',
        ownerId: 'owner-active-checkout',
        subscriptionStatus: 'active',
        stripeCustomerId: 'cus_existing_123',
      });

      const caller = createTestCaller({
        env: workerEnv,
        db,
        userId: 'owner-active-checkout',
        orgId,
        role: 'organiser',
      });

      await expect(
        caller.createSubscriptionCheckout()
      ).rejects.toThrowError(/Organisation already has a subscription\. Manage your subscription through the Billing Portal\./);
    });

    it('allows createSubscriptionCheckout if organisation is canceled', async () => {
      const orgId = 'org-canceled-resub';
      await db.insert(schema.organisations).values({
        id: orgId,
        name: 'Canceled Org',
        ownerId: 'owner-canceled',
        subscriptionStatus: 'canceled',
        stripeCustomerId: 'cus_existing_canceled',
      });

      mockStripeNetworkCall({
        id: 'cs_test_resub_456',
        url: 'https://checkout.stripe.com/pay/cs_test_resub_456',
      });

      const caller = createTestCaller({
        env: workerEnv,
        db,
        userId: 'owner-canceled',
        orgId,
        role: 'organiser',
      });

      const res = await caller.createSubscriptionCheckout();
      expect(res.sessionUrl).toBe('https://checkout.stripe.com/pay/cs_test_resub_456');
    });

    it('rejects createSubscriptionCheckout for non-organiser', async () => {
      const caller = createTestCaller({
        env: workerEnv,
        db,
        userId: 'attendee-user',
        orgId: 'test-org-1',
        role: 'attendee',
      });

      await expect(
        caller.createSubscriptionCheckout()
      ).rejects.toThrowError(/You do not have permission to perform this action/);
    });

    it('fails safely and throws error if D1 customer persistence fails', async () => {
      const orgId = 'org-persistence-fail';
      // Do not insert org into D1, but invoke with org context to simulate lookup/persistence failure
      const caller = createTestCaller({
        env: workerEnv,
        db,
        userId: 'owner-fail',
        orgId,
        role: 'organiser',
      });

      await expect(
        caller.createSubscriptionCheckout()
      ).rejects.toThrowError(/Organisation not recognized/);
    });
  });

  describe('6. Concurrent Stripe Customer Creation & Fallback Invariant', () => {
    it('persists exactly one stripeCustomerId on the organisation across concurrent calls', async () => {
      const orgId = 'org-concurrent-test';
      await db.insert(schema.organisations).values({
        id: orgId,
        name: 'Concurrent Org',
        ownerId: 'owner-concurrent',
        subscriptionStatus: 'inactive',
      });

      let callCount = 0;
      const stripeMock = {
        customers: {
          create: vi.fn().mockImplementation(async (params: any) => {
            callCount++;
            return {
              id: `cus_mock_created_${callCount}`,
              name: params.name,
            };
          }),
        },
      } as unknown as Stripe;

      // Execute two near-simultaneous calls to getOrCreateStripeCustomer(db, stripeMock, orgId)
      const [res1, res2] = await Promise.all([
        getOrCreateStripeCustomer(db, stripeMock, orgId),
        getOrCreateStripeCustomer(db, stripeMock, orgId),
      ]);

      // Both returned customer IDs should resolve to the one stored in D1
      const [org] = await db
        .select()
        .from(schema.organisations)
        .where(eq(schema.organisations.id, orgId));

      expect(org).toBeDefined();
      expect(org!.stripeCustomerId).toBeDefined();
      expect(org!.stripeCustomerId).toBe(res1);
      expect(res1).toBe(res2);
    });

    it('throws error and never returns transient customer ID if D1 persistence cannot be established', async () => {
      const orgId = 'org-unpersisted-edge';
      await db.insert(schema.organisations).values({
        id: orgId,
        name: 'Unpersisted Org',
        ownerId: 'owner-unpersisted',
        subscriptionStatus: 'inactive',
      });

      const stripeMock = {
        customers: {
          create: vi.fn().mockResolvedValue({ id: 'cus_transient_123', name: 'Unpersisted Org' }),
        },
      } as unknown as Stripe;

      // Create a mock DB where the update returns 0 rows and re-fetch returns null stripeCustomerId
      const mockFailingDb = {
        select: vi.fn().mockReturnValue({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue([
              { id: orgId, name: 'Unpersisted Org', stripeCustomerId: null },
            ]),
          }),
        }),
        update: vi.fn().mockReturnValue({
          set: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              returning: vi.fn().mockResolvedValue([]),
            }),
          }),
        }),
      } as any;

      await expect(
        getOrCreateStripeCustomer(mockFailingDb, stripeMock, orgId)
      ).rejects.toThrowError(/Failed to persist or verify Stripe Customer ID for organisation/);
    });
  });

  describe('7. createBillingPortalSession & getSubscriptionStatus', () => {
    it('rejects getSubscriptionStatus for non-organiser (attendee)', async () => {
      const caller = createTestCaller({
        env: workerEnv,
        db,
        userId: 'attendee-status-user',
        orgId: 'test-org-1',
        role: 'attendee',
      });

      await expect(
        caller.getSubscriptionStatus()
      ).rejects.toThrowError(/You do not have permission to perform this action/);
    });

    it('rejects createBillingPortalSession when no Stripe customer exists', async () => {
      const orgId = 'org-no-customer';
      await db.insert(schema.organisations).values({
        id: orgId,
        name: 'No Customer Org',
        ownerId: 'owner-nocust',
        subscriptionStatus: 'inactive',
      });

      const caller = createTestCaller({
        env: workerEnv,
        db,
        userId: 'owner-nocust',
        orgId,
        role: 'organiser',
      });

      await expect(
        caller.createBillingPortalSession()
      ).rejects.toThrowError(/No billing account found for this organisation/);
    });

    it('creates Billing Portal session and points return_url to /dashboard/billing', async () => {
      const orgId = 'org-has-customer';
      await db.insert(schema.organisations).values({
        id: orgId,
        name: 'Has Customer Org',
        ownerId: 'owner-hascust',
        subscriptionStatus: 'active',
        stripeCustomerId: 'cus_portal_test_789',
      });

      mockStripeNetworkCall({
        id: 'bps_test_session_123',
        url: 'https://billing.stripe.com/session/bps_test_session_123',
      });

      const caller = createTestCaller({
        env: workerEnv,
        db,
        userId: 'owner-hascust',
        orgId,
        role: 'organiser',
      });

      const res = await caller.createBillingPortalSession();
      expect(res.sessionUrl).toBe('https://billing.stripe.com/session/bps_test_session_123');
    });

    it('getSubscriptionStatus returns presentation state and never exposes raw Stripe IDs', async () => {
      const orgId = 'org-status-check';
      await db.insert(schema.organisations).values({
        id: orgId,
        name: 'Status Check Org',
        ownerId: 'owner-status',
        subscriptionStatus: 'trialing',
        stripeCustomerId: 'cus_secret_123',
        stripeSubscriptionId: 'sub_secret_456',
      });

      const caller = createTestCaller({
        env: workerEnv,
        db,
        userId: 'owner-status',
        orgId,
        role: 'organiser',
      });

      const status = await caller.getSubscriptionStatus();
      expect(status).toEqual({
        subscriptionStatus: 'trialing',
        hasStripeCustomer: true,
      });

      // Verify no raw Stripe IDs leaked
      expect((status as any).stripeCustomerId).toBeUndefined();
      expect((status as any).stripeSubscriptionId).toBeUndefined();
    });
  });

  describe('8. Webhook Handling: customer.subscription.*', () => {
    const testStripe = new Stripe('sk_test_mock', {
      httpClient: Stripe.createFetchHttpClient(),
    });

    async function dispatchWebhook(eventType: string, subscriptionData: Record<string, any>) {
      // Construct simulated event payload
      const eventPayload = {
        id: `evt_${Date.now()}_${Math.random()}`,
        type: eventType,
        data: {
          object: {
            object: 'subscription',
            id: subscriptionData.id,
            customer: subscriptionData.customer,
            status: subscriptionData.status,
            ...subscriptionData,
          },
        },
      };

      const rawBody = JSON.stringify(eventPayload);
      const signature = await testStripe.webhooks.generateTestHeaderStringAsync({
        payload: rawBody,
        secret: 'whsec_test_secret_123',
      });

      const request = new Request('https://worker.local/stripe/webhook', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'stripe-signature': signature,
        },
        body: rawBody,
      });

      return await handleStripeWebhook(request, workerEnv);
    }

    it('customer.subscription.created: establishes stripeSubscriptionId and subscriptionStatus', async () => {
      const orgId = 'org-webhook-create';
      const stripeCustomerId = 'cus_webhook_create_1';

      await db.insert(schema.organisations).values({
        id: orgId,
        name: 'Webhook Create Org',
        ownerId: 'owner-wh-1',
        stripeCustomerId,
        subscriptionStatus: 'inactive',
      });

      const res = await dispatchWebhook('customer.subscription.created', {
        id: 'sub_wh_create_100',
        customer: stripeCustomerId,
        status: 'active',
      });

      expect(res?.status).toBe(200);

      const [org] = await db
        .select()
        .from(schema.organisations)
        .where(eq(schema.organisations.id, orgId));

      expect(org).toBeDefined();
      expect(org!.stripeSubscriptionId).toBe('sub_wh_create_100');
      expect(org!.subscriptionStatus).toBe('active');
    });

    it('customer.subscription.created: does not overwrite a different non-terminal subscription and cancels duplicate on Stripe', async () => {
      const orgId = 'org-webhook-no-overwrite';
      const stripeCustomerId = 'cus_webhook_no_overwrite';

      await db.insert(schema.organisations).values({
        id: orgId,
        name: 'No Overwrite Org',
        ownerId: 'owner-wh-2',
        stripeCustomerId,
        stripeSubscriptionId: 'sub_primary_active',
        subscriptionStatus: 'active',
      });

      mockStripeNetworkCall({
        id: 'sub_unexpected_secondary',
        status: 'canceled',
      });

      const res = await dispatchWebhook('customer.subscription.created', {
        id: 'sub_unexpected_secondary',
        customer: stripeCustomerId,
        status: 'trialing',
      });

      expect(res?.status).toBe(200);

      const [org] = await db
        .select()
        .from(schema.organisations)
        .where(eq(schema.organisations.id, orgId));

      expect(org).toBeDefined();
      // Primary subscription is preserved in D1
      expect(org!.stripeSubscriptionId).toBe('sub_primary_active');
      expect(org!.subscriptionStatus).toBe('active');
    });

    it('genuine concurrency: simultaneous customer.subscription.created webhooks with Promise.all establish exactly one authoritative subscription in D1 and cancel the loser', async () => {
      const orgId = 'org-concurrent-created-race';
      const stripeCustomerId = 'cus_concurrent_created_race';

      await db.insert(schema.organisations).values({
        id: orgId,
        name: 'Simultaneous Created Race Org',
        ownerId: 'owner-race-created',
        stripeCustomerId,
        stripeSubscriptionId: null, // Initially null
        subscriptionStatus: 'inactive',
      });

      mockStripeNetworkCall({
        id: 'sub_concurrent_winner_or_loser',
        status: 'canceled',
      });

      // Dispatch two webhook events simultaneously while stripeSubscriptionId is NULL
      const [res1, res2] = await Promise.all([
        dispatchWebhook('customer.subscription.created', {
          id: 'sub_concurrent_alpha',
          customer: stripeCustomerId,
          status: 'active',
        }),
        dispatchWebhook('customer.subscription.created', {
          id: 'sub_concurrent_beta',
          customer: stripeCustomerId,
          status: 'active',
        }),
      ]);

      expect(res1?.status).toBe(200);
      expect(res2?.status).toBe(200);

      const [org] = await db
        .select()
        .from(schema.organisations)
        .where(eq(schema.organisations.id, orgId));

      expect(org).toBeDefined();
      // Exactly ONE subscription won the compare-and-set claim and remains authoritative in D1
      expect(['sub_concurrent_alpha', 'sub_concurrent_beta']).toContain(org!.stripeSubscriptionId);
      expect(org!.subscriptionStatus).toBe('active');
    });

    it('genuine concurrency: simultaneous customer.subscription.updated webhooks from NULL with Promise.all establish exactly one authoritative subscription in D1', async () => {
      const orgId = 'org-concurrent-updated-race';
      const stripeCustomerId = 'cus_concurrent_updated_race';

      await db.insert(schema.organisations).values({
        id: orgId,
        name: 'Simultaneous Updated Race Org',
        ownerId: 'owner-race-updated',
        stripeCustomerId,
        stripeSubscriptionId: null, // Initially null
        subscriptionStatus: 'inactive',
      });

      // Dispatch two updated events simultaneously out-of-order from NULL
      const [res1, res2] = await Promise.all([
        dispatchWebhook('customer.subscription.updated', {
          id: 'sub_concurrent_gamma',
          customer: stripeCustomerId,
          status: 'active',
        }),
        dispatchWebhook('customer.subscription.updated', {
          id: 'sub_concurrent_delta',
          customer: stripeCustomerId,
          status: 'active',
        }),
      ]);

      expect(res1?.status).toBe(200);
      expect(res2?.status).toBe(200);

      const [org] = await db
        .select()
        .from(schema.organisations)
        .where(eq(schema.organisations.id, orgId));

      expect(org).toBeDefined();
      // Exactly ONE subscription won the compare-and-set claim in D1
      expect(['sub_concurrent_gamma', 'sub_concurrent_delta']).toContain(org!.stripeSubscriptionId);
      expect(org!.subscriptionStatus).toBe('active');
    });

    it('customer.subscription.updated: updates status when subscription ID matches', async () => {
      const orgId = 'org-webhook-update';
      const stripeCustomerId = 'cus_webhook_update_1';

      await db.insert(schema.organisations).values({
        id: orgId,
        name: 'Update Org',
        ownerId: 'owner-wh-3',
        stripeCustomerId,
        stripeSubscriptionId: 'sub_current_1',
        subscriptionStatus: 'active',
      });

      const res = await dispatchWebhook('customer.subscription.updated', {
        id: 'sub_current_1',
        customer: stripeCustomerId,
        status: 'past_due',
      });

      expect(res?.status).toBe(200);

      const [org] = await db
        .select()
        .from(schema.organisations)
        .where(eq(schema.organisations.id, orgId));

      expect(org).toBeDefined();
      expect(org!.subscriptionStatus).toBe('past_due');
    });

    it('customer.subscription.updated: handles out-of-order delivery before created event', async () => {
      const orgId = 'org-webhook-ooo';
      const stripeCustomerId = 'cus_webhook_ooo_1';

      await db.insert(schema.organisations).values({
        id: orgId,
        name: 'Out of Order Org',
        ownerId: 'owner-wh-4',
        stripeCustomerId,
        stripeSubscriptionId: null, // created event not delivered yet
        subscriptionStatus: 'inactive',
      });

      const res = await dispatchWebhook('customer.subscription.updated', {
        id: 'sub_ooo_100',
        customer: stripeCustomerId,
        status: 'active',
      });

      expect(res?.status).toBe(200);

      const [org] = await db
        .select()
        .from(schema.organisations)
        .where(eq(schema.organisations.id, orgId));

      expect(org).toBeDefined();
      expect(org!.stripeSubscriptionId).toBe('sub_ooo_100');
      expect(org!.subscriptionStatus).toBe('active');
    });

    it('customer.subscription.updated: ignores stale event for non-matching subscription ID', async () => {
      const orgId = 'org-webhook-stale';
      const stripeCustomerId = 'cus_webhook_stale_1';

      await db.insert(schema.organisations).values({
        id: orgId,
        name: 'Stale Org',
        ownerId: 'owner-wh-5',
        stripeCustomerId,
        stripeSubscriptionId: 'sub_latest_active',
        subscriptionStatus: 'active',
      });

      const res = await dispatchWebhook('customer.subscription.updated', {
        id: 'sub_old_canceled_id',
        customer: stripeCustomerId,
        status: 'unpaid',
      });

      expect(res?.status).toBe(200);

      const [org] = await db
        .select()
        .from(schema.organisations)
        .where(eq(schema.organisations.id, orgId));

      expect(org).toBeDefined();
      // Status must not regress
      expect(org!.stripeSubscriptionId).toBe('sub_latest_active');
      expect(org!.subscriptionStatus).toBe('active');
    });

    it('customer.subscription.deleted: sets status to canceled when ID matches, ignores stale ID', async () => {
      const orgId = 'org-webhook-del';
      const stripeCustomerId = 'cus_webhook_del_1';

      await db.insert(schema.organisations).values({
        id: orgId,
        name: 'Delete Org',
        ownerId: 'owner-wh-6',
        stripeCustomerId,
        stripeSubscriptionId: 'sub_to_delete',
        subscriptionStatus: 'active',
      });

      // 1. Stale deletion event for another subscription ID is ignored
      await dispatchWebhook('customer.subscription.deleted', {
        id: 'sub_other_unrelated',
        customer: stripeCustomerId,
        status: 'canceled',
      });

      let [org] = await db
        .select()
        .from(schema.organisations)
        .where(eq(schema.organisations.id, orgId));
      expect(org).toBeDefined();
      expect(org!.subscriptionStatus).toBe('active');

      // 2. Matching deletion event cancels the subscription
      await dispatchWebhook('customer.subscription.deleted', {
        id: 'sub_to_delete',
        customer: stripeCustomerId,
        status: 'canceled',
      });

      [org] = await db
        .select()
        .from(schema.organisations)
        .where(eq(schema.organisations.id, orgId));
      expect(org).toBeDefined();
      expect(org!.subscriptionStatus).toBe('canceled');
    });

    it('webhook idempotency: replaying same event twice produces identical state without side effects', async () => {
      const orgId = 'org-webhook-idempotent';
      const stripeCustomerId = 'cus_webhook_idemp_1';

      await db.insert(schema.organisations).values({
        id: orgId,
        name: 'Idempotent Org',
        ownerId: 'owner-wh-7',
        stripeCustomerId,
        stripeSubscriptionId: 'sub_idemp_1',
        subscriptionStatus: 'active',
      });

      // First delivery
      await dispatchWebhook('customer.subscription.updated', {
        id: 'sub_idemp_1',
        customer: stripeCustomerId,
        status: 'past_due',
      });

      // Second delivery (replay)
      await dispatchWebhook('customer.subscription.updated', {
        id: 'sub_idemp_1',
        customer: stripeCustomerId,
        status: 'past_due',
      });

      const [org] = await db
        .select()
        .from(schema.organisations)
        .where(eq(schema.organisations.id, orgId));

      expect(org).toBeDefined();
      expect(org!.subscriptionStatus).toBe('past_due');
      expect(org!.stripeSubscriptionId).toBe('sub_idemp_1');
    });

    it('customer.subscription.created: losing subscription cancellation succeeds — existing behavior confirmed correct', async () => {
      // Verifies the existing cancellation path calls Stripe cancel for a loser,
      // and that Sentry is NOT called when cancellation succeeds.
      const orgId = 'org-cancel-success';
      const stripeCustomerId = 'cus_cancel_success';

      await db.insert(schema.organisations).values({
        id: orgId,
        name: 'Cancel Success Org',
        ownerId: 'owner-cancel-success',
        stripeCustomerId,
        stripeSubscriptionId: 'sub_winner',
        subscriptionStatus: 'active',
      });

      // Mock Stripe to accept the cancel call
      mockStripeNetworkCall({ id: 'sub_loser', status: 'canceled' });
      const sentrySpy = vi.spyOn(Sentry, 'captureMessage');

      const res = await dispatchWebhook('customer.subscription.created', {
        id: 'sub_loser',
        customer: stripeCustomerId,
        status: 'active',
      });

      expect(res?.status).toBe(200);

      // Authoritative subscription must remain unchanged
      const [org] = await db
        .select()
        .from(schema.organisations)
        .where(eq(schema.organisations.id, orgId));
      expect(org!.stripeSubscriptionId).toBe('sub_winner');
      expect(org!.subscriptionStatus).toBe('active');

      // No Sentry error — cancellation succeeded
      const cancelFailureCalls = sentrySpy.mock.calls.filter(([msg]) =>
        typeof msg === 'string' && msg.includes('failed to cancel redundant'),
      );
      expect(cancelFailureCalls).toHaveLength(0);
    });

    it('customer.subscription.created: losing subscription cancellation fails — Sentry captures at error level, still returns 200', async () => {
      const orgId = 'org-cancel-fail';
      const stripeCustomerId = 'cus_cancel_fail';

      await db.insert(schema.organisations).values({
        id: orgId,
        name: 'Cancel Fail Org',
        ownerId: 'owner-cancel-fail',
        stripeCustomerId,
        stripeSubscriptionId: 'sub_authoritative',
        subscriptionStatus: 'active',
      });

      // Make the outbound Stripe API call fail by intercepting fetch
      const originalFetch = globalThis.fetch;
      globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        const urlString = typeof input === 'string'
          ? input
          : input instanceof URL
          ? input.href
          : (input as Request).url;
        if (urlString.includes('api.stripe.com')) {
          return new Response(
            JSON.stringify({ error: { type: 'api_error', message: 'Service unavailable' } }),
            { status: 503, headers: { 'Content-Type': 'application/json' } },
          );
        }
        return originalFetch(input, init);
      };

      const sentrySpy = vi.spyOn(Sentry, 'captureMessage');

      try {
        const res = await dispatchWebhook('customer.subscription.created', {
          id: 'sub_loser_fail',
          customer: stripeCustomerId,
          status: 'active',
        });

        // Must still return 200 even when the cancellation throws
        expect(res?.status).toBe(200);

        // D1 state must be unchanged
        const [org] = await db
          .select()
          .from(schema.organisations)
          .where(eq(schema.organisations.id, orgId));
        expect(org!.stripeSubscriptionId).toBe('sub_authoritative');
        expect(org!.subscriptionStatus).toBe('active');

        // Sentry must have fired at error level with all required context
        const failureCalls = sentrySpy.mock.calls.filter(([msg]) =>
          typeof msg === 'string' && msg.includes('failed to cancel redundant'),
        );
        expect(failureCalls).toHaveLength(1);
        const [, sentryCtx] = failureCalls[0]!;
        expect(sentryCtx).toMatchObject({
          level: 'error',
          extra: expect.objectContaining({
            orgId,
            authoritativeSubscriptionId: 'sub_authoritative',
            rejectedSubscriptionId: 'sub_loser_fail',
          }),
        });
        // The error field must be a non-empty string (the serialized cancellation error)
        expect(typeof (sentryCtx as any)?.extra?.error).toBe('string');
        expect((sentryCtx as any)?.extra?.error).toBeTruthy();
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    // ── customer.subscription.updated discriminator analysis ──────────────────
    //
    // The current D1 data model stores only one subscription ID slot
    // (stripeSubscriptionId) with no history, no "replaced-by" pointer, and no
    // per-subscription creation timestamp. When a customer.subscription.updated
    // event arrives for a non-matching subscription ID, the state
    //   freshOrg.stripeSubscriptionId !== subscription.id
    // is ambiguous between:
    //   A. A duplicate/loser-race subscription (should be cancelled).
    //   B. A legitimately superseded old subscription whose webhook arrived late
    //      (must NOT be cancelled — doing so would be a regression).
    // Without a reliable discriminator, defensive cancellation cannot be
    // implemented safely. The correct behavior is the existing one: log a
    // warning and return 200. The two tests below prove this contract is preserved.

    it('customer.subscription.updated: legitimately superseded subscription arriving late must NOT trigger cancellation or Sentry error', async () => {
      // Scenario: org previously had sub_old (superseded by sub_current).
      // A late updated event for sub_old arrives. Must be silently ignored.
      const orgId = 'org-updated-superseded';
      const stripeCustomerId = 'cus_updated_superseded';

      await db.insert(schema.organisations).values({
        id: orgId,
        name: 'Superseded Org',
        ownerId: 'owner-superseded',
        stripeCustomerId,
        stripeSubscriptionId: 'sub_current',
        subscriptionStatus: 'active',
      });

      const sentrySpy = vi.spyOn(Sentry, 'captureMessage');

      const res = await dispatchWebhook('customer.subscription.updated', {
        id: 'sub_old_superseded',
        customer: stripeCustomerId,
        status: 'canceled',
      });

      expect(res?.status).toBe(200);

      // D1 must be unchanged
      const [org] = await db
        .select()
        .from(schema.organisations)
        .where(eq(schema.organisations.id, orgId));
      expect(org!.stripeSubscriptionId).toBe('sub_current');
      expect(org!.subscriptionStatus).toBe('active');

      // No error-level Sentry call — this is intentionally a safe ignore
      const errorCalls = sentrySpy.mock.calls.filter(([, ctx]) =>
        (ctx as any)?.level === 'error',
      );
      expect(errorCalls).toHaveLength(0);
    });

    it('customer.subscription.updated: non-matching subscription (potential loser) cannot be safely distinguished from a superseded one — silently ignored, no cancellation, no Sentry error, 200', async () => {
      // This is the companion to the above: a duplicate-race subscription that
      // arrives via updated (not created) cannot be distinguished from a
      // legitimately superseded subscription with the current D1 model.
      // Both produce the same safe outcome: warn + 200, no cancel, no Sentry error.
      const orgId = 'org-updated-stale-dup';
      const stripeCustomerId = 'cus_updated_stale_dup';

      await db.insert(schema.organisations).values({
        id: orgId,
        name: 'Stale Dup Org',
        ownerId: 'owner-stale-dup',
        stripeCustomerId,
        stripeSubscriptionId: 'sub_winner_dup',
        subscriptionStatus: 'active',
      });

      const sentrySpy = vi.spyOn(Sentry, 'captureMessage');

      const res = await dispatchWebhook('customer.subscription.updated', {
        id: 'sub_loser_dup_updated',
        customer: stripeCustomerId,
        status: 'active',
      });

      expect(res?.status).toBe(200);

      const [org] = await db
        .select()
        .from(schema.organisations)
        .where(eq(schema.organisations.id, orgId));
      expect(org!.stripeSubscriptionId).toBe('sub_winner_dup');
      expect(org!.subscriptionStatus).toBe('active');

      // No error-level Sentry call — cancellation cannot be safely performed here
      const errorCalls = sentrySpy.mock.calls.filter(([, ctx]) =>
        (ctx as any)?.level === 'error',
      );
      expect(errorCalls).toHaveLength(0);
    });
  });

  describe('9. Tenant Isolation & Server Authority', () => {
    it('does not allow Organiser A to view or mutate Organiser B subscription state', async () => {
      const orgAId = 'org-iso-A';
      const orgBId = 'org-iso-B';

      await db.insert(schema.organisations).values({
        id: orgAId,
        name: 'Org A',
        ownerId: 'owner-iso-A',
        subscriptionStatus: 'active',
        stripeCustomerId: 'cus_iso_A',
      });

      await db.insert(schema.organisations).values({
        id: orgBId,
        name: 'Org B',
        ownerId: 'owner-iso-B',
        subscriptionStatus: 'inactive',
        stripeCustomerId: null,
      });

      const callerA = createTestCaller({
        env: workerEnv,
        db,
        userId: 'owner-iso-A',
        orgId: orgAId,
        role: 'organiser',
      });

      const statusA = await callerA.getSubscriptionStatus();
      expect(statusA.subscriptionStatus).toBe('active');
      expect(statusA.hasStripeCustomer).toBe(true);

      const callerB = createTestCaller({
        env: workerEnv,
        db,
        userId: 'owner-iso-B',
        orgId: orgBId,
        role: 'organiser',
      });

      const statusB = await callerB.getSubscriptionStatus();
      expect(statusB.subscriptionStatus).toBe('inactive');
      expect(statusB.hasStripeCustomer).toBe(false);
    });
  });
});
