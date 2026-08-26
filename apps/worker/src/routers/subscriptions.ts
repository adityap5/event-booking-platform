import { z } from 'zod';
import Stripe from 'stripe';
import { TRPCError } from '@trpc/server';
import { requireOrganiserRole } from '@event-booking/permissions';
import * as schema from '@event-booking/shared';
import { eq } from 'drizzle-orm';
import { workerProcedure } from '../procedures.js';
import { getOrCreateStripeCustomer } from '../subscription-helpers.js';
import { logStructured } from '../logger.js';

export const subscriptionsRouter = {
  getSubscriptionStatus: workerProcedure
    .input(z.void().optional())
    .query(async ({ ctx }) => {
      // Must be an organiser of the active organisation
      const orgId = requireOrganiserRole(ctx, 'organiser');

      const [org] = await ctx.db
        .select({
          subscriptionStatus: schema.organisations.subscriptionStatus,
          stripeCustomerId: schema.organisations.stripeCustomerId,
        })
        .from(schema.organisations)
        .where(eq(schema.organisations.id, orgId));

      if (!org) {
        return {
          subscriptionStatus: 'inactive',
          hasStripeCustomer: false,
        };
      }

      // Return server-computed presentation state only. Never expose raw Stripe IDs.
      return {
        subscriptionStatus: org.subscriptionStatus,
        hasStripeCustomer: Boolean(org.stripeCustomerId),
      };
    }),

  createSubscriptionCheckout: workerProcedure
    .input(z.void().optional())
    .mutation(async ({ ctx }) => {
      // Must be an organiser of the active organisation
      const orgId = requireOrganiserRole(ctx, 'organiser');

      // Rate limiting: protects against rapid double-clicks and denial-of-service
      const rateLimiter = ctx.env.RATE_LIMITER.get(ctx.env.RATE_LIMITER.idFromName(orgId));
      const { allowed } = await rateLimiter.checkLimit('createSubscriptionCheckout', 5, 60_000);
      if (!allowed) {
        logStructured({
          category: 'rate_limit_rejection',
          action: 'createSubscriptionCheckout',
          orgId,
          userId: ctx.userId,
        });
        throw new TRPCError({
          code: 'TOO_MANY_REQUESTS',
          message: 'Too many subscription checkout attempts. Please wait a moment and try again.',
        });
      }

      const [org] = await ctx.db
        .select({
          id: schema.organisations.id,
          subscriptionStatus: schema.organisations.subscriptionStatus,
          stripeCustomerId: schema.organisations.stripeCustomerId,
        })
        .from(schema.organisations)
        .where(eq(schema.organisations.id, orgId));

      if (!org) {
        throw new TRPCError({
          code: 'PRECONDITION_FAILED',
          message: 'Organisation not recognized. Please complete organiser onboarding first.',
        });
      }

      // Prevent duplicate subscriptions: only 'inactive' (never subscribed) and 'canceled' (ended)
      // are permitted to start a new checkout. All other states must use Billing Portal.
      if (org.subscriptionStatus !== 'inactive' && org.subscriptionStatus !== 'canceled') {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'Organisation already has a subscription. Manage your subscription through the Billing Portal.',
        });
      }

      const stripe = new Stripe(ctx.env.STRIPE_SECRET_KEY, {
        httpClient: Stripe.createFetchHttpClient(),
      });

      // Lazily create or fetch customer ID concurrency-safely (loads org name server-side from D1)
      let stripeCustomerId: string;
      try {
        stripeCustomerId = await getOrCreateStripeCustomer(
          ctx.db,
          stripe,
          org.id,
        );
      } catch (err: unknown) {
        console.error('Failed to get or create Stripe customer:', err);
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Failed to establish billing account. Please try again.',
        });
      }

      // Concurrency & idempotency: 10s time-bucketed idempotency key per organisation
      // ensures concurrent simultaneous checkout requests receive the exact same Checkout Session
      const idempotencyBucket = Math.floor(Date.now() / 10000);
      const idempotencyKey = `sub_checkout_${org.id}_${idempotencyBucket}`;

      const session = await stripe.checkout.sessions.create(
        {
          mode: 'subscription',
          customer: stripeCustomerId,
          line_items: [
            {
              price: ctx.env.STRIPE_SUBSCRIPTION_PRICE_ID,
              quantity: 1,
            },
          ],
          metadata: {
            // organisationId included strictly for operational tracing/debugging.
            // Webhooks and authorization resolve tenant state directly from Stripe Customer ID.
            organisationId: org.id,
          },
          success_url: `${ctx.env.WEB_APP_URL}/dashboard/billing?session_id={CHECKOUT_SESSION_ID}`,
          cancel_url: `${ctx.env.WEB_APP_URL}/dashboard/billing`,
        },
        { idempotencyKey },
      );

      return { sessionUrl: session.url };
    }),

  createBillingPortalSession: workerProcedure
    .input(z.void().optional())
    .mutation(async ({ ctx }) => {
      // Must be an organiser of the active organisation
      const orgId = requireOrganiserRole(ctx, 'organiser');

      const [org] = await ctx.db
        .select({
          stripeCustomerId: schema.organisations.stripeCustomerId,
        })
        .from(schema.organisations)
        .where(eq(schema.organisations.id, orgId));

      if (!org || !org.stripeCustomerId) {
        throw new TRPCError({
          code: 'PRECONDITION_FAILED',
          message: 'No billing account found for this organisation. Please subscribe first.',
        });
      }

      const stripe = new Stripe(ctx.env.STRIPE_SECRET_KEY, {
        httpClient: Stripe.createFetchHttpClient(),
      });

      const portalSession = await stripe.billingPortal.sessions.create({
        customer: org.stripeCustomerId,
        return_url: `${ctx.env.WEB_APP_URL}/dashboard/billing`,
      });

      return { sessionUrl: portalSession.url };
    }),
};
