# Security Checklist

Derived from a real security sweep of this codebase. Each entry names a problem class, says what it looks like in code, how to spot it, and what to do instead. Written so it transfers to a different codebase.

---

## 1. Client-supplied values that the server can compute

**What it looks like**

A client sends a value (quantity, price, count) and the server uses it to drive a side-effect — charging Stripe, allocating seats — rather than recomputing it from server-owned state.

```ts
// vulnerable: seatCount comes from the client
const session = await stripe.checkout.sessions.create({
  line_items: [{ price: priceId, quantity: input.seatCount }],
});

// safe: seatCount is derived from the server's hold record
const hold = await seatLedger.getHold(input.holdId);
const session = await stripe.checkout.sessions.create({
  line_items: [{ price: priceId, quantity: hold.seatCount }],
});
```

**How to spot it**

- Grep for fields like `quantity`, `amount`, `price`, `count`, `role`, `orgId` appearing in both the input schema (Zod, JSON body) and outbound API calls or DB writes.
- Ask: "If a client sent `1` for this field when the real answer is `10`, what happens?"

**How to avoid it**

Never accept a value from a client that the server already knows or can derive. If the value lives in your DB or a Durable Object, look it up; don't trust the client's copy. Add a server-side re-check (e.g., `amount_received` vs `pricePerSeat × seatCount`) as a tripwire for future regressions.

---

## 2. Missing indexes on filtered columns

**What it looks like**

A column is queried in a `WHERE` clause or used as a join key, but has no index. Meanwhile, another column has an index that is never queried.

```sql
-- two live query sites filter on hold_id, no index existed
SELECT id FROM bookings WHERE hold_id = ?

-- stripe_payment_intent_id had an index; grepping the codebase confirmed
-- it was never actually queried by that column
```

**How to spot it**

- Take every `WHERE` clause across the codebase and verify each filtered column has an index in the schema.
- Take every indexed column and verify it actually appears in a `WHERE` clause somewhere. Indexes that match no query are maintenance cost with no benefit.
- Run `EXPLAIN QUERY PLAN` locally on the real queries.

**How to avoid it**

Define indexes alongside queries, not as an afterthought. When a query is added or deleted, update indexes in the same PR. Comment each index with the query or query site it exists for — comments survive; implicit "someone must have had a reason" reasoning does not.

---

## 3. Unbounded or unauthenticated endpoints

**What it looks like**

- A public endpoint that hits an expensive resource (Durable Object, external API) on every call, with no rate limit and no authentication requirement.
- An authenticated endpoint that accepts any authenticated user, where only a subset of users (e.g., org admins) should be able to call it.
- A rate limiter keyed on `userId` applied to an endpoint that anonymous traffic can reach — anonymous requests have no `userId` and bypass the limit entirely.

**How to spot it**

- List every public (unauthenticated) procedure and trace what it touches. Does it hit a DO? An external API? A D1 query across all rows?
- Grep for rate-limit middleware; check whether the key used (`userId`, `orgId`, IP) actually applies to the traffic that reaches that endpoint.
- Check every mutating procedure: does it verify the caller's role, not just their identity?

**How to avoid it**

- Apply rate limits before authentication checks; use IP (from a trusted header like `CF-Connecting-IP`) for anonymous traffic.
- Match the rate-limit key to the threat: per-user for user-abuse, per-IP for anonymous endpoints, per-org for org-level resources.
- Default to the most restrictive role that still makes the feature usable. Add a test that asserts lower-role callers are rejected.

---

## 4. Error messages leaking internal detail

**What it looks like**

A `catch` block forwards the raw exception message to the client, either directly or via a generic error-formatting layer that strips stack traces but not messages.

```ts
// vulnerable: raw DB/library error message reaches the client
} catch (err) {
  throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: err.message });
}

// safe: log the detail, return a generic message
} catch (err) {
  console.error('ensureAttendee failed:', err);
  Sentry.captureException(err);
  throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'Failed to look up attendee' });
}
```

**How to spot it**

- Grep for `err.message` or `error.message` inside `catch` blocks that also throw or return a response. Check whether that message reaches the client.
- Check your error formatter: does it strip stacks but pass `message` through? If so, every `err.message` forwarded in a `TRPCError` or `Response` is client-visible.
- Look for deliberately curated error strings (e.g., `"Only N seats available"`) and distinguish them from raw exception messages — both patterns may appear in the same codebase.

**How to avoid it**

Log the real error server-side. Return a generic, fixed message to the client. Use an error-tracking service (Sentry, etc.) so the detail isn't lost. Treat "log the detail, return a generic message" as the default; treat "return the real message" as a deliberate, audited decision.

---

## 5. DO/D1 non-atomicity and reconciliation gaps

**What it looks like**

A flow spans two storage systems (e.g., Durable Object state and a relational DB). The first write succeeds; the process crashes or returns an error before the second write. On retry, the first write is already consumed — the idempotency check returns "already done" and the caller returns success, but the second write (a booking row, an email, an audit record) never happened.

```
DO.confirmSeat(holdId)      ← succeeds, hold is now consumed
D1 bookings.insert(...)     ← throws; process crashes
--- Stripe retries ---
DO.confirmSeat(holdId)      ← throws HOLD_ALREADY_USED
caller returns 200          ← appears healthy; booking never written
```

**How to spot it**

- Find every flow that writes to more than one storage system in sequence with no rollback.
- For each, ask: "If step N succeeds and step N+1 fails, what does a retry see?" If the retry can return success without completing the remaining steps, you have a silent data gap.
- Search for idempotency checks (`HOLD_ALREADY_USED`, `onConflictDoNothing`, etc.) and trace what happens in the branch that returns "already done" — does it verify the downstream write actually exists?

**How to avoid it**

- Make the "already done" branch verify the downstream record exists, not just that the upstream state was consumed.
- Return a loud failure (`500`) if the upstream is consumed but the downstream is missing — do not silently `200`.
- Build a reconciliation job that cross-checks the two systems periodically. Accept that detection latency exists (cron interval + grace filter); design the alerting accordingly.
- Document the gap explicitly in code comments. An orphaned state that's detectable and loud is far better than one that's invisible.

---

## 6. Audit-write failure isolation

**What it looks like**

An audit log insert is placed inline in a critical path (e.g., a payment webhook) without its own error boundary. If the audit write fails, the exception propagates and causes the webhook to return a non-200 response. The external caller (Stripe, etc.) retries. On retry, the critical path finds the operation already completed and returns success — but the integrations block (email, calendar invite) that only runs in the "just completed" branch never fires.

```
audit_log.insert(...)     ← throws (e.g. D1 overloaded)
webhook returns 500
Stripe retries
confirmSeat → HOLD_ALREADY_USED → returns 200
email/calendar never dispatched; looks healthy
```

**How to spot it**

- Find every `db.insert(auditLog)` (or equivalent) call that is not wrapped in its own `try/catch`.
- Check whether the surrounding function has a top-level catch that turns the exception into a non-2xx response.
- Trace what a retry of that outer operation looks like: does it re-run the integrations/notifications block, or only the idempotency branch?

**How to avoid it**

Wrap every audit-log write in its own `try/catch`. On failure: log to console, capture to your error tracker at `warning` level with relevant IDs in context, and continue — do not let it affect the caller's return value. An audit record is observability infrastructure; it must never be the reason a business-critical operation fails or silently skips downstream steps. Match the swallow-and-continue pattern already used for integration dispatch at the same call site.
