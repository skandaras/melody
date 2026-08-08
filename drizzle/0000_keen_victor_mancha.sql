CREATE TABLE `clips` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`folder_id` text,
	`name` text NOT NULL,
	`tags` text,
	`fragment` text NOT NULL,
	`bars` integer DEFAULT 0 NOT NULL,
	`key_hint` text,
	`tempo_hint` integer,
	`instrument_hint` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `clips_owner_folder_idx` ON `clips` (`owner_id`,`folder_id`);--> statement-breakpoint
CREATE TABLE `controls` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`category` text NOT NULL,
	`kind` text NOT NULL,
	`icon` text,
	`description` text DEFAULT '' NOT NULL,
	`op_name` text,
	`prompt_template` text,
	`system_prompt` text,
	`params_schema` text,
	`default_params` text,
	`builtin` integer DEFAULT false NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE INDEX `controls_category_sort_idx` ON `controls` (`category`,`sort_order`);--> statement-breakpoint
CREATE TABLE `events` (
	`id` text PRIMARY KEY NOT NULL,
	`ts` integer NOT NULL,
	`user_id` text,
	`score_id` text,
	`task` text,
	`type` text NOT NULL,
	`name` text NOT NULL,
	`status` text NOT NULL,
	`duration_ms` integer,
	`detail` text
);
--> statement-breakpoint
CREATE INDEX `events_ts_idx` ON `events` (`ts`);--> statement-breakpoint
CREATE INDEX `events_user_ts_idx` ON `events` (`user_id`,`ts`);--> statement-breakpoint
CREATE TABLE `folders` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`parent_id` text,
	`name` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `folders_owner_idx` ON `folders` (`owner_id`);--> statement-breakpoint
CREATE TABLE `jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`score_id` text,
	`user_id` text NOT NULL,
	`task` text NOT NULL,
	`status` text NOT NULL,
	`error` text,
	`created_at` integer NOT NULL,
	`finished_at` integer
);
--> statement-breakpoint
CREATE INDEX `jobs_score_idx` ON `jobs` (`score_id`);--> statement-breakpoint
CREATE TABLE `models` (
	`id` text PRIMARY KEY NOT NULL,
	`provider_id` text NOT NULL,
	`model_key` text NOT NULL,
	`display_name` text NOT NULL,
	`context_window` integer,
	`supports_tools` integer DEFAULT false NOT NULL,
	`supports_vision` integer DEFAULT false NOT NULL,
	`prompt_cost_per_mtok` real,
	`completion_cost_per_mtok` real,
	`enabled` integer DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE INDEX `models_provider_idx` ON `models` (`provider_id`);--> statement-breakpoint
CREATE TABLE `providers` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`name` text NOT NULL,
	`base_url` text NOT NULL,
	`api_key_enc` text,
	`enabled` integer DEFAULT true NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `recordings` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`score_id` text,
	`name` text NOT NULL,
	`mime` text NOT NULL,
	`size` integer NOT NULL,
	`path` text NOT NULL,
	`duration_ms` integer,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `recordings_owner_idx` ON `recordings` (`owner_id`);--> statement-breakpoint
CREATE TABLE `revisions` (
	`id` text PRIMARY KEY NOT NULL,
	`score_id` text NOT NULL,
	`seq` integer NOT NULL,
	`source` text NOT NULL,
	`label` text NOT NULL,
	`ops` text,
	`diff` text,
	`snapshot_gz` blob,
	`accepted` integer DEFAULT true NOT NULL,
	`job_id` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `revisions_score_seq_idx` ON `revisions` (`score_id`,`seq`);--> statement-breakpoint
CREATE TABLE `scores` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`title` text NOT NULL,
	`doc` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`archived_at` integer
);
--> statement-breakpoint
CREATE INDEX `scores_owner_updated_idx` ON `scores` (`owner_id`,`updated_at`);--> statement-breakpoint
CREATE TABLE `settings` (
	`scope` text NOT NULL,
	`key` text NOT NULL,
	`value` text NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`scope`, `key`)
);
--> statement-breakpoint
CREATE TABLE `style_skills` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`category` text DEFAULT 'style' NOT NULL,
	`summary` text DEFAULT '' NOT NULL,
	`path` text NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `task_configs` (
	`task` text PRIMARY KEY NOT NULL,
	`system_prompt` text DEFAULT '' NOT NULL,
	`primary_model_id` text,
	`backup_model_id` text,
	`options` text
);
--> statement-breakpoint
CREATE TABLE `task_prompt_versions` (
	`id` text PRIMARY KEY NOT NULL,
	`task` text NOT NULL,
	`system_prompt` text NOT NULL,
	`author` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `task_prompt_versions_task_created_idx` ON `task_prompt_versions` (`task`,`created_at`);--> statement-breakpoint
CREATE TABLE `usage_log` (
	`id` text PRIMARY KEY NOT NULL,
	`ts` integer NOT NULL,
	`user_id` text,
	`score_id` text,
	`task` text NOT NULL,
	`model_key` text NOT NULL,
	`prompt_tokens` integer DEFAULT 0 NOT NULL,
	`completion_tokens` integer DEFAULT 0 NOT NULL,
	`cache_read_tokens` integer DEFAULT 0 NOT NULL,
	`cache_write_tokens` integer DEFAULT 0 NOT NULL,
	`cost_usd` real,
	`status` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `usage_ts_idx` ON `usage_log` (`ts`);--> statement-breakpoint
CREATE INDEX `usage_user_ts_idx` ON `usage_log` (`user_id`,`ts`);--> statement-breakpoint
CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`username` text NOT NULL,
	`email` text,
	`display_name` text,
	`is_admin` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL,
	`last_seen_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_username_unique` ON `users` (`username`);