import { analysisReport } from './context.js';
import { summarise } from '$lib/score/analyse.js';
import type { Score } from '$lib/score/types.js';
import type { CoreTask } from '../db/schema.js';
import { checkBudget } from '../budget.js';
import { loadScore } from '../scores.js';
import { DEFAULT_MODELS, getSetting, type ModelSettings } from '../settings.js';
import { createJob, emit, finishJob, recordUsage, timedOut } from './jobs.js';
import { resolveTask } from './provider.js';
import { runProse } from './structured.js';
import { emptyUsage } from './types.js';

/**
 * Describing a finished piece: what it is, and what to call it.
 *
 * `analyse` and `title` are the last two of the four `CORE_TASKS` the epic found
 * with written prompts, seeded per-task model configuration and admin-editable
 * version history, and no caller anywhere. `compose_plan` and `compose_realize`
 * were wired by the Plan and Melody stages; these two are the remainder, and
 * this module is the caller both have been waiting for.
 *
 * They share a file because they are the same shape and differ only in what
 * they are asked. Neither touches the score: they read it, produce prose, and
 * commit nothing. That is why neither goes near `commitOps` or the loop — see
 * `runProse` in structured.ts for why a prose task must not be run as an agent
 * turn with no tools.
 *
 * Both prompts are used exactly as seeded. Both open "Given a score summary",
 * so both are fed the free, pure digest from `$lib/score/analyse.ts` rather than
 * the notes — which is what makes these the two cheapest calls in the app, and
 * what `TASK_EFFORT` already assumed when it gave `title` minimal effort and a
 * 200-token ceiling.
 */

export interface DescribeOptions {
	scoreId: string;
	userId: string;
	origin?: string;
}

/**
 * Explain the piece back to the person who wrote it. The `analyse` task.
 *
 * Fed `analysisReport` rather than `summarise`: its prompt asks the model to
 * "point at bar numbers", and the report is the one that lists bars with their
 * chords and note counts. Asking for something the input cannot support is how
 * a prompt ends up sounding confident and vague.
 */
export function startExplain(opts: DescribeOptions): { jobId: string } {
	return startProse({
		...opts,
		task: 'analyse',
		label: 'Analysing',
		status: 'Reading the score…',
		prompt: (score) => analysisReport(score)
	});
}

/**
 * Suggest a name. The `title` task.
 *
 * The seeded prompt ends "Return only the title", so one call is one suggestion.
 * Several suggestions are several presses, collected by the page — which keeps
 * the prompt honest rather than asking it for a list it was never written to
 * return, and keeps each press as cheap as the task was configured to be.
 */
export function startName(opts: DescribeOptions): { jobId: string } {
	return startProse({
		...opts,
		task: 'title',
		label: 'Naming',
		status: 'Thinking of a name…',
		prompt: (score) => summarise(score)
	});
}

interface ProseJobOptions extends DescribeOptions {
	task: CoreTask;
	label: string;
	status: string;
	prompt: (score: Score) => string;
}

/**
 * One prose task, as a job.
 *
 * Same ordering as every other runner here — ownership, then the provider, then
 * the budget, all before a job row exists, so a misconfiguration is an immediate
 * error with a useful message rather than a job created only to fail.
 */
function startProse(opts: ProseJobOptions): { jobId: string } {
	const row = loadScore(opts.scoreId, opts.userId);
	const resolved = resolveTask(opts.task, opts.origin);
	checkBudget();

	const { id: jobId, abort } = createJob({
		userId: opts.userId,
		scoreId: opts.scoreId,
		task: opts.task
	});

	void execute();
	return { jobId };

	async function execute() {
		const models = getSetting<ModelSettings>('models', DEFAULT_MODELS);
		// The exact text the answer was written from. Kept so a stored analysis
		// can say whether it still describes the piece — see the refine route.
		const userPrompt = opts.prompt(row.doc);

		try {
			emit(jobId, 'plan', { phases: [{ id: opts.task, label: opts.label }] });
			emit(jobId, 'phase', { id: opts.task, index: 0, total: 1, label: opts.label });
			emit(jobId, 'status', { message: opts.status });

			const result = await runProse({
				adapter: resolved.adapter,
				systemPrompt: resolved.systemPrompt,
				userPrompt,
				maxTokens: resolved.options.maxTokens ?? models.maxTokens,
				effort: resolved.options.effort,
				reasoning: resolved.options.reasoning,
				signal: abort,
				// Deltas are forwarded as deltas, unlike the plan job which
				// suppresses them. This answer *is* prose, so streaming it into the
				// progress panel shows the thing itself rather than a wall of braces.
				onEvent: (event) => emit(jobId, event.type, event)
			});

			recordUsage({
				userId: opts.userId,
				scoreId: opts.scoreId,
				task: opts.task,
				modelKey: resolved.model,
				usage: result.usage,
				status: 'ok'
			});

			if (result.stopReason === 'aborted') {
				const outcome = timedOut(jobId) ? 'timed_out' : 'cancelled';
				emit(jobId, 'result', { outcome, text: '', warnings: result.warnings });
				finishJob(jobId, outcome);
				return;
			}

			// `empty` is the only stopReason that means nothing came back. A
			// truncated answer stops mid-thought but is still worth reading, and
			// `runProse` returns its text for that reason — mapping it to
			// `no_effect` alongside a genuinely empty one would throw away a
			// paragraph the person already paid for.
			if (result.stopReason === 'empty' || !result.text) {
				emit(jobId, 'result', {
					outcome: 'no_effect',
					text: '',
					warnings: result.warnings,
					stopReason: result.stopReason
				});
				finishJob(jobId, 'no_effect');
				return;
			}

			emit(jobId, 'result', {
				outcome: 'done',
				text: result.text,
				// Carried so a caller that wants to store the answer can also store
				// what it was written from, and later tell whether it still holds.
				basis: userPrompt,
				// The progress panel reads `summary`; without it a finished run
				// shows an empty completion line for an answer that is all text.
				summary: result.text,
				warnings: result.warnings,
				stopReason: result.stopReason
			});
			finishJob(jobId, 'done');
		} catch (err) {
			recordUsage({
				userId: opts.userId,
				scoreId: opts.scoreId,
				task: opts.task,
				modelKey: resolved.model,
				usage: emptyUsage(),
				status: 'error'
			});
			finishJob(jobId, 'error', err instanceof Error ? err.message : String(err));
		}
	}
}
