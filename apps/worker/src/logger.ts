export interface StructuredLogPayload {
  category: 'rate_limit_rejection' | 'invariant_violation';
  action: string;
  userId?: string;
  keyType?: 'ip' | 'userId' | 'orgId' | 'apiKey';
  orgId?: string;
  holdId?: string;
  eventId?: string;
  reason?: string;
  expectedPence?: number;
  receivedPence?: number;
  seatCount?: number;
  [key: string]: unknown;
}

/**
 * Emits a structured JSON log line via console.log for Workers Logs and Logpush capture.
 */
export function logStructured(payload: StructuredLogPayload): void {
  try {
    console.log({ ts: Date.now(), ...payload });
  } catch {
    // Prevent logging failures from breaking application execution
  }
}
