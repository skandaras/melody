import { describe, it, expect } from 'vitest';
import { applyOps, type Op } from '$lib/score/apply.js';
import { emptyScore, type Score } from '$lib/score/types.js';
import {
	accompanimentParts,
	allOf,
	melodyLock,
	onlyPart,
	unwrittenParts,
	type OpGuard
} from './arrange.js';
import { planToOps, withCreatedIds, withCreatedPartIds } from './plan.js';
import { emptyPlan, type Plan } from './types.js';

/**
 * What an arrangement run may touch, and which parts it has to write.
 *
 * The guards are tested by applying a real op and handing the guard what the
 * loop would: the score before, the score after, and the diff. Testing them
 * against hand-built "after" scores would prove nothing about the ops a model
 * can actually send.
 */

function approved(): { score: Score; plan: Plan } {
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

function notes(score: Score, partId: string, ...pitches: string[]): Score {
	return applyOps(score, [
		{
			op: 'insert_notes',
			args: { partId, notes: pitches.map((p, i) => ({ tick: i * 480, dur: 480, pitches: [p] })) }
		}
	]).score;
}

/** Run one op through a guard the way the loop does. */
function judge(guard: OpGuard, score: Score, op: Op): string | null {
	const trial = applyOps(score, [op]);
	expect(trial.errors).toEqual([]);
	return guard(score, trial.score, trial.diff);
}

describe('melodyLock', () => {
	it('refuses changing an approved melody note', () => {
		const { score: s0, plan } = approved();
		const melody = plan.ensemble[0].partId!;
		const score = notes(s0, melody, 'C5', 'D5');
		const guard = melodyLock(score, melody)!;

		const reason = judge(guard, score, {
			op: 'transpose',
			args: { semitones: 2, selection: { partIds: [melody] } }
		});
		expect(reason).toMatch(/approved/);
		expect(reason).toMatch(/2 of its notes/);
	});

	it('refuses removing the melody part along with its notes', () => {
		const { score: s0, plan } = approved();
		const melody = plan.ensemble[0].partId!;
		const score = notes(s0, melody, 'C5');
		expect(judge(melodyLock(score, melody)!, score, { op: 'remove_part', args: { partId: melody } }))
			.toMatch(/approved/);
	});

	it('allows new melody notes, so a new section can have a tune', () => {
		const { score: s0, plan } = approved();
		const melody = plan.ensemble[0].partId!;
		const score = notes(s0, melody, 'C5');
		const op: Op = {
			op: 'insert_notes',
			args: { partId: melody, notes: [{ tick: 3840, dur: 480, pitches: ['E5'] }] }
		};
		expect(judge(melodyLock(score, melody)!, score, op)).toBeNull();
	});

	it('allows anything in the other parts', () => {
		const { score: s0, plan } = approved();
		const [melody, strings] = plan.ensemble.map((e) => e.partId!);
		const score = notes(s0, melody, 'C5');
		expect(judge(melodyLock(score, melody)!, score, {
			op: 'insert_notes',
			args: { partId: strings, notes: [{ tick: 0, dur: 1920, pitches: ['C4', 'E4', 'G4'] }] }
		})).toBeNull();
	});

	it('has nothing to protect in an empty melody', () => {
		const { score, plan } = approved();
		expect(melodyLock(score, plan.ensemble[0].partId!)).toBeNull();
		expect(melodyLock(score, null)).toBeNull();
	});
});

describe('onlyPart', () => {
	it('allows writing the target part', () => {
		const { score, plan } = approved();
		const strings = plan.ensemble[1].partId!;
		expect(judge(onlyPart(strings), score, {
			op: 'insert_notes',
			args: { partId: strings, notes: [{ tick: 0, dur: 480, pitches: ['C4'] }] }
		})).toBeNull();
	});

	it('refuses writing any other part', () => {
		const { score, plan } = approved();
		const [, strings, bass] = plan.ensemble.map((e) => e.partId!);
		expect(judge(onlyPart(strings), score, {
			op: 'insert_notes',
			args: { partId: bass, notes: [{ tick: 0, dur: 480, pitches: ['C2'] }] }
		})).toMatch(new RegExp(`Leave part ${bass}`));
	});

	it('refuses inventing an instrument the plan did not name', () => {
		const { score, plan } = approved();
		const strings = plan.ensemble[1].partId!;
		expect(judge(onlyPart(strings), score, {
			op: 'add_part',
			args: { name: 'Oboe', instrument: 'Oboe' }
		})).toMatch(/comes from the plan/);
	});

	it('refuses changing what the plan settled', () => {
		const { score, plan } = approved();
		const strings = plan.ensemble[1].partId!;
		expect(judge(onlyPart(strings), score, { op: 'set_tempo', args: { bpm: 140 } }))
			.toMatch(/tempo, metre, key and sections/);
	});
});

describe('allOf', () => {
	it('reports the first refusal and allows what every guard allows', () => {
		const { score: s0, plan } = approved();
		const [melody, strings] = plan.ensemble.map((e) => e.partId!);
		const score = notes(s0, melody, 'C5');
		const guard = allOf(melodyLock(score, melody), null, onlyPart(strings));

		expect(judge(guard, score, {
			op: 'insert_notes',
			args: { partId: strings, notes: [{ tick: 0, dur: 480, pitches: ['C4'] }] }
		})).toBeNull();
		expect(judge(guard, score, {
			op: 'transpose',
			args: { semitones: 1, selection: { partIds: [melody] } }
		})).toMatch(/approved/);
	});
});

describe('accompanimentParts', () => {
	it('is the plan\'s ensemble minus the tune, in plan order', () => {
		const { score, plan } = approved();
		const parts = accompanimentParts(score, plan, null);
		// melodyPartOf falls back to the first ensemble entry.
		expect(parts.map((p) => p.name)).toEqual(['Strings', 'Bass']);
		expect(parts.every((p) => p.state === 'empty')).toBe(true);
	});

	it('follows the melody part chosen on the melody page', () => {
		const { score, plan } = approved();
		const strings = plan.ensemble[1].partId!;
		const parts = accompanimentParts(score, { ...plan, melodyPartId: strings }, null);
		expect(parts.map((p) => p.name)).toEqual(['Flute', 'Bass']);
	});

	it('leaves out the hummed seed, which is a recording rather than a part to write', () => {
		const { score, plan } = approved();
		const [flute, , bass] = plan.ensemble.map((e) => e.partId!);
		// The tune chosen elsewhere: with no choice, the seed would *be* the tune.
		const chosen = { ...plan, melodyPartId: flute };
		const parts = accompanimentParts(score, chosen, { description: '', seedPartId: bass });
		expect(parts.map((p) => p.name)).toEqual(['Strings']);
	});

	it('reads written from notes, and skips a part deleted since', () => {
		const { score: s0, plan } = approved();
		const [, strings, bass] = plan.ensemble.map((e) => e.partId!);
		let score = notes(s0, strings, 'C4', 'E4');
		score = applyOps(score, [{ op: 'remove_part', args: { partId: bass } }]).score;

		const parts = accompanimentParts(score, plan, null);
		expect(parts).toEqual([
			expect.objectContaining({ partId: strings, state: 'written', noteCount: 2 })
		]);
		expect(unwrittenParts(score, plan, null)).toEqual([]);
	});
});
