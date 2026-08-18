# Event Booking Platform - Day 5 Architecture

This document describes the *actual* implemented architecture of the Event Booking Platform as of Day 5. It is written for new backend engineers joining the team to understand the entire stack without needing to open the source code.

---

## 1. High Level Architecture

The platform uses a heavily decoupled edge-native architecture, leveraging Cloudflare's ecosystem for low latency and high scalability.

```text
       Browser
          ↓
       Next.js (React / Frontend UI)
          ↓
        tRPC (Type-safe API layer)
          ↓
   Cloudflare Worker (Edge API / Webhook Handler)
          ↓
    Durable Objects (DO) ──────────┐
          ↓                        ↓
         D1 (SQLite DB)           KV / R2 (Cache / Storage)
```

**Layer Explanation:**
- **Browser:** The client executing our frontend React application.
- **Next.js:** The web application framework, currently handling routing and UI. It does not act as our primary API server.
- **tRPC:** The communication layer. Next.js uses the tRPC client to make fully typed API calls to the Cloudflare Worker.
- **Cloudflare Worker:** The core backend. It handles CORS, intercepts webhooks, decodes Clerk JWTs, and processes tRPC requests.
- **Durable Objects (DO):** A globally distributed, strongly consistent data store. We use it *exclusively* as a transactional Seat Engine for events to prevent race conditions during bookings.
- **D1:** Cloudflare's serverless SQLite database, acting as the permanent system of record for all entities.
- **KV / R2:** Infrastructure initialized in our configurations for caching and file storage (event covers), preparing for upcoming features.

---

## 2. Folder Structure

The project is structured as a monorepo using **TurboRepo** and **pnpm** workspaces.

### Apps
- **`apps/web-app`**: The Next.js frontend application. It contains the UI, pages, components, and the tRPC client setup. It connects to the Worker for all data.
- **`apps/worker`**: The Cloudflare Worker backend. It contains the tRPC router, the Clerk webhook handler, and the Durable Object (`SeatLedger`) implementation. It is the single source of truth for business logic.

### Packages
- **`packages/shared`**: Contains the Drizzle ORM schema defining our D1 database tables. Extracted to a shared package so both the Worker and the frontend (if needed) can share exact database typings.
- **`packages/permissions`**: Contains authorisation logic. Extracted to remain framework-agnostic and ensure it doesn't accidentally import Node.js APIs (must remain Worker compatible).
- **`packages/trpc`**: Contains the tRPC initialization, procedure definitions (`protectedProcedure`, `publicWorkerProcedure`), and the critical `context.ts` which handles networkless Clerk JWT verification.

---

## 3. Request Lifecycle

Here is the exact lifecycle of the `reserveSeat` request.

1. **Browser**: The user clicks "Reserve". The Next.js tRPC client calls `trpc.reserveSeat.mutate({ eventId, seatCount })`.
2. **tRPC**: Serializes the request and sends a `POST /trpc/reserveSeat` HTTP request with an `Authorization: Bearer <token>` header.
3. **Worker (`index.ts`)**: The Cloudflare Worker's `fetch` handler intercepts the request. It handles CORS and forwards the request to the `fetchRequestHandler` from `@trpc/server/adapters/fetch`.
4. **Context (`packages/trpc/src/context.ts`)**: Before the router runs, `createContext` executes. It extracts the JWT, verifies it networklessly using `@clerk/backend` and our public `clerkJwtKey`, and extracts `userId` and `orgId`.
5. **Middleware (`router.ts`)**: The `workerProcedure` middleware executes. It ensures the user is authenticated (via `isAuthed`) and heavily types the Cloudflare `env` so the procedure can safely access bindings.
6. **Procedure (`router.ts`)**: The `reserveSeat` mutation runs. It maps the `eventId` to a Durable Object ID using `env.SEAT_LEDGER.idFromName(eventId)`.
7. **Durable Object (`seat-ledger.ts`)**: The procedure calls the DO stub's `reserveSeat` method. The DO processes the request in a strictly single-threaded execution context, executing SQLite queries against its internal storage to hold the seat. It sets a DO Alarm to expire the hold after 15 minutes.
8. **Response**: The DO returns `{ reservationId, expiresAt }`, which bubbles back up through the Worker, tRPC, and finally to the Browser.

---

## 4. Authentication Flow

We use **Clerk** for authentication, but with a highly optimized edge-verification flow.

- **JWT Issuance:** When a user logs in via Clerk on the frontend, Clerk issues a session token (JWT).
- **Context Injection:** Next.js sends this JWT in the `Authorization` header of every tRPC request.
- **Verification:** In `packages/trpc/src/context.ts`, we use `verifyToken` from `@clerk/backend` combined with the `CLERK_JWT_KEY` environment variable. This allows the Worker to verify the token signature cryptographically *without* making a network request to Clerk's API, eliminating latency.
- **Claim Extraction:** The verified token payload contains `sub` (which becomes `ctx.userId`). If the user is operating within a Clerk Organization, the token contains an `o.id` claim (which becomes `ctx.orgId`).
- **Enforcement:** `protectedProcedure` checks if `ctx.userId` exists and throws a `UNAUTHORIZED` TRPCError if it does not.

---

## 5. Authorization Flow

Authorization determines if an authenticated user is allowed to modify specific resources.

- **Permissions Package:** `packages/permissions/src/index.ts` exposes `authorizeOrganiserAccess(ctx, resourceOrgId)`. It simply checks if `ctx.orgId === resourceOrgId`.
- **Middleware Ordering:** In `packages/trpc/src/trpc.ts`, we export an `enforceOrganiserAccess` middleware factory. This is applied to procedures *after* `.input()`.
- **Why order matters:** By chaining the middleware after `.input()`, the middleware has access to the strongly-typed, parsed input (e.g., `eventId`). The middleware takes a callback to query the D1 database to find the `organisationId` that owns the requested `eventId`. Once found, it passes the `ctx` and `resourceOrgId` to the permissions package to enforce the boundary.

---

## 6. Organisation Sync Flow

To allow our D1 database to track Clerk Organizations, we use an asynchronous sync flow.

1. **Create Organisation:** User creates an org in the Clerk UI on the frontend.
2. **Clerk Webhook:** Clerk fires an asynchronous `organization.created` HTTP POST to our Worker's `/api/webhooks/clerk` endpoint.
3. **Worker Verification:** The Worker intercepts this raw request (before tRPC processing), verifies the Svix cryptographic signature, and extracts the payload.
4. **D1 Insert:** The Worker inserts the new organisation into the D1 `organisations` table.
5. **Frontend Polling:** Because webhooks are asynchronous, Next.js might redirect the user to their dashboard *before* the webhook completes. To solve this race condition, the frontend polls the `checkOrgSync` tRPC procedure.
6. **Dashboard Unlock:** Once `checkOrgSync` returns `true` (the org exists in D1), the Next.js UI stops loading and unlocks the dashboard.

---

## 7. Seat Engine

The Seat Engine is the heart of the platform, built inside a Cloudflare Durable Object (`SeatLedger`).

- **Internal Storage:** The DO uses the new SQLite-in-DO API. It maintains two tables: `event_state` (tracking `total_seats` and initialization status) and `reservations` (tracking individual seat holds and their `status`: pending, confirmed, released).
- **`reserveSeat`:** Enters a synchronous execution block. It calculates available seats by summing used seats. If seats are available, it inserts a `pending` row into `reservations` and sets an alarm.
- **`confirmSeat`:** Changes a reservation status from `pending` to `confirmed`.
- **`releaseSeat`:** Changes a reservation status from `pending` to `released`.
- **Alarms (Expiry):** When the DO Alarm fires, the `alarm()` method executes. It queries for all expired `pending` reservations and automatically releases them, freeing up inventory.
- **Idempotency:** The `releaseSeat` method is built to be idempotent. Calling it multiple times on the same hold ID results in a silent no-op if the status is already `released` or `confirmed`.

---

## 8. Database

The system uses D1 (SQLite) via Drizzle ORM. The schema is defined in `packages/shared/src/schema.ts`.

- **`users` (Clerk)**: There is no users table in D1. Clerk is the absolute source of truth for user identities.
- **`attendees`**: Maps a Clerk `userId` to local platform data (`email`, `name`). Created lazily via the `ensureAttendee` procedure.
- **`organisations`**: Mirrored from Clerk via webhooks. Stores `id`, `name`, and `ownerId`.
- **`events`**: The core resource. Belongs to an organisation. Stores `totalSeats`, `pricePerSeat` (in cents to avoid floating point math), `date`, and `coverImageUrl`.
- **`bookings`**: The permanent record of a sold ticket. Links an `eventId` to an `attendeeId`. Contains `seatCount`, `status`, `holdId`, and `stripePaymentIntentId`.
- **`reservations` (DO Storage)**: This table does *not* exist in D1. It lives exclusively inside the Durable Object's isolated SQLite database to track ephemeral seat holds.

---

## 9. Durable Objects

**Why DO?** 
Seat booking is a classic concurrency problem. If two people try to book the last seat at the exact same millisecond, standard databases struggle without complex locking. A Durable Object acts as a single-threaded coordinator. All requests for a specific event go to a single isolate, eliminating race conditions entirely.

**Why not D1?** 
D1 is great for permanent data, but writing temporary holds and constantly updating available seat counts under high traffic causes DB contention. DO handles this workload in memory/DO-SQLite.

**Why not KV?** 
KV is eventually consistent. Reading available seats from KV might return stale data, leading to overselling.

**APIs Exposed:** `initialize`, `getAvailableSeats`, `reserveSeat`, `confirmSeat`, `releaseSeat`.

---

## 10. D1

D1 is used strictly for **permanent, relational data**. Every procedure uses D1 for checking ownership (events -> organisations), fetching user profiles (attendees), and writing the final, immutable `bookings` records. 

---

## 11. KV

KV is configured in `wrangler.jsonc` as `EVENT_CACHE`, but it is **configured but not yet actively used**. It is positioned to cache heavily read, rarely updated data like public event listings in the future.

---

## 12. R2

R2 is configured in `wrangler.jsonc` as `EVENT_COVERS`. Currently, **only the infrastructure exists**. It will be used to store and serve image assets for events.

---

## 13. End-to-End Booking Flow

1. **Guest:** Browses the public event page.
2. **Browse:** Frontend calls `getEvent` and `getAvailableSeats` (which reads from the DO).
3. **Login:** User authenticates via Clerk.
4. **`ensureAttendee`:** Before booking, the frontend ensures an `attendee` profile exists in D1. If not, it creates one lazily.
5. **`reserveSeat`:** Calls the DO to place a 15-minute hold on a seat, returning a `holdId`.
6. **Payment (Future):** In the future, the user will pay via Stripe using the `holdId`.
7. **`confirmBooking`:** Completes the flow. It calls the DO's `confirmSeat` to lock the hold permanently, and writes the final `bookings` record to D1, optionally attaching the `stripePaymentIntentId`.

---

## 14. Important Architecture Decisions

- **DO owns mutable state:** The SeatLedger DO completely owns seat availability. This ensures strict atomic correctness for inventory.
- **D1 owns permanent state:** Final bookings live in D1 for long-term relational queries and reporting.
- **Authentication in middleware:** Using Clerk's edge-compatible JWT verification prevents the Worker from making slow network requests to Clerk on every single API call.
- **Organisation webhook:** Rather than blocking the user during org creation, we sync asynchronously and poll on the client. This decouples our DB from Clerk's uptime.
- **Idempotency:** Built into the DO `releaseSeat` to ensure network retries don't corrupt seat counts.
- **Lazy attendee creation:** Instead of syncing users via webhooks (which creates massive, mostly unused tables), we create `attendee` rows right before they actually do something (booking), keeping our DB lean.
- **Server as source of truth:** The frontend never assumes it has a seat. Everything is verified and locked on the backend.

---

## 15. Problems Faced

- **Middleware Ordering:** 
  - *Problem:* Needed to check if a user owned the organisation of an event they were modifying.
  - *Fix:* Created `enforceOrganiserAccess` and learned it must be chained *after* `.input()` in tRPC so the middleware has access to the validated `eventId` to query D1.
- **Organisation Sync Race Condition:**
  - *Problem:* User created an org, Clerk redirected to the dashboard, but the webhook hadn't written to D1 yet, causing 404s.
  - *Fix:* Implemented the `checkOrgSync` tRPC polling mechanism on the frontend to wait for the webhook.
- **Wrong tRPC curl format:**
  - *Problem:* When testing the API directly, GET requests were failing.
  - *Lesson:* tRPC GET requests expect parameters to be URL-encoded JSON under the `?input=` query string.
- **Windows Wrangler / WSL:**
  - *Problem:* Minor pathing and execution quirks when running Wrangler dev environments in WSL.
- **DO Alarm Testing:**
  - *Problem:* Waiting 15 minutes to test seat expiry during dev was impossible.
  - *Fix:* Wrote `test-seat-engine.sh` to simulate exact interactions and state transitions.

---

## 16. Testing

The project employs a pragmatic testing approach:
- **`curl` & Shell Scripts:** `apps/worker/test-seat-engine.sh` heavily utilizes curl against the tRPC endpoints to validate the complex Seat Engine state machine (reserves, confirms, releases, double-confirms).
- **Integration Tests:** The bash script acts as a full integration test, ensuring D1 and DO interact correctly.
- **DO Alarms:** Alarms are tested by observing the background worker execution after holds expire.

---

## 17. Current Status

- **Complete:** Core architecture, Monorepo setup, Clerk Authentication, Webhook Sync, tRPC routing, Drizzle schemas, and the complete Durable Object Seat Engine with idempotency and alarms.
- **Pending:** Stripe payment integration, real UI implementation in Next.js, and R2 image uploads.
- **Upcoming (Day 6):** Moving forward to integrate Stripe and finalize the end-to-end checkout experience.

---

## 18. Technologies Used

- **Next.js**: Chosen for its robust React ecosystem and routing capabilities for the frontend UI.
- **Cloudflare Workers**: Chosen for zero cold starts, global distribution, and incredibly low latency edge computing.
- **tRPC**: Chosen for end-to-end type safety between the Next.js frontend and the Cloudflare Worker without needing code generation.
- **Drizzle**: Chosen as the ORM because it has first-class, lightweight support for Cloudflare D1.
- **Durable Objects**: Chosen specifically to solve the concurrency problem of seat booking by acting as a single-threaded execution point.
- **D1**: Chosen for serverless, edge-accessible relational data storage (SQLite).
- **KV / R2**: Chosen to stay entirely within the Cloudflare ecosystem for caching and asset storage.
- **Clerk**: Chosen for out-of-the-box user management, B2B organisation support, and edge-compatible JWTs.
- **TypeScript**: Pervasive across the monorepo for safety and developer experience.
- **TurboRepo & pnpm**: Chosen for lightning-fast monorepo workspace management and dependency installation.
