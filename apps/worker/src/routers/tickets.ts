import { z } from 'zod';
import * as schema from '@event-booking/shared';
import { events, attendees } from '@event-booking/shared';
import { eq } from 'drizzle-orm';
import { TRPCError } from '@trpc/server';
import { requireOrganiserRole } from '@event-booking/permissions';
import { workerProcedure } from '../procedures.js';
import { generateTicketPdf } from '../ticket-pdf.js';
import * as Sentry from '@sentry/cloudflare';

export const ticketsRouter = {
  /**
   * getTicket — returns a confirmed booking's PDF ticket as a base64 string.
   *
   * Authorization: the caller must be either:
   *   (a) the attendee who owns the booking (userId match), or
   *   (b) an organiser of the event's organisation, verified via
   *       requireOrganiserRole('organiser') + explicit org-ID comparison.
   *       requireOrganiserRole is used (not authorizeOrganiserAccess alone) because
   *       the latter checks org membership but does not enforce the organiser role.
   *
   * Lazy fallback: if the R2 object is absent (webhook-time generation failed, or
   * a pre-existing booking), the ticket is generated on demand, stored, and returned.
   *
   * Only confirmed bookings produce a ticket; pending/cancelled return NOT_FOUND.
   */
  getTicket: workerProcedure
    .input(z.object({ bookingId: z.string().min(1) }))
    .query(async ({ input, ctx }) => {
      const db = ctx.db;
      const { bookingId } = input;

      // ── Fetch booking + attendee + event in one join ─────────────────────────
      const [row] = await db
        .select({
          bookingStatus: schema.bookings.status,
          bookingSeatCount: schema.bookings.seatCount,
          attendeeUserId: attendees.userId,
          attendeeName: attendees.name,
          eventName: events.name,
          eventDate: events.date,
          eventOrgId: events.organisationId,
        })
        .from(schema.bookings)
        .innerJoin(attendees, eq(schema.bookings.attendeeId, attendees.id))
        .innerJoin(events, eq(schema.bookings.eventId, events.id))
        .where(eq(schema.bookings.id, bookingId));

      if (!row) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Booking not found' });
      }

      // ── Status guard: only confirmed bookings have tickets ───────────────────
      if (row.bookingStatus !== 'confirmed') {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'No ticket available for this booking' });
      }

      // ── Authorization ────────────────────────────────────────────────────────
      // Path A: the caller is the booking's own attendee.
      const isOwnAttendee = ctx.userId === row.attendeeUserId;

      if (!isOwnAttendee) {
        // Path B: the caller is an organiser of the event's organisation.
        // requireOrganiserRole checks both orgId presence AND role === 'organiser'.
        // The explicit org-ID comparison below additionally rejects organisers from
        // other organisations.
        let callerOrgId: string;
        try {
          callerOrgId = requireOrganiserRole(
            { userId: ctx.userId, orgId: ctx.orgId, role: ctx.role },
            'organiser',
          );
        } catch {
          // requireOrganiserRole threw FORBIDDEN (no orgId or wrong role).
          // Re-throw as FORBIDDEN so the error code is correct.
          throw new TRPCError({
            code: 'FORBIDDEN',
            message: 'You do not have permission to access this ticket.',
          });
        }
        if (callerOrgId !== row.eventOrgId) {
          throw new TRPCError({
            code: 'FORBIDDEN',
            message: 'You do not have permission to access this ticket.',
          });
        }
      }

      // ── R2 fetch ─────────────────────────────────────────────────────────────
      const r2Key = `tickets/${bookingId}.pdf`;
      const existing = await ctx.env.EVENT_TICKETS.get(r2Key);

      if (existing !== null) {
        // Happy path: ticket already exists in R2.
        const bytes = new Uint8Array(await existing.arrayBuffer());
        return {
          pdf: uint8ArrayToBase64(bytes),
          filename: `ticket-${bookingId}.pdf`,
        };
      }

      // ── Lazy generation ──────────────────────────────────────────────────────
      // The R2 object is absent (webhook-time generation failed, or this is a
      // booking that pre-dates this feature). Generate now, upload, and return.
      let pdfBytes: Uint8Array;
      try {
        const eventDateMs = row.eventDate instanceof Date
          ? row.eventDate.getTime()
          : Number(row.eventDate);

        pdfBytes = await generateTicketPdf({
          attendeeName: row.attendeeName,
          eventName: row.eventName,
          eventDate: eventDateMs,
          seatCount: row.bookingSeatCount,
          bookingId,
        });

        // Upload to R2 so future fetches are instant.
        await ctx.env.EVENT_TICKETS.put(r2Key, pdfBytes, {
          httpMetadata: { contentType: 'application/pdf' },
        });
      } catch (lazyErr: unknown) {
        // Log internally; never expose R2/PDF exception details to the client.
        console.error('[TICKET] Lazy PDF generation failed:', lazyErr);
        Sentry.captureException(
          lazyErr instanceof Error ? lazyErr : new Error(String(lazyErr)),
          { extra: { bookingId } },
        );
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Unable to generate ticket. Please try again later.',
        });
      }

      return {
        pdf: uint8ArrayToBase64(pdfBytes),
        filename: `ticket-${bookingId}.pdf`,
      };
    }),
};

/**
 * Converts a Uint8Array to a base64 string using Workers-native btoa.
 * Avoids any dependency on Node.js Buffer in Workers runtime.
 */
function uint8ArrayToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunkSize = 0x8000;

  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(
      ...bytes.subarray(i, i + chunkSize),
    );
  }

  return btoa(binary);
}
