import { sql } from 'drizzle-orm';
import { blob, index, integer, primaryKey, real, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import type { Score, Selection } from '$lib/score/types';
import type { Op } from '$lib/score/apply';

/**
 * Conventions, mirrored from galaxy so the two apps read the same way:
 *  - ids are text primary keys holding a randomUUID()
 *  - timestamps are integer timestamp_ms
 *  - booleans are integer mode:'boolean'
 *  - structured columns are JSON text with an explicit $type<T>()
 *  - enums are exported const tuples reused as Drizzle enums and TS types
 */

// ---------------------------------------------------------------- identity

export const users = sqliteTable('users', {
	id: text('id').primaryKey(),
	username: text('username').notNull().unique(),
	email: text('email'),
	displayName: text('display_name'),
	/**
	 * A cache of Authelia group membership, not a control. It is overwritten
	 * from Remote-Groups on the user's next request, so setting it in-app does
	 * nothing durable — the admin UI must refuse to write it.
	 */
	isAdmin: integer('is_admin', { mode: 'boolean' }).notNull().default(false),
	createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
	lastSeenAt: integer('last_seen_at', { mode: 'timestamp_ms' })
});

// ---------------------------------------------------------------- settings

/** Scoped key/value store. scope is 'global', a user id, or any entity id. */
export const settings = sqliteTable(
	'settings',
	{
		scope: text('scope').notNull(),
		key: text('key').notNull(),
		value: text('value', { mode: 'json' }).notNull(),
		updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull()
	},
	(t) => [primaryKey({ columns: [t.scope, t.key] })]
);

// ------------------------------------------------------------- AI plumbing

/**
 * OpenRouter fronts 400+ models behind one key and one OpenAI-shaped endpoint,
 * so it is the provider rather than one vendor among several. `openai-compatible`
 * stays for a local runtime (Ollama, llama.cpp) that speaks the same wire format
 * without OpenRouter's extensions.
 *
 * These enums are TypeScript-only — Drizzle emits no CHECK constraint, so
 * changing them costs no migration.
 */
export const PROVIDER_KINDS = ['openrouter', 'openai-compatible'] as const;
export type ProviderKind = (typeof PROVIDER_KINDS)[number];

export const providers = sqliteTable('providers', {
	id: text('id').primaryKey(),
	kind: text('kind', { enum: PROVIDER_KINDS }).notNull(),
	name: text('name').notNull(),
	baseUrl: text('base_url').notNull(),
	/** AES-256-GCM ciphertext. Never returned to the browser — see api masking. */
	apiKeyEnc: text('api_key_enc'),
	enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
	createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull()
});

export const models = sqliteTable(
	'models',
	{
		id: text('id').primaryKey(),
		providerId: text('provider_id').notNull(),
		modelKey: text('model_key').notNull(),
		displayName: text('display_name').notNull(),
		contextWindow: integer('context_window'),
		supportsTools: integer('supports_tools', { mode: 'boolean' }).notNull().default(false),
		supportsVision: integer('supports_vision', { mode: 'boolean' }).notNull().default(false),
		promptCostPerMTok: real('prompt_cost_per_mtok'),
		completionCostPerMTok: real('completion_cost_per_mtok'),
		/** Synced models arrive disabled; you curate the list you actually want. */
		enabled: integer('enabled', { mode: 'boolean' }).notNull().default(false)
	},
	(t) => [index('models_provider_idx').on(t.providerId)]
);

// Shared with the admin UI, so they live outside $lib/server — see
// src/lib/ai/config.ts. Re-exported here so server modules can keep importing
// them from the schema alongside the tables they describe.
export {
	CORE_TASKS,
	REASONING_EFFORTS,
	type CoreTask,
	type ReasoningEffort,
	type TaskOptions
} from '$lib/ai/config';
import type { TaskOptions } from '$lib/ai/config';
import { FIRST_STAGE, type Brief, type PipelineState, type Plan, type Stage } from '$lib/pipeline/types';

export const taskConfigs = sqliteTable('task_configs', {
	task: text('task').primaryKey(),
	systemPrompt: text('system_prompt').notNull().default(''),
	primaryModelId: text('primary_model_id'),
	backupModelId: text('backup_model_id'),
	options: text('options', { mode: 'json' }).$type<TaskOptions>()
});

/** Every prompt save, append-only. Restoring is just saving an old version. */
export const taskPromptVersions = sqliteTable(
	'task_prompt_versions',
	{
		id: text('id').primaryKey(),
		task: text('task').notNull(),
		systemPrompt: text('system_prompt').notNull(),
		author: text('author').notNull(),
		createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull()
	},
	(t) => [index('task_prompt_versions_task_created_idx').on(t.task, t.createdAt)]
);

// ----------------------------------------------------------------- scores

export const scores = sqliteTable(
	'scores',
	{
		id: text('id').primaryKey(),
		ownerId: text('owner_id').notNull(),
		title: text('title').notNull(),
		/** The whole document. Small enough (a few hundred KB at worst) that
		 *  storing it as one blob beats normalising notes into rows. */
		doc: text('doc', { mode: 'json' }).notNull().$type<Score>(),
		/**
		 * Where this score is in the composition pipeline.
		 *
		 * Defaulted rather than nullable so every row — including every one that
		 * predates the pipeline — answers the question. A score nobody has taken
		 * anywhere is at the brief, which is true rather than a placeholder.
		 */
		stage: text('stage').notNull().default(FIRST_STAGE).$type<Stage>(),
		/** What was asked for. Null until someone writes one. */
		brief: text('brief', { mode: 'json' }).$type<Brief>(),
		/** The approved blueprint. Null until the plan stage produces one. */
		plan: text('plan', { mode: 'json' }).$type<Plan>(),
		createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
		updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
		archivedAt: integer('archived_at', { mode: 'timestamp_ms' })
	},
	(t) => [index('scores_owner_updated_idx').on(t.ownerId, t.updatedAt)]
);

export const REVISION_SOURCES = ['user', 'ai', 'control', 'import'] as const;
export type RevisionSource = (typeof REVISION_SOURCES)[number];

/**
 * Undo history and the accept/reject diff in one table.
 *
 * `ops` drives the diff overlay; `snapshotGz` is a gzipped full document so
 * undo is a restore rather than an inverse-op replay. A 300KB score gzips to
 * roughly 30KB, so a hundred revisions costs a few megabytes — cheap enough
 * that the simpler design wins.
 */
export const revisions = sqliteTable(
	'revisions',
	{
		id: text('id').primaryKey(),
		scoreId: text('score_id').notNull(),
		seq: integer('seq').notNull(),
		source: text('source', { enum: REVISION_SOURCES }).notNull(),
		label: text('label').notNull(),
		ops: text('ops', { mode: 'json' }).$type<Op[]>(),
		diff: text('diff', { mode: 'json' }).$type<{
			added: string[];
			removed: string[];
			changed: string[];
		}>(),
		snapshotGz: blob('snapshot_gz'),
		/**
		 * Where the pipeline stood when this revision was written.
		 *
		 * Restoring puts the document back and has to put this back with it:
		 * undoing past a plan approval would otherwise leave the score claiming
		 * to be at the melody stage with an approved plan, while the parts and
		 * sections that approval created were gone. One column rather than
		 * three because it is one fact, and it keeps restore a single read.
		 */
		pipeline: text('pipeline', { mode: 'json' }).$type<PipelineState>(),
		/** AI revisions land pending; the user accepts or rejects them. */
		accepted: integer('accepted', { mode: 'boolean' }).notNull().default(true),
		jobId: text('job_id'),
		createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull()
	},
	(t) => [index('revisions_score_seq_idx').on(t.scoreId, t.seq)]
);

// --------------------------------------------------------------- controls

export const CONTROL_KINDS = ['code', 'prompt', 'agent'] as const;
export type ControlKind = (typeof CONTROL_KINDS)[number];

/**
 * The AI mixer rack. `kind` is the architectural split:
 *
 *   code   no model call at all — deterministic ops, instant and free
 *   prompt one model call against promptTemplate, returning an op patch
 *   agent  a tool-use loop that reads the score before it writes
 *
 * Because prompt controls are rows rather than code, a new one can be added
 * from the admin panel with no deploy.
 */
export const controls = sqliteTable(
	'controls',
	{
		id: text('id').primaryKey(),
		name: text('name').notNull(),
		category: text('category').notNull(),
		kind: text('kind', { enum: CONTROL_KINDS }).notNull(),
		icon: text('icon'),
		description: text('description').notNull().default(''),
		/** kind=code: the op name to run. */
		opName: text('op_name'),
		/** kind=prompt|agent: user-prompt template with {{param}} placeholders. */
		promptTemplate: text('prompt_template'),
		systemPrompt: text('system_prompt'),
		/** JSON Schema for the control's parameters, drives the generated UI. */
		paramsSchema: text('params_schema', { mode: 'json' }).$type<Record<string, unknown>>(),
		defaultParams: text('default_params', { mode: 'json' }).$type<Record<string, unknown>>(),
		/** Seeded built-ins are protected from deletion; user rows are not. */
		builtin: integer('builtin', { mode: 'boolean' }).notNull().default(false),
		enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
		sortOrder: integer('sort_order').notNull().default(0)
	},
	(t) => [index('controls_category_sort_idx').on(t.category, t.sortOrder)]
);

/**
 * Style knowledge as markdown on disk, indexed here. Writing a new genre is
 * writing a file — no code, no deploy. Body lives at
 * DATA_DIR/skills/<category>/<name>/SKILL.md.
 */
export const styleSkills = sqliteTable('style_skills', {
	id: text('id').primaryKey(),
	name: text('name').notNull(),
	category: text('category').notNull().default('style'),
	summary: text('summary').notNull().default(''),
	path: text('path').notNull(),
	enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
	updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull()
});

// ---------------------------------------------------------------- library

export const folders = sqliteTable(
	'folders',
	{
		id: text('id').primaryKey(),
		ownerId: text('owner_id').notNull(),
		parentId: text('parent_id'),
		name: text('name').notNull(),
		createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull()
	},
	(t) => [index('folders_owner_idx').on(t.ownerId)]
);

/** A reusable fragment: a riff, a chord loop, a drum pattern. */
export const clips = sqliteTable(
	'clips',
	{
		id: text('id').primaryKey(),
		ownerId: text('owner_id').notNull(),
		folderId: text('folder_id'),
		name: text('name').notNull(),
		tags: text('tags', { mode: 'json' }).$type<string[]>(),
		/** A complete mini-Score, so a clip can carry its own tempo and key. */
		fragment: text('fragment', { mode: 'json' }).notNull().$type<Score>(),
		bars: integer('bars').notNull().default(0),
		keyHint: text('key_hint'),
		tempoHint: integer('tempo_hint'),
		instrumentHint: text('instrument_hint'),
		createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull()
	},
	(t) => [index('clips_owner_folder_idx').on(t.ownerId, t.folderId)]
);

/** Source audio for a transcription. Bytes live at DATA_DIR/recordings/. */
export const recordings = sqliteTable(
	'recordings',
	{
		id: text('id').primaryKey(),
		ownerId: text('owner_id').notNull(),
		scoreId: text('score_id'),
		name: text('name').notNull(),
		mime: text('mime').notNull(),
		size: integer('size').notNull(),
		path: text('path').notNull(),
		durationMs: integer('duration_ms'),
		createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull()
	},
	(t) => [index('recordings_owner_idx').on(t.ownerId)]
);

// -------------------------------------------------------- runtime/telemetry

/**
 * Terminal states a job can reach.
 *
 * `done` and `error` keep their original names rather than becoming
 * succeeded/failed: renaming would strand every historical row or force every
 * reader to understand both spellings, and neither buys anything. `no_effect`
 * is a turn that ran cleanly and changed nothing — a real outcome, not a
 * failure, and the one the UI used to report as plain success while showing
 * the user an empty panel.
 */
export const JOB_STATUSES = [
	'running',
	'done',
	'no_effect',
	'error',
	'cancelled',
	'timed_out'
] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

export const jobs = sqliteTable(
	'jobs',
	{
		id: text('id').primaryKey(),
		scoreId: text('score_id'),
		userId: text('user_id').notNull(),
		task: text('task').notNull(),
		status: text('status', { enum: JOB_STATUSES }).notNull(),
		error: text('error'),
		createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
		finishedAt: integer('finished_at', { mode: 'timestamp_ms' })
	},
	(t) => [index('jobs_score_idx').on(t.scoreId)]
);

export const events = sqliteTable(
	'events',
	{
		id: text('id').primaryKey(),
		ts: integer('ts', { mode: 'timestamp_ms' }).notNull(),
		userId: text('user_id'),
		scoreId: text('score_id'),
		task: text('task'),
		type: text('type').notNull(),
		name: text('name').notNull(),
		status: text('status', { enum: ['ok', 'error', 'running'] }).notNull(),
		durationMs: integer('duration_ms'),
		detail: text('detail', { mode: 'json' })
	},
	// Each index pairs the filter column with ts so the sort is served by the
	// index rather than a temporary b-tree.
	(t) => [index('events_ts_idx').on(t.ts), index('events_user_ts_idx').on(t.userId, t.ts)]
);

export const usageLog = sqliteTable(
	'usage_log',
	{
		id: text('id').primaryKey(),
		ts: integer('ts', { mode: 'timestamp_ms' }).notNull(),
		userId: text('user_id'),
		scoreId: text('score_id'),
		task: text('task').notNull(),
		modelKey: text('model_key').notNull(),
		promptTokens: integer('prompt_tokens').notNull().default(0),
		completionTokens: integer('completion_tokens').notNull().default(0),
		cacheReadTokens: integer('cache_read_tokens').notNull().default(0),
		cacheWriteTokens: integer('cache_write_tokens').notNull().default(0),
		costUsd: real('cost_usd'),
		status: text('status', { enum: ['ok', 'error'] }).notNull()
	},
	(t) => [index('usage_ts_idx').on(t.ts), index('usage_user_ts_idx').on(t.userId, t.ts)]
);

export type SelectionJson = Selection;
export const NOW = sql`(unixepoch() * 1000)`;
