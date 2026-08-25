import { drizzle } from 'drizzle-orm/d1';
import { eq, gte } from 'drizzle-orm';
import * as schema from '@event-booking/shared';
import * as Sentry from '@sentry/cloudflare';
import type { Env } from './index.js';
import { logStructured } from './logger.js';

export interface ReconciliationSummary {
  checkedEvents: number;
  confirmedHoldsInspected: number;
  orphansDetected: number;
}

/**
 * Periodic reconciliation job that cross-checks Durable Object confirmed holds
 * against D1 bookings rows.
 *
 * Orphan criteria:
 * 1. Hold is confirmed in the DO (status === 'confirmed')
 * 2. Hold is past its expiry window (expiresAt < Date.now()) — guards against mid-flight webhook confirmations
 * 3. No matching booking row exists in D1 for this holdId
 *
 * Cutoff derivation:
 * - Holds last 15 minutes; confirmation occurs during the hold lifecycle.
 * - Reconciliation runs every 5 minutes, so orphans are detectable shortly after hold expiry.
 * - The event-date booking guard in reserveSeat enforces that NEW holds cannot be created for past events.
// The 7-day cutoff provides a bounded operational retention window for historical
// reconciliation. Because reserveSeat rejects new holds once an event has started,
// no new reconciliation-relevant holds can be created for events outside this
// window; existing holds expire within 15 minutes of creation and reconciliation
// runs every 5 minutes.
 *
 * On detecting an orphan:
 * - Recovers hold details via DO getHold(holdId)
 * - Writes an audit_log row (eventType: 'reconciliation_orphan_detected')
 * - Emits a Sentry alert with level 'error'
 * - Emits a structured log
 * - DOES NOT write a booking row (alert-only by explicit design)
 */
export async function runReconciliation(env: Env): Promise<ReconciliationSummary> {
  const db = drizzle(env.DB, { schema });

  // 7-day operational retention window for active reconciliation sweep
  const cutoffDate = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

  const events = await db
    .select({
      id: schema.events.id,
      organisationId: schema.events.organisationId,
    })
    .from(schema.events)
    .where(gte(schema.events.date, cutoffDate));

  let confirmedHoldsInspected = 0;
  let orphansDetected = 0;

  const CHUNK_SIZE = 10;
  for (let i = 0; i < events.length; i += CHUNK_SIZE) {
    const chunk = events.slice(i, i + CHUNK_SIZE);
    await Promise.all(
      chunk.map(async (event) => {
        try {
          const stub = env.SEAT_LEDGER.get(env.SEAT_LEDGER.idFromName(event.id));
          const confirmedHolds = await stub.listConfirmedHolds();

          for (const hold of confirmedHolds) {
            confirmedHoldsInspected++;

            // Orphan-eligibility filter: hold must be past expiration window to avoid racing mid-flight webhook processing
            if (hold.expiresAt >= Date.now()) {
              continue;
            }

            const [existingBooking] = await db
              .select({ id: schema.bookings.id })
              .from(schema.bookings)
              .where(eq(schema.bookings.holdId, hold.id));

            if (existingBooking) {
              // DO-confirmed hold with matching D1 booking row — healthy state
              continue;
            }

            // Orphan detected: DO shows confirmed, hold is past expiry, but D1 has no booking row
            orphansDetected++;

            const orphanDetail = {
              holdId: hold.id,
              eventId: event.id,
              userId: hold.userId,
              seatCount: hold.seatCount,
              expiresAt: hold.expiresAt,
            };

            try {
              await db.insert(schema.auditLog).values({
                eventType: 'reconciliation_orphan_detected',
                holdId: hold.id,
                bookingEventId: event.id,
                userId: hold.userId,
                orgId: event.organisationId,
                detail: JSON.stringify(orphanDetail),
              });
            } catch (auditErr: unknown) {
              console.error('Failed to write audit_log for reconciliation_orphan_detected:', auditErr);
              Sentry.captureMessage('Failed to write audit_log for reconciliation_orphan_detected', {
                level: 'warning',
                extra: {
                  ...orphanDetail,
                  error: auditErr instanceof Error ? auditErr.message : String(auditErr),
                },
              });
            }

            Sentry.captureMessage('Reconciliation: ORPHANED HOLD detected', {
              level: 'error',
              extra: orphanDetail,
            });

            logStructured({
              category: 'invariant_violation',
              action: 'reconciliation_orphan_detected',
              holdId: hold.id,
              eventId: event.id,
              userId: hold.userId,
              seatCount: hold.seatCount,
            });
          }
        } catch (eventErr: unknown) {
          // Fault isolation: one failing DO instance must not abort reconciliation for remaining events
          console.error(`[reconciliation] Failed to reconcile event ${event.id}:`, eventErr);
          Sentry.captureException(eventErr, {
            extra: { eventId: event.id, action: 'event_reconciliation_failure' },
          });
        }
      })
    );
  }

  return {
    checkedEvents: events.length,
    confirmedHoldsInspected,
    orphansDetected,
  };
}

