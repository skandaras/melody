import { applyOps, type Op } from '$lib/score/apply.js';
import { checkPlayability, describeIssue } from '$lib/score/playability.js';
import {
	addedParts,
	melodyChanged,
	partChunks,
	partStates,
	unwrittenParts,
	type PartChunk
} from '$lib/pipeline/arrange.js';
import { melodyPartOf } from '$lib/pipeline/realize.js';
import type { Plan } from '$lib/pipeline/types.js';
import type { Score } from '$lib/score/types.js';
import type { ReasoningEffort } from '../db/schema.js';
import { checkBudget } from '../budget.js';
import { commitOps, loadScore } from '../scores.js';
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
import { findSkill, skillBlock } from './skills.js';
import { agentTools, type FunctionDef } from './tools.js';
import type { ProviderAdapter, Usage } from './types.js';
import { emptyUsage } from './types.js';

/**
 * Writing the accompaniment, one part at a time.
 *
 * The sibling of `realize.ts`, and deliberately close to it — same split
 * (`arrangeParts` takes an adapter and touches no database, so the part that is
 * easy to get wrong is testable against a scripted model), same four hazards
 * answered the same way, same one-commit-per-run.
 *
 * What differs is the axis. A realization walks time and each chunk needs the
 * bars before it; an arrangement walks the ensemble and each chunk needs the
 * parts beside it. That is why the working score is threaded through here too,
 * and it matters more rather than less: without it every instrument is written
 * as though it were the only accompaniment, which is exactly the "doubling
 * everything at the octave is not an arrangement" failure the task's own prompt
 * warns about.
 *
 * `orchestrate` is the one compose-adjacent CORE_TASK that was already wired —
 * `controls/run.ts` uses it for every agent-tier control — so unlike
 * `compose_realize` this is a second caller rather than a first.
 */

export interface ArrangeRunOptions {
	adapter: ProviderAdapter;
	systemPrompt: string;
	/** Read against, never mutated. */
	score: Score;
	plan: Plan;
	chunks: PartChunk[];
	/** The approved tune. Every chunk sees it; none may write to it. */
	melodyPartId: string | null;
	instruction?: string;
	/** A style skill block, appended once per chunk when one was named. */
	styleReference?: string;
	maxIterations: number;
	/** Across the whole run, not per chunk. */
	maxOps: number;
	maxTokens?: number;
	effort?: ReasoningEffort;
	reasoning?: 'on' | 'hidden' | 'off';
	/** Called before each part, and may throw to stop the run. */
	onBeforeChunk?: (chunk: PartChunk) => void;
	onEvent?: (type: string, data: unknown) => void;
	signal?: AbortSignal;
}

export interface ArrangeRunResult {
	/** Collected across every part, ready for a single commitOps. */
	ops: Op[];
	/** The score as it will be once those ops land. */
	working: Score;
	usage: Usage;
	warnings: string[];
	/** Part ids that actually got notes. */
	done: string[];
	stopReason: 'done' | 'aborted' | 'budget' | 'max_ops' | 'failed';
}

export async function arrangeParts(opts: ArrangeRunOptions): Promise<ArrangeRunResult> {
	const usage = emptyUsage();
	const warnings: string[] = [];
	const done: string[] = [];
	const ops: Op[] = [];

	// One tool set, built once — tools render at the front of the prompt, so a
	// list that varied per chunk would invalidate the cached prefix on every
	// call of the run. Agent tools rather than op tools, because the whole point
	// of `orchestrate` is that it reads before it writes.
	const tools: FunctionDef[] = agentTools();
	const summary = planSummary(opts.plan);

	// The score as it will be once this run's ops land. See the module comment:
	// this is what lets part three know what parts one and two are playing.
	let working = opts.score;

	for (const [i, chunk] of opts.chunks.entries()) {
		if (opts.signal?.aborted) return result('aborted');

		try {
			opts.onBeforeChunk?.(chunk);
		} catch (err) {
			warnings.push(message(err));
			return result('budget');
		}

		// maxOpsPerTurn is a per-loop cap, so a five-part arrangement could
		// otherwise land 2000 operations in one commit nobody could review.
		const remaining = opts.maxOps - ops.length;
		if (remaining <= 0) {
			warnings.push(`Stopped after ${opts.maxOps} operations across the whole run.`);
			return result('max_ops');
		}

		opts.onEvent?.('phase', {
			id: chunk.partId,
			index: i,
			total: opts.chunks.length,
			label: chunk.label
		});

		// Everything with notes in it, so this part can make room rather than
		// double. Read off `working`, so it grows as the run proceeds.
		const written = partStates(working, opts.plan, opts.melodyPartId)
			.filter((s) => s.state === 'written')
			.map((s) => s.partId);

		const userPrompt = [
			buildArrangeContext({
				score: working,
				planSummary: summary,
				partId: chunk.partId,
				partName: chunk.label,
				instrument: chunk.instrument,
				melodyPartId: opts.melodyPartId,
				writtenPartIds: written,
				instruction: opts.instruction
			}),
			opts.styleReference ?? ''
		]
			.filter(Boolean)
			.join('\n\n');

		let loop;
		try {
			loop = await runAgentLoop({
				adapter: opts.adapter,
				systemPrompt: opts.systemPrompt,
				userPrompt,
				score: working,
				tools,
				maxIterations: opts.maxIterations,
				maxOps: remaining,
				maxTokens: opts.maxTokens,
				effort: opts.effort,
				reasoning: opts.reasoning,
				signal: opts.signal,
				phase: { id: chunk.partId, label: chunk.label },
				onEvent: (event) => opts.onEvent?.(event.type, event)
			});
		} catch (err) {
			// Whatever earlier parts got is kept and returned. The part is the unit
			// of this stage precisely so a run that dies partway leaves usable work
			// — and per-part accept and reject would be a strange promise to make
			// while throwing away three finished parts because the fourth call
			// dropped its connection.
			if (opts.signal?.aborted) return result('aborted');
			warnings.push(`${chunk.label}: ${message(err)}`);
			return result('failed');
		}

		addUsage(usage, loop.usage);
		warnings.push(...loop.warnings);
		if (loop.stopReason === 'aborted') return result('aborted');

		if (loop.ops.length) {
			const before = working;
			ops.push(...loop.ops);
			working = applyOps(working, loop.ops).score;
			if (!done.includes(chunk.partId)) done.push(chunk.partId);

			// The ensemble was decided in the Plan. A part that appears here is a
			// plan change, and the epic asks that it say so rather than be silently
			// absorbed — so it is reported, not reverted. Reverting would throw away
			// work and leave notes pointing at a part that no longer exists.
			for (const part of addedParts(before, working)) {
				warnings.push(
					`${chunk.label}: added "${part.name}", which the plan did not name. ` +
						'Change the plan if you want to keep it.'
				);
			}

			// Trust, then verify. Every chunk is told which single part it may write
			// into and never given the melody as a target, but nothing enforces it,
			// and a silently rewritten tune is the worst possible outcome of a stage
			// whose whole premise is that the melody was already approved.
			if (melodyChanged(before, working, opts.melodyPartId)) {
				warnings.push(
					`${chunk.label}: this run also changed the melody, which it was told not to. ` +
						'Check the tune before continuing, or reject this part.'
				);
			}

			// The check the `Orchestrate as…` prompt has always asked for and never
			// had. Reported rather than corrected: an out-of-range note is a musical
			// judgement — an octave down, a different voicing, or leave it — and the
			// page can offer the choice now that it knows.
			for (const issue of checkPlayability(working, [chunk.partId])) {
				warnings.push(describeIssue(issue));
			}
		} else {
			// `rejectedOps` separates "it answered instead of editing" from "it tried
			// four edits and every one matched nothing". The second is what looked,
			// from outside, like reading the score and then doing nothing at all.
			warnings.push(
				loop.rejectedOps > 0
					? `${chunk.label}: ${loop.rejectedOps} edits were rejected and nothing was written.`
					: `${chunk.label}: the model wrote nothing for this part.`
			);
		}

		// The document so far, so the page fills in part by part without a
		// revision per chunk — which would fight the single pending slot the
		// editor reviews through.
		opts.onEvent?.('progress', { partId: chunk.partId, doc: working, done: [...done] });
	}

	return result('done');

	function result(stopReason: ArrangeRunResult['stopReason']): ArrangeRunResult {
		return { ops, working, usage, warnings, done, stopReason };
	}
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
	/** Restrict to these parts. Omitted means every accompaniment part still empty. */
	partIds?: string[];
	/** Free-text direction, for a pass over parts already written. */
	instruction?: string;
	origin?: string;
}

/**
 * One arrangement, as a job.
 *
 * Same ordering as `startRealize`, `startEdit` and `startPlan`: ownership, then
 * what there is to do, then the provider, then the budget — all before a job
 * row exists, so a misconfiguration is an immediate error with a useful message
 * rather than a job created only to fail a moment later.
 */
export function startArrange(opts: ArrangeOptions): { jobId: string } {
	const row = loadScore(opts.scoreId, opts.userId);
	const plan = row.pipeline.plan;
	if (!plan) throw new NothingToArrangeError('Approve a plan before arranging.');

	const ai = getSetting<AiSettings>('ai', DEFAULT_AI);
	const melodyPartId = melodyPartOf(row.doc, plan, row.pipeline.brief);

	// An explicit list means "these"; no list means "whatever is still empty",
	// which makes resuming an interrupted run the same operation as starting
	// one — and makes rewriting a rejected part the same operation again.
	const targets = opts.partIds?.length
		? opts.partIds
		: unwrittenParts(row.doc, plan, melodyPartId);
	const chunks = partChunks(row.doc, plan, melodyPartId, targets);
	if (!chunks.length) {
		throw new NothingToArrangeError(
			plan.ensemble.length > 1
				? 'Every part is already arranged.'
				: 'The plan has no accompaniment instruments to write for.'
		);
	}

	const resolved = resolveTask('orchestrate', opts.origin);
	checkBudget();

	const { id: jobId, abort } = createJob({
		userId: opts.userId,
		scoreId: opts.scoreId,
		task: 'orchestrate'
	});

	void execute();
	return { jobId };

	async function execute() {
		const models = getSetting<ModelSettings>('models', DEFAULT_MODELS);

		try {
			emit(jobId, 'plan', { phases: chunks.map((c) => ({ id: c.partId, label: c.label })) });
			emit(jobId, 'status', { message: 'Reading the score…' });

			const run = await arrangeParts({
				adapter: resolved.adapter,
				systemPrompt: resolved.systemPrompt,
				score: row.doc,
				plan: plan!,
				chunks,
				melodyPartId,
				instruction: opts.instruction,
				styleReference: ai.useStyleSkills ? styleFor(row.pipeline.brief?.referenceStyle) : '',
				maxIterations: ai.maxIterations,
				maxOps: ai.maxOpsPerTurn,
				maxTokens: resolved.options.maxTokens ?? models.maxTokens,
				effort: resolved.options.effort,
				reasoning: resolved.options.reasoning,
				onBeforeChunk: () => checkBudget(),
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

			// Cancelling has to mean the edits do not land — the bug F1 fixed, and
			// not one to reintroduce here just because this run has several calls.
			if (run.stopReason === 'aborted') {
				const outcome = timedOut(jobId) ? 'timed_out' : 'cancelled';
				emit(jobId, 'result', { outcome, ops: 0, warnings: run.warnings, parts: [] });
				finishJob(jobId, outcome);
				return;
			}

			if (!run.ops.length) {
				emit(jobId, 'result', {
					outcome: 'no_effect',
					ops: 0,
					warnings: run.warnings,
					parts: []
				});
				finishJob(jobId, 'no_effect');
				return;
			}

			// One commit for the run, accepted — as in the melody stage, and for the
			// same reason: per-chunk commits would fight the single pending slot, and
			// staging would ask twice for one decision.
			//
			// Accepted does not mean unreviewable. Per-part accept and reject is what
			// the page offers on top of this, and it needs no second pending slot: a
			// part is what one call wrote, so rejecting one clears its notes as its
			// own revision and "arrange what is left" writes it again.
			const partial = run.stopReason !== 'done';
			const base = labelFor(opts, chunks, run.done);

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
					? [...run.warnings, `Stopped after ${run.done.length} of ${chunks.length} parts.`]
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
 * The brief's reference style, as a prompt block.
 *
 * `skills.ts` appends style markdown for controls with a `style`, `genre`,
 * `influence` or `ensemble` parameter. A pipeline run has no control and so no
 * parameters, but it does have the style the brief named — and dropping it here
 * would mean the one place the person actually stated a style is the one place
 * it is ignored.
 */
function styleFor(name: string | undefined): string {
	if (!name?.trim()) return '';
	const skill = findSkill(name);
	return skill ? skillBlock(skill) : '';
}

function labelFor(opts: ArrangeOptions, chunks: PartChunk[], done: string[]): string {
	if (opts.instruction) return opts.instruction.slice(0, 120);
	const names = chunks.filter((c) => done.includes(c.partId)).map((c) => c.label);
	return names.length ? `Arranged ${names.join(', ')}` : 'Arranged the ensemble';
}

function message(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

function addUsage(total: Usage, add: Usage): void {
	total.promptTokens += add.promptTokens;
	total.completionTokens += add.completionTokens;
	total.cacheReadTokens += add.cacheReadTokens;
	total.cacheWriteTokens += add.cacheWriteTokens;
	if (add.costUsd != null) total.costUsd = (total.costUsd ?? 0) + add.costUsd;
}
