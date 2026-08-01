CREATE TABLE `analysis_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`status` text NOT NULL,
	`portfolio_json` text NOT NULL,
	`result_json` text,
	`error_text` text,
	`started_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`completed_at` text
);
--> statement-breakpoint
CREATE INDEX `analysis_runs_started_idx` ON `analysis_runs` (`started_at`);--> statement-breakpoint
CREATE INDEX `analysis_runs_status_idx` ON `analysis_runs` (`status`);--> statement-breakpoint
CREATE TABLE `analysis_activities` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`sequence` integer NOT NULL,
	`activity_json` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `analysis_runs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `analysis_activities_run_sequence_idx` ON `analysis_activities` (`run_id`,`sequence`);
