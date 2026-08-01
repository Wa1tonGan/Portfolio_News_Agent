CREATE TABLE `security_registry_metadata` (
	`registry_key` text PRIMARY KEY NOT NULL,
	`last_refresh_at` text NOT NULL,
	`source_updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `us_securities` (
	`symbol` text PRIMARY KEY NOT NULL,
	`nasdaq_symbol` text NOT NULL,
	`cqs_symbol` text NOT NULL,
	`security_name` text NOT NULL,
	`exchange_code` text NOT NULL,
	`exchange_name` text NOT NULL,
	`security_type` text NOT NULL,
	`is_etf` integer NOT NULL,
	`source_dataset` text NOT NULL,
	`source_updated_at` text NOT NULL,
	`cached_at` text NOT NULL,
	`refresh_id` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `us_securities_lookup_idx` ON `us_securities` (`nasdaq_symbol`,`cqs_symbol`);--> statement-breakpoint
CREATE INDEX `us_securities_type_idx` ON `us_securities` (`security_type`);