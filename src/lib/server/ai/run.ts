import type { CoreTask } from '../db/schema.js';
import { checkBudget } from '../budget.js';
import { commitOps, loadScore } from '../scores.js';
import { DEFAULT_AI, DEFAULT_MODELS, getSetting, type AiSettings, type ModelSettings } from '../settings.js';
import { buildEditContext } from './context.js';
import { createJob, emit, finishJob, recordUsage, timedOut } from './jobs.js';
import { runAgentLoop } from './loop.js';
import { resolveTask } from './provider.js';
import type { Selection } from '$lib/score/types.js';

/**
 * One AI edit, start to finish.
 *
 * Deliberately fire-and-forget: this returns a job id as soon as the work is
 * scheduled and the caller subscribes to events separately. The turn then
 * survives the browser going away, which on a phone is the normal case rather
 * than an edge one.
 */

export interface RunEditOptions {
	scoreId: string;
	userId: string;
	instruction: string;
	selection: Selection;
	task?: CoreTask;
	origin?: string;
}

export function startEdit(opts: RunEditOptions): { jobId: string } {
	const task = opts.task ?? 'edit_selection';
	// Ownership first. Resolving the provider ahead of it would answer a
	// stranger's request with "no API key configured" — a 400 that both leaks
	// configuration state and contradicts the 404 every other route gives for
	// someone else's score.
	const row = loadScore(opts.scoreId, opts.userId);
	// Then the provider, before the job exists, so a missing key is an
	// immediate error with a useful message rather than a job created only to
	// fail a moment later.
	const resolved = resolveTask(task, opts.origin);
	// Then the budget, for the same reason: refusing spend here is the whole
	// point of the cap, and it is cheaper than a job that only fails when the
	// first API call reports the account is over.
	checkBudget();

	const { id: jobId, abort } = createJob({
		userId: opts.userId,
		scoreId: opts.scoreId,
		task
	});

	void execute();
	return { jobId };

	async function execute() {
		const ai = getSetting<AiSettings>('ai', DEFAULT_AI);
		const models = getSetting<ModelSettings>('models', DEFAULT_MODELS);

		try {
			// One phase, declared anyway: a client that can render a phase list
			// renders every run the same way, and a multi-section realization
			// later is then just a longer list rather than a second code path.
			emit(jobId, 'plan', { phases: [{ id: 'edit', label: 'Editing' }] });
			emit(jobId, 'phase', { id: 'edit', index: 0, total: 1, label: 'Editing' });
			emit(jobId, 'status', { message: 'Thinking…' });

			const result = await runAgentLoop({
				adapter: resolved.adapter,
				systemPrompt: resolved.systemPrompt,
				userPrompt: buildEditContext(row.doc, opts.selection, opts.instruction),
				score: row.doc,
				maxIterations: ai.maxIterations,
				maxOps: ai.maxOpsPerTurn,
				maxTokens: resolved.options.maxTokens ?? models.maxTokens,
				effort: resolved.options.effort,
				reasoning: resolved.options.reasoning,
				signal: abort,
				phase: { id: 'edit', label: 'Editing' },
				onEvent: (event) => emit(jobId, event.type, event)
			});

			recordUsage({
				userId: opts.userId,
				scoreId: opts.scoreId,
				task,
				modelKey: resolved.model,
				usage: result.usage,
				status: 'ok'
			});

			// Cancelling has to mean the edits do not land. runAgentLoop returns
			// `aborted` normally rather than throwing, so without this the turn
			// the user just cancelled would still be committed as a revision.
			if (result.stopReason === 'aborted') {
				// An abort is either a person pressing Cancel or the job's own
				// wall-clock ceiling. Both unwind identically, so ask which it was
				// rather than adding a second writer of the terminal status.
				const outcome = timedOut(jobId) ? 'timed_out' : 'cancelled';
				emit(jobId, 'result', {
					ops: 0,
					outcome,
					opsApplied: 0,
					opsRejected: result.rejectedOps,
					summary: result.summary,
					warnings: result.warnings,
					stopReason: result.stopReason
				});
				finishJob(jobId, outcome);
				return;
			}

			if (result.ops.length === 0) {
				emit(jobId, 'result', {
					ops: 0,
					outcome: result.stopReason === 'no_effect' ? 'no_effect' : 'done',
					opsApplied: 0,
					opsRejected: result.rejectedOps,
					summary: result.summary,
					warnings: result.warnings,
					stopReason: result.stopReason
				});
				finishJob(jobId, result.stopReason === 'no_effect' ? 'no_effect' : 'done');
				return;
			}

			// The whole turn lands as one revision, staged unaccepted, so the
			// editor's existing accept/reject review covers an AI edit exactly
			// as it covers a transcription.
			const commit = commitOps(opts.scoreId, opts.userId, result.ops, {
				source: 'ai',
				label: opts.instruction.slice(0, 120),
				accepted: false,
				jobId
			});

			emit(jobId, 'result', {
				ops: result.ops.length,
				outcome: 'done',
				opsApplied: result.ops.length,
				opsRejected: result.rejectedOps,
				summary: result.summary,
				warnings: result.warnings,
				stopReason: result.stopReason,
				revisionId: commit.revisionId,
				diff: commit.diff,
				created: commit.created,
				doc: commit.score
			});
			finishJob(jobId, 'done');
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			recordUsage({
				userId: opts.userId,
				scoreId: opts.scoreId,
				task,
				modelKey: resolved.model,
				usage: { promptTokens: 0, completionTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: null },
				status: 'error'
			});
			finishJob(jobId, 'error', message);
		}
	}
}
