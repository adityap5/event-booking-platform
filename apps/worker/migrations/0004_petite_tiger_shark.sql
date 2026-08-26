ALTER TABLE `organisations` ADD `stripe_customer_id` text;--> statement-breakpoint
ALTER TABLE `organisations` ADD `stripe_subscription_id` text;--> statement-breakpoint
ALTER TABLE `organisations` ADD `subscription_status` text DEFAULT 'inactive' NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `org_stripe_customer_idx` ON `organisations` (`stripe_customer_id`);