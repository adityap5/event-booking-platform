# Roadmap

Project roadmap and technical debt tracking for the Event Booking Platform. Grounded in actual codebase state following the completion of Phase 2 (Days 1–11).

---

## 1. Done (Completed in Phase 2)

The following items from previous roadmaps, testing gaps, and hardening sweeps have been fully implemented and verified against current code:

### PDF Ticket Generation & Retrieval
- **Resolution:** Implemented on Day 8 (`apps/worker/src/routers/tickets.ts`, `apps/worker/src/ticket-pdf.ts`, `apps/worker/src/handlers/stripe-webhook.ts`).
- Confirmed bookings generate PDF tickets stored in R2 at webhook confirmation time. The `getTicket` tRPC query retrieves the ticket as base64 with automatic lazy fallback generation if the R2 asset is missing.

### Organiser-Initiated Refund Flow
- **Resolution:** Implemented on Day 9 (`apps/worker/src/routers/refunds.ts`, `apps/worker/src/seat-ledger.ts`).
- Organisers can refund confirmed bookings via Stripe using deterministic idempotency keys (`refund_${bookingId}`). The SeatLedger DO returns refunded seats to available inventory via `refundSeat()` (`confirmed → refunded`), while D1 updates `bookings.status` to `'refunded'` with Compare-and-Swap concurrency protection and audit logging.

### Organisation Subscription Lifecycle & Entitlement Gating
- **Resolution:** Implemented on Day 10 (`apps/worker/src/routers/subscriptions.ts`, `apps/worker/src/handlers/stripe-webhook.ts`, `apps/worker/src/subscription-helpers.ts`).
- Full Stripe Billing lifecycle integration. Organisations map 1:1 to Stripe Customers; webhook handlers process `customer.subscription.created`, `updated`, and `deleted` with atomic CAS claims and out-of-order delivery guards. `createEvent` is strictly gated on active or trialing subscription status.

### Public Read-Only API (API-Key Authenticated)
- **Resolution:** Implemented on Day 11 (`apps/worker/src/handlers/public-api.ts`, `apps/worker/src/services/api-key-service.ts`, `apps/worker/src/routers/apiKeys.ts`).
- Provides `/api/v1/events` and `/api/v1/events/:id` authenticated via high-entropy API keys (`evbk_` prefix). Includes SHA-256 hashed storage, reveal-once key generation, atomic CAS key rotation, permissive CORS (`*`), and RateLimiter DO throttling.

### User-Facing Hold-Release Action (`releaseHold`)
- **Resolution:** Implemented in commit `99104b6` (`apps/worker/src/routers/bookings.ts:122-156`).
- Added the `releaseHold` tRPC procedure with ownership verification, allowing users who abandon checkout to explicitly release their pending hold in the DO before the 15-minute alarm expiry.

### Public Event KV Cache Invalidation
- **Resolution:** Implemented in commit `b8dc254` (`apps/worker/src/routers/events.ts:20-34, 298-300, 340-346`).
- `createEvent` and `updateEvent` invoke `safeInvalidateCache()` inline after D1 writes succeed to immediately purge `event:${eventId}` and `events:public` from Workers KV.

### Integration Stub Real Payload Metadata
- **Resolution:** Implemented in commit `c3a48ae` (`apps/worker/src/handlers/stripe-webhook.ts:202-268`).
- The webhook looks up real `name` and `date` from the `events` table in D1 and threads them to `dispatchEmailConfirmation` and `dispatchCalendarInvite`, replacing initial mock placeholders.

### Direct Unit Tests for `RateLimiter` Durable Object
- **Resolution:** Implemented in `apps/worker/tests/rate-limiter.test.ts`.
- Direct unit tests using `runInDurableObject` verifying sliding window rollover, limit enforcement, zero mutation on rejected calls, key isolation across multiple actions within the same DO instance, and serialization of 20 concurrent increments with zero lost updates.

### End-to-End WebSocket Upgrade Test
- **Resolution:** Implemented in `apps/worker/tests/websocket-e2e.test.ts`.
- End-to-end integration tests over the full HTTP `/ws` pipeline verifying RFC 6455 101 Switching Protocols upgrade negotiation, initial seat count push over `res.webSocket`, security header protocol bypass on 101, single-use ticket enforcement, expired ticket rejection (401), event ID mismatch rejection (401), and CSWSH `Origin` allowlist defense (403).

---

## 2. Known Weaknesses (Accepted Trade-Offs, Not Fixed)

Deliberate architectural trade-offs that remain in production. Each item has been verified against current code:

### `hold_expired` Silent-Alerting and Unrefunded Gap
- **Code Site:** `apps/worker/src/handlers/stripe-webhook.ts:85-101`
- **Current Behavior:** If a customer completes payment after their 15-minute seat hold has expired, the webhook releases the hold, inserts an audit log (`hold_released_explicit`), and returns `200` to Stripe. It does **not** allocate a seat, does **not** trigger an automatic Stripe refund, and fires **no Sentry error alert** (unlike `orphaned_hold` which triggers Sentry `error`).
- **Accepted Reasoning:** Building an automated asynchronous refund flow or seat re-allocation mechanism for expired holds introduces edge-case races into the core webhook handler. The audit record enables manual reconciliation.

### Hardcoded URLs in Web App CSP Middleware
- **Code Site:** `apps/web-app/middleware.ts:4-18`
- **Current Behavior:** Content-Security-Policy URLs (`https://event-booking-worker.aditya29.workers.dev`, `https://saved-foxhound-17.clerk.accounts.dev`) are hardcoded in the middleware file.
- **Accepted Reasoning & Verification:** Build testing verified that Next.js statically inlines `process.env.NEXT_PUBLIC_*` variables into middleware bundles at build time (e.g. `process.env.NEXT_PUBLIC_TRPC_URL` compiles to its literal string value). However, dynamic runtime environment variables (non-`NEXT_PUBLIC_*`) remain unavailable in edge middleware without Cloudflare bindings, and hardcoding static domains was retained as an explicit, zero-dependency policy definition.

### Exclusion of `lastUsedAt` Tracking on API Keys
- **Code Site:** `apps/worker/src/handlers/public-api.ts`, `apps/worker/src/services/api-key-service.ts`
- **Current Behavior:** Successful requests to `/api/v1/events` do not record a `last_used_at` timestamp in D1.
- **Accepted Reasoning:** Updating a timestamp on every incoming read request would transform a lightweight, cacheable read path into a high-frequency write bottleneck on D1 SQLite.

### No `invoice.payment_failed` Webhook Handling
- **Code Site:** `apps/worker/src/handlers/stripe-webhook.ts`
- **Current Behavior:** The Stripe webhook does not explicitly listen for or handle `invoice.payment_failed` events.
- **Accepted Reasoning:** When an invoice payment fails, Stripe automatically transitions the subscription status to `past_due` or `unpaid` and emits `customer.subscription.updated`, which the worker already consumes to update entitlements in D1. Proactive warning emails prior to subscription cancellation are deferred as a dedicated notification feature.

### `checkout.session.completed` Omission for Subscriptions
- **Code Site:** `apps/worker/src/handlers/stripe-webhook.ts`, `apps/worker/src/routers/subscriptions.ts`
- **Current Behavior:** The subscription flow ignores `checkout.session.completed` events and relies strictly on `customer.subscription.*` events.
- **Accepted Reasoning:** `stripeCustomerId` is persisted proactively to the organisation row prior to Checkout Session creation. Native `customer.subscription.*` events deliver complete `Stripe.Subscription` objects with `.status` and `.id`, whereas `checkout.session.completed` provides unexpanded identifiers.

### Automated Healing for Orphaned Holds Deferred
- **Code Site:** `apps/worker/src/reconciliation.ts`
- **Current Behavior:** The cron reconciliation job detects confirmed DO holds missing D1 booking records and emits Sentry `error` alerts and audit logs, but does not automatically write booking rows.
- **Accepted Reasoning:** Auto-repairing booking rows without attendee verification carries a risk of quiet data corruption. Alerting ensures that operational incidents are investigated by human operators.

### Client-Only Hydration via `ClerkProvider` (`ssr: false`)
- **Code Site:** `apps/web-app/pages/_app.tsx:4-7`
- **Current Behavior:** `ClerkProvider` is imported dynamically with `{ ssr: false }`, rendering an empty page shell that hydrates client-side across all routes.
- **Accepted Reasoning:** Resolves a production deployment crash (`invariant expected app router to be mounted`). Eliminates SSR across the web app, trading initial page load SEO for stable authentication initialization.

---

## 3. Still Open / Left to Do (Future Roadmap)

Genuine unfinished technical tasks and enhancements:

### 1. Drizzle ORM Inside the SeatLedger Durable Object
- **Context:** `apps/worker/src/seat-ledger.ts` uses raw prepared SQL statements against `this.ctx.storage.sql`, while the rest of the codebase uses Drizzle ORM over D1.
- **Status:** Still open. Drizzle's DO SQLite integration (`drizzle-orm/durable-sqlite`) uses separate migration tooling. Keeping raw SQL preserves visibility over the synchronous critical section until structural modularisation is completed.

### 2. SeatLedger Modularisation
- **Context:** `apps/worker/src/seat-ledger.ts` remains a monolithic file managing initialization, seat reservations, holds, alarms, ticket minting/redemption, refunds, and WebSocket broadcasting.
- **Status:** Still open. Modularising `seat-ledger.ts` into isolated domain services (reservation engine, alarm manager, socket hub) will reduce incidental regression risks.

### 3. Organiser Email Lookup for Calendar Invites
- **Context:** `dispatchCalendarInvite` in `apps/worker/src/handlers/stripe-webhook.ts:248` omits `organizerEmail` with an explanatory comment.
- **Status:** Still open. Requires implementing an organiser email query from Clerk or D1 to populate organizer details in calendar invite payloads.
