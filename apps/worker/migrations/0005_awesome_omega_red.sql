CREATE TABLE `organisation_api_keys` (
	`id` text PRIMARY KEY NOT NULL,
	`organisation_id` text NOT NULL,
	`key_hash` text NOT NULL,
	`key_prefix` text NOT NULL,
	`created_at` integer DEFAULT (strftime('%s', 'now')) NOT NULL,
	`revoked_at` integer,
	FOREIGN KEY (`organisation_id`) REFERENCES `organisations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `org_api_keys_hash_idx` ON `organisation_api_keys` (`key_hash`);--> statement-breakpoint
CREATE UNIQUE INDEX `org_api_keys_active_org_idx` ON `organisation_api_keys` (`organisation_id`) WHERE revoked_at IS NULL;--> statement-breakpoint
CREATE INDEX `org_api_keys_org_idx` ON `organisation_api_keys` (`organisation_id`);