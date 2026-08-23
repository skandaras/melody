/**
 * The AI vocabulary shared by both sides.
 *
 * These constants describe configuration the admin panel edits and the server
 * enforces, so they cannot live in `server/db/schema.ts` — SvelteKit refuses to
 * bundle anything under `$lib/server` into the client, and rightly so. The
 * schema re-exports these rather than redeclaring them, so there is still one
 * definition and no chance of the two drifting.
 */

/**
 * Named AI jobs. Each gets its own model, system prompt and effort so you can
 * run cheap models for titling and the best one for composition.
 */
export const CORE_TASKS = [
	'transcribe_cleanup',
	'compose_plan',
	'compose_realize',
	'edit_selection',
	'control_prompt',
	'orchestrate',
	'analyse',
	'title'
] as const;
export type CoreTask = (typeof CORE_TASKS)[number];

/** OpenRouter's reasoning levels. Note there is no `max` — the ceiling is
 *  `xhigh`, which allocates roughly 95% of max_tokens to reasoning. */
export const REASONING_EFFORTS = ['minimal', 'low', 'medium', 'high', 'xhigh'] as const;
export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];

/**
 * Per-task knobs, in OpenRouter's vocabulary rather than any one vendor's.
 *
 * Deliberately no temperature: several current reasoning models reject it
 * outright, so exposing the field would only invite an un-runnable
 * configuration.
 *
 * `reasoning` is three-state rather than a boolean because "think but don't
 * show me" is a genuinely different request from "don't think":
 *   on     run reasoning and return it
 *   hidden run reasoning, omit it from the response (exclude)
 *   off    don't reason at all
 */
export interface TaskOptions {
	effort?: ReasoningEffort;
	maxTokens?: number;
	reasoning?: 'on' | 'hidden' | 'off';
}

/** What each task is for, shown beside its settings in the admin panel. */
export const TASK_BLURBS: Record<CoreTask, string> = {
	transcribe_cleanup: 'Tidies raw pitch-detection output into readable notation.',
	compose_plan: 'Sketches the shape of a new piece before any notes are written.',
	compose_realize: 'Writes the actual notes for one chunk of a plan.',
	edit_selection: 'The Ask box, and any edit aimed at the current selection.',
	control_prompt: 'The single-round-trip controls — Darken, Increase energy, and friends.',
	orchestrate: 'Spreads existing material across parts and instruments.',
	analyse: 'Answers questions about a score without changing it.',
	title: 'Names a piece. Wants speed, not depth.'
};
