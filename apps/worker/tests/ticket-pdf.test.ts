/**
 * ticket-pdf.test.ts — Pure unit tests for the PDF generation function.
 *
 * No Miniflare, no R2, no D1. The function is pure so these tests run in the
 * same V8 isolate as the rest of the Cloudflare test pool without any special setup.
 */

import { describe, it, expect } from 'vitest';
import { generateTicketPdf } from '../src/ticket-pdf.js';
import { PDFDocument } from 'pdf-lib';

const SAMPLE_TICKET = {
  attendeeName: 'Alice Attendee',
  eventName: 'Summer Tech Conference 2026',
  eventDate: new Date('2026-07-15T18:00:00Z').getTime(),
  seatCount: 2,
  bookingId: '550e8400-e29b-41d4-a716-446655440000',
};

describe('generateTicketPdf', () => {
  it('returns a non-empty Uint8Array for valid input', async () => {
    const bytes = await generateTicketPdf(SAMPLE_TICKET);
    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(bytes.length).toBeGreaterThan(0);
  });

  it('produces parseable PDF bytes (PDFDocument.load succeeds)', async () => {
    const bytes = await generateTicketPdf(SAMPLE_TICKET);
    // PDFDocument.load() throws if the bytes are not a valid PDF.
    // This is the correct parsability gate per review feedback.
    await expect(PDFDocument.load(bytes)).resolves.not.toThrow();
  });

  it('produces a PDF with exactly one page', async () => {
    const bytes = await generateTicketPdf(SAMPLE_TICKET);
    const loaded = await PDFDocument.load(bytes);
    expect(loaded.getPageCount()).toBe(1);
  });

  it('handles a seatCount of 1 without error', async () => {
    const bytes = await generateTicketPdf({ ...SAMPLE_TICKET, seatCount: 1 });
    await expect(PDFDocument.load(bytes)).resolves.not.toThrow();
  });

  it('sanitizes control characters in attendee name without throwing', async () => {
    const bytes = await generateTicketPdf({
      ...SAMPLE_TICKET,
      attendeeName: 'Bob\x00\x1F\x7FMalicious',
    });
    await expect(PDFDocument.load(bytes)).resolves.not.toThrow();
  });

  it('sanitizes control characters in event name without throwing', async () => {
    const bytes = await generateTicketPdf({
      ...SAMPLE_TICKET,
      eventName: '\x01\x02Evil\x03Event\x04',
    });
    await expect(PDFDocument.load(bytes)).resolves.not.toThrow();
  });

  it('truncates extremely long strings without throwing', async () => {
    const longString = 'A'.repeat(500);
    const bytes = await generateTicketPdf({
      ...SAMPLE_TICKET,
      attendeeName: longString,
      eventName: longString,
    });
    await expect(PDFDocument.load(bytes)).resolves.not.toThrow();
  });

  it('handles a zero-epoch eventDate (Unix epoch) without throwing', async () => {
    const bytes = await generateTicketPdf({ ...SAMPLE_TICKET, eventDate: 0 });
    await expect(PDFDocument.load(bytes)).resolves.not.toThrow();
  });
});
