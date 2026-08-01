CREATE TABLE `company_facts` (
	`id` text PRIMARY KEY NOT NULL,
	`profile_id` text NOT NULL,
	`category` text NOT NULL,
	`fact_key` text NOT NULL,
	`value` text NOT NULL,
	`status` text NOT NULL,
	`source_type` text NOT NULL,
	`source_url` text,
	`evidence_text` text NOT NULL,
	`last_verification_date` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`profile_id`) REFERENCES `company_profiles`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `company_facts_profile_idx` ON `company_facts` (`profile_id`);--> statement-breakpoint
CREATE INDEX `company_facts_lookup_idx` ON `company_facts` (`profile_id`,`category`,`fact_key`);--> statement-breakpoint
CREATE TABLE `company_profiles` (
	`id` text PRIMARY KEY NOT NULL,
	`ticker` text NOT NULL,
	`company_name` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`last_reviewed_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `company_profiles_ticker_idx` ON `company_profiles` (`ticker`);