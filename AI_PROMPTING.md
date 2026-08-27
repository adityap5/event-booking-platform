# AI Prompting Guide for the Event Booking Platform

`SECURITY.md` is what to look for when reviewing code that already exists. `AI_PROMPTING.md` is how to prevent those problems from being written in the first place — the stack-specific preamble, domain invariants, and operational review rules you must put in front of an AI model working on this codebase.

The system is split into three operational pillars:
1. **Platform constraints** that prevent flawed code generation on this specific edge runtime.
2. **Domain logic & process rules** that no model can infer from code structure alone.
3. **Review checks** that catch what generative models cannot self-apply.
4. **Retrospective Evaluation** analyzing how these rules map against the actual Day 8–11 implementation and correction history.

---

## Part 1: Platform Rules (Edge, Workers, DO, D1, Stripe, Clerk, Drizzle)

These rules address edge runtime semantics that standard LLMs routinely misinterpret based on generic Node.js or relational database assumptions.

### 1. KV is a Cache, Not a Lock
- Cloudflare Workers KV is eventually consistent with globally distributed reads.
- **Rule:** Never attempt atomic read-then-write or compare-and-swap operations in KV. KV cannot serve as a distributed mutex, reservation counter, or deduplication store.
- **Enforcement:** All atomic state, concurrency serialization, and critical sections must live in a **Durable Object** (`SeatLedger` or `RateLimiter`). Use KV strictly for ephemeral, TTL-backed read caches (e.g. `EVENT_CACHE` in `apps/worker/src/routers/events.ts`).

### 2. Durable Object Alarms, Never `setTimeout` / `setInterval`
- Cloudflare Worker isolates are ephemeral and freeze or terminate when idle between request invocations. Timers registered via `setTimeout` or `setInterval` will not fire reliably across requests.
- **Rule:** For scheduled background transitions (such as releasing expired seat holds after 15 minutes), use the Durable Object Alarms API (`this.ctx.storage.setAlarm(expiryTimestamp)` and `async alarm()`).
- **Enforcement:** Never use Node/browser timers for asynchronous business workflows.

### 3. Stripe Webhooks in Workers Must Use `constructEventAsync`
- The Cloudflare Workers runtime does not provide Node's synchronous `crypto` bindings used by Stripe's default `stripe.webhooks.constructEvent`.
- **Rule:** Always verify Stripe webhook signatures asynchronously using Web Crypto-compatible SDK methods:
  ```ts
  const stripeEvent = await stripe.webhooks.constructEventAsync(
    rawBody,
    stripeSignature,
    env.STRIPE_WEBHOOK_SECRET,
  );
  ```
- **Enforcement:** Never import or call synchronous `constructEvent()`.

### 4. D1 Has No Interactive `db.transaction()` with Rollbacks
- Cloudflare D1 (SQLite) executes over an HTTP/RPC transport to the database engine. It does not support multi-statement interactive transactions with client-side rollback (`BEGIN ... COMMIT / ROLLBACK` across multiple `await` boundaries).
- **Rule:** For multi-statement atomicity, use `db.batch([stmt1, stmt2])`.
- **Enforcement:** Understand that `db.batch()` executes a list of prepared statements in a single batch transaction, but statements cannot dynamically inspect the return values of preceding statements in the same batch. Condition individual statements with SQL `WHERE` clauses (e.g. CAS patterns) and evaluate affected rows (`.returning()`).

### 5. Pure Edge / Web Standard APIs — No Node.js Dependencies
- The Worker runs on the V8-based Cloudflare Workerd runtime. Node standard libraries (`node:fs`, `node:net`, `node:child_process`) are unavailable.
- **Rule:** Use `@clerk/backend` (which supports Web Standard `fetch` and `crypto`), never `@clerk/clerk-sdk-node`.
- **Enforcement:** For binary/base64 conversions, use native `Uint8Array`, `btoa()`, and `atob()` rather than Node's `Buffer` (see `uint8ArrayToBase64` in `apps/worker/src/routers/tickets.ts:153-164`).

### 6. Cross-Boundary `Response` Headers Are Immutable
- In Cloudflare Workers, when a `Response` is received from a Durable Object RPC stub (`stub.fetch()`) or Service Binding, its `.headers` object is marked immutable by the runtime.
- **Rule:** Calling `.headers.set()` on a cross-boundary response throws `TypeError: Can't modify immutable headers`.
- **Enforcement:** Always reconstruct the response with a cloned `Headers` instance (`apps/worker/src/cors.ts:20-30`):
  ```ts
  export function applyWorkerSecurityHeaders(response: Response): Response {
    const headers = new Headers(response.headers);
    headers.set('X-Content-Type-Options', 'nosniff');
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  }
  ```

### 7. Drizzle Enums on SQLite Are TypeScript-Only
- In SQLite/D1, columns created with `text('col', { enum: [...] })` are raw SQLite `TEXT` columns unless explicitly configured with SQL `CHECK` constraints.
- **Rule:** Widening an enum array in Drizzle TypeScript code produces **no database schema diff** in SQLite migrations.
- **Enforcement:** Do not create manual migration scripts for Drizzle enum widenings on SQLite unless a database-level `CHECK` constraint actually exists. Verify the generated SQL from `drizzle-kit generate` before assuming a database migration is required.

### 8. Webhook Ordering and Payload Expand Limitations
- Stripe webhook events (`customer.subscription.created`, `updated`, `deleted`) do not guarantee sequential in-order delivery over the network.
- Furthermore, `expand` options configured during API session creation do not carry forward into asynchronous webhook event bodies.
- **Rule:** Never rely on webhook delivery order or expanded metadata in webhook payloads.
- **Enforcement:** Store canonical identifiers (`stripeCustomerId`, `stripeSubscriptionId`) directly in D1 beforehand, and design webhook handlers to be idempotent, handling out-of-order deliveries (e.g. `updated` arriving before `created`) using conditional CAS updates (`apps/worker/src/handlers/stripe-webhook.ts:373-490`).

---

## Part 2: Application Invariants & Logic Rules

These rules represent core domain invariants that a model cannot deduce solely from framework documentation.

### 1. Server Authority Over Derivable Values
- **Rule:** Never accept from the client any value that the server or Durable Object can independently compute or look up.
- **Enforcement:** If an endpoint requires seat counts, prices, organization IDs, or user IDs, derive them from the verified JWT context (`ctx.userId`, `ctx.orgId`) or the server-owned reservation record (`hold.seatCount`, `event.pricePerSeat`). Client inputs must never override server state.

### 2. Authorization Precedes All State-Dependent Branching
- **Rule:** Authentication identifies *who* the caller is; Authorization verifies *what* they can touch. Authorization must always run before any lifecycle or status check.
- **Enforcement:** In any procedure fetching a resource by ID (e.g. `getTicket` in `apps/worker/src/routers/tickets.ts`), verify caller ownership (`ctx.userId === row.attendeeUserId`) or organization role (`requireOrganiserRole(ctx, 'organiser')`) immediately after fetching the row, *before* checking whether the resource is `confirmed`, `pending`, or `cancelled`. Reversing this order creates an oracle leaking private resource status.

### 3. Comprehensive Request Validation on Every Boundary
- **Rule:** Every parameter in a Zod request schema must be explicitly bounded, typed, and constrained.
- **Enforcement:**
  - Numeric integers must use `.int()` (e.g. `seatCount: z.number().int().min(1).max(10)`).
  - Upper and lower bounds must be explicit (e.g. `pricePerSeat: z.number().int().min(0).max(100_000_00)`).
  - Date inputs must be bounded against past timestamps (`refine((val) => val > Date.now())`).
  - Never omit validation on metadata fields (like `name` or `date`) simply because they do not appear to directly control pricing or concurrency.

### 4. Validation Symmetry Across Neighboring Fields
- **Rule:** If one field in a schema or entity has strict validation (e.g. `totalSeats: z.number().int()`), any neighboring field handling the same conceptual domain (e.g. `seatCount`) must have matching validation rigor.
- **Enforcement:** Treat any asymmetry in schema constraints as a potential bug, not an intentional design choice.

### 5. Explicit, Non-Crossing State Machine Lifecycles
- **Rule:** Model state machine transitions explicitly and forbid invalid cross-lifecycle state changes.
- **Enforcement:**
  - For event tickets and holds, `pending → released` (unpaid hold expired/abandoned) and `confirmed → refunded` (paid seat reversed by organiser) are strictly separate, non-crossing lifecycles.
  - `releaseSeat()` must only transition `pending → released`.
  - `refundSeat()` must only transition `confirmed → refunded`.
  - Available capacity in the DO is computed purely via `SUM(seat_count) WHERE status = 'pending' OR status = 'confirmed'`. Released and refunded reservations naturally drop out of the sum without manual arithmetic counters.

### 6. Atomic Compare-And-Swap (CAS) Under Real Concurrency
- **Rule:** Any write touching shared state under concurrency (seat allocations, API key rotations, subscription claims) must condition its update on an observed prior state.
- **Enforcement:** Never execute blind `UPDATE table SET status = 'new' WHERE is_active = true`. Scope the `WHERE` clause to the exact entity ID observed (`WHERE id = :observedId AND revoked_at IS NULL`). Evaluate rows affected via `.returning()`: if 0 rows modified, treat the race as lost and abort or reject with `CONFLICT`.

### 7. Mutation Impact Analysis on Pre-Existing Invariants
- **Rule:** When introducing a new mutation or relaxing a field constraint, explicitly re-evaluate all historical invariant assumptions across the codebase.
- **Enforcement:** For example, when adding `updateEvent`, determine whether updating fields affects payment webhook invariants (e.g. keeping `pricePerSeat` immutable so `amount_mismatch` remains unreachable during active checkout sessions).

---

## Part 3: Review Checks That Generation Cannot Self-Apply

Generative models cannot objectively grade their own semantic intent. The following checks must be verified by a human reviewer or a dedicated secondary verification pass.

### 1. Root-Cause Fix vs. Visual Symptom Suppression
- **Check:** Does the proposed change actually close the security boundary, or does it merely hide the UI trigger?
- **Example:** Hiding a "Create Organisation" button with CSS (`display: 'none'`) improves UX but is not an access control boundary; the real fix is setting the organization limit to 1 in the Clerk Dashboard and checking foreign key constraints in D1.

### 2. Literal Assertion Verification vs. Test Name Semantics
- **Check:** Does the test assertion literally verify what the test title describes?
- **Example:** Verify that an exact-boundary streaming test actually tests the stream reader (using `ReadableStream` without `Content-Length`), rather than hitting the fast-path header check injected by the test runner.

### 3. Documentation Drift Following Design Pivots
- **Check:** When a design decision changes during development (e.g. abandoning grandfathering for subscriptions in favor of a clean `'inactive'` schema default, or dropping `checkout.session.completed` in favor of `customer.subscription.*`), did documentation and comments update across all referencing files?
- **Action:** Grep for references to deprecated architecture concepts to ensure documentation reflects current code truth.

### 4. Quiet Scope Expansion Detection
- **Check:** Did a PR or refactor introduce unrequested functionality as an incidental side-effect?
- **Example:** Introducing an `updateEvent` mutation while attempting to fix KV cache invalidation. When scope expansion occurs, review the new surface with the same rigor as an explicitly requested feature.

### 5. Alerting Severity and Error Boundary Audit
- **Check:** Did every "should not normally happen" branch in an async handler or webhook receive a deliberate Sentry alerting level, or was it quietly defaulted to `console.log` / return `200`?
- **Action:** Audit every outcome branch in Stripe and Clerk webhooks to confirm abnormal states trigger Sentry alerts at the proper severity level (`warning` or `error`).

---

## Part 4: Retrospective Evaluation Against Days 8–11 History

To evaluate the validity of these guidelines, we assess the real defects, review findings, and corrections that occurred during Days 8 through 11 against the rules in this document:

| Day & Finding / Defect | Root Cause in Code | Applicable Rule | Prevention vs. Review Classification |
| :--- | :--- | :--- | :--- |
| **Day 8: `getTicket` Status Leak**<br>Status check ran before ownership check in `routers/tickets.ts` | Early status guard leaked whether an arbitrary booking was confirmed vs pending | **Part 2, Rule 2:** Authorization Precedes All State-Dependent Branching | **Prevented by Generation Rule:** Pre-prompting the model with Rule 2 mandates placing authorization immediately after row retrieval. |
| **Day 8: Cross-Boundary Response Header Immutability**<br>`TypeError` when setting headers on DO stub responses | `applyWorkerSecurityHeaders` mutated `response.headers` in place | **Part 1, Rule 6:** Cross-Boundary `Response` Headers Are Immutable | **Prevented by Generation Rule:** Rule 6 explicitly warns against in-place mutation and dictates cloning `Headers`. |
| **Day 8: Cross-Site WebSocket Hijacking (CSWSH)**<br>`/ws` route did not validate `Origin` header | Relying on Bearer token auth without checking origin on WebSocket handshake | **Part 1 & 2:** WebSockets bypass CORS; explicit `Origin` validation required | **Prevented by Generation Rule:** Mandates origin checking in `handleWebSocketUpgrade`. |
| **Day 8: `createEvent` Date Validation Omission**<br>`date` field lacked validation while other fields had bounds | Asymmetrical schema validation | **Part 2, Rule 3 & 4:** Request validation completeness and schema symmetry | **Prevented by Generation Rule:** Highlights that non-monetary fields still require bounds. |
| **Day 8: KV Cache Invalidation Scope Creep**<br>`updateEvent` mutation added unexpectedly | Model created full update procedure to test cache invalidation | **Part 3, Check 4:** Quiet Scope Expansion Detection | **Requires Review Pass:** Generation models frequently add helper mutations; human review must catch and audit scope changes. |
| **Day 9: Refund State Machine Separation**<br>Risk of conflating `refundSeat` with `releaseSeat` | Merging confirmed refund logic with pending hold release corrupts seat counts | **Part 2, Rule 5:** Explicit, Non-Crossing State Machine Lifecycles | **Prevented by Generation Rule:** Explicitly defining `pending → released` vs `confirmed → refunded` ensures clean state separation. |
| **Day 9: Concurrency CAS on Refund D1 Update**<br>Ensuring exactly one audit log entry on concurrent refunds | Multiple concurrent refund requests could race on D1 status updates | **Part 2, Rule 6:** Atomic Compare-And-Swap (CAS) Under Concurrency | **Prevented by Generation Rule:** Mandating conditional updates with `.returning()` affected row counts. |
| **Day 10: Clean Slate vs Grandfathering Design Shift**<br>Shifting from `not_required` status to default `'inactive'` | Requirements simplified to avoid redundant migrations | **Part 3, Check 3:** Documentation Drift Following Design Pivots | **Requires Review Pass:** When requirements pivot away from grandfathering, review checks ensure stale references are purged. |
| **Day 10: Out-of-Order Webhook Delivery Race**<br>`customer.subscription.updated` arriving before `created` | Stripe webhooks arriving out of sequence | **Part 1, Rule 8 & Part 2, Rule 6:** Webhook ordering and CAS claims | **Prevented by Generation Rule:** Designing atomic subscription claims that handle null current states safely. |
| **Day 11: API Key Rotation Race Condition**<br>Blind revocation allowed concurrent callers to receive dead keys | Unconditional `UPDATE ... WHERE revoked_at IS NULL` | **Part 2, Rule 6:** Atomic CAS against specifically observed row ID | **Prevented by Generation Rule:** Directing the model to target `activeKey.id` in atomic batch updates. |
| **Day 11: Permissive CORS (`*`) on Public API**<br>Ensuring wildcard CORS is safe for `/api/v1/events` | Permissive CORS on bearer-authenticated headless routes | **Part 2, Rule 1 / Part 1:** Wildcard CORS is safe only with per-request bearer tokens | **Prevented by Generation Rule:** Explains authentication boundaries to prevent misclassifying CORS. |
| **Day 11: Webhook Alerting Gap (`hold_expired`)**<br>No Sentry alert fired on payment after hold expiry | Branch logged warning and returned 200 without Sentry error capture | **Part 3, Check 5:** Alerting Severity and Error Boundary Audit | **Requires Review Pass:** Alerting severity requires human judgment to align business impact with monitoring priority. |

### Conclusion
Generation-time constraints (Parts 1 & 2) reliably prevent **structural runtime errors, concurrency races, and authorization ordering leaks**. However, **scope adjustments, design pivot documentation syncs, and operational alerting severities** (Part 3) inherently require an intentional review pass. Combining strict generation rules with structured review criteria ensures that edge-specific defects are systematically eliminated.
