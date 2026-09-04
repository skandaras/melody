import { error } from '@sveltejs/kit';
import type { Op } from '$lib/score/apply.js';
import type { Selection } from '$lib/score/types.js';
import { checkBudget } from '../budget.js';
import { buildEditContext } from '../ai/context.js';
import { createJob, emit, finishJob, recordUsage } from '../ai/jobs.js';
import { runAgentLoop } from '../ai/loop.js';
import { NoModelError, NoProviderError, resolveTask } from '../ai/provider.js';
import { findSkill, skillBlock } from '../ai/skills.js';
import { agentTools, opTools } from '../ai/tools.js';
import type { ChatMessage } from '../ai/types.js';
import type { CoreTask } from '../db/schema.js';
import { commitOps, loadScore } from '../scores.js';
import {
	DEFAULT_AI,
	DEFAULT_MODELS,
	getSetting,
	type AiSettings,
	type ModelSettings
} from '../settings.js';
import { getControl } from './registry.js';

/**
 * Running a control.
 *
 * The three tiers are not three flavours of the same thing — they have
 * genuinely different costs, latencies and failure modes, and the dispatch
 * here is where that becomes concrete:
 *
 *   code   deterministic ops. No model, no key, no network, no job. Returns
 *          the finished document, because waiting on a promise for something
 *          that takes a millisecond is worse than doing it inline.
 *   prompt one model call against a stored template. Returns a job, because a
 *          single call is still seconds.
 *   agent  the tool-use loop. Returns a job.
 *
 * Keeping the free tier synchronous is deliberate: "Transpose" costing nothing
 * and answering instantly is a feature, and hiding it behind the same
 * machinery as "Orchestrate as a string quartet" would throw that away.
 */

export type ControlResult =
	| { kind: 'applied'; doc: unknown; revisionId: string; diff: unknown }
	| { kind: 'job'; jobId: string };

export interface RunControlOptions {
	controlId: string;
	scoreId: string;
	userId: string;
	params: Record<string, unknown>;
	selection: Selection;
	origin?: string;
}

export function runControl(opts: RunControlOptions): ControlResult {
	const control = getControl(opts.controlId);
	if (!control || !control.enabled) error(404, 'Control not found');

	// Ownership before anything else, so a stranger learns nothing about how
	// the instance is configured.
	const row = loadScore(opts.scoreId, opts.userId);
	const params = { ...(control.defaultParams ?? {}), ...opts.params };

	if (control.kind === 'code') {
		if (!control.opName) error(500, `Control "${control.name}" has no operation to run`);

		// Selection is merged in rather than taken from params: it comes from
		// what the user has highlighted, not from the control's own form.
		const op = { op: control.opName, args: { ...params, selection: opts.selection } } as Op;
		const commit = commitOps(opts.scoreId, opts.userId, [op], {
			source: 'control',
			label: control.name,
			// Deterministic and reversible through undo like any manual edit,
			// so there is nothing to review — staging it would just add a click.
			accepted: true
		});

		if (commit.errors.length) {
			error(400, commit.errors.map((e) => e.reason).join('; '));
		}
		return {
			kind: 'applied',
			doc: commit.score,
			revisionId: commit.revisionId,
			diff: commit.diff
		};
	}

	const task: CoreTask = control.kind === 'agent' ? 'orchestrate' : 'control_prompt';
	const resolved = resolveTask(task, opts.origin);
	// Code-tier controls return before this point and cost nothing, so only
	// model-backed controls meet the budget. Checked beside the provider so an
	// exhausted budget behaves exactly like a missing key: an immediate,
	// legible refusal before any job exists.
	checkBudget();
	const ai = getSetting<AiSettings>('ai', DEFAULT_AI);
	const models = getSetting<ModelSettings>('models', DEFAULT_MODELS);

	const instruction = interpolate(control.promptTemplate ?? '', params);
	// A control's own system prompt wins over the task's: it was written for
	// this specific job, and the task prompt is the generic fallback.
	const systemPrompt = control.systemPrompt || resolved.systemPrompt;

	const { id: jobId, abort } = createJob({
		userId: opts.userId,
		scoreId: opts.scoreId,
		task
	});

	void (async () => {
		try {
			emit(jobId, 'plan', { phases: [{ id: 'control', label: control.name }] });
			emit(jobId, 'phase', { id: 'control', index: 0, total: 1, label: control.name });
			emit(jobId, 'status', { message: `${control.name}…` });

			const styleRef = ai.useStyleSkills ? styleReference(params) : '';
			const userPrompt = [
				buildEditContext(row.doc, opts.selection, instruction),
				styleRef
			]
				.filter(Boolean)
				.join('\n\n');

			const result = await runAgentLoop({
				adapter: resolved.adapter,
				systemPrompt,
				userPrompt,
				score: row.doc,
				// A prompt control is one round trip by definition. Letting it
				// loop would quietly turn it into an agent control with an
				// agent's cost, which is exactly the distinction the tiers
				// exist to make visible.
				maxIterations: control.kind === 'agent' ? ai.maxIterations : 1,
				maxOps: ai.maxOpsPerTurn,
				maxTokens: resolved.options.maxTokens ?? models.maxTokens,
				effort: resolved.options.effort,
				reasoning: resolved.options.reasoning,
				tools: control.kind === 'agent' ? agentTools() : opTools(),
				signal: abort,
				phase: { id: 'control', label: control.name },
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

			// See run.ts: the loop reports an abort as an ordinary return, so a
			// cancelled control would otherwise still commit its edits.
			if (result.stopReason === 'aborted') {
				emit(jobId, 'result', {
					ops: 0,
					outcome: 'cancelled',
					opsApplied: 0,
					opsRejected: result.rejectedOps,
					summary: result.summary,
					warnings: result.warnings,
					stopReason: result.stopReason
				});
				finishJob(jobId, 'cancelled');
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

			// Staged, unlike the code tier: a model-driven change is a proposal
			// until someone has looked at it.
			const commit = commitOps(opts.scoreId, opts.userId, result.ops, {
				source: 'control',
				label: control.name,
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
			finishJob(jobId, 'error', err instanceof Error ? err.message : String(err));
		}
	})();

	return { kind: 'job', jobId };
}

/**
 * Fill `{{param}}` placeholders.
 *
 * A missing parameter leaves the placeholder in the prompt rather than
 * inserting "undefined" — a visible `{{amount}}` in a failing output points
 * straight at the misconfigured control, which the word "undefined" does not.
 */
export function interpolate(template: string, params: Record<string, unknown>): string {
	return template.replace(/\{\{\s*(\w+)\s*\}\}/g, (whole, key: string) => {
		const value = params[key];
		return value == null ? whole : String(value);
	});
}

/** The style skill for whichever parameter names one, if any. */
function styleReference(params: Record<string, unknown>): string {
	for (const key of ['style', 'genre', 'influence', 'ensemble']) {
		const value = params[key];
		if (typeof value !== 'string' || !value.trim()) continue;
		const skill = findSkill(value);
		if (skill) return skillBlock(skill);
	}
	return '';
}

export { NoModelError, NoProviderError };
