# Technical Documentation — Event Booking Platform

Audience: engineers, testers, DevOps and integration engineers working on this codebase after the onboarding build. This document explains what exists, why it's built this way, and what to watch out for.

---

## 1. Architecture Overview

**Turborepo monorepo, pnpm workspaces:**

```
apps/
  web-app/    Next.js (Pages Router), deployed to Cloudflare Workers via OpenNext
  worker/     Cloudflare Worker — owns tRPC, D1, Durable Objects, R2, KV
packages/
  shared/     Drizzle schema, shared types
  trpc/       tRPC setup, context, shared middleware (auth, org-access)
  permissions/ authorisation helpers, framework-agnostic
```

**The frontend never touches the database.** Every read/write goes through the worker over tRPC. `web-app` has no Drizzle dependency and no D1 binding.

**The frontend imports the `AppRouter` type directly from the worker package** (`import type { AppRouter } from '@event-booking/worker/src/router'`). There is no separate types package. This gives end-to-end type inference across two independently deployed applications — the type import is compile-time only, no worker runtime code ships to the frontend bundle.

**Pages Router, not App Router.** Server-side data fetching is `getServerSideProps`; everything else is client-side (no react-query provider is configured — data fetching from client components uses an imperative `useEffect` + tRPC client pattern throughout, not `useQuery` hooks).

**`getServerSideProps` runs in the Workers runtime** (via OpenNext), which has a direct consequence documented in Ponit 9: it cannot make a plain `fetch()` to another Worker's public URL.

### Two-app split rationale

Splitting `web-app` and `worker` (rather than a single Next.js app with API routes) mirrors how the team's production system is structured, and gives a hard boundary: the worker is the only thing with database credentials, R2/KV/DO bindings, and Stripe/Clerk secret keys. The frontend is a pure client of the worker's tRPC API. This makes "does the frontend leak a secret or bypass an authorisation check" a structural question (can you find a binding import in `web-app`? no) rather than a code-review-by-vigilance question.

---

## 2. The Seat Ledger — Durable Object Model

### Why a Durable Object, not D1 alone

**Rejected alternative: D1-only, `SELECT available` then `UPDATE available` on the events/seat-state row.**

D1 does not support `db.transaction()`. Without a transaction, two concurrent requests for the last seat can both `SELECT` the same "1 seat available" value before either has `UPDATE`d it — both proceed, both succeed, and the event is oversold. This is exactly the race condition class the onboarding-build (referenced in the brief). `db.batch()` (D1's alternative to transactions) batches multiple statements atomically as a unit, but it does not give you a read-then-conditional-write primitive across concurrent *separate* requests — it doesn't serialize two different incoming HTTP requests against each other.

**What we use instead: one Durable Object instance per event** (`SEAT_LEDGER.idFromName(eventId)`), holding seat state in the DO's own SQLite storage (`this.ctx.storage.sql`).

A Durable Object is **single-threaded** — Cloudflare guarantees only one JavaScript execution context is active for a given DO instance at a time. Concurrent requests to the same event's DO are queued and executed one at a time, in order. This makes the DO the serialisation primitive the exercise is built around: "check available seats, then insert a hold" inside a single DO method call is *effectively atomic* with respect to any other concurrent call to the same DO, because there is no interleaving possible.

Ownership boundary: **the DO is the single source of truth for real-time seat availability** (via the `reservations` table inside its own SQLite storage — status `pending`/`confirmed`/`released`). **D1 is the durable, queryable system of record** for confirmed bookings (the `bookings` table), event metadata, organisations, and attendees. The DO does not know about organisations, pricing, or attendee identity beyond a bare `userId` string on a hold — it only knows "does this event have N seats free right now."

### Lazy initialisation

A DO for a given event only gets `initialize(totalSeats)` called on it the first time something touches it (`reserveSeat` or `createSocketTicket`) — not at event-creation time. `getAvailableSeats()` returns `null` to signal "never initialized"; callers fall back to reading `totalSeats` from D1 and calling `initialize()`.

**Known past bug, now fixed:** the WebSocket broadcast path (`fetch()` on connect, and `broadcastSeatCount()` after every mutation) originally did `getAvailableSeats() ?? 0` — collapsing "never initialized" into the same displayed value as "sold out" (`0`). A brand new event with no reservations yet would show `0 / totalSeats` to anyone watching over the socket, indistinguishable from genuinely sold out. Fixed by having `createSocketTicket` perform the same lazy-init check `reserveSeat` already did, before minting a ticket — guaranteeing the DO is always initialized by the time a socket connects. See Point 8 for the general class of bug this represents.

### Hold expiry — alarm API, not `setTimeout`

`reserveSeat` places a `pending` hold with a 15-minute expiry and schedules `this.ctx.storage.setAlarm(expiresAt)`. The DO's `alarm()` handler releases any expired pending holds and re-schedules itself for the next upcoming expiry.

**Rejected alternative: `setTimeout` inside the DO.** A `setTimeout` is an in-memory JS timer. Durable Objects hibernate when idle (to avoid holding memory/compute for inactive objects) — hibernation kills any pending `setTimeout`. This works perfectly in local development (the process never hibernates on your laptop) and silently fails after deployment, where hibernation is real. The DO Alarm API persists the scheduled wake-up in Cloudflare's own storage, independent of whether the DO's JS execution context is currently alive — it survives hibernation by design.

### Concurrency-correctness note

Automated concurrency coverage now fires 20 parallel reserveSeat calls against a one-seat event and asserts exactly one succeeds. The test runs against the real Durable Object critical section via @cloudflare/vitest-pool-workers. Manual two-browser testing remains useful as a smoke test but is no longer the primary concurrency verification.

### Known deferred decision: Drizzle inside the DO

The DO currently uses raw prepared SQL statements against `this.ctx.storage.sql`, not Drizzle ORM. This was raised at a team check-in — the team's broader stack convention is Drizzle everywhere. Reasoning for the current approach, and why the switch was deliberately deferred rather than made under deadline pressure:

- D1 and DO SQLite are different Cloudflare storage bindings. Drizzle's DO-SQLite support (`drizzle-orm/durable-sqlite`) is a separate, newer integration path from the D1 support used elsewhere in this codebase, with its own migration tooling — not simply "the same ORM, one more table."
- The DO's entire purpose is concurrency correctness for a small number of narrow, security/correctness-critical operations (hold, confirm, release, mint/redeem ticket). Raw SQL keeps exactly what runs, and when, fully visible — which matters more here than the typed-query convenience Drizzle buys on the relational, multi-table D1 side.
- This is the most heavily tested, most concurrency-sensitive file in the repo. Swapping its storage layer on the final day, without time for full regression testing, was judged too risky relative to the benefit of stack consistency.

**Decision:** defer to a follow-up branch, done together with the file's structural modularisation (see Point 10), rather than rushed alongside feature work.

### 2a. Confirming a Hold — Webhook-Only, One Call Site (Day 1, Phase 2)

Booking confirmation used to be implemented twice: once in a client-callable `confirmBooking` tRPC procedure, once in the Stripe webhook handler — each independently doing confirm-seat → attendee lookup → booking insert.`confirmBooking` predated the webhook flow and had become dead code by the time it was found (zero frontend callers); it was removed.

The logic now lives once, in `confirmBookingFromPayment`
(`apps/worker/src/booking-confirmation.ts`), designed around its one real caller — the webhook — rather than kept generic for a second caller that no longer exists. It takes plain, explicit dependencies (`db`, a narrow `SeatLedgerStub` shape) instead of tRPC's `ctx`, so it's testable without mocking the whole Worker environment, and it returns a discriminated result instead of throwing, since HTTP-status mapping (200 for a stale/idempotent Stripe retry, 500 for a real failure) is the webhook's job, not the helper's:

```ts
type ConfirmBookingFromPaymentResult =
  | { outcome: 'confirmed'; booking; attendee; seatCount }
  | { outcome: 'already_confirmed' }
  | { outcome: 'hold_not_found' }
  | { outcome: 'hold_expired' }
  | { outcome: 'event_not_found' }
  | { outcome: 'attendee_not_found'; userId }
  | { outcome: 'amount_mismatch'; expectedPence; receivedPence; ... }
  | { outcome: 'orphaned_hold'; holdId; eventId };
```

**Non-atomicity, made explicit rather than assumed away:** `confirmSeat()` on the DO and the D1 booking insert are two separate writes with no rollback between them. Earlier versions of this logic treated the DO's `HOLD_ALREADY_USED` error as proof a booking had been written — but a crash between confirming the seat and inserting the booking would make that assumption false, and a Stripe retry would then silently return `200` on a booking that was never created, permanently. The helper now queries D1 for an actual booking row before trusting `HOLD_ALREADY_USED`; if none exists, it returns `orphaned_hold` instead, and the webhook responds `500` (loud, not silent) rather than acknowledging it. This doesn't close the gap — see the updated §10 bullet — it makes the gap detectable instead of invisible.

**Defence-in-depth amount check, not the primary fix:** Stripe's `amount_received` is compared against `pricePerSeat × seatCount` derived server-side. The primary fix for the payment-bypass vulnerability is that `seatCount` is no longer client-suppliable anywhere upstream (§2b) — this check exists only as a tripwire in case that invariant is ever broken by a future change, and it cannot undo the DO's already-consumed hold if it fires (same `orphaned_hold`-adjacent limitation).

### 2b. Payment Bypass Fix (Day 1, Phase 2)

**Original bug:** `createCheckoutSession` accepted `seatCount` as client input and passed it straight to Stripe as `quantity`, independent of the DO hold's actual seat count. A client could reserve N seats, then tell checkout to charge for 1, and receive N confirmed seats for the price of one.

**Fix:** `seatCount` removed from the procedure's input entirely. A new read-only DO method, `getHold(holdId)`, exposes a hold's `{ userId, seatCount, status, expiresAt }` without consuming it (unlike
`confirmSeat`, which does). `createCheckoutSession` derives `seatCount` exclusively from `getHold()` — the client cannot influence Stripe's `quantity` through any input field.

**Validation order is deliberate:** `NOT_FOUND` → `FORBIDDEN` (ownership) → `CONFLICT` (non-`pending`) → `PRECONDITION_FAILED` (expired). Ownership is checked immediately after existence, before status or expiry — checking those first would let a `FORBIDDEN` response leak whether another user's hold is pending, confirmed, or expired, even without exposing its contents.

**Known point-in-time gap, accepted, not solved:** a hold can expire between `getHold()`'s read and Stripe session creation. `getHold()` deliberately stays strictly read-only — it does not lock, extend, or re-confirm the hold to close this window. `confirmSeat()` (via the webhook) remains the sole authority for actually consuming a hold. Closing this window would mean either mutating what should be a pure read, or building real reconciliation — neither was judged worth doing inside this fix.

### 2c. Hold-Exhaustion Cap (Day 1, Phase 2)

**Original gap:** `reserveSeat` has a request-frequency rate limit (10 calls/60s per user, §7) but no cap on concurrent *pending* holds. A user could hold up to 100 seats in a 60-second burst, let the rate limit reset, and repeat — indefinitely denying real buyers, at zero cost, without ever paying.

**Fix:** `reserveSeat` now rejects (`TOO_MANY_PENDING_HOLDS` → `CONFLICT`) if the calling user already has a live pending hold for the event (`status = 'pending' AND expires_at > now` — an expired-but-not-yet-alarm- cleaned-up row does not count against the user).

**Deliberate trade-off:** reject-on-duplicate, not auto-replace. A user who wants to change their seat count mid-flow currently has no way to release their existing hold early and must wait out the 15-minute expiry — see the new §10 bullet, "No user-facing hold-release action." The 15- minute hold duration itself was deliberately left unchanged — a separate, independent lever from this fix.

---

## 3. Socket Ticket Flow

Browsers cannot set custom headers on a WebSocket upgrade request, so the Clerk JWT can't travel to the `/ws` endpoint the way it does on ordinary HTTP calls. The token **must not** go in the URL query string — URLs land in access logs, proxy logs, and browser history, and a leaked token there stays valid until it expires.

**Flow:**

1. Client calls the authenticated tRPC procedure `createSocketTicket({ eventId })`. The JWT is verified as normal (Authorization header, `verifyToken` against Clerk's JWKS).
2. The procedure calls the **event's own SeatLedger DO** to mint an opaque ticket (`crypto.randomUUID()`), stored in the **DO's own SQLite storage** (`socket_tickets` table) with a 30-second expiry, `userId`, `orgId`, and the `eventId` it's scoped to.
3. The client opens the WebSocket with that ticket as the *only* URL parameter — the ticket itself is single-use and short-lived, so even if it appears in a log, it's already worthless by the time anyone could misuse it.
4. The **same DO** (`fetch()` handler) validates and deletes the ticket **before** accepting the WebSocket upgrade — rejecting with 401 if missing, expired, or already used (previously redeemed).
5. Resolved identity (`userId`) is stored in the WebSocket connection's **attachment** (`this.ctx.acceptWebSocket(server, [identity.userId])`) — not read from message payloads. The attachment survives DO hibernation, which is exactly why it's the right home for identity: a client-supplied `userId` inside a later message is never trusted.

**Why the DO, not KV, for ticket storage:** the DO is single-threaded, so "check ticket exists, then delete it" is genuinely atomic — two simultaneous connection attempts with the same ticket cannot both succeed. KV has no atomic check-and-delete, and writes propagate across Cloudflare's regions with delay — a ticket minted in one region might not yet be visible when redeemed against another, producing intermittent, hard-to-diagnose rejections that look like network faults, not logic bugs.

**Why not in-memory (a plain JS `Map`) instead of DO SQLite:** the DO can hibernate between minting a ticket (step 2) and the client actually opening the socket (step 3-4) — an in-memory ticket would vanish on hibernation, leaving the client holding a ticket the server no longer knows about. DO SQLite storage persists across hibernation.

Hibernation-capable WebSockets are used throughout (`this.ctx.acceptWebSocket()`, not the older `server.accept()` pattern) — this allows the DO to be evicted from memory while still holding live WebSocket connections, waking only when a message needs handling.

---

## 4. Bindings and Secrets

### Worker bindings (`apps/worker/wrangler.jsonc`)

| Binding | Type | Purpose |
|---|---|---|
| `DB` | D1 | Relational data: organisations, events, attendees, bookings |
| `SEAT_LEDGER` | Durable Object (`SeatLedger`) | One instance per event, seat holds/confirms/releases, socket tickets |
| `RATE_LIMITER` | Durable Object (`RateLimiter`) | Atomic per-key rate limiting (see §7) |
| `EVENT_CACHE` | KV | Caches the public event payload (name/date/price/image), 5-minute TTL |
| `EVENT_COVERS` | R2 | Event cover images — both temp uploads and finalised event covers |
| `EVENT_TICKETS` | R2 | Private bucket for generated PDF tickets — access gated by authenticated `getTicket` |

### Worker variables (`apps/worker/wrangler.jsonc` `vars`)

Public non-secret configuration variables used to construct absolute URLs without hardcoding hostnames in source code:

| Variable | Where used | Notes |
|---|---|---|
| `WORKER_URL` | worker | Deployed worker public URL — used for building absolute image URLs (`/images/events/...`) |
| `WEB_APP_URL` | worker | Deployed web application URL — used for Stripe Checkout and Billing redirect URLs (`success_url`, `cancel_url`, `return_url`) |

### Web-app bindings (`apps/web-app/wrangler.jsonc`)

| Binding | Type | Purpose |
|---|---|---|
| `ASSETS` | Static assets | OpenNext-built Next.js static output |
| `WORKER_SERVICE` | Service binding → `event-booking-worker` | Server-side (`getServerSideProps`) calls to the worker's tRPC API — see §9, this is not optional |

### Secrets

Never committed. Local: `.dev.vars` (gitignored). Deployed: `wrangler secret put <NAME>`.

| Secret | Where used | Notes |
|---|---|---|
| `CLERK_JWT_KEY` | worker | Clerk's *public* JWT key — networkless JWT signature verification, no per-request Clerk API call |
| `CLERK_SECRET_KEY` | worker | Clerk's secret key — used only when resolving a real name/email for a newly-created attendee (`ensureAttendee`), via `clerkClient.users.getUser()` |
| `CLERK_WEBHOOK_SECRET` | worker | Verifies the `organization.created` webhook signature (svix) |
| `STRIPE_SECRET_KEY` | worker | Stripe API secret key for Checkout Sessions, Customer creation, Refunds, and Billing Portal |
| `STRIPE_WEBHOOK_SECRET` | worker | Verifies Stripe webhook signatures (`constructEventAsync`) for payment and subscription events |
| `STRIPE_SUBSCRIPTION_PRICE_ID` | worker | Stripe recurring price ID for organiser monthly subscription (`createSubscriptionCheckout`) |
| `SENTRY_DSN` | worker | Sentry Data Source Name for error and exception monitoring across worker handlers and Durable Objects |

**To add a new secret:** add it to the relevant `Env` type (`apps/worker/src/index.ts` or wherever it's consumed), set it locally in `.dev.vars`, and deploy it with `wrangler secret put <NAME>` from the correct app directory. It will not appear in `wrangler.jsonc` — secrets are never listed there.

---

## 5. Data Model

D1, via Drizzle (`packages/shared/src/schema.ts`), migrations always generated via `drizzle-kit`, never hand-written.

```
organisations
  id (uuid, pk)
  name
  ownerId                — Clerk userId of the creating user (unique index)
  stripeCustomerId       — Stripe Customer ID for subscriptions & billing (unique index, nullable)
  stripeSubscriptionId   — Authoritative Stripe Subscription ID (nullable)
  subscriptionStatus     — text (default: 'inactive'; values: 'inactive' | 'active' | 'trialing' | 'past_due' | 'canceled')
  createdAt

events
  id (uuid, pk)
  organisationId         — FK → organisations.id, cascade delete (indexed)
  name
  description            — nullable
  date                   — integer, timestamp mode (seconds precision, indexed)
  totalSeats
  pricePerSeat           — integer, smallest currency unit (pence), never floats
  coverImageUrl          — nullable, full public /images/... URL
  createdAt

attendees
  id (uuid, pk)
  userId                 — Clerk userId (unique index)
  email
  name

bookings
  id (uuid, pk)
  eventId                — FK → events.id, cascade delete (indexed)
  attendeeId             — FK → attendees.id, cascade delete (indexed)
  status                 — enum: pending | confirmed | cancelled | refunded
  holdId                 — nullable, indexed (pre-hold-system rows have none)
  seatCount
  stripePaymentIntentId  — nullable
  createdAt

audit_log
  id (uuid, pk)
  eventType              — text, indexed (e.g. booking_confirmed, booking_refunded, hold_released_explicit, reconciliation_orphan_detected)
  holdId                 — nullable
  bookingEventId         — nullable, indexed
  userId                 — nullable
  orgId                  — nullable
  detail                 — nullable text (JSON string containing structured operational detail)
  createdAt

organisation_api_keys
  id (uuid, pk)
  organisationId         — FK → organisations.id, cascade delete (indexed)
  keyHash                — text, SHA-256 hash of the plaintext API key (unique index)
  keyPrefix              — text (e.g. 'eb_live_a1b2c3d4' for display/identification)
  createdAt
  revokedAt              — nullable timestamp (partial unique index on organisationId WHERE revoked_at IS NULL structurally enforces at most one active key per org)
```

**DO/D1 boundary for seat state:** D1's `bookings` table is the durable record of what was actually paid for and confirmed. The DO's own SQLite `reservations` table is the live, serialised source of truth for "is this seat available right now" — it exists only inside the DO instance for that event, is not queried directly by any other part of the system, and a pending hold in the DO does not yet have a corresponding bookings row in D1 (that row is only written by `confirmBookingFromPayment`, called exclusively from the Stripe webhook — see §2a). There is no client-triggered confirm path; confirmation happens server-side only, driven by a verified Stripe payment event.

**The Confirm Failure Window:** The DO/D1 split introduces a strict boundary where a hold is atomically locked/confirmed in the DO, but the durable `bookings` row must subsequently be written to D1 via the tRPC router. If the DO confirms the hold and the ensuing D1 insert fails (e.g., network fault or DB constraint error), the seat is permanently consumed in the DO without a corresponding booking record. This is a known trade-off acceptable at this scale, and this exact failure mode is systematically detected in production by the nightly reconciliation job, which cross-references DO reservations against D1 bookings and logs orphaned holds to Sentry/Axiom for manual remediation.

**DO Internal Storage Tables (SQLite):**
- `event_state` (`id INTEGER PRIMARY KEY, total_seats INTEGER, initialized INTEGER`): Single row storing total event capacity.
- `reservations` (`id TEXT PRIMARY KEY, user_id TEXT, seat_count INTEGER, expires_at INTEGER, status TEXT`): Holds active (`pending`, `confirmed`) and terminal (`released`, `refunded`) reservation rows.
- `socket_tickets` (`ticket TEXT PRIMARY KEY, user_id TEXT, org_id TEXT, event_id TEXT, expires_at INTEGER`): Ephemeral single-use tickets for WebSocket connection authentication (30-second TTL).

**IDs are not enumerable.** Every primary key is a `crypto.randomUUID()`, not a sequential integer — a user cannot walk the dataset by incrementing a URL parameter.

All `createdAt` and `date` columns use `mode: 'timestamp'` (seconds), paired with `sql\`(strftime('%s', 'now'))\`` defaults (also seconds) — verified against drizzle-orm's actual source.

---

## 6. Caching vs Live Counts

**Rejected alternative: cache the full event payload including seat count.**

The public event page (`getPublicEvent`) caches static metadata (name, description, date, price, cover image) in KV for 5 minutes — this data changes rarely and a stale 5-minute-old name/price is a non-issue. **Seat count is deliberately excluded from this cached payload.** Available seats change on every booking; caching that number would mean serving a stale count on every cache hit for up to 5 minutes, directly defeating the purpose of the WebSocket-based live seat count system. Live seat counts are always read either from the SeatLedger DO directly (`getAvailableSeats`, for the unauthenticated polling fallback) or streamed over the WebSocket (for authenticated users) — never from KV.

This is the general principle applied throughout: **KV is a cache, not a lock, and not a source of truth for anything that changes faster than its TTL.**

**Note on `listPublicEvents`:** The public catalog endpoint does not use KV caching. It queries D1 directly, ensuring newly published events appear immediately in the feed.

---

## 7. Rate Limiting

**Rejected alternative: a counter stored in KV.**

KV has no atomic increment. Two simultaneous requests can both read `count = 9`, both write `count = 10`, and both succeed — the limit is silently bypassed under concurrent load. KV writes also propagate across Cloudflare's regions with delay, so even a single-threaded-looking increment can undercount if requests land in different regions.

**What we use: a dedicated `RateLimiter` Durable Object**, keyed by `idFromName(<key>)`, exposing `checkLimit(action, limit, windowMs)`. Because the DO is single-threaded, `checkLimit` is genuinely atomic — no bypass under concurrent load.

Rate limits enforced via `RateLimiter`:

| Action | Key | Limit | Notes |
|---|---|---|---|
| `reserveSeat` | `userId` | 10 per 60s | Per-attendee booking-abuse concern |
| `createEvent` | `orgId` | 5 per hour | Per-organisation (all members of an org share one quota) |
| `createCheckoutSession` | `userId` | 10 per 60s | Prevents Stripe Checkout session spam |
| `createSocketTicket` | `userId` | 10 per 60s | Prevents Durable Object WebSocket connection exhaustion |
| `uploadEventCover` | `userId` | 5 per 60s | Tighter bounds for R2 write operations |
| `publicRead` | IP (`CF-Connecting-IP`) | 60 per 60s | Shared bucket for all public read queries (`listPublicEvents`, `getPublicEvent`, `getAvailableSeats`) |
| `publicImageRead` | IP (`CF-Connecting-IP`) | 120 per 60s | Higher capacity for public `/images/*` loading (often bulk-fetched) |

Rate limiting is a separate DO class (`RateLimiter`) from `SeatLedger`, not folded into the seat DO — it's a cross-cutting concern with a different lifecycle (per-user or per-org, not per-event).

---

## 8. Integration Stub Contracts

Two stubs exist, deliberately not implemented against a real provider: **email confirmation** and **calendar invite**. Both live in `apps/worker/src/integrations.ts` with a single dispatch point each — call sites do not scatter outbound integration calls, everything funnels through `dispatchEmailConfirmation()` / `dispatchCalendarInvite()`, both called from exactly one place (the Stripe webhook handler, on `payment_intent.succeeded`).

### `dispatchEmailConfirmation`

```ts
{
  idempotencyKey: string;   // the booking's holdId — stable across webhook retries
  to: string;               // attendee email
  attendeeName: string;
  eventName: string;
  eventDate: number;        // ms timestamp
  seatCount: number;
  bookingId: string;
  totalPaidPence: number;
}
```

**Idempotency:** `idempotencyKey` is the `holdId`, which is unique per booking and stable if Stripe retries the webhook — a real implementation should de-duplicate dispatches on this key. **Failure behaviour:** dispatch errors are caught and swallowed at the call site — a failed stub dispatch must never cause the webhook handler to return a non-200 response, since that would make Stripe retry the *entire* webhook, re-running the seat-confirmation logic against an already-confirmed hold (safely idempotent there) but also re-attempting a possibly-permanently-failing dispatch indefinitely. A real implementation should route failures to a dead-letter queue instead of swallowing them.

### `dispatchCalendarInvite`

```ts
{
  idempotencyKey: string;   // same holdId
  attendeeEmail: string;
  organizerEmail: string;
  eventName: string;
  eventDate: number;
  durationMinutes: number;
  locationOrUrl: string;
  bookingId: string;
}
```

Same idempotency and failure-handling contract as above.

**To swap in a real provider:** replace the body of `dispatchEmailConfirmation`/`dispatchCalendarInvite` in `integrations.ts` with the real API call, keeping the function signature (and therefore every call site) unchanged.

**Integration payloads:** Real `eventName` and `eventDate` are queried from D1 by the Stripe webhook handler and threaded through to `dispatchEmailConfirmation` and `dispatchCalendarInvite` (omitted if event metadata is unavailable, preventing placeholder data). `organizerEmail` is optional and currently omitted until organiser email resolution is added.

**Header Injection Warning:** When a real email provider is wired in, ensure that newlines (`\r`, `\n`) are strictly stripped or escaped from `to` and `attendeeName` payloads before passing them to the provider. Unescaped newlines in those user-controlled fields become header-injection vectors.

---

## 9. Local Setup and Deployment

### Local setup

```bash
pnpm install
# apps/worker/.dev.vars — CLERK_JWT_KEY, CLERK_SECRET_KEY, CLERK_WEBHOOK_SECRET,
#                         STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET
pnpm exec wrangler d1 migrations apply event-booking-db --local   #apps/worker
pnpm dev   # or wrangler dev, per app
```

**Known local-dev gap:** Clerk's `organization.created` webhook is configured (in the Clerk dashboard) to POST to a fixed URL — currently the deployed worker. Running the worker locally does **not** receive this webhook unless the dashboard is pointed at a local tunnel (e.g. `ngrok http 8787`) during development. Practical effect: organisations created against a locally-running worker will exist in Clerk but not sync into local D1, and any insert referencing that `organisationId` will fail a foreign-key constraint. Workaround for local testing: either tunnel the webhook, or manually insert the organisation row into local D1 via `wrangler d1 execute ... --local`.

**Known local-dev gap:** `getCloudflareContext()` (used for the `WORKER_SERVICE` service binding, see below) is Workers-runtime-specific and may not resolve correctly under plain `next dev` outside of `wrangler dev`/a real deployed Worker.

### Deployment

```bash
#apps/worker
pnpm exec wrangler deploy

#apps/web-app
pnpm run deploy   # opennextjs-cloudflare build && opennextjs-cloudflare deploy
```

### SSR-to-worker calls must use a Service Binding, not a public fetch

**This bit us directly during Day 9 and is worth stating plainly for the next engineer.** Cloudflare blocks a deployed Worker from `fetch()`-ing another Worker's public `*.workers.dev` URL (error 1042) — loop/abuse protection between Workers on the same account. This was invisible throughout earlier development because `web-app` was always run locally (a plain Node process) while pointed at the deployed worker — a local Node process calling a public URL is an ordinary cross-origin request, no restriction applies. The very first time `web-app` itself was deployed to Workers, its own `getServerSideProps` calls (in `pages/index.tsx`, `pages/events/[id].tsx`) started failing with an opaque, non-JSON 500.

**Fix:** a Cloudflare **service binding** (`WORKER_SERVICE` in `apps/web-app/wrangler.jsonc`, pointing at the `event-booking-worker` Worker by name) lets `web-app`'s server-side code call the worker directly, without a public network hop, entirely bypassing the restriction. `getServerSideProps` in both affected pages accesses it via `getCloudflareContext()` (from `@opennextjs/cloudflare`) and passes a custom `fetch` implementation to tRPC's `httpBatchLink` that delegates to `env.WORKER_SERVICE.fetch(...)`. Client-side (browser) tRPC calls are unaffected and continue to use the public worker URL as normal — this restriction only applies to Worker-to-Worker calls, and the browser is not a Worker.

This required a chain of supporting fixes, each worth knowing about if touching this area again:
- `getCloudflareContext()`'s binding types require `@opennextjs/cloudflare`'s ambient `CloudflareEnv` global interface to be extended via declaration merging — this project didn't have that declared until now (`apps/web-app/cloudflare-env.d.ts`, `declare global { interface CloudflareEnv extends Env {} }`).
- `wrangler types` must be re-run after any `wrangler.jsonc` binding change, to regenerate `worker-configuration.d.ts`.
- `apps/web-app/tsconfig.json`'s `exclude` did not previously exclude `.open-next`/`.wrangler` (generated build output) — `tsc --noEmit` was type-checking generated files it was never meant to.
- `next build`'s own type-check gate fails on `@opennextjs/cloudflare`'s **own** internal generated Durable Object wrapper classes (pulled in transitively via `worker-configuration.d.ts`'s `mainModule` type reference), independent of anything in this codebase — this is disabled via `typescript.ignoreBuildErrors: true` in `next.config.js`, with a comment explaining why. `wrangler deploy`/`opennextjs-cloudflare build` do not use `tsc` as a build gate, so this does not affect runtime correctness — only the `next build` type-check pass, which was failing on vendor code, not ours.

### CORS

`apps/worker/src/cors.ts` holds `resolveAllowedOrigin(request)`, which echoes back the matching origin from the incoming request's `Origin` header (falling back to the deployed URL if no match) — not `*`, origins are explicitly enumerated. `Access-Control-Allow-Origin` only supports a single value per response, so a static single-origin constant cannot serve both a deployed app and local dev simultaneously — this must be resolved per-request.

**Two separate exports, not one (Day 3, Phase 2):** `CORS_ALLOWED_ORIGINS` and `JWT_AUTHORIZED_PARTIES` are kept as distinct constants even though they're currently identical (one entry: the deployed web-app URL). Originally a single `ALLOWED_ORIGINS` array was used for both CORS resolution *and* Clerk's `authorizedParties` JWT-audience check — which meant a JWT scoped to `http://localhost:3000` (present in that array for dev convenience) was valid against production. Dev/localhost/LAN origins were removed from the codebase entirely rather than gated behind an environment check. **Note:** These arrays remain hardcoded static strings in `cors.ts` (see §10 Known Weaknesses) rather than being populated by `env.WEB_APP_URL`.

---

## 10. Known Weaknesses and Accepted Trade-offs

- Reconciliation job implemented; automatic healing remains deferred. The job detects confirmed DO holds without corresponding D1 bookings and raises an audit/Sentry alert, but deliberately does not create or repair booking rows.
- **`seat-ledger.ts` uses raw SQL, not Drizzle** — see point 2, deliberately deferred alongside its structural modularisation.
- **`apps/worker/src/router.ts` and `index.ts` have been split into `routers/`, `handlers/`, and `procedures.ts`; `seat-ledger.ts` and the web-app have not yet received the same treatment** — see `ROADMAP.md`.
- **Pagination Limits vs CPU Execution Time:** `listPublicEvents` enforces a hard `MAX_OFFSET = 10000`. Cloudflare D1/SQLite offset pagination performs an index scan, and excessively deep offsets (e.g., 500k) consume too much CPU time under the Workers 50ms subrequest budget. This protects the runtime but restricts pagination depth. If datasets grow extremely large, this must be refactored to use cursor-based pagination.
- **Hardcoded URLs in Edge/Middleware Boundaries:** While application URLs were moved to environment config, two locations retain hardcoded domains:
  1. `apps/web-app/middleware.ts` Content-Security-Policy URLs. Next.js edge middleware cannot access dynamic runtime non-`NEXT_PUBLIC_` environment variables without Cloudflare bindings, so static domains are retained as an explicit, zero-dependency policy.
  2. `apps/worker/src/cors.ts` (`CORS_ALLOWED_ORIGINS` and `JWT_AUTHORIZED_PARTIES`). These remain static array constants rather than dynamically resolving against `env.WEB_APP_URL`, making the CORS and JWT-audience boundaries static configuration rather than runtime-derived.

## 11. Test Suite (Day 2, Phase 2)

- Tests live in `apps/worker/tests/`, sibling to `src/`. Run with `pnpm --filter worker test` (Vitest). Uses `@cloudflare/vitest-pool-workers`, which runs tests inside a real Miniflare-backed Workers runtime — real D1, real Durable Objects, real KV/R2 bindings, not mocks. `isolatedStorage: true` is set in `vitest.config.ts` so each test gets a clean storage instance.

- **D1 setup is migration-driven, not a hand-copied schema.**
`tests/test-helpers.ts`'s `setupTestDb` drops and re-creates D1 tables by executing the real files in `apps/worker/migrations/*.sql`, in order, on every test (via `beforeEach`). This is deliberate: an earlier hand-typed schema copy was missing indexes that specific production code depends on (`attendee_user_idx` — a unique index `ensureAttendee`'s insert-then-fallback logic relies on to work at all), which would have made that code path untestable, or worse, silently appear to pass against a schema that doesn't match production.

- **Auth is bypassed, not mocked.** `createContext` (Clerk `verifyToken`) is a separate function from the tRPC router. Tests call `appRouter.createCaller(ctx)` directly with a hand-built context (`{ userId, orgId, role, db, env }`) — no Clerk network calls, no fake JWTs, ever.

- **Stripe uses two different strategies, deliberately not one:**
- `createCheckoutSession`'s outbound `checkout.sessions.create` call is intercepted at the `fetch` layer (`test-helpers.ts`'s `mockStripeNetworkCall`) — no real network call, but the actual request body sent to Stripe is captured and asserted on (e.g. `line_items[0][quantity]` really does come from the hold, not any client input).

- Webhook signature verification uses Stripe's own `stripe.webhooks.generateTestHeaderStringAsync()` against a test secret — real HMAC-SHA256 crypto, zero mocking, zero network. This tests the actual
  verification logic, not a stand-in for it.

- **Covered:** true concurrency (20 parallel `reserveSeat` calls against a 1-seat event, exactly 1 succeeds — exercised against the DO's real synchronous critical section, no simulated locking), alarm expiry via the real `alarm()` handler (`runDurableObjectAlarm`, not a manual `releaseSeat()`call), per-organisation isolation (`listOrgEvents`, `getEventAttendees`), ticket single-use (`redeemTicket` via `runInDurableObject`), and regression coverage for every Day 1 fix — including the specific ordering case of `FORBIDDEN` winning over `PRECONDITION_FAILED` (an expired hold owned by a different user), not just `FORBIDDEN` over `CONFLICT`.

- **Not covered yet — known gaps, not oversights:**
- `RateLimiter` DO itself has no direct tests (only exercised indirectly through procedures that call it).
- No test exercises the actual WebSocket upgrade handshake end-to-end; ticket single-use is tested at the DO method level (`redeemTicket` directly), not through a real `/ws` connection.
- `EVENT_CACHE` hit/miss behavior in `getPublicEvent` is untested.
- `cors.ts`'s `resolveAllowedOrigin` has no direct unit test (only exercised indirectly). The upload handler (`handlers/upload.ts`) is now tested (Day 3, Phase 2, Day 3 adds `tests/upload.test.ts` and `tests/public-rate-limiting.test.ts`) — magic-byte content validation, per-user upload rate limiting, and per-IP public-endpoint rate limiting are all covered against real R2/D1/DO state, not mocks.

- `test-seat-engine.sh` (the previous bash-based smoke test, sequential, hitting the deployed worker directly) has been deleted — this suite replaces it.

### Test Files and Feature Coverage (244 tests total)

| File | Tests | Feature Covered |
|---|---|---|
| `api-keys.test.ts` | 20 | Public API key issuance, revocation, middleware validation, offset pagination |
| `body-size-limit.test.ts` | 6 | 100KB payload limit enforcement (`Content-Length` and streaming boundaries) |
| `booking-confirmation.test.ts` | 8 | DO `confirmSeat`, idempotency, orphan hold detection, mismatched amounts |
| `cache-control.test.ts` | 6 | `Cache-Control: no-store` header behavior on tRPC vs R2 image routes |
| `clerk-webhook.test.ts` | 2 | `organization.created` webhooks, SVIX signatures, owner conflict handling |
| `error-formatter.test.ts` | 2 | tRPC error serialization and internal message masking |
| `events.test.ts` | 24 | `reserveSeat` concurrency, hold releasing, event creation, permission boundaries |
| `get-ticket.test.ts` | 13 | Authenticated fetching of PDF tickets for confirmed bookings |
| `payments.test.ts` | 7 | Stripe `createCheckoutSession` payload assertions, query params, rate limiting |
| `public-rate-limiting.test.ts` | 3 | IP-based rate limiting on public endpoints (`listPublicEvents` etc.) |
| `rate-limiter.test.ts` | 4 | `RateLimiter` Durable Object atomic limits and window rollovers |
| `realtime.test.ts` | 2 | `createSocketTicket` minting, org membership enforcement, rate limiting |
| `reconciliation.test.ts` | 15 | Nightly CRON reconciliation, orphan DO hold detection, and Sentry/Axiom logging |
| `refund-booking.test.ts` | 18 | `refundBooking`, Stripe API calls, terminal DO transitions, permission checks |
| `seat-ledger.test.ts` | 22 | Durable Object core: isolation, alarm-based expiry, single-threaded locks |
| `security-headers.test.ts` | 10 | CSP, HSTS, `nosniff`, `Referrer-Policy` across APIs, R2 images, and WebSockets |
| `sentry.test.ts` | 9 | Sentry error capture formatting, request tagging, unhandled error catching |
| `stripe-webhook.test.ts` | 7 | Webhook HMAC-SHA256 signature verification, Stripe event routing |
| `structured-logging.test.ts` | 11 | Axiom JSON logging format and audit log schema validation |
| `subscriptions.test.ts` | 29 | Stripe Billing portal, subscription state syncing (`active`, `past_due`, `canceled`) |
| `ticket-pdf.test.ts` | 8 | PDF generation magic byte validation and dummy layout rendering |
| `upload.test.ts` | 12 | Event cover uploads, R2 binding, magic byte (JPEG/PNG/WebP) checks, rate limits |
| `websocket-e2e.test.ts` | 6 | Full 101 WebSocket upgrades, CSWSH CORS defense, single-use ticket consumption |

## 12. Security Sweep Fixes (Day 3, Phase 2)

- A full endpoint-by-endpoint security sweep (per `SECURITY_SWEEP_BRIEF.md`) found 9 concrete findings; all 9 were fixed same-day, each with a regression
test exercising the real mechanism, not a mock of it.

- **Validation tightening.** `reserveSeat`'s `seatCount` was `z.number().min(1).max(10)` with no `.int()` — a client could request a fractional seat count. Since the DO computes availability via `SUM(seat_count)` across all reservations, a fractional value corrupts the exact arithmetic the concurrency guarantee
depends on. Now `.int()`, matching `totalSeats`'s existing convention. `pricePerSeat` gained a sanity upper bound (previously unbounded).

- **CORS / JWT origin split** — see the updated `### CORS` section above.

- **Error-message leak fixed in `ensureAttendee`** (`routers/bookings.ts`): its catch block forwarded a raw D1/SQLite exception message directly to the client. Unlike `reserveSeat`'s error passthrough (which forwards deliberately curated strings like `"Only N seats available"`), this one could leak genuine internal detail. Now logs the real error server-side, returns a generic message to the client.

- **Clerk webhook org-ownership conflict** (`handlers/clerk-webhook.ts`): `organisations.ownerId` has a unique index (one org per Clerk user, by design). The webhook previously used `.onConflictDoNothing()` on insert — a second organisation created by the same user silently vanished: no error, no log, `200` to Clerk, and the org existed in Clerk with no D1 row. The failure only surfaced later as a confusing FK error on `createEvent`. Now the specific `owner_id` constraint violation is detected narrowly (matched against the real D1/SQLite error message — `"organisations.owner_id"` — not a blanket catch of any unique-constraint failure, which would have also caught unrelated conflicts like `attendee_user_idx`) and logged loudly as `[ORG_OWNER_CONFLICT]` with both org IDs and the owner ID. Still returns `200` — this is a permanent business-rule violation, not a transient failure, so making Clerk retry achieves nothing; the log is the intended alerting surface once Sentry/Axiom land (Days 5-6). Any other DB error still returns `500` as before, verified by a dedicated regression test proving the new handling doesn't accidentally widen into "all DB failures return 200."

  **Update (A2: Org-Creation Loophole Fix):** the authoritative fix is now a Clerk Dashboard setting — organization-creation limit set to 1 per user — which closes this at the platform level, before any request reaches this app at all. The frontend `appearance.elements` CSS hide (`organizationSwitcherPopoverActionButton__createOrganization: { display: 'none' }`) and the backend FK-violation handling in `createEvent` are both still in place, but their role has changed: the CSS hide is now pure UX polish (avoids showing a button that would fail anyway), and the backend handling is now a defense-in-depth safety net for a case Clerk itself should prevent, not the load-bearing fix. Worth noting for anyone revisiting this later: the CSS hide alone was never a real access-control boundary — it's a visual-only change that a user could bypass via dev tools — so if the Clerk dashboard setting is ever reset or misconfigured, that specific defense reverts to nothing, while the backend handling continues to hold.

- **`bookings` table indexes**: added `booking_hold_idx` on `hold_id` (two live queries filter on it — `routers/bookings.ts`, `handlers/stripe-webhook.ts` —
neither had an index to use). Dropped `booking_stripe_idx` on `stripe_payment_intent_id` — confirmed via grep to be queried nowhere in the codebase; its own inline comment describing a webhook lookup pattern stopped being accurate after Day 1's webhook rewrite moved to querying by `holdId` instead. Generated via `drizzle-kit generate`, not hand-written, per the project's migration convention.

- **Upload content-type is now derived from real file bytes** (`handlers/upload.ts`), not trusted from the client. `file.type` is a client-declared multipart header, never previously checked against actual file content — and it flowed all the way through to `httpMetadata.contentType` in R2, which is echoed back verbatim as the `Content-Type` response header on every `/images/*` request. Now checks magic bytes directly (JPEG `FF D8 FF`; PNG's full 8-byte signature; WebP's `RIFF`/`WEBP` markers) and uses the derived type for both the stored extension and R2 metadata. The old client-type allow-list check was removed entirely rather than kept alongside the byte check — once byte detection is authoritative, a redundant client-type gate can only reject legitimate files for no security benefit. (The `X-Content-Type-Options: nosniff` response header itself remains deliberately deferred to Day 4 — this fix closes the underlying trust problem independently of that header.)

- **Rate limiting added in two places**, both using the existing `RateLimiter` DO (`rate-limiter.ts` itself required zero changes — `checkLimit(action, limit, windowMs)` is already fully identity-agnostic; the "identity" is entirely which DO instance you call, so anonymous IP-keying needed no new DO logic):
- `/upload/event-cover`: 5/60s per `userId` (tighter than `reserveSeat`'s 10/60s — this endpoint writes files to R2, not just a DB row).
- All three unauthenticated public tRPC procedures (`getAvailableSeats`,   `getPublicEvent`, `listPublicEvents`) share **one** `publicRead` budget (60/60s per IP) via `publicWorkerProcedure`'s middleware — a single combined bucket, not one per procedure, so rotating endpoints doesn't multiply the effective limit. `/images/*` gets its own separate `publicImageRead` budget (120/60s — a single event page can load several cover images at once).
- IP is sourced from `CF-Connecting-IP`, added to the tRPC `Context` in `packages/trpc/src/context.ts`. Verified trustworthy for this deployment before use: the Worker sits directly behind Cloudflare's edge with no intermediary proxies, and Cloudflare's edge sets/overwrites this header before the Worker ever sees the request — a client cannot spoof it. Missing-header fallback is a **fixed** sentinel (`'unknown-ip'`), not randomized per request — deliberately fail-closed (a shared, restrictive bucket) rather than fail-open (bypassing the limit entirely).

- **Reviewed and confirmed clean, not a finding**: realtime/socket-ticket authorization (`routers/realtime.ts`, `SeatLedger.mintTicket`/`redeemTicket`). Any authenticated user can request a ticket for any event, with no org/role check — but the only data ever broadcast over the resulting WebSocket (`{ type: 'seat_count', available }`) is identical to what `getAvailableSeats` already serves fully unauthenticated. The ticket gate is, if anything, more restrictive than the sensitivity of the data behind it warrants, not less. Tickets are correctly scoped at mint time from server-derived `ctx.userId`/ `ctx.orgId` (never client input), and doubly scoped at redemption — once by which DO instance the ticket even exists in, once again by an explicit `eventId` equality check.

- **Organiser-restricted endpoints (`createEvent`, `/upload/event-cover`).** New `requireOrganiserRole(ctx, requiredRole)` in `packages/permissions/src/index.ts`, kept separate from `requireActiveOrganisation` (other org-scoped read procedures — `listOrgEvents`, `getEventAttendees` — intentionally stay open to all org members). The same role check logic is manually enforced in the HTTP upload handler for `/upload/event-cover` by checking the Clerk JWT `o` (org) claim. This is a defensive fix, not a response to a live exploit: verified first that no invite-member feature exists anywhere in the codebase (`become-organiser.tsx` uses Clerk's own `<CreateOrganization />` with no custom member-invite flow), so every organisation today has exactly one member, always admin — the gap is currently unreachable. Fixed ahead of the onboarding page's own copy, which already promises "invite team members later."

- **Rate limiting added to two previously-unprotected authenticated procedures**, both using the existing `RateLimiter` DO, keyed by `userId`, 10/60s — same pattern as `reserveSeat` / `uploadEventCover` / `createEvent`:
  - `createCheckoutSession` (`routers/payments.ts`) — previously uncapped despite creating real external Stripe Checkout Session resources per call.
  - `createSocketTicket` (`routers/realtime.ts`) — previously uncapped despite consuming Durable Object resources per call.

- **Malformed multipart body in the upload handler.** `request.formData()` in `handlers/upload.ts` threw uncaught on a malformed body — nothing upstream in `index.ts` catches it either, so this produced an uncontrolled Workers-runtime error instead of an intentional `400`. Now wrapped in try/catch.

- **Confirmed false positive, for the record:** a suspected `createdAt` seconds-vs-milliseconds mismatch (`organisations`/`events`/`bookings` all use `integer(..., { mode: 'timestamp' })` with `strftime('%s', 'now')` as the default) was disproven by installing the exact pinned `drizzle-orm@0.45.2` standalone and reading its actual source: `mode: 'timestamp'` explicitly expects seconds (multiplies by 1000 on read, divides by 1000 on write) — correctly matched with `strftime('%s', ...)`'s seconds output. `events.date` was checked too; `createEvent` already does `new Date(input.date)` correctly.
No change was made. Documented here so this doesn't get re-flagged later without someone re-doing the verification.

- **Test infra note:** `tests/test-helpers.ts`'s `createTestCaller` previously made `orgId: null`/`role: null` silently indistinguishable from "not provided" — the old `??` fallback treated both the same, always defaulting to `'test-org-1'`/`'organiser'`. Fixed to distinguish them; this is what makes `createEvent`'s "missing organisation" test case possible at all. Confirmed no pre-existing test relied on the old behavior.

## 13. Response Headers & Request Hardening (Day 4, Phase 2)

- **Cleanup batch, zero remaining judgment calls**: orphaned `packages/shared/drizzle/` directory deleted; `dispatchCalendarInvite`'s `organizerEmail` omission in `stripe-webhook.ts` now has an explanatory comment (no organiser-email lookup exists yet); the two real `any` types fixed (`procedures.ts`'s DO id, now `DurableObjectId`; `clerk-webhook.ts`'s `evt: any` deliberately left — svix/`@clerk/backend` have no usable type); stray debug `console.log`s removed from `clerk-webhook.ts`; `robots.txt` added to `web-app`.

- **Hardcoded URLs removed.** All environment-specific URLs have been moved to configuration (`.dev.vars`, `.env.local`, `wrangler.jsonc`).
  - Worker's `WEB_APP_URL` now drives Stripe redirect URIs in `createCheckoutSession`.
  - Worker's `WORKER_URL` now drives image-URL construction in `createEvent`.
  - Web App's `NEXT_PUBLIC_WS_URL` and `NEXT_PUBLIC_UPLOAD_URL` replace static strings in `useSeatCount.ts` and `pages/events/create.tsx`.
  This prevents local development requests from accidentally hitting production endpoints and cleans up deployment configuration.

- **POST body size cap — 100KB, two-layer enforcement.** Nothing previously bounded raw tRPC request body size; `fetchRequestHandler` buffers and parses the full JSON body before Zod validation runs, so an unauthenticated caller could force the worker to buffer/parse an arbitrarily large body before anything rejects it. `checkBodySize()` in `index.ts` does a `Content-Length`-header fast-path rejection when present and trustworthy, and falls back to incremental byte-counting via `request.body.getReader()` (never buffering past the limit) when the header is absent or unreliable — chunks are preserved and reassembled into a reconstructed `Request` for the under-limit case, since reading `body` consumes it. Cap: 102400 bytes — largest legitimate payload (`createEvent`: name ≤200 chars, description ≤2000 chars, few numeric fields) is under 3KB even batched, so this is generous headroom, not a derived number.
  **Known runtime gotcha, worth documenting so it doesn't get re-flagged**: `SELF.fetch` (real dispatch in `@cloudflare/vitest-pool-workers`, not local `new Request()` construction) auto-computes and injects a `Content-Length` header for plain `Uint8Array`/`ArrayBuffer`-backed bodies. This means a naive boundary test using `Uint8Array` bodies silently exercises the `Content-Length` fast path for *both* the accept and reject cases, never the streaming reader loop's own boundary — the exact-boundary test for the streaming path (`102400`/`102401` bytes) has to use a real `ReadableStream` body (no explicit `Content-Length`) to genuinely prove the reader loop's own comparison is correct, not just the header check's.

- **`Cache-Control: no-store` applied uniformly to every `/trpc` response**, not just authenticated ones. `fetchRequestHandler` sets headers once per HTTP response, and tRPC batches public + authenticated calls into a single request — there's no clean point to differentiate by procedure at the point headers get set. This means some cacheable public data (`listPublicEvents`) also gets marked `no-store`; accepted tradeoff for correctness over the complexity of per-procedure differentiation. Does not touch the R2 image route's existing `Cache-Control: public, max-age=31536000, immutable`.

- **Security response headers** (`X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`, `Strict-Transport-Security: max-age=15552000; includeSubDomains` — 6 months, no `preload`, deliberately conservative for a first rollout) applied uniformly across the worker: tRPC responses, R2 images, uploads, CORS preflight, the `checkBodySize` 413, and both Clerk/Stripe webhook responses (including their error paths — server-to-server callers never see these headers, but uniform application was chosen for consistency over selectively exempting them). `nosniff` on `/images/*` is defense-in-depth on top of Day 3's upload-time magic-byte validation, not a replacement for it.
  
- **Known runtime exception, verified not assumed**: the WebSocket `101 Switching Protocols` response returned from `SeatLedger`'s live `stub.fetch()` has an immutable header guard in this runtime — attempting `.headers.set(...)` on it throws `TypeError: Can't modify immutable headers.`, confirmed directly against a real ticket-minted upgrade response, not a synthetic stand-in. `index.ts`'s `wsResponse.status === 101` branch deliberately returns the response unmodified; the ordinary `400 "Missing eventId"` case on the same route is *not* exempt and gets full headers like any other worker error response — the exemption is specific to the 101 handshake, not the whole WebSocket route.

- **Content-Security-Policy** — origins confirmed by reading the actual codebase, not assumed: worker API + WebSocket are the same origin (`event-booking-worker.aditya29.workers.dev`, HTTPS and WSS); event cover images are served from that same worker origin (`/images/events/{eventId}/cover.{ext}`, constructed server-side in `routers/events.ts` — no separate R2 public bucket domain); Stripe checkout is a full-page redirect (`window.location.href`), not an iframe or embedded Stripe.js, so no CSP entry needed for Stripe on the app's own pages; Clerk's Frontend API domain read from the actual configured publishable key. Shipped as `Content-Security-Policy-Report-Only` first, verified against real browser console violations across every Clerk-touching flow (sign-in, sign-up, `UserButton`, `OrganizationSwitcher`) plus event images, upload, checkout redirect, and the seat-count WebSocket, then flipped to enforcing once confirmed clean — never flipped blind. `style-src` needs `'unsafe-inline'` due to existing inline React `style={{}}` props across several pages; flagged, not refactored (out of scope).

- An early WS-header implementation used the *presence* of the 101-immutability exception to skip Sentry-equivalent header wrapping across the **entire** `wsResponse` branch, including the plain `400 "Missing eventId"` case — which has nothing WebSocket-protocol-specific about it and was silently getting zero security headers. Caught by testing the actual mechanical claim (`.headers.set()` on both a `400` and a real `101` response) rather than accepting the stated justification. Documented here as a general pattern: a documented protocol exception for *one* response shape on a route is not license to skip *every* response shape sharing that route.

---

## 14. Sentry Error Monitoring (Day 5, Phase 2)

- **Package**: `@sentry/cloudflare@10.70.0`, error monitoring only — Logging, Application Metrics, and Tracing are all disabled per the actual Sentry project configuration; nothing in this integration sends spans, traces, or performance data.

- **Compatibility flag: `nodejs_als`, not the broader `nodejs_compat`.** The SDK needs `node:async_hooks`'s `AsyncLocalStorage` for scope tracking (confirmed by reading the installed package's own source, `build/cjs/async.js`) — `nodejs_als` grants exactly that without the wider Node API surface `nodejs_compat` would expose. `wrangler.jsonc` had no `compatibility_flags` array at all previously, so this is a clean addition with nothing to conflict against.
  **Known project-specific safety check, worth documenting**: `packages/trpc/src/trpc.ts`'s `errorFormatter` reads `process.env.NODE_ENV` to decide whether to strip stack traces from client-facing errors — predates Sentry entirely. Verified this flag doesn't change what `process.env.NODE_ENV` resolves to in this runtime before shipping; `errorFormatter` itself was not touched.

- **Instrumentation surface**: top-level handler wrapped with `Sentry.withSentry(...)` in `index.ts`; both Durable Objects (`SeatLedger`, `RateLimiter`) wrapped with `instrumentDurableObjectWithSentry(...)`, exported under their original names so `wrangler.jsonc`'s `class_name` bindings and `index.ts`'s re-exports remain valid without any rename. A centralized tRPC `onError` hook on `fetchRequestHandler` captures unexpected internal failures; individual webhook/DO error sites were each classified by hand rather than mechanically wrapped.

- **tRPC error classification — not everything is an incident.** Expected application/control-flow error codes (`UNAUTHORIZED`, `FORBIDDEN`, `NOT_FOUND`, `CONFLICT`, `PRECONDITION_FAILED`, `TOO_MANY_REQUESTS`, `BAD_REQUEST`) are excluded from Sentry capture — they're normal outcomes (an expired hold, a rate limit, a missing resource), not bugs. Only genuinely unexpected failures (`INTERNAL_SERVER_ERROR` and anything not a deliberately-thrown expected code) get sent. The exclusion list was built by grepping this codebase's actual `TRPCError` usages, not from a generic list — a first pass missed `PRECONDITION_FAILED` (thrown in `payments.ts` for expired holds) precisely because it came from a textbook list instead of the real call sites; caught and added before shipping.

- **Non-tRPC error/log sites classified into three categories**, not mechanically converted from `console.error`:
  - *Actual exceptions* (genuinely unexpected — DB insert failures, unhandled seat-confirmation errors, WebSocket errors, R2 finalize failures) → `Sentry.captureException`.
  - *Expected/adversarial failures* (webhook signature verification failing on a malformed or malicious request) → left as `console.error` only; this is expected adversarial behavior, not an application bug, and sending it to Sentry would be noise.
  - *Non-throwing invariant/operational failures* (`[ORG_OWNER_CONFLICT]`, and Stripe webhook's `orphaned_hold`/`amount_mismatch`/event-or-attendee-not-found/stub-dispatch-failure) → `Sentry.captureMessage`. The `orphaned_hold` and `amount_mismatch` cases already carried code comments from Day 3 ("Loud on purpose; wire to Sentry/Axiom on days 5–6") — this wasn't a new judgment call, just following through on intent already left in the code.
  - `events.ts`'s three `createEvent` cover-image failure sites were traced individually rather than assumed covered by `onError`: two are genuine non-throwing soft-degradation paths (event still creates without a cover image) and stay `console.error`-only; the third (R2 finalize failure inside a real try/catch) is an actual infrastructure exception and gets `captureException`.

- **Sensitive data**: no secrets, authorization headers, webhook signatures, payment credentials, full request bodies, or raw third-party payloads are ever attached as Sentry context — only bare identifiers already present in existing logs (event/hold/org/user IDs), never whole objects copied wholesale.

- **DSN**: `SENTRY_DSN` declared in the `Env` type only, no value anywhere in git — configured via `wrangler secret put SENTRY_DSN`, same convention as every other secret in this project (`CLERK_SECRET_KEY`, `STRIPE_SECRET_KEY`, etc.). SDK confirmed to no-op safely (no throw, no interruption) when DSN is unset/empty, so local dev and CI are unaffected. Verified end-to-end with a temporary `captureMessage` smoke test through `listPublicEvents`, confirmed visible in the Sentry Issues tab, then fully removed (`git grep` confirms zero residue) before final commit.

- Two things an early draft got wrong, corrected before shipping — noted here so they don't get silently reintroduced later:

- 1. **`tracesSampleRate: 0` does not disable tracing.** The SDK's own docs: "Tracing is enabled if either this or `tracesSampler` is defined... set this and `tracesSampler` to `undefined` to disable tracing." `0` is still *defined* — it keeps tracing instrumentation active internally (spans still created and tracked) at 0% sample, not the same as off. Given the project's config is Tracing: disabled, the option is omitted entirely, not set to `0`.
- 2. A proposed Sentry payload for the `amount_mismatch` Stripe outcome referenced `result.userId` — that field doesn't exist on that branch's actual return type in `booking-confirmation.ts` (only `expectedPence`, `receivedPence`, `seatCount`, `holdId`, `eventId`). Caught by checking the real type before shipping; would otherwise have sent `undefined` in every such event indefinitely. `userId` is correctly present and used on the separate `attendee_not_found` branch, which does have it.

---

## 15. Audit Log Design (Day 7, Phase 2)

**What the table looks like**

The `audit_log` table lives in D1 (`packages/shared/src/schema.ts`) alongside the rest of the relational schema:

```
audit_log
  id              — uuid, pk
  event_type      — text (booking_confirmed | hold_released_explicit |
                           reconciliation_orphan_detected)
  hold_id         — nullable text — FK-style reference, not a real FK
  booking_event_id — nullable text — the event the hold belongs to
  user_id         — nullable text — Clerk userId of the actor
  org_id          — nullable text — organisation context
  detail          — nullable text — JSON blob for event-specific fields
  created_at      — integer, timestamp mode (seconds)
```

Indexes: `audit_event_type_idx` on `event_type`; `audit_booking_event_idx` on `booking_event_id`. Nullable FKs are intentional — the audit row outlives the rows it references and must never be blocked by a referential integrity failure.

**Why writes come from the webhook/cron layer, not from inside the DO**

The Durable Object is single-threaded. Its synchronous critical section (the block between "read available seats" and "insert the reservation row") must complete atomically with no awaited I/O in between. A `db.insert(auditLog)` is a D1 network round-trip; awaiting it inside that block would introduce an `await` across a write, breaking the concurrency guarantee the DO exists to provide — two concurrent `reserveSeat` calls could then interleave, and a third request could read a partially-updated seat count between the DO write and the D1 write.

Beyond the synchronous block: even for DO methods that are not themselves in a critical section (`confirmSeat`, `releaseSeat`, `alarm()`), writing to D1 from inside the DO creates a second storage system within the same isolate. If that write fails, the DO cannot roll back its own SQLite state — you now have a partial write spanning two systems *inside* the most correctness-critical code in the repository, with no recovery path.

The correct layer for audit writes is any caller that:
1. Already owns a D1 binding (`db`)
2. Runs outside the DO's synchronous block
3. Has enough context to know which event, hold, and user the action relates to

That is the Stripe webhook handler (for confirmation, expiry, payment failure) and the reconciliation cron (for orphan detection). All four call sites follow this pattern and wrap their audit inserts in their own `try/catch` (see §18).

---

## 16. Reconciliation Job (Day 7, Phase 2)

**What it does**

`apps/worker/src/reconciliation.ts`, triggered every 5 minutes by a Cloudflare Cron Trigger (`scheduled()` in `index.ts`), cross-checks every event's confirmed DO holds against D1 booking rows. An orphan is a hold that is:
1. Confirmed in the DO (`status = 'confirmed'`)
2. Past its expiration window (`expiresAt < Date.now()`)
3. Missing a corresponding `bookings` row in D1

On detection: an `audit_log` row is written, a Sentry `error`-level message is fired, and a structured log is emitted. The job does **not** write a booking row — detection and alerting only, recovery requires human intervention.

**Why `listConfirmedHolds()` over the hold_created-tracking alternative**

The alternative approach would be to write an audit row at hold-creation time (tracking every hold created) and then, at reconciliation time, look for created-but-unconfirmed holds past expiry. This was rejected for two reasons:

1. It requires audit rows to be written from inside the DO or immediately after `reserveSeat` returns — the timing problem described in §15 above.
2. It conflates two distinct states: a hold that was created and legitimately expired (the DO's alarm released it correctly) vs. a hold that was confirmed but never resulted in a D1 booking. Those need different responses; tracking creation does not let you distinguish them.

`listConfirmedHolds()` is a read-only method on the DO that scans `reservations WHERE status = 'confirmed'` and returns the results without consuming or mutating anything. The reconciliation job calls it, then joins against D1 to find which confirmed holds have no booking row. This is the minimal, correct query for the actual problem: "does every confirmed seat in the DO have a corresponding record in D1?"

**Why the `expires_at < now()` grace filter**

A hold transitions to `confirmed` in the DO before the D1 booking insert in `confirmBookingFromPayment`. If the reconciliation job ran in the window between those two writes, it would see a confirmed hold with no D1 row and fire a false-positive alert — classifying a healthy, in-flight confirmation as an orphan.

The `expires_at` grace filter eliminates this race. A hold's `expires_at` is set at creation time (15 minutes from now). The entire confirmation flow (DO confirm → D1 insert) completes in well under a second. By requiring `expiresAt < Date.now()` as an eligibility criterion, the reconciliation job ignores any hold that is still within its original hold window — which is an over-conservative filter (15 minutes of grace for a sub-second operation) but has zero false-positive risk.

**Why the 5-minute cron interval; detection latency trade-off**

Five minutes is the shortest Cloudflare Cron interval available (`*/5 * * * *`). This means an orphan created at time T can be detected at the earliest at the next cron tick after T. In the worst case:

- Hold created and confirmed: T=0 (DO and D1 write both succeed)
- D1 write fails; orphan created: T=0
- Hold was created with `expiresAt = T + 15min`
- Orphan is eligible for detection: T + 15min (once it's past the grace filter)
- Cron runs at: T + 15min rounded up to next 5-min boundary
- Worst-case detection: up to ~20 minutes from hold creation, ~5 minutes from when the hold becomes eligible

In practice, the detection latency from confirmation failure to alert is: expiry window (15 minutes) + cron interval (up to 5 minutes) = **up to ~20 minutes from hold creation, or about 5 minutes after the hold becomes eligible**. This is acceptable for an alert-and-recover flow; a real-time response is not needed because recovery (manual or automated) happens on a longer timescale anyway.

**Why `listConfirmedHolds()` is a zero-mutation method (tested)**

The method only reads from DO SQLite; it does not modify any row. This is enforced in the test suite with a zero-mutation assertion matching the pattern used for `getHold()`: the test calls `listConfirmedHolds()`, then verifies that the DO's state (available seats, reservation statuses) is identical before and after the call. This prevents someone from "helpfully" adding cleanup logic to the method in a future pass and inadvertently breaking the reconciliation job's invariant that it never mutates DO state.

**Reconciliation Scaling & Event Date Filter (A3):**

**Known limitation:** the events-date filter (`gte(events.date, cutoffDate)`) relies on `reserveSeat`'s "event already started" guard, which was introduced in this same fix. Any hold created before that guard existed, for an event dated more than 7 days in the past, would not be checked by this filter going forward. In practice this is low-impact: such holds would already be long-resolved (confirmed or expired) given the 15-minute hold lifecycle, so this only matters for genuinely stale, already-settled historical data — not anything currently in flight.

---

## 17. `hold_released_alarm` — Deliberately Excluded from D1 (Day 7, Phase 2)

When the DO's `alarm()` fires to release expired pending holds, it runs entirely inside the DO's own execution context — specifically inside a `ScheduledController` callback managed by Cloudflare's alarm infrastructure. There is no D1 binding available at the call site, and adding one would require passing `env` through a chain of private methods in the DO that currently have no need for it.

More importantly: `alarm()` is called by Cloudflare's runtime, not by application code. Any I/O failure inside `alarm()` (including a failed D1 audit write) would leave the alarm in a partially-executed state with no clean retry path at the application layer — Cloudflare does not expose alarm retry semantics to the DO's own code.

**Decision:** `hold_released_alarm` is deliberately not written to D1's `audit_log`. Alarm-driven expirations are fully observable through:
- The DO's own `logEvent({ type: 'EXPIRED', holdId, reason: 'alarm_expiry' })` call, which emits a structured `console.log` inside the DO.
- Cloudflare Workers Logpush, which ships those DO-emitted logs to Axiom via the existing pipeline (Day 6, Phase 2).
- The reconciliation job, which indirectly covers this path: if an alarm fires correctly, the hold is released from `confirmed`/`pending` and `listConfirmedHolds()` will no longer return it.

This is not a coverage gap; it's a deliberate division of observability concerns. D1 `audit_log` covers outcomes in the tRPC/webhook/cron layer where D1 writes are safe and appropriate. Axiom/Logpush covers DO-internal events where D1 writes are not. The two pipelines together give complete coverage without pulling D1 I/O into the DO's alarm path.

---

## 18. Audit-Write Failure Isolation — Why It Matters (Day 7, Phase 2)

**The bug**

Before the Day 7 correction pass, `stripe-webhook.ts`'s `'confirmed'` case placed the `db.insert(schema.auditLog)` call inline, before the integrations-dispatch block, with no `try/catch` of its own. The outer `confirmBookingFromPayment` call was wrapped in `try/catch`, but the `switch` statement handling its result was not.

If that audit insert threw (e.g., D1 overloaded, schema mismatch, transient network error), the exception propagated uncaught out of `handleStripeWebhook`. Stripe's retry then sees a non-200 response and requeues the event.

On retry, `confirmBookingFromPayment` calls `confirmSeat()` on the DO, which throws `HOLD_ALREADY_USED` (the hold was consumed in the first attempt). The code returns `already_confirmed` and the webhook immediately returns `200` — without executing the `'confirmed'` case at all. The integrations dispatch block (email confirmation, calendar invite) is inside that case. It never runs.

**The result**: a booking succeeds, the payment is collected, and the seat is correctly marked confirmed in the DO and D1 — but the confirmation email and calendar invite are permanently silently dropped. The `200` response to Stripe makes this look healthy across every observable signal except the attendee's inbox.

**The fix**

Every `db.insert(schema.auditLog)` call in `stripe-webhook.ts` (for `hold_expired`, `confirmed`, and `payment_failed`) and in `reconciliation.ts` is wrapped in its own isolated `try/catch`. On failure: `console.error`, `Sentry.captureMessage` at `warning` level with `holdId`/`eventId` in `extra`, and continue. The audit failure does not affect the function's return value.

The same swallow-and-continue pattern was already in use for the integrations block immediately below the audit write in the `'confirmed'` case — the pattern was already established; the audit write just wasn't following it yet.

**Why this class of bug is easy to miss**

Audit inserts feel like "just logging" — low-stakes, safe to call anywhere. The failure mode is not the audit write itself crashing anything; it's the interaction between the crash propagation path and Stripe's retry behavior and the idempotency branch structure. Tracing it requires following the control flow through three separate layers (audit write → outer handler → Stripe retry → `confirmBookingFromPayment` → `already_confirmed` branch) and noticing that the `already_confirmed` branch returns without executing the integrations block. Any one of those layers in isolation looks correct.

---

## 19. `updateEvent` Field Scoping & Invariant Boundaries (Day 8, Phase 2)

`updateEvent` (`routers/events.ts`) is deliberately restricted to updating only `name` and `description`. `totalSeats`, `pricePerSeat`, and `date` are intentionally excluded from mutation inputs.

**1. `totalSeats` immutability:**
- The SeatLedger Durable Object is the real-time authority on seat availability, initialized once with `totalSeats` and tracking `used` seats via `SUM(seat_count)` across active reservations.
- If `totalSeats` could be decreased by an organiser after reservations have started, `totalSeats` could drop below the count of already-confirmed-or-pending holds. This would corrupt the availability math (`totalSeats - used` going negative or inconsistent with DO state).
- Safely allowing `totalSeats` changes would require a complex distributed reconciliation protocol between D1 and the DO (e.g., rejecting reductions below active holds, updating internal DO limits, handling in-flight holds). Building that safely was judged out of scope; keeping `totalSeats` immutable preserves the DO correctness guarantee.

**2. `pricePerSeat` and `date` immutability:**
- Excluding `pricePerSeat` ensures that the amount calculated when creating a Stripe Checkout Session (`hold.seatCount × event.pricePerSeat`) remains strictly identical to what the webhook verifies upon payment confirmation.
- **Architectural note on `amount_mismatch` reachability:** The Day 7 review concluded that the `amount_mismatch` branch in `confirmBookingFromPayment` is unreachable in practice under normal operation because no event-editing mutation exists to alter prices mid-flight. If `pricePerSeat` or `date` are ever exposed in an event-updating mutation in the future, this conclusion **must be explicitly revisited**: a price change occurring while a customer is completing an open Stripe Checkout session would make `amount_mismatch` reachable in practice.

---

## 20. Ticket Delivery Mechanism & Security Refinements (Day 8, Phase 2)

### PDF Ticket Download via tRPC (`getTicket`)

`getTicket` returns `{ pdf: base64string, filename }` from a tRPC query rather than streaming raw PDF bytes from a custom HTTP endpoint with `Content-Type: application/pdf` and `Content-Disposition`.

**Trade-off evaluation & decision:**
- **Auth reuse:** Returning via tRPC allows direct reuse of the existing `workerProcedure` / `Context` authentication chain, attendee ownership matching (`ctx.userId === attendee.userId`), and organiser role verification (`requireOrganiserRole` with org matching) without duplicating JWT verification and route matching logic in a custom HTTP fetch handler.
- **Payload efficiency:** Generated ticket PDFs are small (~1-2KB). The ~33% base64 encoding overhead amounts to ~500 bytes, which is completely negligible over modern network connections.
- **Access model:** Tickets are strictly gated to the booking's attendee or event organiser. Because shareable/bookmarkable unauthenticated URLs are not a requirement, tRPC base64 delivery is simpler, safer, and completely adequate.

### `getTicket` Authorization Ordering

In `routers/tickets.ts`, authorization (`isOwnAttendee` and organiser role verification) is executed **immediately after fetching the booking row and before the status guard** (`row.bookingStatus !== 'confirmed'`):
- **Preventing Status Leaks:** If the status guard ran before authorization, unauthorized callers would receive `NOT_FOUND` ("No ticket available") for `pending` or `cancelled` bookings and `FORBIDDEN` for `confirmed` bookings. This would allow unauthorized users to probe arbitrary booking IDs to discover their status. Checking authorization first ensures that any unauthorized caller receives `FORBIDDEN` uniformly across all existing bookings.
- **Non-existent booking IDs:** Non-existent booking IDs return `NOT_FOUND` ("Booking not found"). This is an accepted trade-off because booking IDs are unguessable UUIDs (`crypto.randomUUID()`), rendering ID-enumeration or existence-probing attacks impractical.

### Cross-Site WebSocket Hijacking (CSWSH) Defense on `/ws`

`handleWebSocketUpgrade` (`handlers/websocket.ts`) validates the `Origin` header against `CORS_ALLOWED_ORIGINS`:
- **Why Origin validation is needed:** WebSocket upgrade handshakes bypass standard CORS preflights. While socket tickets are single-use and minted via Bearer-authenticated tRPC calls, Bearer tokens only provide incidental protection (browsers do not attach custom Authorization headers cross-origin). If socket authentication ever shifts to ambient credentials (such as cookies or session identifiers), cross-origin websites could establish unauthorized WebSocket connections on behalf of logged-in users. Validating `Origin` provides designed CSWSH protection.
- **Why absent-Origin is allowed:** Browsers unconditionally attach the `Origin` header to all WebSocket upgrade requests, making it unforgeable in browser contexts. Non-browser clients (automated integration tests, monitoring probes, CLI tools) often omit the `Origin` header. Permitting absent `Origin` preserves testing and tooling interoperability while strictly enforcing the allowlist for all browser-originated requests.

### Non-Mutating Security Headers (`applyWorkerSecurityHeaders`)

`applyWorkerSecurityHeaders` (`cors.ts`) reconstructs `new Response(response.body, { status, statusText, headers: new Headers(response.headers) })` rather than mutating `response.headers` in place.
- **Durable Object RPC immutability:** Responses returned across Durable Object RPC stubs (`stub.fetch(request)`) carry immutable header guards in the Cloudflare Workers runtime. In-place `.headers.set()` on a DO-generated response (such as a `400 "Missing ticket or eventId"`) throws `TypeError: Can't modify immutable headers`, which Sentry's outer handler would escalate into an unexpected 500 error.
- Reconstructing the `Response` with cloned `Headers` ensures uniform, safe application of security headers across both locally constructed responses and DO stub responses. All call sites (including `index.ts`'s tRPC handler) capture the returned reconstructed `Response`.

---

## 21. Networkless JWT Verification

Chose networkless JWT verification (via Clerk's JWKS public key, `CLERK_JWT_KEY`) over live JWKS fetching, trading automatic key-rotation awareness for lower per-request latency. This is acceptable at this scale, with the understanding that a future Clerk key rotation requires updating the Worker secret manually.

Worth stating explicitly: this fails **closed**, not open. If the key is ever out of date after a rotation, every request fails signature verification and returns `401` loudly — it does not silently accept a token it can no longer properly verify. That's what makes the latency/rotation-awareness trade-off acceptable: the failure mode of being wrong is "loud outage," not "silent security hole."

**Implementation Call Sites:**
- `packages/trpc/src/context.ts` (`createContext`, lines 56–59): All incoming authenticated tRPC requests verify the Bearer token via `verifyToken(token, { jwtKey: clerkJwtKey, authorizedParties })` using the static `env.CLERK_JWT_KEY` secret. Failure throws a `TRPCError` with code `UNAUTHORIZED` (`401`).
- `apps/worker/src/handlers/upload.ts` (`handleUpload`, lines 32–38): The event cover upload endpoint `/upload/event-cover` verifies the Bearer token via `verifyToken(token, { jwtKey: env.CLERK_JWT_KEY, authorizedParties: JWT_AUTHORIZED_PARTIES })`. Failure immediately returns `new Response('Unauthorized', { status: 401 })`.

---

## 22. ClerkProvider with `ssr: false` (Frontend Hydration Trade-off)

`apps/web-app/pages/_app.tsx` (lines 4–7) dynamically imports `ClerkProvider` with `{ ssr: false }`. This was the fix for a Day 3 deployment-only error (`invariant expected app router to be mounted`) that only manifested once deployed, not in local dev.

**Trade-off:** since `ClerkProvider` wraps the entire app (`<Component />` renders inside it, not beside it), nothing anywhere in the app can render server-side anymore — not just auth-gated pages. Every page, including fully public ones like event listings, now ships an empty shell on first response and hydrates client-side before anything becomes visible. This is directly observable in production: fetching the deployed frontend returns a page shell with no server-rendered content.

**Cost:** a visible blank/loading gap on every page load (worse on slow connections), and any SEO/crawlability benefit of SSR is lost app-wide rather than just for the pages that actually need Clerk's client. This wasn't scoped narrowly at the time because the immediate deployment blocker took priority — worth revisiting whether only the auth-dependent subtree needs the dynamic import, rather than the whole provider, so public pages could keep SSR.

---

## 23. Lazy Attendee Creation

Attendee rows are created lazily, on first use (`ensureAttendee` in `apps/worker/src/routers/bookings.ts`, lines 106–148), rather than eagerly at sign-up — mirroring the pattern used for organisation sync via the Clerk webhook, but implemented differently: rather than waiting for an async webhook to populate the row, `ensureAttendee` calls Clerk's API directly and synchronously at creation time (`clerk.users.getUser(ctx.userId)`) to get the real name/email immediately. The placeholder values (`''` email, `'Attendee'` name) are a degrade-gracefully fallback for if that live Clerk API call itself fails — not the primary path. A concurrent double-insert race (two simultaneous first-time calls) is handled by catching the resulting unique-constraint error and re-reading the now-existing row rather than failing the request.

---

## 24. Organiser-Initiated Refund Flow (Day 9, Phase 2)

Stretch item 2 of 4 from `PHASE_2_PLAN.md`: organiser-initiated full refunds via Stripe, returning released seats directly to the SeatLedger Durable Object and updating durable booking status in D1.

### 1. State Machine Invariant & Semantic Status Distinction

**Semantic Distinction in D1 & Durable Object:**
- **`'cancelled'` vs `'refunded'` (D1 `bookings.status`):**
  - `'cancelled'`: payment was never successfully completed (e.g. checkout abandoned, payment failed via webhook). The booking was never sold.
  - `'refunded'`: the booking was genuinely confirmed, paid for, and active, and subsequently financially reversed by an organiser refund.
- **`'released'` vs `'refunded'` (DO `reservations.status`):**
  - `'released'`: a pending hold that expired or was released by the attendee prior to payment.
  - `'refunded'`: a confirmed seat hold that was successfully sold and later refunded.

**The Central Invariant:**
- `pending` and `confirmed` reservations consume seats: `used_seats = SUM(seat_count) WHERE status = 'pending' OR status = 'confirmed'`.
- `released` and `refunded` reservations do NOT consume seats.
- Refunding a confirmed reservation returns its **entire** `seatCount` to availability immediately and purely by dropping out of the `SUM()` query in `getAvailableSeats()` — with no manual arithmetic, counters, or partial adjustments.
- The `pending → confirmed → refunded` lifecycle and the `pending → released` lifecycle are strictly separate, non-crossing paths:
  - `refundSeat()` only ever transitions `confirmed → refunded`.
  - `releaseSeat()` / alarm only ever transition `pending → released`.
  - Neither method gains awareness of the other's states beyond cleanly rejecting invalid transitions.

### 2. Ownership Boundary

- **Durable Object owns:** seat reservation state, the `confirmed → refunded` transition, real-time availability math (`getAvailableSeats()`), and broadcasting updated seat counts to connected WebSocket clients (`broadcastSeatCount()`).
- **D1 owns:** durable booking business records, historical status for attendees and organisers, and immutable audit logs (`audit_log`).
- D1 never tracks or tallies seat counts; the DO is the single source of truth for seat capacity.

### 3. Order of Operations & Failure Isolation

The mutation executes in strict sequence:
1. **D1 fetch & Authorization:** Organiser authentication and organisation ownership are verified via `requireOrganiserRole(ctx, 'organiser')` and `authorizeOrganiserAccess(ctx, eventOrgId)` before any Stripe interaction can take place.
2. **Stripe Refund:** Stripe owns the actual financial money movement. It executes first with a deterministic idempotency key (`refund_${bookingId}`).
3. **DO `refundSeat()`:** Releases the seat in the DO's SQLite storage and broadcasts the new seat count.
4. **Conditional D1 Status Update:** Updates `bookings.status` to `'refunded'` where `id = bookingId AND status = 'confirmed'`.
5. **Audit Log:** Writes an `audit_log` entry with `eventType: 'booking_refunded'`.

**Failure Isolation:**
If Stripe succeeds but the DO or D1 step throws unexpectedly:
- The mutation still reports **success** to the organiser to prevent double-refund attempts on retry (since Stripe has already moved the money).
- An alert is sent to Sentry at `error` level with full diagnostic context (`step`, `bookingId`, `holdId`, `eventId`, `stripePaymentIntentId`, `stripeRefundId`) enabling manual operational recovery without quiet data fabrication.

### 4. Stripe Idempotency Key vs. Already-Refunded Recovery

These are two distinct mechanisms:
- **Deterministic Idempotency Key (`refund_${bookingId}`):** Passed as `{ idempotencyKey: \`refund_\${bookingId}\` }` in `stripe.refunds.create()`. Protects against network drops or retries of the exact same request, causing Stripe to replay the original refund object without creating duplicate charges.
- **Already-Refunded Recovery:** Handles refunds that already exist (e.g., retrying after a prior partial local failure or manual Stripe refund).
  - Triggered strictly by structured Stripe error types: `StripeInvalidRequestError` with code `'charge_already_refunded'`.
  - Verification requirements:
    1. Retrieves the PaymentIntent via `stripe.paymentIntents.retrieve(stripePaymentIntentId)`.
    2. Lists all refunds across all pages using `stripe.refunds.list({ payment_intent, limit: 100 })`.
    3. Confirms that all refunds belong to this exact `stripePaymentIntentId`, have `status === 'succeeded'`, and aggregate to `paymentIntent.amount_received`.
    4. If fully verified, proceeds with local DO and D1 state reconciliation; otherwise rejects safely with an `error` level Sentry alert.

### 5. Concurrency Handling & Single Audit Log Guarantee

When two organiser refund requests for the same booking arrive simultaneously:
- **Stripe:** Deduplicated by the deterministic idempotency key.
- **DO:** Synchronized by the DO's single-threaded event loop; the second caller receives `HOLD_ALREADY_REFUNDED`, which is treated as idempotent success.
- **D1:** Guarded by conditional `UPDATE bookings SET status = 'refunded' WHERE id = ? AND status = 'confirmed'`. Drizzle's `.returning()` identifies whether 0 or 1 rows were modified.
  - **1 row returned:** This caller won the transition and writes the single `booking_refunded` audit log.
  - **0 rows returned:** Another caller won the transition. The caller re-reads the booking from D1 to confirm status is `'refunded'`. If verified, it skips audit logging without error. If D1 has an unexpected non-refunded status, an error is alerted to Sentry.

---

## Day 10 — Organisation Subscription

### 1. Business Model & Grandfathering Decision
- **Clean Slate Policy (No Grandfathering):** All organisations uniformly require an active (`active` or `trialing`) subscription to publish and create events from Day 10 onwards. There is no `not_required` status, no `subscriptionRequired` boolean flag, and no manual backfill migration.
- **Column Default:** `organisations.subscription_status` defaults strictly to `'inactive'` at the database schema level for all organisations.
- **Targeted Action Gating:** Only `createEvent` is gated by subscription status. Existing published events, bookings, attendees, ticket downloads, event updates (`updateEvent`), and uploads remain accessible even if an organisation's subscription is later canceled or past due.

### 2. Stripe Integration & Webhook Architecture
- **Separation of Domains:** Subscription billing is cleanly modularised in `apps/worker/src/routers/subscriptions.ts` and `apps/worker/src/subscription-helpers.ts`. It remains completely decoupled from ticket purchases, attendee payments, and the Day 9 refund flow. Attendees never receive Stripe Customer records; organisations map 1:1 to Stripe Customer records.
- **Proactive Customer Creation:** When an organiser calls `createSubscriptionCheckout`, the worker creates and stores `stripeCustomerId` in D1 *before* generating the Checkout Session in `mode: 'subscription'`.
- **Why `checkout.session.completed` Is Not Used:** Because `stripeCustomerId` is already persisted on the organisation row, Stripe's native `customer.subscription.*` events (`created`, `updated`, `deleted`) deliver complete `Stripe.Subscription` objects containing `.id`, `.customer`, and `.status`. In contrast, `checkout.session.completed` delivers only an unexpanded `subscription` ID string without `.status`. Relying directly on `customer.subscription.*` events ensures a unified lifecycle model.
- **Why `invoice.payment_failed` Is Out of Scope:** Day 10 implements server-side entitlement gating based on current status. When payments fail, Stripe transitions subscription status to `past_due` or `unpaid`, firing `customer.subscription.updated` which immediately updates entitlement. Proactive notifications (e.g. sending warning emails to organisers before cancellation) are a distinct notification feature for future roadmap consideration.

### 3. Concurrency & Invariant Protections
- **Server Authority & Role Authorization:**
  - `getSubscriptionStatus` strictly enforces `requireOrganiserRole(ctx, 'organiser')` so attendees cannot query organisation subscription state.
  - `getOrCreateStripeCustomer(db, stripe, orgId)` loads organisation attributes (such as `name`) directly from D1, ensuring caller-supplied inputs cannot inject or override organisation metadata.
- **Persistence Invariant Guard:**
  - `getOrCreateStripeCustomer` will never return a transient Stripe Customer ID if the conditional D1 persistence/re-fetch invariant cannot be verified. It immediately throws an internal error, preventing Checkout from proceeding with an unlinked or orphaned customer ID.
- **Atomic Compare-and-Set (CAS) Subscription Establishment:**
  - In `customer.subscription.created` and the out-of-order `customer.subscription.updated` handler, subscription ownership is claimed via an atomic conditional D1 update (`WHERE id = ? AND (stripe_subscription_id IS NULL OR subscription_status = 'canceled')`).
  - Ownership is determined strictly from the affected-row count (`.returning()`). If the claim loses the race (0 rows updated), the worker re-reads the organisation from D1, treats the incoming subscription as redundant, avoids overwriting D1, and defensively cancels the loser on Stripe via `stripe.subscriptions.cancel(subscription.id)`.
- **Concurrent Checkout & Duplicate Prevention:**
  - `createSubscriptionCheckout` applies per-organisation rate limiting via the `RATE_LIMITER` Durable Object and attaches a time-bucketed deterministic idempotency key (`sub_checkout_${orgId}_${bucket}`) to `stripe.checkout.sessions.create`.
- **Subscription Staleness & Out-of-Order Guards:**
  - Webhook event updates (`updated` and `deleted`) verify that `subscription.id === organisation.stripeSubscriptionId` before modifying `subscriptionStatus`. Events for stale or replaced subscriptions are logged and ignored, preventing old events from regressing entitlement state.
  - If a `customer.subscription.updated` event arrives before `customer.subscription.created` when `organisations.stripeSubscriptionId` is null, the handler establishes the subscription via the atomic CAS claim.

---

## Day 11 — Public Read-Only API (API-Key Authenticated)

### 1. Per-Organisation Scoping vs. Platform-Wide Public Listings
- **Platform-Wide Public Listings (`listPublicEvents` / `getPublicEvent`):** Unauthenticated tRPC procedures returning all upcoming events across all organisations on the platform. These remain untouched for discovery on the main platform website.
- **Organisation-Scoped Public API (`/api/v1/events`):** A dedicated, API-key-authenticated HTTP interface designed for third-party integrations (e.g. organisers embedding their own event calendars on external websites, native apps, or headless platforms). Each organisation generates its own API key and can query only its own events. Data from other organisations is strictly inaccessible and invisible.

### 2. API Key Format, Hashing, and Reveal-Once Model
- **Format:** `evbk_` static prefix followed by 256 bits of high-entropy cryptographically secure random bytes (64 hexadecimal characters) generated using Web Crypto's `crypto.getRandomValues()`.
  - The static prefix matches industry standards (e.g., Stripe's `sk_live_`, GitHub's `ghp_`), allowing secret scanning scanners to detect leaked keys automatically.
- **Storage & Lookups:** The raw key is **never** persisted in D1 or logged.
  - A SHA-256 digest (`crypto.subtle.digest('SHA-256', ...)`) is computed upon key generation and stored in the `organisation_api_keys.key_hash` column.
  - Incoming requests extract the `Bearer <key>` token, hash it with SHA-256, and perform an indexed equality lookup against `organisation_api_keys` where `revoked_at IS NULL`.
- **Why SHA-256 vs. Slow Password Hashes (e.g. bcrypt/argon2):**
  - Slow, memory-hard hashing algorithms exist to defend against dictionary attacks on human-chosen, low-entropy passwords.
  - API keys have 256 bits of true cryptographic entropy ($2^{256}$ keyspace). Brute-forcing a 256-bit space is computationally infeasible.
  - SHA-256 enables low-latency, zero-cost indexed lookup in Cloudflare Workers and D1 without wasting edge CPU cycles.
- **Reveal-Once Lifecycle:**
  - The full raw API key is returned in the HTTP response body **only once** at the instant of generation or rotation.
  - Subsequent queries (`getApiKeyInfo`) and dashboard views only return the safe-to-display prefix (`evbk_` + first 8 characters + `...`) and `createdAt` timestamp.
  - The raw key is never stored in browser `localStorage`/`sessionStorage`, never written to structured logs, never printed in console output, and never transmitted to Sentry.

### 3. Structural Database Invariant & Atomic CAS State Transitions
- **One Active Key Invariant:** Each organisation may possess at most one active key at a time.
- **Structural Database Enforcement:** Enforced natively at the database level via a Drizzle SQLite partial unique index:
  ```sql
  CREATE UNIQUE INDEX `org_api_keys_active_org_idx` ON `organisation_api_keys` (`organisation_id`) WHERE revoked_at IS NULL;
  ```
- **Compare-And-Swap (CAS) Concurrency Protection:**
  - *The Race Problem:* If rotate operations unconditionally revoke "whatever key is currently active" and insert a new key in sequence, multiple concurrent callers would execute sequentially in D1: each caller would revoke the previous caller's newly created key, resulting in multiple callers receiving successful responses containing keys that were immediately revoked.
  - *The CAS Solution:* `rotateApiKey` observes the specific active key record (`activeKey.id`). It performs an atomic D1 batch operation targeting that exact key:
    1. Statement 1: `UPDATE organisation_api_keys SET revoked_at = :now WHERE id = :activeKey.id AND revoked_at IS NULL;`
    2. Statement 2: `INSERT INTO organisation_api_keys (id, organisation_id, key_hash, key_prefix, created_at) VALUES (...);`
  - If a concurrent rotation already modified or revoked `activeKey.id`, Statement 1 affects 0 rows, and Statement 2 attempts to insert a second active key while the winner's key is active. The partial unique index (`org_api_keys_active_org_idx`) immediately trips, aborting the batch and rejecting the stale caller with a formatted `TRPCError` `CONFLICT`.
  - For first-time generation (`generateApiKey`), concurrent callers attempt `INSERT` directly; the partial unique index ensures exactly one caller succeeds while stale callers receive `CONFLICT`.
  - Stale/losing callers are rejected with `CONFLICT` and never receive a dead/revoked raw key.

### 4. `generateApiKey` vs. `rotateApiKey` Semantics
- **`generateApiKey`:** Intended for first-time key creation when an organisation has no active key. If an active key already exists, `generateApiKey` rejects with `CONFLICT` ("An active API key already exists for this organisation. Use rotateApiKey to replace it.").
- **`rotateApiKey`:** Intended for replacing an existing active key. Uses CAS conditional batch updates to safely rotate the observed key. If concurrent rotation requests occur, stale callers receive `CONFLICT`.
- Keeping these as distinct procedures provides explicit dashboard UI semantics (e.g. "Generate API Key" button shown only in empty state, "Rotate API Key" button shown when active key exists) and prevents accidental silent replacement of active integrations.

### 5. Permissive CORS & Security Boundary Architecture
- **Route-Specific Permissive CORS:**
  - Public API routes (`/api/v1/events` and `/api/v1/events/:id`) respond with:
    - `Access-Control-Allow-Origin: *`
    - `Access-Control-Allow-Methods: GET, OPTIONS`
    - `Access-Control-Allow-Headers: Authorization, Content-Type`
    - `Access-Control-Max-Age: 86400`
- **Security Boundary:**
  - CORS is **not** an authentication boundary. The security boundary is the possession and server-side verification of the secret API key provided via the `Authorization: Bearer <key>` header.
  - Permissive CORS (`*`) is secure here because authentication uses an explicit bearer token, not ambient browser credentials (cookies, HTTP basic auth, or session tokens).
  - The platform's global frontend CORS allowlist (`CORS_ALLOWED_ORIGINS` in `cors.ts`) and all protected tRPC routes remain completely unchanged and strictly restricted.

### 6. Exclusion of `lastUsedAt` Tracking
- Updating a `last_used_at` timestamp on each incoming read request would convert a lightweight, read-only cacheable hot path into a write-per-request hotspot on D1.
- To maintain maximum throughput and low latency, `lastUsedAt` tracking was deliberately excluded.

### 7. Endpoint Contracts & Boundaries
- **`GET /api/v1/events` (List Endpoint):**
  - **Filter:** Future events only (`events.date >= now`) belonging to the API key's organisation, ordered by `events.date ASC`.
  - **Public Safe Fields:** `id`, `name`, `date` (ms timestamp), `totalSeats`, `pricePerSeat`, `coverImageUrl`.
  - **No DO Fanout:** Deliberately excludes live seat count Durable Object lookups to eliminate N+1 DO requests.
- **`GET /api/v1/events/:id` (Single Event Endpoint):**
  - **Filter:** Returns event where `events.id = :id` AND `events.organisationId = :orgId`. Allows retrieving past events belonging to the organisation.
  - **Live Seat Composition:** Queries the event's `SeatLedger` DO (`stub.getAvailableSeats() ?? event.totalSeats`) and returns `availableSeats` in the JSON response.
  - **Unified 404 Behavior:** Returns generic 404 `{ "error": "Not Found" }` identically if the event does not exist OR belongs to another organisation, preventing organisation resource enumeration.

### 8. Day 11 Public API Architecture
- **Raw HTTP vs. tRPC:** The public API (`/api/v1/events`) is implemented as raw HTTP handlers (`apps/worker/src/handlers/public-api.ts`) built directly on the standard `Request`/`Response` API, completely bypassing the tRPC router.
- **Why Bypass tRPC?** tRPC is strictly designed for first-party frontend-to-backend communication. It uses a bespoke, batch-optimized JSON-RPC-like envelope that is hostile to third-party integrators expecting standard RESTful JSON APIs. The raw HTTP handlers provide a clean, predictable REST contract for external developers while internally reusing the exact same Drizzle queries and DO stubs.

### 9. API Pagination Implementation Detail
- **Mechanism:** Offset-based pagination over D1 SQLite.
- **Contract:**
  - `limit`: defaults to `50`. Client-provided values are clamped to a maximum of `100` rather than rejected with `400 Bad Request`, ensuring over-eager clients gracefully receive standard page sizes instead of failing.
  - `offset`: defaults to `0`.
  - **Response Structure:** `{ events: [...], pagination: { limit, offset, hasMore: boolean } }`. `hasMore` is derived by fetching `limit + 1` rows from D1 and returning `limit` rows, popping the extra row to set `hasMore = true`.
- **Runtime Protection Guardrail:** `offset` is strictly clamped to `MAX_OFFSET = 10000` (see §10). This protects the Worker's CPU time limits against excessively deep SQLite index scans, enforcing a ceiling on query cost for unauthenticated or abusive iteration.

### 10. Organiser Authorization Gating
- Organiser key-management mutations and queries (`generateApiKey`, `rotateApiKey`, `revokeApiKey`, `getApiKeyInfo`) in `apps/worker/src/routers/apiKeys.ts` require Clerk JWT authentication and enforce:
  1. `requireOrganiserRole(ctx, 'organiser')`
  2. `requireActiveOrganisation(ctx)`