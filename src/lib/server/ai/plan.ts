import { analyse } from '$lib/score/analyse.js';
import { coercePlan, MAX_ENSEMBLE } from '$lib/pipeline/plan.js';
import { SEED_ROLE_LABELS, type Brief, type Plan } from '$lib/pipeline/types.js';
import type { Score } from '$lib/score/types.js';
import { checkBudget } from '../budget.js';
import { loadScore, setPipeline } from '../scores.js';
import {
	DEFAULT_MODELS,
	getSetting,
	type ModelSettings
} from '../settings.js';
import { createJob, emit, finishJob, recordUsage, timedOut } from './jobs.js';
import { resolveTask } from './provider.js';
import { findSkill, skillBlock } from './skills.js';
import { runStructured, type StructuredEvent } from './structured.js';
import { toStrictSchema } from './tools.js';

/**
 * Planning a piece before any of it is written.
 *
 * `compose_plan` has had a prompt and a seeded configuration since the
 * beginning and has never been called by anything. This is its first caller.
 *
 * The whole point of the stage is that this output is cheap, legible and
 * *wrong in ways a person can see* — so it is saved to the score's `plan`
 * column and shown for editing. Nothing here writes a note; approving does
 * that, and approving is a separate action the user takes.
 */

/**
 * The plan schema, before strict-mode rewriting.
 *
 * Authored with ordinary bounds and run through `toStrictSchema`, which strips
 * them into the description and makes every property required and nullable —
 * `strict: true` is hardcoded in the adapter, so a stray `minimum` is a 400
 * rather than a hint.
 */
const PLAN_SCHEMA = {
	type: 'object',
	properties: {
		title: {
			type: 'string',
			description: 'A short title for the piece. Two to five words, no quotation marks.'
		},
		key: {
			type: 'object',
			properties: {
				tonic: { type: 'string', description: 'Note name without octave, e.g. "D", "Bb", "F#".' },
				mode: { type: 'string', enum: ['major', 'minor'] }
			},
			required: ['tonic', 'mode'],
			additionalProperties: false
		},
		tempoBpm: { type: 'integer', minimum: 20, maximum: 300 },
		timeSig: {
			type: 'object',
			properties: {
				num: { type: 'integer', minimum: 1, maximum: 32 },
				den: { type: 'integer', enum: [1, 2, 4, 8, 16, 32] }
			},
			required: ['num', 'den'],
			additionalProperties: false
		},
		ensemble: {
			type: 'array',
			maxItems: MAX_ENSEMBLE,
			description: 'The instruments that play. One entry per staff.',
			items: {
				type: 'object',
				properties: {
					name: { type: 'string', description: 'Staff name, e.g. "Violin I".' },
					instrument: { type: 'string', description: 'General MIDI instrument name.' },
					partId: {
						type: 'string',
						description:
							'The id of an existing part this entry stands for. Use it for a part that is already in the score, so it is not added twice. Leave null for a new part.'
					}
				},
				required: ['name', 'instrument'],
				additionalProperties: false
			}
		},
		sections: {
			type: 'array',
			minItems: 1,
			maxItems: 24,
			description: 'The form, in order.',
			items: {
				type: 'object',
				properties: {
					name: { type: 'string', description: 'e.g. "Verse 1", "Chorus", "Bridge".' },
					bars: { type: 'integer', minimum: 1, maximum: 64 },
					harmony: {
						type: 'string',
						description: 'A concrete progression, e.g. "i-VI-III-VII in A minor".'
					},
					role: {
						type: 'string',
						description: 'What the section does: statement, contrast, release, climax.'
					}
				},
				required: ['name', 'bars', 'harmony', 'role'],
				additionalProperties: false
			}
		}
	},
	required: ['title', 'key', 'tempoBpm', 'timeSig', 'ensemble', 'sections'],
	additionalProperties: false
};

const STRICT_PLAN_SCHEMA = {
	name: 'composition_plan',
	schema: toStrictSchema(PLAN_SCHEMA) as Record<string, unknown>
};

/** Exported for the schema test — strict mode has rules worth pinning. */
export const planSchema = STRICT_PLAN_SCHEMA;

/**
 * What the model is told.
 *
 * The brief carries the intent; the score carries what already exists. Both
 * matter: a plan that ignores the part the user hummed into is a plan that
 * duplicates it.
 */
export function buildPlanContext(score: Score, brief: Brief): string {
	const lines: string[] = [];

	lines.push('The brief:');
	lines.push(brief.description.trim() || '(nothing written — work from the recording below)');
	if (brief.mood) lines.push(`Mood: ${brief.mood}`);
	if (brief.ensemble) lines.push(`Instruments asked for: ${brief.ensemble}`);
	if (brief.lengthBars) lines.push(`Rough length: ${brief.lengthBars} bars`);

	if (score.parts.length) {
		lines.push('', 'Parts already in the score:');
		for (const part of score.parts) {
			const notes = part.voices.reduce((n, v) => n + v.events.length, 0);
			const seeded = part.id === brief.seedPartId;
			lines.push(
				`  ${part.id} "${part.name}" — ${notes} events${seeded ? ' (the recording)' : ''}`
			);
		}
		lines.push(
			'Use an existing part id as `partId` for any instrument already present, so it is not added twice.'
		);
	}

	if (brief.seedPartId) {
		const role = brief.seedRole ? SEED_ROLE_LABELS[brief.seedRole] : 'part of the piece';
		lines.push('', `The recording is ${role.toLowerCase()}. Give it that role in the plan.`);

		// The seed's own key and tempo, because `set_key` changes the signature
		// without transposing anything (ops/global.ts). A plan in a distant key
		// leaves what the user hummed sounding wrong against it, and the cheapest
		// fix by far is to plan in a key that already fits.
		const a = analyse(score, { partIds: [brief.seedPartId] });
		if (a.totalNotes > 0) {
			lines.push(
				`It is in ${a.key.name} at about ${a.tempoBpm}bpm. Plan in that key unless the brief asks for something else — the recording is not transposed to match.`
			);
		}
	}

	const skill = brief.referenceStyle ? findSkill(brief.referenceStyle) : null;
	if (skill) lines.push('', skillBlock(skill));

	lines.push('', 'Plan the piece.');
	return lines.join('\n');
}

export interface PlanJobOptions {
	scoreId: string;
	userId: string;
	origin?: string;
}

/**
 * Generate a plan as a job.
 *
 * Same shape as `startEdit`: ownership, then provider, then budget, all before
 * a job row exists, so a misconfiguration is an immediate error with a useful
 * message rather than a job created only to fail a moment later.
 */
export function startPlan(opts: PlanJobOptions): { jobId: string } {
	const row = loadScore(opts.scoreId, opts.userId);
	const brief = row.pipeline.brief;
	if (!brief) throw new Error('Write a brief before planning.');

	const resolved = resolveTask('compose_plan', opts.origin);
	checkBudget();

	const { id: jobId, abort } = createJob({
		userId: opts.userId,
		scoreId: opts.scoreId,
		task: 'compose_plan'
	});

	void execute();
	return { jobId };

	async function execute() {
		const models = getSetting<ModelSettings>('models', DEFAULT_MODELS);
		let writing = false;

		/**
		 * Forward progress, but not the JSON itself.
		 *
		 * `delta` accumulates into `RunState.streamed`, which the progress panel
		 * renders as prose — and a structured reply is a wall of braces, not
		 * prose. So the tokens become one status change instead: enough to show
		 * the run is alive, without scrolling a schema past the reader.
		 */
		function relay(event: StructuredEvent) {
			if (event.type === 'delta') {
				if (writing) return;
				writing = true;
				emit(jobId, 'status', { message: 'Writing the plan…' });
				return;
			}
			emit(jobId, event.type, event);
		}

		try {
			emit(jobId, 'plan', { phases: [{ id: 'plan', label: 'Planning' }] });
			emit(jobId, 'phase', { id: 'plan', index: 0, total: 1, label: 'Planning' });
			emit(jobId, 'status', { message: 'Reading the brief…' });

			const result = await runStructured<unknown>({
				adapter: resolved.adapter,
				systemPrompt: resolved.systemPrompt,
				userPrompt: buildPlanContext(row.doc, brief!),
				schema: STRICT_PLAN_SCHEMA,
				maxTokens: resolved.options.maxTokens ?? models.maxTokens,
				effort: resolved.options.effort,
				reasoning: resolved.options.reasoning,
				signal: abort,
				onEvent: relay
			});

			recordUsage({
				userId: opts.userId,
				scoreId: opts.scoreId,
				task: 'compose_plan',
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

			const plan = coercePlan(result.value, row.doc);
			if (!plan) {
				// A run that produced no usable plan changed nothing, which is
				// exactly what `no_effect` is for — reporting it as success would
				// leave the user looking at an empty page that claims to be done.
				emit(jobId, 'result', {
					outcome: 'no_effect',
					warnings: result.warnings,
					stopReason: result.stopReason
				});
				finishJob(jobId, 'no_effect');
				return;
			}

			// Saved, not committed. The plan is a proposal until the user approves
			// it, and approval is the only thing in this stage that writes music.
			const pipeline = setPipeline(opts.scoreId, opts.userId, { plan });

			emit(jobId, 'result', {
				outcome: 'done',
				plan: pipeline.plan,
				summary: plan.title,
				warnings: result.warnings,
				stopReason: result.stopReason
			});
			finishJob(jobId, 'done');
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			recordUsage({
				userId: opts.userId,
				scoreId: opts.scoreId,
				task: 'compose_plan',
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
			finishJob(jobId, 'error', message);
		}
	}
}

/** Re-exported so the approval route reads as one import. */
export type { Plan };
