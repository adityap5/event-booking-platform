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
| `STRIPE_SECRET_KEY` | worker | Stripe Checkout session creation |
| `STRIPE_WEBHOOK_SECRET` | worker | Verifies Stripe webhook signatures (`constructEventAsync`) |

**To add a new secret:** add it to the relevant `Env` type (`apps/worker/src/index.ts` or wherever it's consumed), set it locally in `.dev.vars`, and deploy it with `wrangler secret put <NAME>` from the correct app directory. It will not appear in `wrangler.jsonc` — secrets are never listed there.

---

## 5. Data Model

D1, via Drizzle (`packages/shared/src/schema.ts`), migrations always generated via `drizzle-kit`, never hand-written.

```
organisations
  id (uuid, pk)
  name
  ownerId          — Clerk userId of the creating user
  createdAt

events
  id (uuid, pk)
  organisationId   — FK → organisations.id, cascade delete
  name
  description      — nullable
  date             — integer, timestamp mode (full date+time, seconds precision)
  totalSeats
  pricePerSeat     — integer, smallest currency unit (pence), never floats
  coverImageUrl    — nullable, full public /images/... URL
  createdAt

attendees
  id (uuid, pk)
  userId           — Clerk userId, unique
  email
  name

bookings
  id (uuid, pk)
  eventId          — FK → events.id, cascade delete
  attendeeId       — FK → attendees.id, cascade delete
  status           — enum: pending | confirmed | cancelled
  holdId           — nullable (pre-hold-system rows have none)
  seatCount
  stripePaymentIntentId — nullable
  createdAt
```

**DO/D1 boundary for seat state:** D1's `bookings` table is the durable record of what was actually paid for and confirmed. The DO's own SQLite `reservations` table is the live, serialised source of truth for "is this seat available right now" — it exists only inside the DO instance for that event, is not queried directly by any other part of the system, and a pending hold in the DO does not yet have a corresponding bookings row in D1 (that row is only written by confirmBookingFromPayment, called exclusively from the Stripe webhook — see §2a). There is no client-triggered confirm path; confirmation happens server-side only, driven by a verified Stripe payment event.

**IDs are not enumerable.** Every primary key is a `crypto.randomUUID()`, not a sequential integer — a user cannot walk the dataset by incrementing a URL parameter.

All createdAt and date columns use mode: 'timestamp' (seconds), paired with strftime('%s', 'now') defaults (also seconds) — verified against drizzle-orm's actual source, not just assumed. See §12's follow-up pass for how this was confirmed." Skip this one if that section already documents the seconds convention clearly — it'd be redundant.

---

## 6. Caching vs Live Counts

**Rejected alternative: cache the full event payload including seat count.**

The public event page (`getPublicEvent`) caches static metadata (name, description, date, price, cover image) in KV for 5 minutes — this data changes rarely and a stale 5-minute-old name/price is a non-issue. **Seat count is deliberately excluded from this cached payload.** Available seats change on every booking; caching that number would mean serving a stale count on every cache hit for up to 5 minutes, directly defeating the purpose of the WebSocket-based live seat count system. Live seat counts are always read either from the SeatLedger DO directly (`getAvailableSeats`, for the unauthenticated polling fallback) or streamed over the WebSocket (for authenticated users) — never from KV.

This is the general principle applied throughout: **KV is a cache, not a lock, and not a source of truth for anything that changes faster than its TTL.**

---

## 7. Rate Limiting

**Rejected alternative: a counter stored in KV.**

KV has no atomic increment. Two simultaneous requests can both read `count = 9`, both write `count = 10`, and both succeed — the limit is silently bypassed under concurrent load. KV writes also propagate across Cloudflare's regions with delay, so even a single-threaded-looking increment can undercount if requests land in different regions.

**What we use: a dedicated `RateLimiter` Durable Object**, keyed by `idFromName(<key>)`, exposing `checkLimit(action, limit, windowMs)`. Because the DO is single-threaded, `checkLimit` is genuinely atomic — no bypass under concurrent load.

Two rate limits are enforced today:

| Action | Key | Limit |
|---|---|---|
| `reserveSeat` | `userId` | 10 per 60 seconds — per-attendee, booking-abuse concern |
| `createEvent` | `orgId` | 5 per hour — per-organisation (all members of an org share one quota, since event-creation abuse is an org-level concern, not an individual-teammate one) |

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

**Known data-quality gap in the current stub payloads** (not a stub design flaw — a caller-side gap): `eventName` is currently populated with the raw `eventId`, and `eventDate` are placeholder values (`Date.now()`) rather than the real event's stored data. Fix: change the webhook's `bookings` insert to use `.returning()` and thread the real event name/date through to the dispatch calls. Not implemented — acceptable at this scale, documented here so the next engineer wiring in a real provider doesn't inherit it silently.

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

**Two separate exports, not one (Day 3, Phase 2):** `CORS_ALLOWED_ORIGINS` and `JWT_AUTHORIZED_PARTIES` are kept as distinct constants even though they're currently identical (one entry: the deployed web-app URL). Originally a single `ALLOWED_ORIGINS` array was used for both CORS resolution *and* Clerk's `authorizedParties` JWT-audience check — which meant a JWT scoped to `http://localhost:3000` (present in that array for dev convenience) was valid against production. Dev/localhost/LAN origins were removed from the codebase entirely rather than gated behind an environment check — dev auth should point at a separate Clerk dev instance, not share production's trust boundary. The two constants stay separate so a future CORS-only dev origin can't silently become a trusted JWT audience by sharing the same value.

---

## 10. Known Weaknesses and Accepted Trade-offs

- Reconciliation job implemented; automatic healing remains deferred. The job detects confirmed DO holds without corresponding D1 bookings and raises an audit/Sentry alert, but deliberately does not create or repair booking rows.
- **`seat-ledger.ts` uses raw SQL, not Drizzle** — see point 2, deliberately deferred alongside its structural modularisation.
- **`apps/worker/src/router.ts` and `index.ts` have been split into `routers/`, `handlers/`, and `procedures.ts`; `seat-ledger.ts` and the web-app have not yet received the same treatment** — see `ROADMAP.md`.
- **No user-facing way to release a pending hold.** `releaseBooking` was removed Day 1 Phase 2 as dead code (zero callers at the time) — but it was the only path a user could ever voluntarily free their own hold. Combined with the same day's hold-exhaustion fix (§2c, reject-on-duplicate), a user who reserves seats and then changes their mind is now locked out of reserving again for up to 15 minutes, with no way to hurry it along. `booking/cancelled.tsx` (where Stripe sends users who back out of checkout) is purely informational and does not call `releaseSeat`. Fix: a minimal ownership-checked `releaseHold` procedure, wired to a "change seat count" action in the booking UI.
- **`getPublicEvent`'s cached metadata is never invalidated on event update.** The 5-minute KV cache described in §6 had exactly one invalidation path, `invalidateEventCache` — never called anywhere in the frontend, confirmed by grep before it was removed as dead code alongside `whoami`/`getEvent`/etc. on Day 1 Phase 2. Net effect, present since before that cleanup: editing an event's name/description/price does not update what public visitors see for up to 5 minutes; the cleanup didn't introduce this, it just removed the never-used procedure that was theoretically supposed to prevent it. Fix: whichever mutation updates an event row should call `ctx.env.EVENT_CACHE.delete(...)` inline, immediately after the D1 write succeeds — not via a separately exposed procedure the frontend has to remember to call.

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


## 12. Security Sweep Fixes (Day 3, Phase 2)

- A full endpoint-by-endpoint security sweep (per `SECURITY_SWEEP_BRIEF.md`) found 9 concrete findings; all 9 were fixed same-day, each with a regression
test exercising the real mechanism, not a mock of it.

- **Validation tightening.** `reserveSeat`'s `seatCount` was `z.number().min(1).max(10)` with no `.int()` — a client could request a fractional seat count. Since the DO computes availability via `SUM(seat_count)` across all reservations, a fractional value corrupts the exact arithmetic the concurrency guarantee
depends on. Now `.int()`, matching `totalSeats`'s existing convention. `pricePerSeat` gained a sanity upper bound (previously unbounded).

- **CORS / JWT origin split** — see the updated `### CORS` section above.

- **Error-message leak fixed in `ensureAttendee`** (`routers/bookings.ts`): its catch block forwarded a raw D1/SQLite exception message directly to the client. Unlike `reserveSeat`'s error passthrough (which forwards deliberately curated strings like `"Only N seats available"`), this one could leak genuine internal detail. Now logs the real error server-side, returns a generic message to the client.

- **Clerk webhook org-ownership conflict** (`handlers/clerk-webhook.ts`): `organisations.ownerId` has a unique index (one org per Clerk user, by design). The webhook previously used `.onConflictDoNothing()` on insert — a second organisation created by the same user silently vanished: no error, no log, `200` to Clerk, and the org existed in Clerk with no D1 row. The failure only surfaced later as a confusing FK error on `createEvent`. Now the specific `owner_id` constraint violation is detected narrowly (matched against the real D1/SQLite error message — `"organisations.owner_id"` — not a blanket catch of any unique-constraint failure, which would have also caught unrelated conflicts like `attendee_user_idx`) and logged loudly as `[ORG_OWNER_CONFLICT]` with both org IDs and the owner ID. Still returns `200` — this is a permanent business-rule violation, not a transient failure, so making Clerk retry achieves nothing; the log is the intended alerting surface once Sentry/Axiom land (Days 5-6). Any other DB error still returns `500` as before, verified by a dedicated regression test proving the new handling doesn't accidentally widen into "all DB failures return 200."

- **`bookings` table indexes**: added `booking_hold_idx` on `hold_id` (two live queries filter on it — `routers/bookings.ts`, `handlers/stripe-webhook.ts` —
neither had an index to use). Dropped `booking_stripe_idx` on `stripe_payment_intent_id` — confirmed via grep to be queried nowhere in the codebase; its own inline comment describing a webhook lookup pattern stopped being accurate after Day 1's webhook rewrite moved to querying by `holdId` instead. Generated via `drizzle-kit generate`, not hand-written, per the project's migration convention.

- **Upload content-type is now derived from real file bytes** (`handlers/upload.ts`), not trusted from the client. `file.type` is a client-declared multipart header, never previously checked against actual file content — and it flowed all the way through to `httpMetadata.contentType` in R2, which is echoed back verbatim as the `Content-Type` response header on every `/images/*` request. Now checks magic bytes directly (JPEG `FF D8 FF`; PNG's full 8-byte signature; WebP's `RIFF`/`WEBP` markers) and uses the derived type for both the stored extension and R2 metadata. The old client-type allow-list check was removed entirely rather than kept alongside the byte check — once byte detection is authoritative, a redundant client-type gate can only reject legitimate files for no security benefit. (The `X-Content-Type-Options: nosniff` response header itself remains deliberately deferred to Day 4 — this fix closes the underlying trust problem independently of that header.)

- **Rate limiting added in two places**, both using the existing `RateLimiter` DO (`rate-limiter.ts` itself required zero changes — `checkLimit(action, limit, windowMs)` is already fully identity-agnostic; the "identity" is entirely which DO instance you call, so anonymous IP-keying needed no new DO logic):
- `/upload/event-cover`: 5/60s per `userId` (tighter than `reserveSeat`'s 10/60s — this endpoint writes files to R2, not just a DB row).
- All three unauthenticated public tRPC procedures (`getAvailableSeats`,   `getPublicEvent`, `listPublicEvents`) share **one** `publicRead` budget (60/60s per IP) via `publicWorkerProcedure`'s middleware — a single combined bucket, not one per procedure, so rotating endpoints doesn't multiply the effective limit. `/images/*` gets its own separate `publicImageRead` budget (120/60s — a single event page can load several cover images at once).
- IP is sourced from `CF-Connecting-IP`, added to the tRPC `Context` in `packages/trpc/src/context.ts`. Verified trustworthy for this deployment before use: the Worker sits directly behind Cloudflare's edge with no intermediary proxies, and Cloudflare's edge sets/overwrites this header before the Worker ever sees the request — a client cannot spoof it. Missing-header fallback is a **fixed** sentinel (`'unknown-ip'`), not randomized per request — deliberately fail-closed (a shared, restrictive bucket) rather than fail-open (bypassing the limit entirely).

- **Reviewed and confirmed clean, not a finding**: realtime/socket-ticket authorization (`routers/realtime.ts`, `SeatLedger.mintTicket`/`redeemTicket`). Any authenticated user can request a ticket for any event, with no org/role check — but the only data ever broadcast over the resulting WebSocket (`{ type: 'seat_count', available }`) is identical to what `getAvailableSeats` already serves fully unauthenticated. The ticket gate is, if anything, more restrictive than the sensitivity of the data behind it warrants, not less. Tickets are correctly scoped at mint time from server-derived `ctx.userId`/ `ctx.orgId` (never client input), and doubly scoped at redemption — once by which DO instance the ticket even exists in, once again by an explicit `eventId` equality check.

### Follow-up pass (pre-Day-4)

- A second, targeted pass against 7 findings, each verified against real code or real library behavior before anything was implemented — not taken on faith from a pre-drafted list.

- **`createEvent` restricted to `org:admin`.** New `requireOrganiserRole(ctx, requiredRole)` in `packages/permissions/src/index.ts`, kept separate from `requireActiveOrganisation` (other org-scoped read procedures — `listOrgEvents`, `getEventAttendees` — intentionally stay open to all org members). This is a defensive fix, not a response to a live exploit: verified first that no invite-member feature
exists anywhere in the codebase (`become-organiser.tsx` uses Clerk's own `<CreateOrganization />` with no custom member-invite flow), so every organisation today has exactly one member, always admin — the gap is currently unreachable. Fixed ahead of the onboarding page's own copy, which already promises "invite team members later."

 -**Rate limiting added to two previously-unprotected authenticated procedures**, both using the existing `RateLimiter` DO, keyed by `userId`, 10/60s — same pattern as reserveSeat`/`uploadEventCover`/`createEvent`:
- `createCheckoutSession` (`routers/payments.ts`) — previously uncapped despite creating real external Stripe Checkout Session resources per call.
- `createSocketTicket` (`routers/realtime.ts`) — previously uncapped despite consuming Durable Object resources per call.

- **Malformed multipart body in the upload handler.** `request.formData()` in `handlers/upload.ts` threw uncaught on a malformed body — nothing upstream in `index.ts` catches it either, so this produced an uncontrolled Workers-runtime error instead of an intentional `400`. Now wrapped in try/catch.

- **Confirmed false positive, for the record:** a suspected `createdAt` seconds-vs-milliseconds mismatch (`organisations`/`events`/`bookings` all use `integer(..., { mode: 'timestamp' })` with `strftime('%s', 'now')` as the default) was disproven by installing the exact pinned `drizzle-orm@0.45.2` standalone and reading its actual source: `mode: 'timestamp'` explicitly expects seconds (multiplies by 1000 on read, divides by 1000 on write) — correctly matched with `strftime('%s', ...)`'s seconds output. `events.date` was checked too; `createEvent` already does `new Date(input.date)` correctly.
No change was made. Documented here so this doesn't get re-flagged later without someone re-doing the verification.

- **Test infra note:** `tests/test-helpers.ts`'s `createTestCaller` previously made `orgId: null`/`role: null` silently indistinguishable from "not provided" — the old `??` fallback treated both the same, always defaulting to `'test-org-1'`/`'org:admin'`. Fixed to distinguish them; this is what makes `createEvent`'s "missing organisation" test case possible at all. Confirmed no pre-existing test relied on the old behavior.

## 13. Response Headers & Request Hardening (Day 4, Phase 2)

- **Cleanup batch, zero remaining judgment calls**: orphaned `packages/shared/drizzle/` directory deleted; `dispatchCalendarInvite`'s `organizerEmail` omission in `stripe-webhook.ts` now has an explanatory comment (no organiser-email lookup exists yet); the two real `any` types fixed (`procedures.ts`'s DO id, now `DurableObjectId`; `clerk-webhook.ts`'s `evt: any` deliberately left — svix/`@clerk/backend` have no usable type); stray debug `console.log`s removed from `clerk-webhook.ts`; `robots.txt` added to `web-app`.

- **POST body size cap — 100KB, two-layer enforcement.** Nothing previously bounded raw tRPC request body size; `fetchRequestHandler` buffers and parses the full JSON body before Zod validation runs, so an unauthenticated caller could force the worker to buffer/parse an arbitrarily large body before anything rejects it. `checkBodySize()` in `index.ts` does a `Content-Length`-header fast-path rejection when present and trustworthy, and falls back to incremental byte-counting via `request.body.getReader()` (never buffering past the limit) when the header is absent or unreliable — chunks are preserved and reassembled into a reconstructed `Request` for the under-limit case, since reading `body` consumes it. Cap: 102400 bytes — largest legitimate payload (`createEvent`: name ≤200 chars, description ≤2000 chars, few numeric fields) is under 3KB even batched, so this is generous headroom, not a derived number.
  **Known runtime gotcha, worth documenting so it doesn't get re-flagged**: `SELF.fetch` (real dispatch in `@cloudflare/vitest-pool-workers`, not local `new Request()` construction) auto-computes and injects a `Content-Length` header for plain `Uint8Array`/`ArrayBuffer`-backed bodies. This means a naive boundary test using `Uint8Array` bodies silently exercises the `Content-Length` fast path for *both* the accept and reject cases, never the streaming reader loop's own boundary — the exact-boundary test for the streaming path (`102400`/`102401` bytes) has to use a real `ReadableStream` body (no explicit `Content-Length`) to genuinely prove the reader loop's own comparison is correct, not just the header check's.

- **`Cache-Control: no-store` applied uniformly to every `/trpc` response**, not just authenticated ones. `fetchRequestHandler` sets headers once per HTTP response, and tRPC batches public + authenticated calls into a single request — there's no clean point to differentiate by procedure at the point headers get set. This means some cacheable public data (`listPublicEvents`) also gets marked `no-store`; accepted tradeoff for correctness over the complexity of per-procedure differentiation. Does not touch the R2 image route's existing `Cache-Control: public, max-age=31536000, immutable`.

- **Security response headers** (`X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`, `Strict-Transport-Security: max-age=15552000; includeSubDomains` — 6 months, no `preload`, deliberately conservative for a first rollout) applied uniformly across the worker: tRPC responses, R2 images, uploads, CORS preflight, the `checkBodySize` 413, and both Clerk/Stripe webhook responses (including their error paths — server-to-server callers never see these headers, but uniform application was chosen for consistency over selectively exempting them). `nosniff` on `/images/*` is defense-in-depth on top of Day 3's upload-time magic-byte validation, not a replacement for it.
  **Known runtime exception, verified not assumed**: the WebSocket `101 Switching Protocols` response returned from `SeatLedger`'s live `stub.fetch()` has an immutable header guard in this runtime — attempting `.headers.set(...)` on it throws `TypeError: Can't modify immutable headers.`, confirmed directly against a real ticket-minted upgrade response, not a synthetic stand-in. `index.ts`'s `wsResponse.status === 101` branch deliberately returns the response unmodified; the ordinary `400 "Missing eventId"` case on the same route is *not* exempt and gets full headers like any other worker error response — the exemption is specific to the 101 handshake, not the whole WebSocket route.

- **Content-Security-Policy** — origins confirmed by reading the actual codebase, not assumed: worker API + WebSocket are the same origin (`event-booking-worker.aditya29.workers.dev`, HTTPS and WSS); event cover images are served from that same worker origin (`/images/events/{eventId}/cover.{ext}`, constructed server-side in `routers/events.ts` — no separate R2 public bucket domain); Stripe checkout is a full-page redirect (`window.location.href`), not an iframe or embedded Stripe.js, so no CSP entry needed for Stripe on the app's own pages; Clerk's Frontend API domain read from the actual configured publishable key. Shipped as `Content-Security-Policy-Report-Only` first, verified against real browser console violations across every Clerk-touching flow (sign-in, sign-up, `UserButton`, `OrganizationSwitcher`) plus event images, upload, checkout redirect, and the seat-count WebSocket, then flipped to enforcing once confirmed clean — never flipped blind. `style-src` needs `'unsafe-inline'` due to existing inline React `style={{}}` props across several pages; flagged, not refactored (out of scope).

### Day 4 — the actual reviewer catch worth documenting

An early WS-header implementation used the *presence* of the 101-immutability exception to skip Sentry-equivalent header wrapping across the **entire** `wsResponse` branch, including the plain `400 "Missing eventId"` case — which has nothing WebSocket-protocol-specific about it and was silently getting zero security headers. Caught by testing the actual mechanical claim (`.headers.set()` on both a `400` and a real `101` response) rather than accepting the stated justification. Documented here as a general pattern: a documented protocol exception for *one* response shape on a route is not license to skip *every* response shape sharing that route.

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

### Day 5 — the actual reviewer catches worth documenting

Two things an early draft got wrong, corrected before shipping — noted here so they don't get silently reintroduced later:

1. **`tracesSampleRate: 0` does not disable tracing.** The SDK's own docs: "Tracing is enabled if either this or `tracesSampler` is defined... set this and `tracesSampler` to `undefined` to disable tracing." `0` is still *defined* — it keeps tracing instrumentation active internally (spans still created and tracked) at 0% sample, not the same as off. Given the project's config is Tracing: disabled, the option is omitted entirely, not set to `0`.
2. A proposed Sentry payload for the `amount_mismatch` Stripe outcome referenced `result.userId` — that field doesn't exist on that branch's actual return type in `booking-confirmation.ts` (only `expectedPence`, `receivedPence`, `seatCount`, `holdId`, `eventId`). Caught by checking the real type before shipping; would otherwise have sent `undefined` in every such event indefinitely. `userId` is correctly present and used on the separate `attendee_not_found` branch, which does have it.

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

**Why writes come from the tRPC/webhook/cron layer, not from inside the DO**

The Durable Object is single-threaded. Its synchronous critical section (the block between "read available seats" and "insert the reservation row") must complete atomically with no awaited I/O in between. A `db.insert(auditLog)` is a D1 network round-trip; awaiting it inside that block would introduce an `await` across a write, breaking the concurrency guarantee the DO exists to provide — two concurrent `reserveSeat` calls could then interleave, and a third request could read a partially-updated seat count between the DO write and the D1 write.

Beyond the synchronous block: even for DO methods that are not themselves in a critical section (`confirmSeat`, `releaseSeat`, `alarm()`), writing to D1 from inside the DO creates a second storage system within the same isolate. If that write fails, the DO cannot roll back its own SQLite state — you now have a partial write spanning two systems *inside* the most correctness-critical code in the repository, with no recovery path.

The correct layer for audit writes is any caller that:
1. Already owns a D1 binding (`db`)
2. Runs outside the DO's synchronous block
3. Has enough context to know which event, hold, and user the action relates to

That is the Stripe webhook handler (for confirmation, expiry, payment failure) and the reconciliation cron (for orphan detection). All three call sites follow this pattern and wrap their audit inserts in their own `try/catch` (see §18).

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