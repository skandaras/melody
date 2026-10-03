import type { PipelineState } from '$lib/pipeline/types.js';
import type { Score } from '$lib/score/types.js';
import type { CoreTask } from '../db/schema.js';
import { checkBudget } from '../budget.js';
import { loadScore, musicFingerprint, setAnalysis } from '../scores.js';
import { DEFAULT_MODELS, getSetting, type ModelSettings } from '../settings.js';
import { analysisReport, describeScore } from './context.js';
import { createJob, emit, finishJob, recordUsage, timedOut } from './jobs.js';
import { resolveTask } from './provider.js';
import { runStructured, type StructuredEvent } from './structured.js';
import { toStrictSchema } from './tools.js';

/**
 * Naming a piece, and explaining it.
 *
 * The `title` and `analyse` tasks have had written prompts and seeded configs
 * since the beginning and have never been called. These are their callers.
 * Both are one structured call with no tools and no edits, so both go through
 * `runStructured` as a job — the same stream, cancel and progress bar as
 * everything else — and neither writes music. A title is only a suggestion
 * until the person saves one; an explanation is stored, but beside the score
 * rather than in it.
 */

const TITLES_SCHEMA = {
	name: 'title_suggestions',
	schema: toStrictSchema({
		type: 'object',
		properties: {
			titles: {
				type: 'array',
				items: { type: 'string' },
				description: 'Three different titles, best first.'
			}
		},
		required: ['titles'],
		additionalProperties: false
	}) as Record<string, unknown>
};

const EXPLAIN_SCHEMA = {
	name: 'explanation',
	schema: toStrictSchema({
		type: 'object',
		properties: {
			explanation: {
				type: 'string',
				description: 'A few short paragraphs of plain prose. Point at bar numbers.'
			}
		},
		required: ['explanation'],
		additionalProperties: false
	}) as Record<string, unknown>
};

/**
 * What both tasks are shown: the piece, read off the notes, and what it was
 * asked to be.
 *
 * The brief is included because a good title names the music rather than the
 * request, and the model cannot tell the two apart without seeing the request.
 */
export function buildFinishContext(score: Score, pipeline: PipelineState): string {
	const lines = [describeScore(score), '', analysisReport(score)];
	if (score.sections.length) {
		lines.push('', 'Sections:');
		for (const s of [...score.sections].sort((a, b) => a.startTick - b.startTick)) {
			lines.push(`  ${s.name}: ticks ${s.startTick} to ${s.endTick}`);
		}
	}
	const brief = pipeline.brief;
	if (brief?.description.trim()) lines.push('', `It was asked for as: ${brief.description.trim()}`);
	if (brief?.mood?.trim()) lines.push(`Mood: ${brief.mood.trim()}`);
	if (pipeline.plan?.title) lines.push(`Working title: ${pipeline.plan.title}`);
	return lines.join('\n');
}

/**
 * Titles worth offering.
 *
 * The prompt already forbids quotation marks and "Untitled"; this does not
 * trust it to. Duplicates differing only in case or quoting are one title.
 */
export function parseTitles(value: unknown): string[] {
	const raw = (value as { titles?: unknown } | null)?.titles;
	if (!Array.isArray(raw)) return [];
	const seen = new Set<string>();
	const out: string[] = [];
	for (const item of raw) {
		if (typeof item !== 'string') continue;
		const title = item
			.trim()
			.replace(/^["'“‘«]+|["'”’»]+$/g, '')
			.trim()
			.slice(0, 120);
		const key = title.toLowerCase();
		if (!title || key === 'untitled' || seen.has(key)) continue;
		seen.add(key);
		out.push(title);
		if (out.length === 3) break;
	}
	return out;
}

export function parseExplanation(value: unknown): string | null {
	const raw = (value as { explanation?: unknown } | null)?.explanation;
	if (typeof raw !== 'string') return null;
	const text = raw.trim();
	return text ? text.slice(0, 20_000) : null;
}

export interface FinishJobOptions {
	scoreId: string;
	userId: string;
	origin?: string;
}

/** Three title suggestions, as a job. Nothing is saved. */
export function startTitles(opts: FinishJobOptions): { jobId: string } {
	return startOne(opts, {
		task: 'title',
		label: 'Naming it',
		schema: TITLES_SCHEMA,
		finish: (value) => {
			const titles = parseTitles(value);
			return titles.length ? { titles, summary: titles.join(' · ') } : null;
		}
	});
}

/**
 * An explanation of the piece, as a job, kept on success.
 *
 * Stored against the music it was shown, so an edit made while it was being
 * written marks it out of date straight away rather than leaving it claiming
 * to describe music it never saw.
 */
export function startExplain(opts: FinishJobOptions): { jobId: string } {
	return startOne(opts, {
		task: 'analyse',
		label: 'Listening',
		schema: EXPLAIN_SCHEMA,
		finish: (value, shown) => {
			const text = parseExplanation(value);
			if (!text) return null;
			const stored = setAnalysis(opts.scoreId, opts.userId, text, shown);
			const stale = musicFingerprint(loadScore(opts.scoreId, opts.userId).doc) !== stored.fingerprint;
			return { analysis: { text, createdAt: stored.createdAt, stale }, summary: '' };
		}
	});
}

/**
 * One structured call as a job.
 *
 * Same ordering as `startPlan`: ownership, provider, budget, then the job. The
 * `finish` callback turns the parsed reply into the result payload, or null
 * when it had nothing usable in it — which is `no_effect`, not success.
 */
function startOne(
	opts: FinishJobOptions,
	spec: {
		task: CoreTask;
		label: string;
		schema: { name: string; schema: Record<string, unknown> };
		/** `shown` is the document the model was given. */
		finish: (value: unknown, shown: Score) => Record<string, unknown> | null;
	}
): { jobId: string } {
	const row = loadScore(opts.scoreId, opts.userId);
	const resolved = resolveTask(spec.task, opts.origin);
	checkBudget();

	const { id: jobId, abort } = createJob({
		userId: opts.userId,
		scoreId: opts.scoreId,
		task: spec.task
	});

	void execute();
	return { jobId };

	async function execute() {
		const models = getSetting<ModelSettings>('models', DEFAULT_MODELS);
		let writing = false;

		// The reply is JSON, not prose, so its tokens become one status line —
		// see the same choice in plan.ts.
		function relay(event: StructuredEvent) {
			if (event.type === 'delta') {
				if (writing) return;
				writing = true;
				emit(jobId, 'status', { message: `${spec.label}…` });
				return;
			}
			emit(jobId, event.type, event);
		}

		try {
			emit(jobId, 'plan', { phases: [{ id: spec.task, label: spec.label }] });
			emit(jobId, 'phase', { id: spec.task, index: 0, total: 1, label: spec.label });

			const result = await runStructured<unknown>({
				adapter: resolved.adapter,
				systemPrompt: resolved.systemPrompt,
				userPrompt: buildFinishContext(row.doc, row.pipeline),
				schema: spec.schema,
				maxTokens: resolved.options.maxTokens ?? models.maxTokens,
				effort: resolved.options.effort,
				reasoning: resolved.options.reasoning,
				signal: abort,
				onEvent: relay
			});

			recordUsage({
				userId: opts.userId,
				scoreId: opts.scoreId,
				task: spec.task,
				modelKey: resolved.model,
				usage: result.usage,
				status: 'ok'
			});

			if (result.stopReason === 'aborted') {
				const outcome = timedOut(jobId) ? 'timed_out' : 'cancelled';
				emit(jobId, 'result', { outcome, warnings: result.warnings });
				finishJob(jobId, outcome);
				return;
			}

			const payload = result.value === null ? null : spec.finish(result.value, row.doc);
			if (!payload) {
				emit(jobId, 'result', {
					outcome: 'no_effect',
					warnings: result.warnings,
					stopReason: result.stopReason
				});
				finishJob(jobId, 'no_effect');
				return;
			}

			emit(jobId, 'result', {
				outcome: 'done',
				...payload,
				warnings: result.warnings,
				stopReason: result.stopReason
			});
			finishJob(jobId, 'done');
		} catch (err) {
			recordUsage({
				userId: opts.userId,
				scoreId: opts.scoreId,
				task: spec.task,
				modelKey: resolved.model,
				usage: {
					promptTokens: 0,
					completionTokens: 0,
					cacheReadTokens: 0,
					cacheWriteTokens: 0,
					costUsd: null
				},
				status: 'error'
			});
			finishJob(jobId, 'error', err instanceof Error ? err.message : String(err));
		}
	}
}
