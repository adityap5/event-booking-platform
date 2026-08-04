CREATE TABLE `attendees` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`email` text NOT NULL,
	`name` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `attendee_user_idx` ON `attendees` (`user_id`);--> statement-breakpoint
CREATE TABLE `bookings` (
	`id` text PRIMARY KEY NOT NULL,
	`event_id` text NOT NULL,
	`attendee_id` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`seat_count` integer NOT NULL,
	`stripe_payment_intent_id` text,
	`created_at` integer DEFAULT (strftime('%s', 'now')) NOT NULL,
	FOREIGN KEY (`event_id`) REFERENCES `events`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`attendee_id`) REFERENCES `attendees`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `booking_event_idx` ON `bookings` (`event_id`);--> statement-breakpoint
CREATE INDEX `booking_attendee_idx` ON `bookings` (`attendee_id`);--> statement-breakpoint
CREATE INDEX `booking_stripe_idx` ON `bookings` (`stripe_payment_intent_id`);--> statement-breakpoint
CREATE TABLE `events` (
	`id` text PRIMARY KEY NOT NULL,
	`organisation_id` text NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`date` integer NOT NULL,
	`total_seats` integer NOT NULL,
	`price_per_seat` integer NOT NULL,
	`cover_image_url` text,
	`created_at` integer DEFAULT (strftime('%s', 'now')) NOT NULL,
	FOREIGN KEY (`organisation_id`) REFERENCES `organisations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `event_org_idx` ON `events` (`organisation_id`);--> statement-breakpoint
CREATE INDEX `event_date_idx` ON `events` (`date`);--> statement-breakpoint
CREATE TABLE `organisations` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`owner_id` text NOT NULL,
	`created_at` integer DEFAULT (strftime('%s', 'now')) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `org_owner_idx` ON `organisations` (`owner_id`);