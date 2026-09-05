ALTER TABLE `revisions` ADD `pipeline` text;--> statement-breakpoint
ALTER TABLE `scores` ADD `stage` text DEFAULT 'brief' NOT NULL;--> statement-breakpoint
ALTER TABLE `scores` ADD `brief` text;--> statement-breakpoint
ALTER TABLE `scores` ADD `plan` text;