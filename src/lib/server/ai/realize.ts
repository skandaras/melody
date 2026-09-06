import { applyOps, type Op } from '$lib/score/apply.js';
import { chunksFor, melodyPartOf, unwrittenSections, type Chunk } from '$lib/pipeline/realize.js';
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
import { buildRealizeContext, planSummary } from './context.js';
import { createJob, emit, finishJob, recordUsage, timedOut } from './jobs.js';
import { runAgentLoop } from './loop.js';
import { resolveTask } from './provider.js';
import { agentTools, type FunctionDef } from './tools.js';
import type { ProviderAdapter, Usage } from './types.js';
import { emptyUsage } from './types.js';

/**
 * Writing the melody, one section at a time.
 *
 * `compose_realize` has had a prompt and a seeded config since the beginning
 * and has never been called; `AiSettings.realizeChunkBars` was added to chunk
 * it and is likewise dead. This is the caller both were waiting for.
 *
 * Chunking is not only about context length. It is what gives the run a real
 * denominator: phases are declared before the first call, so the progress bar
 * counts sections rather than spinning — the direct answer to "no progress of
 * what it's doing, so a failed run might just never resolve".
 *
 * Split the same way `runAgentLoop`/`startEdit` and `runStructured`/`startPlan`
 * already are: `realizeChunks` takes an adapter and touches no database, so the
 * part that is easy to get wrong can be tested against a scripted model.
 */

export interface RealizeRunOptions {
	adapter: ProviderAdapter;
	systemPrompt: string;
	/** Read against, never mutated. */
	score: Score;
	plan: Plan;
	chunks: Chunk[];
	/** The one part every chunk writes into. */
	partId: string;
	/** The hummed theme, forwarded to every chunk. */
	motifPartId?: string;
	instruction?: string;
	maxIterations: number;
	/** Across the whole run, not per chunk. See the loop below. */
	maxOps: number;
	maxTokens?: number;
	effort?: ReasoningEffort;
	reasoning?: 'on' | 'hidden' | 'off';
	/**
	 * Called before each chunk, and may throw to stop the run.
	 *
	 * This is where the budget check goes. `run.ts` checks once when a job
	 * starts, which for a six-chunk realization leaves the cap five calls behind
	 * the spending — a check can only refuse work it runs in front of.
	 */
	onBeforeChunk?: (chunk: Chunk) => void;
	onEvent?: (type: string, data: unknown) => void;
	signal?: AbortSignal;
}

export interface RealizeRunResult {
	/** Collected across every chunk, ready for a single commitOps. */
	ops: Op[];
	/** The score as it will be once those ops land. */
	working: Score;
	usage: Usage;
	warnings: string[];
	/** Section ids that actually got notes. */
	done: string[];
	stopReason: 'done' | 'aborted' | 'budget' | 'max_ops' | 'failed';
}

export async function realizeChunks(opts: RealizeRunOptions): Promise<RealizeRunResult> {
	const usage = emptyUsage();
	const warnings: string[] = [];
	const done: string[] = [];
	const ops: Op[] = [];

	// One tool set, built once. tools.ts warns that definitions are sorted and
	// identical for every task precisely because they render at the very front
	// of the prompt — a list that varied per chunk would invalidate the cached
	// prefix on every call of the run.
	const tools: FunctionDef[] = agentTools();
	const summary = planSummary(opts.plan);

	// The score as it will be once this run's ops land. The loop advances its
	// own copy within one loop only, so without applying each chunk here every
	// later chunk would be written against the original score and "connect to
	// what came before" would mean nothing.
	let working = opts.score;

	for (const [i, chunk] of opts.chunks.entries()) {
		if (opts.signal?.aborted) return result('aborted');

		try {
			opts.onBeforeChunk?.(chunk);
		} catch (err) {
			warnings.push(message(err));
			return result('budget');
		}

		// maxOpsPerTurn is a per-loop cap, so six chunks could otherwise land
		// 2400 operations in one commit nobody could review. What is left of the
		// run's whole allowance becomes this chunk's cap.
		const remaining = opts.maxOps - ops.length;
		if (remaining <= 0) {
			warnings.push(`Stopped after ${opts.maxOps} operations across the whole run.`);
			return result('max_ops');
		}

		opts.onEvent?.('phase', {
			id: chunkId(chunk),
			index: i,
			total: opts.chunks.length,
			label: chunk.label
		});

		const cards = opts.plan.sections;
		const next = cards[cards.indexOf(chunk.section) + 1];

		let loop;
		try {
			loop = await runAgentLoop({
				adapter: opts.adapter,
				systemPrompt: opts.systemPrompt,
				userPrompt: buildRealizeContext({
					score: working,
					planSummary: summary,
					sectionBrief: describeSection(chunk),
					nextRole: next ? `${next.name} — ${next.role}` : undefined,
					startTick: chunk.startTick,
					endTick: chunk.endTick,
					partId: opts.partId,
					motifPartId: opts.motifPartId,
					instruction: opts.instruction
				}),
				score: working,
				tools,
				maxIterations: opts.maxIterations,
				maxOps: remaining,
				maxTokens: opts.maxTokens,
				effort: opts.effort,
				reasoning: opts.reasoning,
				signal: opts.signal,
				phase: { id: chunkId(chunk), label: chunk.label },
				onEvent: (event) => opts.onEvent?.(event.type, event)
			});
		} catch (err) {
			// Whatever earlier chunks wrote is kept and returned. Sections are the
			// unit of this stage precisely so a run that dies partway leaves usable
			// work — losing four finished sections because the fifth call dropped
			// its connection would be the worst possible reading of "one commit".
			if (opts.signal?.aborted) return result('aborted');
			warnings.push(`${chunk.label}: ${message(err)}`);
			return result('failed');
		}

		addUsage(usage, loop.usage);
		warnings.push(...loop.warnings);
		if (loop.stopReason === 'aborted') return result('aborted');

		if (loop.ops.length) {
			ops.push(...loop.ops);
			working = applyOps(working, loop.ops).score;
			if (!done.includes(chunk.sectionId)) done.push(chunk.sectionId);
		} else {
			// Worth naming rather than passing over. `rejectedOps` separates "it
			// answered instead of editing" from "it tried four edits and every one
			// matched nothing" — the second is what looked, from outside, like
			// reading the score and then doing nothing at all.
			warnings.push(
				loop.rejectedOps > 0
					? `${chunk.label}: ${loop.rejectedOps} edits were rejected and nothing was written.`
					: `${chunk.label}: the model wrote nothing.`
			);
		}

		// The document so far, so the page fills in section by section without a
		// revision per chunk — which would fight the single pending slot the
		// editor reviews through.
		opts.onEvent?.('progress', { sectionId: chunk.sectionId, doc: working, done: [...done] });
	}

	return result('done');

	function result(stopReason: RealizeRunResult['stopReason']): RealizeRunResult {
		return { ops, working, usage, warnings, done, stopReason };
	}
}

/** Nothing to do, for a reason the user can act on rather than a 500. */
export class NothingToRealizeError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'NothingToRealizeError';
	}
}

export interface RealizeOptions {
	scoreId: string;
	userId: string;
	/** Restrict to these sections. Omitted means every section not yet written. */
	sectionIds?: string[];
	/** Free-text direction, for a pass over sections already written. */
	instruction?: string;
	origin?: string;
}

/**
 * One realization, as a job.
 *
 * Same ordering as `startEdit` and `startPlan`: ownership, then what there is
 * to do, then the provider, then the budget — all before a job row exists, so a
 * misconfiguration is an immediate error with a useful message rather than a
 * job created only to fail a moment later.
 */
export function startRealize(opts: RealizeOptions): { jobId: string } {
	const row = loadScore(opts.scoreId, opts.userId);
	const plan = row.pipeline.plan;
	if (!plan) throw new NothingToRealizeError('Approve a plan before writing the melody.');

	const ai = getSetting<AiSettings>('ai', DEFAULT_AI);
	const partId = melodyPartOf(row.doc, plan, row.pipeline.brief);
	if (!partId) throw new NothingToRealizeError('The plan has no instruments to write for.');

	// An explicit list means "these"; no list means "whatever is still empty",
	// which makes resuming an interrupted run the same operation as starting one.
	const targets = opts.sectionIds?.length
		? opts.sectionIds
		: unwrittenSections(row.doc, plan, partId);
	const chunks = chunksFor(row.doc, plan, ai.realizeChunkBars, targets);
	if (!chunks.length) throw new NothingToRealizeError('Every section is already written.');

	const resolved = resolveTask('compose_realize', opts.origin);
	checkBudget();

	const { id: jobId, abort } = createJob({
		userId: opts.userId,
		scoreId: opts.scoreId,
		task: 'compose_realize'
	});

	void execute();
	return { jobId };

	async function execute() {
		const models = getSetting<ModelSettings>('models', DEFAULT_MODELS);

		try {
			emit(jobId, 'plan', { phases: chunks.map((c) => ({ id: chunkId(c), label: c.label })) });
			emit(jobId, 'status', { message: 'Reading the plan…' });

			const run = await realizeChunks({
				adapter: resolved.adapter,
				systemPrompt: resolved.systemPrompt,
				score: row.doc,
				plan: plan!,
				chunks,
				partId: partId!,
				motifPartId: row.pipeline.brief?.seedPartId,
				instruction: opts.instruction,
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
				task: 'compose_realize',
				modelKey: resolved.model,
				usage: run.usage,
				status: 'ok'
			});

			// Cancelling has to mean the edits do not land — the bug F1 fixed, and
			// not one to reintroduce here just because this run has several calls.
			if (run.stopReason === 'aborted') {
				const outcome = timedOut(jobId) ? 'timed_out' : 'cancelled';
				emit(jobId, 'result', { outcome, ops: 0, warnings: run.warnings, sections: [] });
				finishJob(jobId, outcome);
				return;
			}

			if (!run.ops.length) {
				emit(jobId, 'result', {
					outcome: 'no_effect',
					ops: 0,
					warnings: run.warnings,
					sections: []
				});
				finishJob(jobId, 'no_effect');
				return;
			}

			// One commit for the run, accepted. Per-chunk commits would fight the
			// single pending slot, and staging would ask twice for one decision —
			// accept the notes, then approve the stage. Each run being its own
			// revision is what makes comparing and reverting variants the existing
			// history mechanism rather than a new one.
			// A run that stopped early still commits what it wrote — but says so.
			// Reporting a partial realization as plain success is the same dishonesty
			// as reporting a turn that changed nothing as success, which is the
			// complaint this whole pipeline exists to answer.
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
					? [...run.warnings, `Stopped after ${run.done.length} of ${chunks.length} sections.`]
					: run.warnings,
				sections: run.done,
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

/** Stable per chunk, and unique when a section was split into several. */
function chunkId(chunk: Chunk): string {
	return chunk.of > 1 ? `${chunk.sectionId}#${chunk.part}` : chunk.sectionId;
}

function describeSection(chunk: Chunk): string {
	const { section } = chunk;
	const lines = [
		`${section.name} — ${section.role || 'no stated role'}`,
		`Harmony: ${section.harmony || 'choose something that fits the plan'}`,
		`Ticks ${chunk.startTick} to ${chunk.endTick}.`
	];
	if (chunk.of > 1) lines.push(`This is part ${chunk.part} of ${chunk.of} of that section.`);
	return lines.join('\n');
}

function labelFor(opts: RealizeOptions, chunks: Chunk[], done: string[]): string {
	if (opts.instruction) return opts.instruction.slice(0, 120);
	const names = [
		...new Set(chunks.filter((c) => done.includes(c.sectionId)).map((c) => c.section.name))
	];
	return names.length ? `Wrote ${names.join(', ')}` : 'Wrote the melody';
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
