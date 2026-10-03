import { applyOps, type Op } from '$lib/score/apply.js';
import { collectIds } from '$lib/score/ids.js';
import {
	accompanimentParts,
	clearPartOps,
	countNotes,
	type PartStatus
} from '$lib/pipeline/arrange.js';
import { onlyPart } from '$lib/pipeline/guards.js';
import { melodyPartOf } from '$lib/pipeline/realize.js';
import type { Plan } from '$lib/pipeline/types.js';
import type { Score } from '$lib/score/types.js';
import type { ReasoningEffort } from '../db/schema.js';
import { checkBudget } from '../budget.js';
import { assertNothingStaged, commitOps, loadScore } from '../scores.js';
import {
	DEFAULT_AI,
	DEFAULT_MODELS,
	getSetting,
	type AiSettings,
	type ModelSettings
} from '../settings.js';
import { buildArrangeContext, planSummary } from './context.js';
import { createJob, emit, finishJob, recordUsage, timedOut } from './jobs.js';
import { runAgentLoop } from './loop.js';
import { resolveTask } from './provider.js';
import { addUsage, message } from './realize.js';
import { agentTools, type FunctionDef } from './tools.js';
import type { ProviderAdapter, Usage } from './types.js';
import { emptyUsage } from './types.js';

/**
 * Arranging, one part at a time.
 *
 * The same shape as the melody stage, with parts where that has sections: the
 * phases are declared before the first call, so the progress bar counts parts;
 * each part is its own loop; and the document advances between them, so the
 * bass is written knowing what the strings did.
 *
 * Each loop is held to its one part by `onlyPart`. That is what makes the
 * page's per-part controls honest — clearing the strings undoes the run that
 * wrote them and nothing else — and it also keeps the melody as approved,
 * because the melody is never a target.
 *
 * Split like `realize.ts`: `arrangeParts` takes an adapter and touches no
 * database, so it can be tested against a scripted model.
 */

export interface ArrangeTarget {
	partId: string;
	name: string;
	instrument: string;
}

export interface ArrangeRunOptions {
	adapter: ProviderAdapter;
	systemPrompt: string;
	/** Read against, never mutated. */
	score: Score;
	plan: Plan;
	targets: ArrangeTarget[];
	melodyPartId: string | null;
	instruction?: string;
	maxIterations: number;
	/** Across the whole run, not per part. */
	maxOps: number;
	maxTokens?: number;
	effort?: ReasoningEffort;
	reasoning?: 'on' | 'hidden' | 'off';
	/** Called before each part, and may throw to stop the run. The budget check. */
	onBeforePart?: (target: ArrangeTarget) => void;
	onEvent?: (type: string, data: unknown) => void;
	signal?: AbortSignal;
}

export interface ArrangeRunResult {
	/** Collected across every part, ready for a single commitOps. */
	ops: Op[];
	working: Score;
	usage: Usage;
	warnings: string[];
	/** Part ids that were actually written. */
	done: string[];
	stopReason: 'done' | 'aborted' | 'budget' | 'max_ops' | 'failed';
}

export async function arrangeParts(opts: ArrangeRunOptions): Promise<ArrangeRunResult> {
	const usage = emptyUsage();
	const warnings: string[] = [];
	const done: string[] = [];
	const ops: Op[] = [];

	// One tool set for the run, for the cached prefix — see realize.ts.
	const tools: FunctionDef[] = agentTools();
	const summary = planSummary(opts.plan);
	const sections = formOf(opts.score, opts.plan);
	let working = opts.score;
	// Every id the commit will have seen — including the notes a rewrite
	// clears, which the loop's score no longer holds. See applyOps.
	let reserved: string[] = collectIds(opts.score);

	for (const [i, target] of opts.targets.entries()) {
		if (opts.signal?.aborted) return result('aborted');

		try {
			opts.onBeforePart?.(target);
		} catch (err) {
			warnings.push(message(err));
			return result('budget');
		}

		const remaining = opts.maxOps - ops.length;
		if (remaining <= 0) {
			warnings.push(`Stopped after ${opts.maxOps} operations across the whole run.`);
			return result('max_ops');
		}

		opts.onEvent?.('phase', {
			id: target.partId,
			index: i,
			total: opts.targets.length,
			label: target.name
		});

		// A rewrite starts from an empty part, cleared here rather than left to
		// the model: insert_notes into a part that still has notes would lay the
		// new line over the old one. The clear is only kept if something was
		// written to replace it — a rewrite that fails must not leave the part
		// emptier than it found it.
		const clear = clearPartOps(working, target.partId);
		const cleared = clear.length ? applyOps(working, clear, { reservedIds: reserved }).score : working;

		let loop;
		try {
			loop = await runAgentLoop({
				adapter: opts.adapter,
				systemPrompt: opts.systemPrompt,
				userPrompt: buildArrangeContext({
					score: cleared,
					planSummary: summary,
					sections,
					part: { id: target.partId, name: target.name, instrument: target.instrument },
					melodyPartId: opts.melodyPartId,
					written: cleared.parts
						.filter((p) => p.id !== target.partId && p.id !== opts.melodyPartId)
						.map((p) => ({ id: p.id, name: p.name, notes: countNotes(cleared, p.id) }))
						.filter((p) => p.notes > 0),
					instruction: opts.instruction
				}),
				score: cleared,
				tools,
				maxIterations: opts.maxIterations,
				maxOps: remaining,
				maxTokens: opts.maxTokens,
				effort: opts.effort,
				reasoning: opts.reasoning,
				signal: opts.signal,
				phase: { id: target.partId, label: target.name },
				guard: onlyPart(target.partId),
				reservedIds: reserved,
				onEvent: (event) => opts.onEvent?.(event.type, event)
			});
		} catch (err) {
			// Parts already written are kept, for the reason sections are kept in
			// realize.ts: a dropped connection on the fourth part must not cost
			// the first three.
			if (opts.signal?.aborted) return result('aborted');
			warnings.push(`${target.name}: ${message(err)}`);
			return result('failed');
		}

		addUsage(usage, loop.usage);
		warnings.push(...loop.warnings);
		if (loop.stopReason === 'aborted') return result('aborted');

		if (loop.ops.length) {
			ops.push(...clear, ...loop.ops);
			working = applyOps(cleared, loop.ops, { reservedIds: reserved }).score;
			reserved = loop.idsSeen;
			done.push(target.partId);
		} else {
			warnings.push(
				loop.rejectedOps > 0
					? `${target.name}: ${loop.rejectedOps} edits were refused and nothing was written.`
					: `${target.name}: the model wrote nothing.`
			);
		}

		opts.onEvent?.('progress', { partId: target.partId, doc: working, done: [...done] });
	}

	return result('done');

	function result(stopReason: ArrangeRunResult['stopReason']): ArrangeRunResult {
		return { ops, working, usage, warnings, done, stopReason };
	}
}

/**
 * The form with ticks, for the prompt.
 *
 * The score's sections, in order, with each plan card's harmony and role where
 * one points at it. A section with no card — written while arranging and not
 * yet synced — still gets its name and span.
 */
function formOf(score: Score, plan: Plan) {
	return [...score.sections]
		.filter((s) => s.endTick > s.startTick)
		.sort((a, b) => a.startTick - b.startTick)
		.map((s) => {
			const card = plan.sections.find((c) => c.sectionId === s.id);
			return {
				name: s.name,
				harmony: card?.harmony ?? '',
				role: card?.role ?? '',
				startTick: s.startTick,
				endTick: s.endTick
			};
		});
}

/** Nothing to do, for a reason the user can act on rather than a 500. */
export class NothingToArrangeError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'NothingToArrangeError';
	}
}

export interface ArrangeOptions {
	scoreId: string;
	userId: string;
	/** Restrict to these parts. Omitted means every part not yet written. */
	partIds?: string[];
	instruction?: string;
	origin?: string;
}

/**
 * One arrangement, as a job.
 *
 * Same ordering as `startRealize`: ownership, then what there is to do, then
 * the provider, then the budget — all before a job exists.
 */
export function startArrange(opts: ArrangeOptions): { jobId: string } {
	const row = loadScore(opts.scoreId, opts.userId);
	const plan = row.pipeline.plan;
	if (!plan) throw new NothingToArrangeError('Approve a plan before arranging.');
	assertNothingStaged(opts.scoreId, opts.userId);

	const parts = accompanimentParts(row.doc, plan, row.pipeline.brief);
	if (!parts.length) {
		throw new NothingToArrangeError(
			'The plan names no instruments besides the melody. Add some to the plan to arrange for them.'
		);
	}

	const targets = pickTargets(parts, opts.partIds);
	if (!targets.length) throw new NothingToArrangeError('Every part is already written.');

	const resolved = resolveTask('orchestrate', opts.origin);
	checkBudget();

	const melodyPartId = melodyPartOf(row.doc, plan, row.pipeline.brief);
	const { id: jobId, abort } = createJob({
		userId: opts.userId,
		scoreId: opts.scoreId,
		task: 'orchestrate'
	});

	void execute();
	return { jobId };

	async function execute() {
		const ai = getSetting<AiSettings>('ai', DEFAULT_AI);
		const models = getSetting<ModelSettings>('models', DEFAULT_MODELS);

		try {
			emit(jobId, 'plan', { phases: targets.map((t) => ({ id: t.partId, label: t.name })) });
			emit(jobId, 'status', { message: 'Reading the melody…' });

			const run = await arrangeParts({
				adapter: resolved.adapter,
				systemPrompt: resolved.systemPrompt,
				score: row.doc,
				plan: plan!,
				targets,
				melodyPartId,
				instruction: opts.instruction,
				maxIterations: ai.maxIterations,
				maxOps: ai.maxOpsPerTurn,
				maxTokens: resolved.options.maxTokens ?? models.maxTokens,
				effort: resolved.options.effort,
				reasoning: resolved.options.reasoning,
				onBeforePart: () => checkBudget(),
				onEvent: (type, data) => emit(jobId, type, data),
				signal: abort
			});

			recordUsage({
				userId: opts.userId,
				scoreId: opts.scoreId,
				task: 'orchestrate',
				modelKey: resolved.model,
				usage: run.usage,
				status: 'ok'
			});

			if (run.stopReason === 'aborted') {
				const outcome = timedOut(jobId) ? 'timed_out' : 'cancelled';
				emit(jobId, 'result', { outcome, ops: 0, warnings: run.warnings, parts: [] });
				finishJob(jobId, outcome);
				return;
			}

			if (!run.ops.length) {
				emit(jobId, 'result', { outcome: 'no_effect', ops: 0, warnings: run.warnings, parts: [] });
				finishJob(jobId, 'no_effect');
				return;
			}

			// One accepted commit per run, as in the melody stage: review here is
			// per part, through clear and rewrite, not through a pending slot.
			const partial = run.stopReason !== 'done';
			const base = labelFor(opts, targets, run.done);
			const commit = commitOps(opts.scoreId, opts.userId, run.ops, {
				source: 'ai',
				label: partial ? `${base} (incomplete)` : base,
				accepted: true,
				jobId
			});

			emit(jobId, 'result', {
				outcome: 'done',
				ops: run.ops.length,
				opsApplied: run.ops.length,
				warnings: partial
					? [...run.warnings, `Stopped after ${run.done.length} of ${targets.length} parts.`]
					: run.warnings,
				parts: run.done,
				stopReason: run.stopReason,
				doc: commit.score,
				revisionId: commit.revisionId,
				diff: commit.diff
			});
			finishJob(jobId, 'done');
		} catch (err) {
			finishJob(jobId, 'error', message(err));
		}
	}
}

/**
 * The parts a run writes.
 *
 * An explicit list is checked against the parts this stage writes, so a
 * request naming the melody — or a part from another score — is refused
 * rather than quietly arranged. No list means every empty part, which makes
 * resuming the same button as starting.
 */
export function pickTargets(parts: PartStatus[], partIds?: string[]): ArrangeTarget[] {
	const chosen = partIds?.length
		? partIds.map((id) => {
				const part = parts.find((p) => p.partId === id);
				if (!part) throw new NothingToArrangeError('That part is not one this stage writes.');
				return part;
			})
		: parts.filter((p) => p.state === 'empty');
	return chosen.map((p) => ({ partId: p.partId, name: p.name, instrument: p.instrument }));
}

function labelFor(opts: ArrangeOptions, targets: ArrangeTarget[], done: string[]): string {
	if (opts.instruction) return opts.instruction.slice(0, 120);
	const names = targets.filter((t) => done.includes(t.partId)).map((t) => t.name);
	return names.length ? `Arranged ${names.join(', ')}` : 'Arranged';
}
