/**
 * ticket-pdf.ts — Pure PDF ticket generation.
 *
 * Design rules:
 *   - No R2, D1, or Worker bindings. Data in → Uint8Array out.
 *   - All string inputs are sanitized before PDF rendering.
 *   - Uses only Helvetica/Helvetica-Bold (StandardFonts) — no external font fetch.
 *   - No QR code or machine-readable content; informational-only for Day 8.
 *
 * Compatible with Cloudflare Workers V8 isolates: pdf-lib and all its transitive
 * dependencies (pako, @pdf-lib/standard-fonts, @pdf-lib/upng, tslib) are pure JS
 * with no Node.js fs/path/Buffer/canvas dependencies.
 */

import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';

export interface TicketData {
  attendeeName: string;
  eventName: string;
  /** Unix timestamp in milliseconds. */
  eventDate: number;
  seatCount: number;
  /** D1 booking row UUID — used as a reference number on the ticket. */
  bookingId: string;
}

/**
 * Maximum rendered length for user-supplied strings on the ticket.
 * Values exceeding this are truncated to prevent layout overflow.
 */
const MAX_STRING_LENGTH = 120;

/**
 * Strips control characters from a user-supplied string.
 * The library renders text by value, not by interpreting it as markup,
 * so there's no script-injection risk — but removing control chars prevents
 * unexpected glyph substitutions and layout breakage.
 */
function sanitize(value: string): string {
  // Remove all ASCII control characters (0x00–0x1F, 0x7F)
  // eslint-disable-next-line no-control-regex
  const cleaned = value.replace(/[\x00-\x1F\x7F]/g, ' ').trim();
  return cleaned.length > MAX_STRING_LENGTH
    ? cleaned.slice(0, MAX_STRING_LENGTH) + '\u2026'
    : cleaned;
}

/**
 * Formats an event date timestamp for display on the ticket.
 * Uses a fixed, unambiguous format: "Mon, 15 January 2024 at 19:30 UTC".
 */
function formatEventDate(timestampMs: number): string {
  try {
    return new Date(timestampMs).toLocaleString('en-GB', {
      weekday: 'short',
      day: 'numeric',
      month: 'long',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      timeZone: 'UTC',
      timeZoneName: 'short',
    });
  } catch {
    // Defensive: fall back to ISO string which is always safe
    return new Date(timestampMs).toISOString();
  }
}

/**
 * Generates a PDF ticket for a confirmed booking.
 * Returns raw PDF bytes as a Uint8Array.
 *
 * This function is deliberately pure — no side effects, no external I/O —
 * so it can be unit-tested without Miniflare, R2, or D1.
 */
export async function generateTicketPdf(data: TicketData): Promise<Uint8Array> {
  const { attendeeName, eventName, eventDate, seatCount, bookingId } = data;

  const doc = await PDFDocument.create();
  const page = doc.addPage([595, 420]); // A5 landscape in points

  const fontRegular = await doc.embedFont(StandardFonts.Helvetica);
  const fontBold = await doc.embedFont(StandardFonts.HelveticaBold);

  const { width, height } = page.getSize();

  // ── Colour palette ──────────────────────────────────────────────────────────
  const deepNavy = rgb(0.06, 0.1, 0.24);   // #0F1A3D
  const gold = rgb(0.9, 0.72, 0.2);        // #E6B833
  const white = rgb(1, 1, 1);
  const lightGrey = rgb(0.92, 0.92, 0.92);
  const darkGrey = rgb(0.35, 0.35, 0.35);

  // ── Background ──────────────────────────────────────────────────────────────
  page.drawRectangle({ x: 0, y: 0, width, height, color: deepNavy });

  // ── Header accent bar ────────────────────────────────────────────────────────
  page.drawRectangle({ x: 0, y: height - 60, width, height: 60, color: gold });

  // ── Header: "EVENT TICKET" ───────────────────────────────────────────────────
  const headerText = 'EVENT TICKET';
  const headerSize = 22;
  const headerWidth = fontBold.widthOfTextAtSize(headerText, headerSize);
  page.drawText(headerText, {
    x: (width - headerWidth) / 2,
    y: height - 42,
    size: headerSize,
    font: fontBold,
    color: deepNavy,
  });

  // ── Tear-off divider (dotted line) ──────────────────────────────────────────
  const dividerY = height - 68;
  for (let x = 20; x < width - 20; x += 8) {
    page.drawLine({
      start: { x, y: dividerY },
      end: { x: x + 4, y: dividerY },
      thickness: 1,
      color: lightGrey,
      opacity: 0.4,
    });
  }

  // ── Field layout ────────────────────────────────────────────────────────────
  const leftMargin = 40;
  const labelSize = 9;
  const valueSize = 14;
  const lineGap = 38;
  let currentY = height - 100;

  const fields: Array<{ label: string; value: string }> = [
    { label: 'EVENT', value: sanitize(eventName) },
    { label: 'DATE', value: formatEventDate(eventDate) },
    { label: 'ATTENDEE', value: sanitize(attendeeName) },
    { label: 'SEATS', value: String(seatCount) },
  ];

  for (const { label, value } of fields) {
    page.drawText(label, {
      x: leftMargin,
      y: currentY + 16,
      size: labelSize,
      font: fontRegular,
      color: gold,
      opacity: 0.85,
    });

    // Clamp value to page width to prevent layout overflow
    const maxValueWidth = width - leftMargin * 2;
    let displayValue = value;
    while (
      fontBold.widthOfTextAtSize(displayValue, valueSize) > maxValueWidth &&
      displayValue.length > 1
    ) {
      displayValue = displayValue.slice(0, -2) + '\u2026';
    }

    page.drawText(displayValue, {
      x: leftMargin,
      y: currentY,
      size: valueSize,
      font: fontBold,
      color: white,
    });

    page.drawLine({
      start: { x: leftMargin, y: currentY - 8 },
      end: { x: width - leftMargin, y: currentY - 8 },
      thickness: 0.5,
      color: lightGrey,
      opacity: 0.2,
    });

    currentY -= lineGap;
  }

  // ── Booking reference (bottom) ───────────────────────────────────────────────
  const refY = 28;
  page.drawText('BOOKING REF', {
    x: leftMargin,
    y: refY + 12,
    size: 7,
    font: fontRegular,
    color: gold,
    opacity: 0.7,
  });

  page.drawText(sanitize(bookingId).toUpperCase(), {
    x: leftMargin,
    y: refY,
    size: 9,
    font: fontRegular,
    color: darkGrey,
  });

  // ── Right-side accent strip ──────────────────────────────────────────────────
  page.drawRectangle({ x: width - 12, y: 0, width: 12, height, color: gold, opacity: 0.6 });

  return doc.save();
}
