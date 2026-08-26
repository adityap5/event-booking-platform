import { eq, and, isNull } from 'drizzle-orm';
import type { DrizzleD1Database } from 'drizzle-orm/d1';
import * as schema from '@event-booking/shared';
import type Stripe from 'stripe';

export type Db = DrizzleD1Database<typeof schema>;

/**
 * Looks up an organisation by its Stripe Customer ID.
 * Used by subscription webhooks and mutations.
 */
export async function findOrgByStripeCustomerId(db: Db, stripeCustomerId: string) {
  const [org] = await db
    .select()
    .from(schema.organisations)
    .where(eq(schema.organisations.stripeCustomerId, stripeCustomerId));

  return org ?? null;
}

/**
 * Retrieves an existing Stripe Customer ID for an organisation or creates a new one concurrency-safely.
 *
 * IMPORTANT:
 * - orgId must strictly originate from the verified server auth context.
 * - Organisation attributes (e.g. name) are loaded exclusively from D1, never from caller inputs.
 * - If two requests execute concurrently when stripeCustomerId is null, both might call stripe.customers.create().
 *   The conditional update (WHERE id = ? AND stripe_customer_id IS NULL) ensures only one write wins.
 *   The losing request re-reads D1 and uses the winning customer ID. The losing request's created Stripe Customer
 *   object is left as a harmless, unused orphan, which is an acceptable low-cost trade-off vs distributed locks.
 * - Under NO circumstances will this helper return an unpersisted transient Customer ID. If D1 persistence/re-fetch
 *   cannot be established, it throws an error immediately to prevent unlinked Checkout sessions.
 */
export async function getOrCreateStripeCustomer(
  db: Db,
  stripe: Stripe,
  orgId: string,
): Promise<string> {
  // 1. Fetch organisation record from D1
  const [org] = await db
    .select({
      id: schema.organisations.id,
      name: schema.organisations.name,
      stripeCustomerId: schema.organisations.stripeCustomerId,
    })
    .from(schema.organisations)
    .where(eq(schema.organisations.id, orgId));

  if (!org) {
    throw new Error(`Organisation not found: ${orgId}`);
  }

  if (org.stripeCustomerId) {
    return org.stripeCustomerId;
  }

  // 2. Proactively create Stripe customer with server-derived name
  const customer = await stripe.customers.create({
    name: org.name,
    metadata: {
      organisationId: orgId,
    },
  });

  // 3. Conditional update to guarantee exactly one customer ID is persisted per organisation
  const updateResult = await db
    .update(schema.organisations)
    .set({ stripeCustomerId: customer.id })
    .where(
      and(
        eq(schema.organisations.id, orgId),
        isNull(schema.organisations.stripeCustomerId),
      ),
    )
    .returning({ stripeCustomerId: schema.organisations.stripeCustomerId });

  if (updateResult.length > 0 && updateResult[0]?.stripeCustomerId) {
    return updateResult[0].stripeCustomerId;
  }

  // 4. Concurrency race lost — another request committed its stripeCustomerId first.
  // Re-fetch and return the persisted ID. The orphaned customer created above is harmlessly ignored.
  const [freshOrg] = await db
    .select({ stripeCustomerId: schema.organisations.stripeCustomerId })
    .from(schema.organisations)
    .where(eq(schema.organisations.id, orgId));

  if (freshOrg?.stripeCustomerId) {
    return freshOrg.stripeCustomerId;
  }

  // 5. Invariant: Never proceed if the Customer ID is not durably recorded in D1.
  throw new Error(`Failed to persist or verify Stripe Customer ID for organisation ${orgId}`);
}
