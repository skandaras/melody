import { expect } from 'vitest';
import { applyOps, type Op } from '$lib/score/apply.js';
import { emptyScore, type Score } from '$lib/score/types.js';
import type { OpGuard } from './guards.js';
import { planToOps, withCreatedIds, withCreatedPartIds } from './plan.js';
import { emptyPlan, type Plan } from './types.js';

/**
 * Fixtures for the pipeline's tests. Imported only by tests.
 *
 * Every score here has really been through plan approval, because the guards
 * and the part lists are about parts and sections approval created — a
 * hand-built score would prove nothing about the join they make.
 */

/** A three-part ensemble (Flute, Strings, Bass) and one four-bar verse. */
export function approved(): { score: Score; plan: Plan } {
	const plan: Plan = {
		...emptyPlan(),
		title: 'Rain',
		ensemble: [
			{ name: 'Flute', instrument: 'Flute' },
			{ name: 'Strings', instrument: 'String Ensemble 1' },
			{ name: 'Bass', instrument: 'Acoustic Bass' }
		],
		sections: [{ name: 'Verse', bars: 4, harmony: 'I-V', role: 'statement' }]
	};
	const before = emptyScore();
	const result = applyOps(before, planToOps(before, plan));
	const created = result.diff.created;
	const withParts = withCreatedPartIds(withCreatedIds(plan, created), before, created);
	return { score: result.score, plan: { ...withParts, approved: true } };
}

export function notes(score: Score, partId: string, ...pitches: string[]): Score {
	return applyOps(score, [
		{
			op: 'insert_notes',
			args: { partId, notes: pitches.map((p, i) => ({ tick: i * 480, dur: 480, pitches: [p] })) }
		}
	]).score;
}

/** Run one op through a guard the way the loop does. */
export function judge(guard: OpGuard, score: Score, op: Op): string | null {
	const trial = applyOps(score, [op]);
	expect(trial.errors).toEqual([]);
	return guard(score, trial.score, trial.diff);
}
