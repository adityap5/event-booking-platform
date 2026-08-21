# Roadmap

Deferred items and known gaps that are out of scope for Phase 2 but worth tracking. Items are grouped by origin; they are not prioritised against each other.

---

## Carried from `PHASE_2_PLAN.md` (explicitly out of scope, Phase 2)

### Drizzle inside the seat-ledger DO

`seat-ledger.ts` uses raw prepared SQL statements against `this.ctx.storage.sql`, not Drizzle ORM, despite the rest of the stack using Drizzle everywhere. The reasoning for deferring is unchanged and still applies: Drizzle's DO-SQLite path (`drizzle-orm/durable-sqlite`) is a separate integration from the D1 path used elsewhere, with its own migration tooling. The seat ledger is the most concurrency-sensitive file in the repository and the most heavily tested. Changing its storage layer in isolation from its structural modularisation (below) adds risk with no correctness benefit — raw SQL keeps exactly what runs, and when, fully visible.

**Pre-conditions before picking this up:** the modularisation task (below) must land first, and the full test suite must pass cleanly against the refactored version before the ORM swap begins.

### Seat-ledger and web-app modularisation

`seat-ledger.ts` is a monolithic file. `apps/worker/src/router.ts` and `index.ts` were split into `routers/`, `handlers/`, and `procedures.ts` during Phase 2; `seat-ledger.ts` and the web-app have not yet received the same treatment.

**What this means in practice:** adding a new DO method requires editing a single file that mixes initialisation, reservation logic, confirmation, release, alarm handling, ticket minting/redemption, WebSocket handling, and broadcasting. No individual concern is hard to find, but the file is large enough that mechanical changes carry a higher incidental-change risk than they would in a modular structure.

---

## Known weaknesses documented in `TECHNICAL.md §10` (not fixed, tracked here)

### No user-facing hold-release action

A user who reserves seats and then changes their mind cannot release the hold early — they must wait out the 15-minute expiry. `releaseBooking` was removed as dead code on Day 1 Phase 2 because it had zero frontend callers; the hold-exhaustion cap added the same day means a user with an active pending hold is locked out of re-reserving for up to 15 minutes.

**Fix:** a minimal ownership-checked `releaseHold` tRPC procedure, wired to a "change seat count" or "cancel reservation" action in the booking UI (e.g., from `pages/booking/cancelled.tsx`).

### Event cache not invalidated on update

The 5-minute KV cache for public event metadata is never explicitly invalidated when an event is edited. The invalidation procedure (`invalidateEventCache`) was removed on Day 1 Phase 2 as dead code (zero callers); the underlying gap was pre-existing.

**Fix:** whichever mutation updates an event row should call `ctx.env.EVENT_CACHE.delete(eventId)` inline after the D1 write succeeds — not via a separately exposed procedure.

### Integration stub payloads

`dispatchEmailConfirmation` and `dispatchCalendarInvite` in the `'confirmed'` webhook branch use placeholder values (`eventId` instead of event name, `Date.now()` instead of real event date). See §8 in `TECHNICAL.md`.

**Fix:** change the bookings insert in the webhook to use `.returning()` and thread real event name/date through to the dispatch calls.

---

## Feature completion items from `PHASE_2_PLAN.md` (Days 8–11 scope)

These are in-scope for Phase 2's feature phase but tracked here for visibility:

- **PDF ticket** — generated on confirmation, stored in R2, linked from the attendee's booking.
- **Refund flow** — organiser-initiated refund via Stripe, releasing an already-confirmed seat back to the DO. Requires a new DO method (releasing a confirmed seat is a distinct state transition from releasing a pending hold — conflating them corrupts seat maths).
- **Organisation subscription** — recurring Stripe Billing relationship, subscription lifecycle webhooks, organiser features gated on subscription status.
- **Public read-only API** — event listings authenticated by API key rather than Clerk JWT.

---

## Observability and operational gaps

### RateLimiter DO direct tests

The `RateLimiter` DO has no unit tests of its own — it is only exercised indirectly through procedures that call it. A direct test covering window boundary behaviour, concurrent increments, and key isolation would prevent regressions if the DO's logic is ever changed.

### WebSocket upgrade end-to-end test

Ticket single-use is tested at the DO method level (`redeemTicket` via `runInDurableObject`). A test that exercises the full WebSocket upgrade path (`/ws?ticket=...&eventId=...`) through `index.ts` does not exist.
