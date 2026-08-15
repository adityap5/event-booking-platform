DROP INDEX `booking_stripe_idx`;--> statement-breakpoint
CREATE INDEX `booking_hold_idx` ON `bookings` (`hold_id`);