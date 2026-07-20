ALTER TABLE `digest_deliveries` ADD `claimed_at` text;--> statement-breakpoint
ALTER TABLE `digest_deliveries` ADD `attempt_count` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `digest_deliveries` ADD `provider_message_id` text;