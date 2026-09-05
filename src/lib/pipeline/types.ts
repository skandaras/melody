/**
 * The composition pipeline: what stage a score is at, and what it was asked
 * for.
 *
 * Shared by both sides, and therefore in neither of the two places it might
 * first appear to belong. Not `$lib/score/`, which is the music document and
 * imports nothing — a brief is not music. Not `$lib/server/db/schema.ts`,
 * which the client cannot import at all. `$lib/ai/config.ts` already exists
 * for exactly this reason and says so: SvelteKit refuses to bundle anything
 * under `$lib/server` into the client, and rightly so.
 *
 * Nothing here imports anything, so it stays testable and cheap to reason
 * about.
 */

/**
 * The six stages, in order.
 *
 * A score is always at one of them; there is no "not started". A document that
 * predates the pipeline reads as `brief`, which is true — nobody has taken it
 * anywhere yet.
 */
export const STAGES = ['brief', 'plan', 'melody', 'arrangement', 'refine', 'finish'] as const;
export type Stage = (typeof STAGES)[number];

export const FIRST_STAGE: Stage = 'brief';

/** Human labels, used by the stepper and by anything reporting progress. */
export const STAGE_LABELS: Record<Stage, string> = {
	brief: 'Brief',
	plan: 'Plan',
	melody: 'Melody',
	arrangement: 'Arrangement',
	refine: 'Refinement',
	finish: 'Finish'
};

/** What a hummed or uploaded seed is *for*. */
export const SEED_ROLES = ['theme', 'hook', 'motif'] as const;
export type SeedRole = (typeof SEED_ROLES)[number];

export const SEED_ROLE_LABELS: Record<SeedRole, string> = {
	theme: 'The main theme',
	hook: 'The chorus hook',
	motif: 'A motif to develop'
};

/**
 * What the person asked for.
 *
 * The description carries the weight; everything else is a shortcut for what a
 * description usually leaves implicit, and every one of them can be said in
 * words instead. Nothing here is required — a brief with only a hummed seed is
 * a perfectly good brief.
 */
export interface Brief {
	description: string;
	/** Free text, not an enum: "like rain on a window" is a real answer. */
	mood?: string;
	ensemble?: string;
	/** Rough length. Bars rather than seconds, because tempo is not decided yet. */
	lengthBars?: number;
	/** One of the seeded style skills, by name. */
	referenceStyle?: string;
	/** The part a transcribed seed became, so later stages can point at it. */
	seedPartId?: string;
	/**
	 * What that seed is.
	 *
	 * Asked rather than guessed because `compose_plan`'s prompt already
	 * requires it: "The seed must have a defined role in the plan — state
	 * whether it is the main theme, the chorus hook, or a motif to be
	 * developed."
	 */
	seedRole?: SeedRole;
}

export function emptyBrief(): Brief {
	return { description: '' };
}

/** A brief with nothing in it is not worth planning from. */
export function isBriefUsable(brief: Brief | null | undefined): boolean {
	if (!brief) return false;
	return brief.description.trim().length > 0 || Boolean(brief.seedPartId);
}

/** One span of the piece, before it has any ticks. */
export interface PlanSection {
	name: string;
	/** Bars, not ticks — the metre may not be settled when the plan is written. */
	bars: number;
	/** A harmonic sketch, e.g. "i-VI-III-VII in A minor". */
	harmony: string;
	/** What the section is doing: statement, contrast, release. */
	role: string;
}

export interface PlanPart {
	name: string;
	/** A General MIDI instrument name; resolved to a program when realised. */
	instrument: string;
}

/**
 * The blueprint, approved before any notes are written.
 *
 * Deliberately not `Score.sections`: those are tick ranges, and a plan is
 * written in bars and harmony before the piece has either. Approving a plan is
 * what projects it onto the document.
 */
export interface Plan {
	key: { tonic: string; mode: 'major' | 'minor' };
	tempoBpm: number;
	timeSig: { num: number; den: number };
	ensemble: PlanPart[];
	sections: PlanSection[];
	/** True once it has been committed to the score as parts and sections. */
	approved: boolean;
}

/** Where a score is in the pipeline. Snapshotted with each revision. */
export interface PipelineState {
	stage: Stage;
	brief: Brief | null;
	plan: Plan | null;
}

/**
 * Read pipeline state off a row that may predate any of it.
 *
 * Every score in an existing install has null columns, so this is the upgrade
 * path rather than an edge case.
 */
export function pipelineOf(row: {
	stage?: string | null;
	brief?: Brief | null;
	plan?: Plan | null;
}): PipelineState {
	return {
		stage: isStage(row.stage) ? row.stage : FIRST_STAGE,
		brief: row.brief ?? null,
		plan: row.plan ?? null
	};
}

export function isStage(value: unknown): value is Stage {
	return typeof value === 'string' && (STAGES as readonly string[]).includes(value);
}

/** The stage after this one, or null at the end of the pipeline. */
export function nextStage(stage: Stage): Stage | null {
	const i = STAGES.indexOf(stage);
	return i >= 0 && i < STAGES.length - 1 ? STAGES[i + 1] : null;
}
