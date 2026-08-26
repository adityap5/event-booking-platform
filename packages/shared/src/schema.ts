import { sqliteTable, text, integer, index, uniqueIndex } from 'drizzle-orm/sqlite-core';
import { relations, sql } from 'drizzle-orm';

// We use crypto.randomUUID() for non-sequential IDs, which is natively supported in Cloudflare Workers and Node
const generateId = () => crypto.randomUUID();

export const organisations = sqliteTable(
  'organisations',
  {
    id: text('id').primaryKey().$defaultFn(generateId),
    name: text('name').notNull(),
    ownerId: text('owner_id').notNull(), // Clerk userId
    createdAt: integer('created_at', { mode: 'timestamp' })
      .notNull()
      .default(sql`(strftime('%s', 'now'))`),
    stripeCustomerId: text('stripe_customer_id'),
    stripeSubscriptionId: text('stripe_subscription_id'),
    subscriptionStatus: text('subscription_status').notNull().default('inactive'),
  },
  (table) => {
    return [
      // Enables fast lookup by Clerk's userId when determining org ownership
      uniqueIndex('org_owner_idx').on(table.ownerId),
      // Enables fast lookup by Stripe customer ID on incoming subscription webhooks
      uniqueIndex('org_stripe_customer_idx').on(table.stripeCustomerId),
    ];
  }
);

export const events = sqliteTable(
  'events',
  {
    id: text('id').primaryKey().$defaultFn(generateId),
    organisationId: text('organisation_id')
      .notNull()
      .references(() => organisations.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    description: text('description'),
    date: integer('date', { mode: 'timestamp' }).notNull(),
    totalSeats: integer('total_seats').notNull(),
    pricePerSeat: integer('price_per_seat').notNull(), // Stored in cents to avoid floating point math issues
    coverImageUrl: text('cover_image_url'),
    createdAt: integer('created_at', { mode: 'timestamp' })
      .notNull()
      .default(sql`(strftime('%s', 'now'))`),
  },
  (table) => {
    return [
      // Critical index for API authorization checks: "Does this event belong to this org?"
      index('event_org_idx').on(table.organisationId),
      // Useful for querying upcoming events or filtering by date
      index('event_date_idx').on(table.date),
    ];
  }
);

export const attendees = sqliteTable(
  'attendees',
  {
    id: text('id').primaryKey().$defaultFn(generateId),
    userId: text('user_id').notNull(), // Clerk userId
    email: text('email').notNull(),
    name: text('name').notNull(),
  },
  (table) => {
    return [
      // Enables fast lookup by Clerk's userId when the user views their tickets
      uniqueIndex('attendee_user_idx').on(table.userId),
    ];
  }
);

export const bookings = sqliteTable(
  'bookings',
  {
    id: text('id').primaryKey().$defaultFn(generateId),
    eventId: text('event_id')
      .notNull()
      .references(() => events.id, { onDelete: 'cascade' }),
    attendeeId: text('attendee_id')
      .notNull()
      .references(() => attendees.id, { onDelete: 'cascade' }),
    // Status semantic distinction:
    // - 'pending': temporary reservation hold awaiting payment.
    // - 'confirmed': payment succeeded and booking is active.
    // - 'cancelled': payment failed or was abandoned before confirmation (booking was never completed/sold).
    // - 'refunded': booking was genuinely confirmed and sold, then subsequently financially reversed via Stripe refund.
    status: text('status', { enum: ['pending', 'confirmed', 'cancelled', 'refunded'] })
      .notNull()
      .default('pending'),
    holdId: text('hold_id'),  // nullable — pre-existing bookings have no holdId
    seatCount: integer('seat_count').notNull(),
    stripePaymentIntentId: text('stripe_payment_intent_id'),
    createdAt: integer('created_at', { mode: 'timestamp' })
      .notNull()
      .default(sql`(strftime('%s', 'now'))`),
  },
  (table) => {
    return [
      // Look up all bookings for a specific event (organiser view)
      index('booking_event_idx').on(table.eventId),
      // Look up all bookings for a specific attendee (user view)
      index('booking_attendee_idx').on(table.attendeeId),
      // Fast lookup by holdId for seat confirmation in bookings.ts router and stripe-webhook.ts handler
      index('booking_hold_idx').on(table.holdId),
    ];
  }
);

export const auditLog = sqliteTable(
  'audit_log',
  {
    id: text('id').primaryKey().$defaultFn(generateId),
    eventType: text('event_type').notNull(),
    holdId: text('hold_id'),
    bookingEventId: text('booking_event_id'),
    userId: text('user_id'),
    orgId: text('org_id'),
    detail: text('detail'),
    createdAt: integer('created_at', { mode: 'timestamp' })
      .notNull()
      .default(sql`(strftime('%s', 'now'))`),
  },
  (table) => {
    return [
      index('audit_event_type_idx').on(table.eventType),
      index('audit_booking_event_idx').on(table.bookingEventId),
    ];
  }
);

export const organisationApiKeys = sqliteTable(
  'organisation_api_keys',
  {
    id: text('id').primaryKey().$defaultFn(generateId),
    organisationId: text('organisation_id')
      .notNull()
      .references(() => organisations.id, { onDelete: 'cascade' }),
    keyHash: text('key_hash').notNull(),
    keyPrefix: text('key_prefix').notNull(),
    createdAt: integer('created_at', { mode: 'timestamp' })
      .notNull()
      .default(sql`(strftime('%s', 'now'))`),
    revokedAt: integer('revoked_at', { mode: 'timestamp' }),
  },
  (table) => {
    return [
      // Enables fast indexed lookup by hashed API key for incoming public API requests
      uniqueIndex('org_api_keys_hash_idx').on(table.keyHash),
      // Partial unique index structurally enforcing "one active key per organisation"
      uniqueIndex('org_api_keys_active_org_idx')
        .on(table.organisationId)
        .where(sql`revoked_at IS NULL`),
      // Foreign key index for cascade lookups and organisation-scoped queries
      index('org_api_keys_org_idx').on(table.organisationId),
    ];
  }
);

// ── Relations (Drizzle ORM Object Relational API) ───────────────────────────────────

export const organisationsRelations = relations(organisations, ({ many }) => ({
  events: many(events),
  apiKeys: many(organisationApiKeys),
}));

export const organisationApiKeysRelations = relations(organisationApiKeys, ({ one }) => ({
  organisation: one(organisations, {
    fields: [organisationApiKeys.organisationId],
    references: [organisations.id],
  }),
}));

export const eventsRelations = relations(events, ({ one, many }) => ({
  organisation: one(organisations, {
    fields: [events.organisationId],
    references: [organisations.id],
  }),
  bookings: many(bookings),
}));

export const attendeesRelations = relations(attendees, ({ many }) => ({
  bookings: many(bookings),
}));

export const bookingsRelations = relations(bookings, ({ one }) => ({
  event: one(events, {
    fields: [bookings.eventId],
    references: [events.id],
  }),
  attendee: one(attendees, {
    fields: [bookings.attendeeId],
    references: [attendees.id],
  }),
}));


