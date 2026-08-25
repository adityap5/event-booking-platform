import { z } from 'zod';
import * as schema from '@event-booking/shared';
import { events } from '@event-booking/shared';
import { eq, and } from 'drizzle-orm';
import Stripe from 'stripe';
import { TRPCError } from '@trpc/server';
import { requireOrganiserRole, authorizeOrganiserAccess } from '@event-booking/permissions';
import { workerProcedure } from '../procedures.js';
import * as Sentry from '@sentry/cloudflare';

export const refundsRouter = {
  /**
   * refundBooking — organiser-initiated full refund for a confirmed booking.
   *
   * State Machine & Invariant Guarantees:
   * 1. Full refund only — returns all reserved seats back to DO availability without manual counters.
   * 2. Authorisation is enforced before any Stripe interaction can occur.
   * 3. Order of operations: Stripe refund → DO refundSeat() → D1 status update → audit log.
   * 4. Idempotency: Uses deterministic Stripe idempotency key `refund_${bookingId}`.
   * 5. Recovery: If Stripe reports `charge_already_refunded`, verifies PaymentIntent and full refund
   *    amount before reconciling local DO/D1 state.
   * 6. Failure isolation: If DO or D1 fails after Stripe money movement succeeds, the mutation returns
   *    success to the organiser (preventing double-refund retries) and alerts Sentry at error level.
   *
   * Ownership Boundary:
   * - DO owns: seat reservation state, the 'confirmed' → 'refunded' transition, live availability computation,
   *   and broadcasting updated seat count to connected WebSocket clients.
   * - D1 owns: the durable booking/business record and organiser history status.
   */
  refundBooking: workerProcedure
    .input(z.object({ bookingId: z.string().min(1) }))
    .mutation(async ({ input, ctx }) => {
      // ── 1. Fetch booking with event details ──────────────────────────────────
      const [bookingRow] = await ctx.db
        .select({
          bookingId: schema.bookings.id,
          holdId: schema.bookings.holdId,
          eventId: schema.bookings.eventId,
          eventOrgId: events.organisationId,
          stripePaymentIntentId: schema.bookings.stripePaymentIntentId,
          seatCount: schema.bookings.seatCount,
          bookingStatus: schema.bookings.status,
        })
        .from(schema.bookings)
        .innerJoin(events, eq(schema.bookings.eventId, events.id))
        .where(eq(schema.bookings.id, input.bookingId));

      // ── 2. Existence check ───────────────────────────────────────────────────
      if (!bookingRow) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Booking not found' });
      }

      // ── 3. Authorization (Must happen before any Stripe interaction) ────────
      requireOrganiserRole(ctx, 'organiser');
      authorizeOrganiserAccess(ctx, bookingRow.eventOrgId);

      // ── 4. Booking status validation (internally distinguishable errors) ─────
      if (bookingRow.bookingStatus === 'refunded') {
        throw new TRPCError({
          code: 'CONFLICT',
          message: 'Booking has already been refunded',
        });
      }
      if (bookingRow.bookingStatus === 'pending') {
        throw new TRPCError({
          code: 'CONFLICT',
          message: 'Cannot refund a pending reservation',
        });
      }
      if (bookingRow.bookingStatus === 'cancelled') {
        throw new TRPCError({
          code: 'CONFLICT',
          message: 'Cannot refund a cancelled booking',
        });
      }
      if (bookingRow.bookingStatus !== 'confirmed') {
        throw new TRPCError({
          code: 'CONFLICT',
          message: 'Only confirmed bookings can be refunded',
        });
      }

      // ── 5. Verify Stripe PaymentIntent ID is present ────────────────────────
      if (!bookingRow.stripePaymentIntentId) {
        console.error('[refundBooking] Confirmed booking missing stripePaymentIntentId:', bookingRow.bookingId);
        Sentry.captureMessage('Confirmed booking missing stripePaymentIntentId', {
          level: 'error',
          extra: {
            bookingId: bookingRow.bookingId,
            eventId: bookingRow.eventId,
            holdId: bookingRow.holdId,
          },
        });
        throw new TRPCError({
          code: 'PRECONDITION_FAILED',
          message: 'Booking cannot be refunded due to missing payment reference',
        });
      }

      // ── 6. Stripe refund execution with deterministic idempotency key ───────
      const stripe = new Stripe(ctx.env.STRIPE_SECRET_KEY, {
        httpClient: Stripe.createFetchHttpClient(),
      });

      let stripeRefundId: string;
      const idempotencyKey = `refund_${bookingRow.bookingId}`;

      try {
        const refund = await stripe.refunds.create(
          { payment_intent: bookingRow.stripePaymentIntentId },
          { idempotencyKey },
        );
        stripeRefundId = refund.id;
      } catch (err: unknown) {
        // Structured error detection: only match verified structured Stripe error type/code
        const isChargeAlreadyRefunded =
          (err instanceof Stripe.errors.StripeInvalidRequestError ||
           (typeof err === 'object' && err !== null && 'code' in err)) &&
          ((err as { code?: string }).code === 'charge_already_refunded');

        if (!isChargeAlreadyRefunded) {
          console.error('[refundBooking] Stripe refund creation failed:', err);
          throw new TRPCError({
            code: 'INTERNAL_SERVER_ERROR',
            message: 'Failed to process refund with Stripe',
            cause: err,
          });
        }

        // ── 7. Already-refunded recovery path ──────────────────────────────────
        // Retrieve PaymentIntent and inspect aggregate successful refunds across all pages
        let paymentIntent: Stripe.PaymentIntent;
        try {
          paymentIntent = await stripe.paymentIntents.retrieve(bookingRow.stripePaymentIntentId);
        } catch (piErr) {
          console.error('[refundBooking] Failed to retrieve PaymentIntent during recovery:', piErr);
          Sentry.captureException(piErr, {
            extra: {
              bookingId: bookingRow.bookingId,
              stripePaymentIntentId: bookingRow.stripePaymentIntentId,
            },
          });
          throw new TRPCError({
            code: 'INTERNAL_SERVER_ERROR',
            message: 'Failed to verify existing refund status',
            cause: piErr,
          });
        }

        const allRefunds: Stripe.Refund[] = [];
        let hasMore = true;
        let startingAfter: string | undefined = undefined;

        try {
          while (hasMore) {
            const listParams: Stripe.RefundListParams = {
              payment_intent: bookingRow.stripePaymentIntentId,
              limit: 100,
            };
            if (startingAfter) {
              listParams.starting_after = startingAfter;
            }
            const page = await stripe.refunds.list(listParams);
            allRefunds.push(...page.data);
            hasMore = page.has_more;
            if (page.data.length > 0) {
              startingAfter = page.data[page.data.length - 1]!.id;
            } else {
              hasMore = false;
            }
          }
        } catch (listErr) {
          console.error('[refundBooking] Failed to list refunds during recovery:', listErr);
          Sentry.captureException(listErr, {
            extra: {
              bookingId: bookingRow.bookingId,
              stripePaymentIntentId: bookingRow.stripePaymentIntentId,
            },
          });
          throw new TRPCError({
            code: 'INTERNAL_SERVER_ERROR',
            message: 'Failed to verify existing refund details',
            cause: listErr,
          });
        }

        const expectedAmount = paymentIntent.amount_received;
        let totalSucceededRefundAmount = 0;
        let verifiedRefundId: string | null = null;
        let hasMismatchedPaymentIntent = false;
        let hasNonSucceededRefund = false;

        for (const r of allRefunds) {
          const piId = typeof r.payment_intent === 'string' ? r.payment_intent : r.payment_intent?.id;
          if (piId !== bookingRow.stripePaymentIntentId) {
            hasMismatchedPaymentIntent = true;
          }
          if (r.status === 'succeeded') {
            totalSucceededRefundAmount += r.amount;
            if (!verifiedRefundId) {
              verifiedRefundId = r.id;
            }
          } else {
            hasNonSucceededRefund = true;
          }
        }

        const isVerifiedFullRefund =
          !hasMismatchedPaymentIntent &&
          !hasNonSucceededRefund &&
          expectedAmount > 0 &&
          totalSucceededRefundAmount === expectedAmount &&
          verifiedRefundId !== null;

        if (!isVerifiedFullRefund || !verifiedRefundId) {
          console.error('[refundBooking] Could not verify full prior refund:', {
            bookingId: bookingRow.bookingId,
            stripePaymentIntentId: bookingRow.stripePaymentIntentId,
            expectedAmount,
            totalSucceededRefundAmount,
            hasMismatchedPaymentIntent,
            hasNonSucceededRefund,
            refundCount: allRefunds.length,
          });
          Sentry.captureMessage('Unverified already-refunded recovery state', {
            level: 'error',
            extra: {
              bookingId: bookingRow.bookingId,
              stripePaymentIntentId: bookingRow.stripePaymentIntentId,
              expectedAmount,
              totalSucceededRefundAmount,
              hasMismatchedPaymentIntent,
              hasNonSucceededRefund,
              refundCount: allRefunds.length,
            },
          });
          throw new TRPCError({
            code: 'INTERNAL_SERVER_ERROR',
            message: 'Existing refund could not be verified as a full refund',
          });
        }

        stripeRefundId = verifiedRefundId;
      }

      // ── 8. DO Seat Release Step ──────────────────────────────────────────────
      if (bookingRow.holdId) {
        try {
          const stub = ctx.env.SEAT_LEDGER.get(ctx.env.SEAT_LEDGER.idFromName(bookingRow.eventId));
          await stub.refundSeat(bookingRow.holdId);
        } catch (doErr: unknown) {
          const msg = doErr instanceof Error ? doErr.message : String(doErr);
          if (msg !== 'HOLD_ALREADY_REFUNDED') {
            console.error('[refundBooking] Unexpected DO refundSeat error after Stripe success:', doErr);
            Sentry.captureException(doErr, {
              level: 'error',
              extra: {
                step: 'DO_REFUND_SEAT',
                bookingId: bookingRow.bookingId,
                holdId: bookingRow.holdId,
                eventId: bookingRow.eventId,
                stripePaymentIntentId: bookingRow.stripePaymentIntentId,
                stripeRefundId,
              },
            });
            // Still return success to organiser because Stripe has genuinely refunded
            return { success: true, bookingId: bookingRow.bookingId };
          }
        }
      }

      // ── 9. Conditional D1 Update Step ────────────────────────────────────────
      let updatedRow: { id: string } | undefined;
      try {
        const [updated] = await ctx.db
          .update(schema.bookings)
          .set({ status: 'refunded' })
          .where(
            and(
              eq(schema.bookings.id, bookingRow.bookingId),
              eq(schema.bookings.status, 'confirmed'),
            ),
          )
          .returning({ id: schema.bookings.id });
        updatedRow = updated;
      } catch (d1Err: unknown) {
        console.error('[refundBooking] Unexpected D1 update error after Stripe success:', d1Err);
        Sentry.captureException(d1Err, {
          level: 'error',
          extra: {
            step: 'D1_STATUS_UPDATE',
            bookingId: bookingRow.bookingId,
            holdId: bookingRow.holdId,
            eventId: bookingRow.eventId,
            stripePaymentIntentId: bookingRow.stripePaymentIntentId,
            stripeRefundId,
          },
        });
        return { success: true, bookingId: bookingRow.bookingId };
      }

      let wonD1Transition = false;

      if (updatedRow) {
        wonD1Transition = true;
      } else {
        // 0 rows updated — re-read booking to confirm status is actually 'refunded'
        try {
          const [currentBooking] = await ctx.db
            .select({ status: schema.bookings.status })
            .from(schema.bookings)
            .where(eq(schema.bookings.id, bookingRow.bookingId));

          if (currentBooking && currentBooking.status === 'refunded') {
            wonD1Transition = false;
          } else {
            console.error('[refundBooking] D1 update affected 0 rows and status is NOT refunded:', currentBooking?.status);
            Sentry.captureMessage('D1 conditional update affected 0 rows with non-refunded status', {
              level: 'error',
              extra: {
                step: 'D1_ZERO_ROWS_INCONSISTENCY',
                bookingId: bookingRow.bookingId,
                holdId: bookingRow.holdId,
                eventId: bookingRow.eventId,
                stripePaymentIntentId: bookingRow.stripePaymentIntentId,
                stripeRefundId,
                observedStatus: currentBooking?.status,
              },
            });
          }
        } catch (reReadErr) {
          console.error('[refundBooking] Failed to re-read booking after 0-row update:', reReadErr);
          Sentry.captureException(reReadErr, {
            level: 'error',
            extra: {
              step: 'D1_RE_READ_FAILURE',
              bookingId: bookingRow.bookingId,
              stripeRefundId,
            },
          });
        }
      }

      // ── 10. Audit Log Write Step (Only if won D1 transition) ───────────────────
      if (wonD1Transition) {
        try {
          await ctx.db.insert(schema.auditLog).values({
            eventType: 'booking_refunded',
            holdId: bookingRow.holdId,
            bookingEventId: bookingRow.eventId,
            userId: ctx.userId,
            orgId: bookingRow.eventOrgId,
            detail: JSON.stringify({
              bookingId: bookingRow.bookingId,
              eventId: bookingRow.eventId,
              holdId: bookingRow.holdId,
              stripeRefundId,
              seatCount: bookingRow.seatCount,
              stripePaymentIntentId: bookingRow.stripePaymentIntentId,
            }),
          });
        } catch (auditErr: unknown) {
          console.error('Failed to write audit_log for booking_refunded:', auditErr);
          Sentry.captureMessage('Failed to write audit_log for booking_refunded', {
            level: 'warning',
            extra: {
              bookingId: bookingRow.bookingId,
              eventId: bookingRow.eventId,
              holdId: bookingRow.holdId,
              stripeRefundId,
              error: auditErr instanceof Error ? auditErr.message : String(auditErr),
            },
          });
        }
      }

      return { success: true, bookingId: bookingRow.bookingId };
    }),
};
