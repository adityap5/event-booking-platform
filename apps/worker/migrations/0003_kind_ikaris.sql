CREATE TABLE `audit_log` (
	`id` text PRIMARY KEY NOT NULL,
	`event_type` text NOT NULL,
	`hold_id` text,
	`booking_event_id` text,
	`user_id` text,
	`org_id` text,
	`detail` text,
	`created_at` integer DEFAULT (strftime('%s', 'now')) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `audit_event_type_idx` ON `audit_log` (`event_type`);--> statement-breakpoint
CREATE INDEX `audit_booking_event_idx` ON `audit_log` (`booking_event_id`);