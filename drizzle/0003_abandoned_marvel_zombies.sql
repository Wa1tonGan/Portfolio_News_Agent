ALTER TABLE `fund_profiles` ADD `leverage_known` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `fund_profiles` ADD `inverse_known` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `fund_profiles` ADD `daily_reset_known` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `fund_profiles` ADD `covered_call_known` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `fund_profiles` ADD `actively_managed_known` integer DEFAULT false NOT NULL;--> statement-breakpoint
UPDATE `fund_profiles`
SET `leverage_known` = true,
    `inverse_known` = true,
    `daily_reset_known` = true,
    `covered_call_known` = true,
    `actively_managed_known` = true
WHERE EXISTS (
  SELECT 1 FROM `fund_facts`
  WHERE `fund_facts`.`profile_id` = `fund_profiles`.`id`
    AND `fund_facts`.`category` = 'fund_structure'
);
