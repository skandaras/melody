import { randomUUID } from 'node:crypto';
import { and, desc, eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import {
	CORE_TASKS,
	REASONING_EFFORTS,
	taskConfigs,
	taskPromptVersions,
	type CoreTask,
	type ReasoningEffort,
	type TaskOptions
} from '../db/schema.js';

/**
 * Per-task model and reasoning configuration.
 *
 * Each of melody's jobs wants something different from a model. Naming a piece
 * is a sentence and should be answered by something cheap and instant;
 * orchestrating for string quartet is worth the slowest, most careful model
 * available. Forcing both through one global setting means either paying opus
 * prices to generate a title or arranging with a model that cannot hold four
 * parts in its head.
 *
 * The columns for this already existed — resolveTask has always preferred a
 * task's own model over the global default. Only the way to set them was
 * missing.
 */

export interface TaskView {
	task: CoreTask;
	systemPrompt: string;
	primaryModelId: string | null;
	backupModelId: string | null;
	options: TaskOptions;
	/** How many saved prompt versions exist, for the history control. */
	versionCount: number;
}

export { TASK_BLURBS } from '$lib/ai/config';

export function listTasks(): TaskView[] {
	const rows = db.select().from(taskConfigs).all();
	const versions = db.select().from(taskPromptVersions).all();

	return CORE_TASKS.map((task) => {
		const row = rows.find((r) => r.task === task);
		return {
			task,
			systemPrompt: row?.systemPrompt ?? '',
			primaryModelId: row?.primaryModelId ?? null,
			backupModelId: row?.backupModelId ?? null,
			options: row?.options ?? {},
			versionCount: versions.filter((v) => v.task === task).length
		};
	});
}

export interface SaveTaskInput {
	task: CoreTask;
	systemPrompt?: string;
	/** Empty string clears the override and falls back to the global default. */
	primaryModelId?: string | null;
	backupModelId?: string | null;
	options?: TaskOptions;
	/** Who to record against a new prompt version. */
	author?: string;
}

export function saveTask(input: SaveTaskInput): TaskView {
	if (!CORE_TASKS.includes(input.task)) {
		throw new Error(`Unknown task: ${input.task}`);
	}

	const existing = db.select().from(taskConfigs).where(eq(taskConfigs.task, input.task)).get();
	const patch: Record<string, unknown> = {};

	if (input.systemPrompt !== undefined) patch.systemPrompt = input.systemPrompt;
	if (input.primaryModelId !== undefined) patch.primaryModelId = input.primaryModelId || null;
	if (input.backupModelId !== undefined) patch.backupModelId = input.backupModelId || null;
	if (input.options !== undefined) patch.options = sanitiseOptions(input.options);

	if (existing) {
		if (Object.keys(patch).length) {
			db.update(taskConfigs).set(patch).where(eq(taskConfigs.task, input.task)).run();
		}
	} else {
		db.insert(taskConfigs)
			.values({
				task: input.task,
				systemPrompt: (patch.systemPrompt as string) ?? '',
				primaryModelId: (patch.primaryModelId as string | null) ?? null,
				backupModelId: (patch.backupModelId as string | null) ?? null,
				options: (patch.options as TaskOptions) ?? {}
			})
			.run();
	}

	// Version the prompt only when it actually changed. Recording a version for
	// a model-only edit would bury the real prompt history in noise.
	if (
		input.systemPrompt !== undefined &&
		input.systemPrompt !== (existing?.systemPrompt ?? '') &&
		input.systemPrompt.trim()
	) {
		db.insert(taskPromptVersions)
			.values({
				id: randomUUID(),
				task: input.task,
				systemPrompt: input.systemPrompt,
				author: input.author || 'admin',
				createdAt: new Date()
			})
			.run();
	}

	return listTasks().find((t) => t.task === input.task)!;
}

export interface PromptVersionView {
	id: string;
	systemPrompt: string;
	author: string;
	createdAt: number;
}

export function listPromptVersions(task: CoreTask, limit = 25): PromptVersionView[] {
	return db
		.select()
		.from(taskPromptVersions)
		.where(eq(taskPromptVersions.task, task))
		.orderBy(desc(taskPromptVersions.createdAt))
		.limit(limit)
		.all()
		.map((v) => ({
			id: v.id,
			systemPrompt: v.systemPrompt,
			author: v.author,
			createdAt: v.createdAt.getTime()
		}));
}

/**
 * Restore an old prompt by saving it as a new version.
 *
 * The history stays append-only: reverting is a forward move, so the thing you
 * reverted away from is still there if the revert was itself a mistake.
 */
export function restorePromptVersion(task: CoreTask, versionId: string, author: string): TaskView {
	const version = db
		.select()
		.from(taskPromptVersions)
		.where(and(eq(taskPromptVersions.task, task), eq(taskPromptVersions.id, versionId)))
		.get();
	if (!version) throw new Error('That prompt version no longer exists.');
	return saveTask({ task, systemPrompt: version.systemPrompt, author });
}

/** Keep stored options inside the shapes the adapter knows how to send. */
function sanitiseOptions(raw: TaskOptions): TaskOptions {
	const out: TaskOptions = {};

	if (raw.effort && REASONING_EFFORTS.includes(raw.effort as ReasoningEffort)) {
		out.effort = raw.effort;
	}
	if (raw.reasoning && ['on', 'hidden', 'off'].includes(raw.reasoning)) {
		out.reasoning = raw.reasoning;
	}
	if (typeof raw.maxTokens === 'number' && Number.isFinite(raw.maxTokens)) {
		// An upper bound rather than a guess: past about 200k the request is
		// rejected by every provider anyway, and 0 would silently disable output.
		out.maxTokens = Math.max(64, Math.min(200_000, Math.round(raw.maxTokens)));
	}
	return out;
}
