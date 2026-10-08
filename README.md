# Event Booking Platform

A full-stack event booking platform built on the Cloudflare edge, featuring real-time seat reservation, Stripe payments, PDF ticket generation, and a public REST API. Structured as a Turborepo monorepo with strict application boundaries.

---

## Architecture Overview

```
apps/
  web-app/     Next.js (Pages Router), deployed to Cloudflare Workers via OpenNext
  worker/      Cloudflare Worker — owns tRPC, D1, Durable Objects, R2, KV
packages/
  shared/      Drizzle schema, shared types
  trpc/        tRPC setup, context, shared middleware (auth, org-access)
  permissions/ authorisation helpers, framework-agnostic
```

**The frontend never touches the database.** Every read/write goes through `apps/worker` over tRPC. The web app has no Drizzle dependency and no D1/KV/R2/DO bindings — only an `ASSETS` binding and a private `WORKER_SERVICE` binding for SSR calls.

For the full system topology and sequence diagrams, see [ARCHITECTURE_DIAGRAM.md](./ARCHITECTURE_DIAGRAM.md).

---

## Key Features

- **Real-time seat reservation** — per-event `SeatLedger` Durable Object provides a single-threaded critical section that prevents overselling without relying on D1 transactions.
- **15-minute holds with alarm-based expiry** — seat holds are released via the Cloudflare DO Alarm API (survives DO hibernation), not `setTimeout`.
- **Stripe Checkout & Billing** — seat purchase via Checkout Sessions; organisation subscriptions via Stripe Billing with full `customer.subscription.*` webhook lifecycle handling.
- **PDF ticket generation** — tickets are generated on webhook confirmation and stored in a private R2 bucket; `getTicket` provides lazy fallback generation.
- **Organiser refunds** — organisers can refund confirmed bookings via Stripe with deterministic idempotency keys; seats are atomically returned to inventory in the DO.
- **Live seat updates** — WebSocket endpoint (`/ws`) backed by the `SeatLedger` DO, with single-use ticket enforcement and CSWSH origin allowlist defence.
- **Public REST API** — `/api/v1/events` authenticated via high-entropy `evbk_` API keys (SHA-256 hashed in D1), with RateLimiter DO throttling and permissive CORS.
- **KV caching** — public event metadata cached in Cloudflare KV with a 5-minute TTL and invalidated inline on `createEvent`/`updateEvent`.
- **Reconciliation cron** — a `*/5 * * * *` scheduled handler cross-checks DO holds against D1 bookings and surfaces orphaned holds to Sentry.
- **Rate limiting** — all authenticated and public endpoints are rate-limited via the `RateLimiter` Durable Object (sliding window, per-key, atomic).

---

## Technology Stack

| Layer | Technology |
|---|---|
| Monorepo | Turborepo + pnpm workspaces |
| Frontend | Next.js (Pages Router) via `@opennextjs/cloudflare` |
| Backend | Cloudflare Workers (tRPC router + raw HTTP handlers) |
| Database | Cloudflare D1 (SQLite) with Drizzle ORM |
| Seat state | Cloudflare Durable Objects (`SeatLedger`) |
| Rate limiting | Cloudflare Durable Objects (`RateLimiter`) |
| Object storage | Cloudflare R2 (event covers + PDF tickets) |
| Cache | Cloudflare KV (public event metadata) |
| Auth | Clerk (JWT verification via static `CLERK_JWT_KEY`) |
| Payments | Stripe Checkout, Stripe Billing |
| Monitoring | Sentry (`@sentry/cloudflare`), Cloudflare Logpush → Axiom |
| API layer | tRPC v11 (end-to-end type-safe, no separate types package) |
| Language | TypeScript |

---

## Prerequisites

- **Node.js** ≥ 18
- **pnpm** ≥ 11.1.1 (auto-downloaded via `devEngines` if missing)
- **Wrangler** CLI (installed as a dev dependency)
- Cloudflare account with D1, R2, KV, and Durable Objects enabled
- Clerk application (for authentication)
- Stripe account (for payments)

---

## Getting Started

### 1. Install dependencies

```bash
pnpm install
```

### 2. Configure environment variables

**Worker** (`apps/worker/.dev.vars`):

```bash
CLERK_SECRET_KEY=sk_test_...
CLERK_JWT_KEY=...           # Public key for networkless JWT verification
STRIPE_SECRET_KEY=sk_test_...
STRIPE_WEBHOOK_SECRET=whsec_...
STRIPE_SUBSCRIPTION_WEBHOOK_SECRET=whsec_...
SENTRY_DSN=https://...
```

**Web app** (`apps/web-app/.env.local`):

```bash
NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=pk_test_...
NEXT_PUBLIC_TRPC_URL=http://localhost:8787/trpc
NEXT_PUBLIC_WORKER_URL=http://localhost:8787
```

### 3. Set up the database

```bash
cd apps/worker
npx wrangler d1 migrations apply event-booking-db --local
```

### 4. Run locally

```bash
# From the repo root — starts both apps in parallel
pnpm dev
```

- **Web app**: http://localhost:3000
- **Worker**: http://localhost:8787

---

## Scripts

Run from the repo root via Turborepo:

| Command | Description |
|---|---|
| `pnpm dev` | Start both apps in development mode |
| `pnpm build` | Build all apps and packages |
| `pnpm deploy` | Deploy all apps to Cloudflare |
| `pnpm lint` | Lint all packages |
| `pnpm clean` | Clean build artefacts |

---

## Testing

Tests live in `apps/worker/tests/` and run against real Cloudflare primitives via `@cloudflare/vitest-pool-workers`:

```bash
cd apps/worker
pnpm test
```

Key test suites:

| File | Coverage |
|---|---|
| `rate-limiter.test.ts` | Sliding window, limit enforcement, key isolation, 20 concurrent increments |
| `websocket-e2e.test.ts` | RFC 6455 upgrade, single-use ticket enforcement, CSWSH origin defence |
| Concurrency tests | 20 parallel `reserveSeat` calls on a 1-seat event — exactly one succeeds |

---

## Deployment

### Provision Cloudflare resources (first time only)

```bash
# R2 buckets
npx wrangler r2 bucket create event-covers
npx wrangler r2 bucket create event-tickets   # private — never serve publicly

# KV namespace
npx wrangler kv namespace create EVENT_CACHE

# D1 database
npx wrangler d1 create event-booking-db
npx wrangler d1 migrations apply event-booking-db --remote
```

### Deploy

```bash
# Worker
cd apps/worker && npx wrangler deploy

# Web app
cd apps/web-app && npx wrangler deploy
```

Or from the repo root:

```bash
pnpm deploy
```

---

## Project Documentation

| Document | Purpose |
|---|---|
| [ARCHITECTURE_DIAGRAM.md](./ARCHITECTURE_DIAGRAM.md) | Full system topology, sequence diagrams, and storage boundary invariants |
| [TECHNICAL.md](./TECHNICAL.md) | Deep-dive into design decisions, edge cases, and implementation rationale |
| [SECURITY.md](./SECURITY.md) | Security model, threat surface, and hardening details |
| [ROADMAP.md](./ROADMAP.md) | Completed work, accepted trade-offs, and future roadmap items |
| [PHASE_2_PLAN.md](./PHASE_2_PLAN.md) | Phase 2 build plan (Days 1–11) |
| [MANAGEMENT.md](./MANAGEMENT.md) | Project management notes |
| [OUTSTANDING_ITEMS.md](./OUTSTANDING_ITEMS.md) | Tracked outstanding items |

---

## Architectural Invariants

Three hard boundaries are enforced structurally:

1. **Zero DB access from the web app.** `apps/web-app` has no D1, KV, R2, or DO bindings. All data flows through the worker's tRPC API.

2. **SSR uses a service binding, not a public fetch.** `getServerSideProps` calls the worker via Cloudflare's private `WORKER_SERVICE` binding — avoiding the worker-to-worker loop restriction (Cloudflare error 1042).

3. **Durable Objects never access D1.** The DO / D1 boundary is a strict invariant: DOs hold only live, transient state (holds, rate windows, socket tickets). D1 is the durable system of record. All synchronisation between the two is orchestrated externally by the worker layer.

See [ARCHITECTURE_DIAGRAM.md §3](./ARCHITECTURE_DIAGRAM.md) for full details.
