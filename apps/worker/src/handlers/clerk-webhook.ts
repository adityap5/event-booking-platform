import { Webhook } from 'svix';
import { drizzle } from 'drizzle-orm/d1';
import { eq } from 'drizzle-orm';
import * as schema from '@event-booking/shared';
import type { Env } from '../index.js';
import * as Sentry from '@sentry/cloudflare';

interface ClerkWebhookEvent {
  type: string;
  data: {
    id: string;
    name: string;
    created_by: string;
    created_at?: number;
  };
}

export async function handleClerkWebhook(request: Request, env: Env): Promise<Response | null> {
  const url = new URL(request.url);
  
  if (url.pathname === '/api/webhooks/clerk' && request.method === 'POST') {
    const WEBHOOK_SECRET = env.CLERK_WEBHOOK_SECRET;
    if (!WEBHOOK_SECRET) {
      return new Response('Missing CLERK_WEBHOOK_SECRET', { status: 500 });
    }

    const svix_id = request.headers.get("svix-id");
    const svix_timestamp = request.headers.get("svix-timestamp");
    const svix_signature = request.headers.get("svix-signature");

    if (!svix_id || !svix_timestamp || !svix_signature) {
      return new Response('Error: Missing svix headers', { status: 400 });
    }

    const payload = await request.text();
    const wh = new Webhook(WEBHOOK_SECRET);

    let evt: ClerkWebhookEvent;
    try {
      evt = wh.verify(payload, {
        "svix-id": svix_id,
        "svix-timestamp": svix_timestamp,
        "svix-signature": svix_signature,
      }) as ClerkWebhookEvent;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.error('Error verifying webhook:', message);
      return new Response('Error verifying signature', { status: 400 });
    }

    if (evt.type === 'organization.created') {
      const db = drizzle(env.DB, { schema });
      try {
        await db.insert(schema.organisations).values({
          id: evt.data.id,
          name: evt.data.name,
          ownerId: evt.data.created_by,
          subscriptionStatus: 'inactive',
          // Clerk returns created_at as milliseconds, our schema expects a Date object because mode='timestamp'
          createdAt: evt.data.created_at ? new Date(evt.data.created_at) : new Date(),
        });
      } catch (err: unknown) {
        const errObj = typeof err === 'object' && err !== null ? (err as { message?: string; cause?: { message?: string }; stack?: string }) : null;
        const errorMessage = String(errObj?.cause?.message ?? errObj?.message ?? err);
        const isOwnerConflict = errorMessage.includes('organisations.owner_id') || errorMessage.includes('org_owner_idx');

        if (isOwnerConflict) {
          const [existingOrg] = await db
            .select({ id: schema.organisations.id })
            .from(schema.organisations)
            .where(eq(schema.organisations.ownerId, evt.data.created_by));

          // This is a permanent violation of the one-org-per-user model, retrying achieves nothing,
          // so we acknowledge receipt (HTTP 200) but log loudly for manual follow-up.
          console.error('[ORG_OWNER_CONFLICT]', {
            existingOrgId: existingOrg?.id ?? 'unknown',
            newOrgId: evt.data.id,
            ownerId: evt.data.created_by,
          });
          Sentry.captureMessage('[ORG_OWNER_CONFLICT]', {
            level: 'warning',
            extra: {
              existingOrgId: existingOrg?.id ?? 'unknown',
              newOrgId: evt.data.id,
              ownerId: evt.data.created_by,
            },
          });
          return new Response('', { status: 200 });
        }

        console.error('Error inserting organisation to DB:', err);
        console.error('Error cause:', errObj?.cause);
        console.error('Error stack:', errObj?.stack);
        Sentry.captureException(err, {
          extra: {
            orgId: evt.data.id,
            ownerId: evt.data.created_by,
          },
        });
        return new Response('Database error', { status: 500 });
      }
    }

    return new Response('', { status: 200 });
  }

  return null;
}
