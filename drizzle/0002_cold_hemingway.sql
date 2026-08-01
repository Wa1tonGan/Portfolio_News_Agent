CREATE TABLE `fund_facts` (
	`id` text PRIMARY KEY NOT NULL,
	`profile_id` text NOT NULL,
	`category` text NOT NULL,
	`fact_key` text NOT NULL,
	`value` text NOT NULL,
	`status` text NOT NULL,
	`source_type` text NOT NULL,
	`source_url` text,
	`evidence_text` text NOT NULL,
	`effective_date` text,
	`last_verification_date` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`profile_id`) REFERENCES `fund_profiles`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `fund_facts_profile_idx` ON `fund_facts` (`profile_id`);--> statement-breakpoint
CREATE INDEX `fund_facts_lookup_idx` ON `fund_facts` (`profile_id`,`category`,`fact_key`,`effective_date`);--> statement-breakpoint
CREATE TABLE `fund_holdings` (
	`id` text PRIMARY KEY NOT NULL,
	`profile_id` text NOT NULL,
	`constituent_ticker` text,
	`constituent_name` text NOT NULL,
	`weight_percent` real,
	`country` text,
	`sector` text,
	`currency` text,
	`status` text NOT NULL,
	`source_type` text NOT NULL,
	`source_url` text,
	`evidence_text` text NOT NULL,
	`effective_date` text NOT NULL,
	`last_verification_date` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`profile_id`) REFERENCES `fund_profiles`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `fund_holdings_profile_idx` ON `fund_holdings` (`profile_id`);--> statement-breakpoint
CREATE INDEX `fund_holdings_lookup_idx` ON `fund_holdings` (`profile_id`,`constituent_ticker`,`constituent_name`,`effective_date`);--> statement-breakpoint
CREATE TABLE `fund_profiles` (
	`id` text PRIMARY KEY NOT NULL,
	`ticker` text NOT NULL,
	`fund_name` text NOT NULL,
	`issuer_name` text,
	`security_type` text NOT NULL,
	`leverage_multiplier` real NOT NULL,
	`inverse` integer NOT NULL,
	`daily_reset` integer NOT NULL,
	`covered_call` integer NOT NULL,
	`actively_managed` integer NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`last_reviewed_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `fund_profiles_ticker_idx` ON `fund_profiles` (`ticker`);