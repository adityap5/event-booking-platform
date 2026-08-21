import { drizzle } from 'drizzle-orm/d1';
import { eq } from 'drizzle-orm';
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
 * On detecting an orphan:
 * - Recovers hold details via DO getHold(holdId)
 * - Writes an audit_log row (eventType: 'reconciliation_orphan_detected')
 * - Emits a Sentry alert with level 'error'
 * - Emits a structured log
 * - DOES NOT write a booking row (alert-only by explicit design)
 */
export async function runReconciliation(env: Env): Promise<ReconciliationSummary> {
  const db = drizzle(env.DB, { schema });
  const events = await db
    .select({
      id: schema.events.id,
      organisationId: schema.events.organisationId,
    })
    .from(schema.events);

  let confirmedHoldsInspected = 0;
  let orphansDetected = 0;

  for (const event of events) {
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
  }

  return {
    checkedEvents: events.length,
    confirmedHoldsInspected,
    orphansDetected,
  };
}

