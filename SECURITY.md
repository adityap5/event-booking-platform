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

---

## 7. Authorization must run before any state disclosure, not after

**What it looks like**

An endpoint fetches a resource, evaluates an internal lifecycle or status condition, and returns an early error before verifying whether the caller is authorized to view or mutate the resource.

```ts
// vulnerable (the getTicket incident): status check runs before ownership check
const [booking] = await db.select().from(bookings).where(eq(bookings.id, input.bookingId));
if (!booking) throw new TRPCError({ code: 'NOT_FOUND', message: 'Booking not found' });

if (booking.status !== 'confirmed') {
  throw new TRPCError({ code: 'NOT_FOUND', message: 'No ticket available' });
}

if (booking.userId !== ctx.userId && !isOrgAdmin(ctx, booking.orgId)) {
  throw new TRPCError({ code: 'FORBIDDEN' });
}
```

In the vulnerable pattern, an unauthorized caller probing random UUIDs receives `NOT_FOUND` ("No ticket available") if the booking is pending or cancelled, but receives `FORBIDDEN` if the booking is confirmed. The status check acts as an oracle, leaking internal business state to unauthorized parties.

```ts
// safe (apps/worker/src/routers/tickets.ts:53-94): authorization precedes all status guards
const [booking] = await db.select().from(bookings).where(eq(bookings.id, input.bookingId));
if (!booking) throw new TRPCError({ code: 'NOT_FOUND', message: 'Booking not found' });

// 1. Authorization runs first
const isOwnAttendee = ctx.userId === booking.attendeeUserId;
if (!isOwnAttendee && !isAuthorizedOrganiser(ctx, booking.eventOrgId)) {
  throw new TRPCError({ code: 'FORBIDDEN', message: 'You do not have permission to access this ticket.' });
}

// 2. Status guard runs only after authorization has passed
if (booking.status !== 'confirmed') {
  throw new TRPCError({ code: 'NOT_FOUND', message: 'No ticket available for this booking' });
}
```

**How to spot it**

- Inspect every endpoint that returns different HTTP status codes or error messages for different resource states (`pending`, `confirmed`, `cancelled`, `archived`).
- Check whether any branching, filtering, or early-return statement executes between the initial DB select and the caller identity/role check.

**How to avoid it**

Any check that can return a *different* response depending on a resource's internal state must not run until authorization has already passed. Structure procedures so that authorization is asserted immediately after record retrieval (or folded into the query itself). An unauthorized caller must receive `FORBIDDEN` uniformly, regardless of resource status.

---

## 8. Cross-boundary `Response` header immutability

**What it looks like**

A handler receives a `Response` object returned from a Durable Object RPC stub (`stub.fetch()`) or a Cloudflare Service Binding, and attempts to append or modify headers in place using `response.headers.set(...)`.

```ts
// throws TypeError: Can't modify immutable headers
export async function applySecurityHeaders(response: Response): Promise<Response> {
  response.headers.set('X-Content-Type-Options', 'nosniff'); // FAILS on DO/Service-Binding responses
  return response;
}
```

In the Cloudflare Workers runtime, a `Response` object's headers become strictly immutable once the response crosses an RPC or stub boundary — even if the DO constructed that response locally with `new Response(...)`. Mutating in place works for locally constructed responses within the current isolate, but throws an uncaught `TypeError` for cross-boundary responses (such as DO error responses or WebSocket handshakes), turning intentional responses into unexpected `500` errors.

**How to spot it**

- Search for `.headers.set(`, `.headers.append(`, or `.headers.delete(` called on `Response` variables that originate from `stub.fetch()`, `env.BINDING.fetch()`, or helper functions that accept arbitrary `Response` instances.
- Test error paths on DO-proxied routes (e.g. passing missing parameters to a DO endpoint) and check if runtime header mutation throws.

**How to avoid it**

Never mutate `Response.headers` in place if the response could originate from a DO or service binding. Always reconstruct a new `Response` object with cloned headers (`apps/worker/src/cors.ts:20-30`):

```ts
export function applyWorkerSecurityHeaders(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  headers.set('Strict-Transport-Security', 'max-age=15552000; includeSubDomains');
  headers.set('Content-Security-Policy', "frame-ancestors 'none'");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
```

---

## 9. Blind revocations race under concurrency — use Compare-and-Swap (CAS)

**What it looks like**

A mutation revokes or replaces an active resource by executing an unconditional "revoke whatever is currently active" write, followed by creating the new state.

```ts
// vulnerable: concurrent callers race on unconditional revocation
await db.update(apiKeys).set({ revokedAt: now }).where(and(eq(apiKeys.orgId, orgId), isNull(apiKeys.revokedAt)));
await db.insert(apiKeys).values({ id: newKeyId, orgId, ... });
return { rawKey };
```

Under concurrency, two callers (A and B) rotating an API key or updating a subscription will interleave:
1. Caller A revokes Key 0 and inserts Key 1.
2. Caller B revokes Key 1 (unconditionally revoking whatever is active) and inserts Key 2.
3. Caller A returns Key 1 to the user — but Key 1 was already killed by Caller B. Caller A received an already-dead key with no error.
Similarly, in async subscription webhooks, an out-of-order `customer.subscription.updated` event could overwrite a newer active subscription if it updates unconditionally without verifying that the existing DB row matches the specific subscription ID being updated.

**How to spot it**

- Search for `UPDATE ... WHERE ... AND is_active = true` or `WHERE revoked_at IS NULL` without scoping to a specifically observed primary key / row version.
- Trace concurrent execution of rotation, replacement, and out-of-order webhook handlers.

**How to avoid it**

Implement optimistic Compare-and-Swap (CAS):
1. Read the specific row and ID you expect to be active (`activeKey.id` or `org.stripeSubscriptionId`).
2. Condition the update on that exact ID (`WHERE id = :observedId AND revoked_at IS NULL`).
3. Combine revocation and insertion in an atomic batch (`db.batch([revokeStmt, insertStmt])`) backed by a partial unique index (`WHERE revoked_at IS NULL`), or verify affected rows via `.returning()`.
4. If 0 rows were updated, treat the race as lost: abort cleanly, throw a `CONFLICT` error (as in `apps/worker/src/services/api-key-service.ts:164-230`), or defensively cancel redundant external entities (as in `apps/worker/src/handlers/stripe-webhook.ts:373-424`).

---

## 10. WebSocket upgrades bypass CORS — validate Origin explicitly

**What it looks like**

A WebSocket upgrade endpoint relies solely on CORS middleware or assumes cross-origin requests are blocked automatically by the browser.

```ts
// vulnerable: WebSocket handshake does not validate Origin
if (url.pathname === '/ws' && request.headers.get('Upgrade') === 'websocket') {
  const stub = env.SEAT_LEDGER.get(id);
  return stub.fetch(request);
}
```

The browser WebSocket API does not execute CORS preflights and does not adhere to standard Same-Origin Policy fetch restrictions. Ticket-based auth provides only *incidental* protection because browsers do not attach custom `Authorization: Bearer` headers cross-origin. If authentication ever migrates to ambient credentials (session cookies or HTTP auth), malicious third-party websites could initiate Cross-Site WebSocket Hijacking (CSWSH) against logged-in users.

**How to spot it**

- Check all HTTP handlers handling `Upgrade: websocket`. Verify whether `request.headers.get('Origin')` is validated.
- Test if a browser-originated request with `Origin: https://evil.com` can successfully negotiate a WebSocket connection.

**How to avoid it**

Explicitly validate the `Origin` header against a trusted allowlist during the upgrade handshake (`apps/worker/src/handlers/websocket.ts:7-26`):

```ts
const origin = request.headers.get('Origin');
// Reject browser requests from unauthorized origins
if (origin !== null && !CORS_ALLOWED_ORIGINS.includes(origin)) {
  return new Response('Invalid origin', { status: 403 });
}
```

*Note on non-browser clients:* Browsers unforgeably attach the `Origin` header. Non-browser clients (automated integration tests, monitoring probes, CLI tools) often omit `Origin`. Permitting `origin === null` preserves tooling interoperability while strictly enforcing the allowlist for all browser-originated connections.

---

## 11. Permissive CORS (`*`) is only safe with explicit per-request credentials

**What it looks like**

Applying `Access-Control-Allow-Origin: *` to an endpoint that relies on ambient credentials (cookies, session state, IP allowlists), or conversely, assuming `*` is automatically a vulnerability on public APIs.

```ts
// DANGEROUS: Wildcard CORS with ambient cookie-based authentication
app.use('/api/*', cors({ origin: '*' }));
app.get('/api/user/private-data', (req) => {
  const session = req.cookies.session; // EXPLOITABLE via CSRF / cross-origin data read
});

// SAFE: Wildcard CORS on headless API with explicit Bearer token authentication
// (apps/worker/src/handlers/public-api.ts:11-26, 60-70)
const PUBLIC_API_CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type',
};
```

**How to spot it**

- Review all routes returning `Access-Control-Allow-Origin: *`.
- Check if the route reads `Cookie`, session headers, or ambient auth. If it does, any malicious site visited by an authenticated user can read private data.
- Check if public headless endpoints (e.g. `/api/v1/events`) have explicit documentation stating why `*` is permissible.

**How to avoid it**

- Never use `Access-Control-Allow-Origin: *` on endpoints that read cookies, session credentials, or ambient state.
- Permissive CORS (`*`) is valid *only* on headless, read-only public APIs where authentication is established via an explicit per-request Bearer token (`Authorization: Bearer <key>`) checked server-side.
- Document this security model explicitly at the route definition so future code reviewers do not misclassify the intentional wildcard header as a regression.

---

## 12. Cross-tenant existence oracles: structure queries to prevent leaks

**What it looks like**

An endpoint checks if a resource exists in the database first, and then checks if the resource belongs to the caller's organisation in a separate second step.

```ts
// vulnerable: two-step existence then ownership check
const [event] = await db.select().from(events).where(eq(events.id, input.eventId));
if (!event) {
  return jsonResponse({ error: 'Not Found' }, 404); // Event does not exist anywhere
}
if (event.organisationId !== auth.organisationId) {
  return jsonResponse({ error: 'Forbidden' }, 403); // Leaks: event exists, but belongs to another org!
}
```

A two-step check allows attackers to enumerate IDs and determine whether private resources belonging to competitor organisations exist on the platform.

**How to spot it**

- Look for sequential `WHERE id = ?` queries followed by manual `if (row.orgId !== ctx.orgId)` branching.
- Test whether requesting a valid ID belonging to Org B using Org A's credentials returns a different status code (`403`) than requesting a non-existent ID (`404`).

**How to avoid it**

Structure the database query so that cross-tenant isolation is enforced at the SQL level. Query by both resource ID and organisation ID simultaneously (`apps/worker/src/services/public-events-service.ts` and `apps/worker/src/handlers/public-api.ts:110-123`):

```ts
const [event] = await db
  .select()
  .from(events)
  .where(and(eq(events.id, eventId), eq(events.organisationId, orgId)));

if (!event) {
  // Structurally uniform: 404 returned identically for non-existent and other-org events
  return jsonResponse({ error: 'Not Found' }, 404);
}
```

Because the query itself filters on `organisationId`, there is no divergence possible in application logic.

---

## 13. High-entropy API keys: SHA-256 lookup and reveal-once lifecycle

**What it looks like**

Storing plaintext API keys in the database, using slow password hashing (bcrypt/argon2) on high-entropy tokens, or returning raw API keys in list/info responses.

```ts
// vulnerable: storing raw API key in database
await db.insert(apiKeys).values({ id, rawKey: input.key, orgId });

// inefficient / problematic in edge workers: bcrypt on 256-bit entropy secrets
const hash = await bcrypt.hash(rawKey, 10); // Wastes edge CPU; unnecessary for high-entropy secrets
```

**How to spot it**

- Grep for API key schema definitions; check if columns contain raw tokens or hashes.
- Inspect read endpoints (`getApiKeyInfo`, `listApiKeys`) to verify they return only redacted prefixes (`evbk_a1b2c3d4...`) rather than full keys or hashes.
- Verify whether the key generation routine uses cryptographically secure random number generators (`crypto.getRandomValues`).

**How to avoid it**

1. **Entropy:** Generate API keys with 256 bits of true cryptographic entropy (`crypto.getRandomValues(new Uint8Array(32))`) prefixed with an identifiable namespace (e.g. `evbk_` in `apps/worker/src/services/api-key-service.ts:14-21`).
2. **Fast Hashing:** For high-entropy secrets ($2^{256}$ search space), slow password hashes (bcrypt/argon2) designed for low-entropy human passwords are unnecessary and waste edge CPU. Compute a standard SHA-256 digest (`crypto.subtle.digest('SHA-256', ...)`) and perform fast indexed lookups (`WHERE key_hash = :hash`).
3. **Reveal-Once:** Return the raw key string in the HTTP response **exactly once** upon initial generation or rotation. Never store the raw key in databases, logs, or browser storage. All subsequent queries must return only the non-sensitive prefix and creation timestamp.

---

## 14. Column defaults vs. redundant migrations and SQLite enum realities

**What it looks like**

Writing complex manual data-backfill scripts for schema migrations that add columns with default values, or conversely, assuming a Drizzle enum modification requires an `ALTER TABLE` migration on SQLite.

```ts
// Example: Adding subscription_status with default 'inactive'
export const organisations = sqliteTable('organisations', {
  // ...
  subscriptionStatus: text('subscription_status', {
    enum: ['inactive', 'active', 'past_due', 'canceled', 'trialing'],
  }).notNull().default('inactive'),
});
```

**How to spot it**

- Review migration files generated by `drizzle-kit generate`. Check the raw generated SQL before writing manual backfill scripts.
- Check whether an `ALTER TABLE ADD COLUMN ... DEFAULT 'inactive'` is produced. SQLite automatically populates existing rows with the schema default during the migration.
- Check if enum changes alter SQLite constraints. SQLite `text` columns do not enforce enum constraints at the database level unless explicitly configured with `CHECK` constraints. Drizzle's `{ enum: [...] }` parameter is enforced at the TypeScript compilation layer, producing no SQLite schema modification on enum widening.

**How to avoid it**

- Always inspect the generated `.sql` migration file. If a column has a schema-level `DEFAULT`, SQLite backfills all existing rows automatically at migration execution time; manual `UPDATE` scripts are redundant.
- Understand SQLite type affinity: widening a TypeScript Drizzle enum produces zero SQL changes on SQLite. Verify the migration diff rather than blindly writing migration operations.

---

## 15. Every "unexpected" async handler branch needs deliberate alerting severity

**What it looks like**

An asynchronous event handler or webhook encounters an abnormal state branch, logs a generic message, returns `200`, but omits error tracking (e.g. Sentry), leaving critical invariant violations unmonitored.

```ts
// Example in apps/worker/src/handlers/stripe-webhook.ts:85-101:
case 'hold_expired':
  console.warn('payment_intent.succeeded: HOLD_EXPIRED — releasing hold', { holdId, eventId });
  await db.insert(schema.auditLog).values({ eventType: 'hold_released_explicit', ... });
  return new Response('', { status: 200 }); // Money collected, no seat given, NO Sentry alert!
```

In the `hold_expired` case, a customer paid Stripe after the 15-minute reservation hold expired. The payment succeeded, but the seat was already released back to inventory and cannot be confirmed. The handler records an audit log and returns `200` to acknowledge Stripe, but triggers **zero** Sentry alerts. In contrast, the structurally similar `orphaned_hold` case (lines 121-144) correctly alerts Sentry at `error` level.

> [!WARNING]
> **Currently Open Item in Codebase:** The `hold_expired` branch in `apps/worker/src/handlers/stripe-webhook.ts` represents a real monetary/state discrepancy (customer charged without receiving a booking) that currently lacks automated Sentry alerting and automated refund processing.

**How to spot it**

- Review every branch of `switch` statements and error handlers in webhook consumers (`stripe-webhook.ts`, `clerk-webhook.ts`, `reconciliation.ts`).
- For every branch where money, seat allocation, or tenant entitlement deviates from normal flow, check if `Sentry.captureMessage` / `Sentry.captureException` is called with the appropriate severity (`warning` or `error`).

**How to avoid it**

Classify every non-standard branch with a deliberate alerting policy:
- *Benign expected races* (e.g. duplicate webhook retries, already confirmed holds): log at `info`/`warn`, return `200`, no Sentry noise.
- *Operational anomalies* (e.g. missing optional metadata): log at `warn`, capture Sentry message at `warning`.
- *Inconsistencies & Financial Desyncs* (e.g. `orphaned_hold`, `hold_expired`, `amount_mismatch`): log at `error`, capture Sentry event at `error` level with full identifiers in context, and alert operations for manual reconciliation or automated refunding.
