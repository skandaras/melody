import { describe, it, expect } from 'vitest';
import { applyOps } from '$lib/score/apply.js';
import { emptyScore, type Score } from '$lib/score/types.js';
import { planToOps, withCreatedIds, withCreatedPartIds } from './plan.js';
import {
	addedParts,
	isArranged,
	melodyChanged,
	noteIdsIn,
	partChunks,
	partStates,
	unwrittenParts
} from './arrange.js';
import { emptyPlan, type Plan } from './types.js';

/**
 * The ensemble side of the pipeline.
 *
 * Everything works against a score that has really been through plan approval,
 * for the same reason the realize tests do: the whole design rests on approval
 * having created the parts, so hand-built parts would prove nothing about the
 * join these functions make between `plan.ensemble` and `score.parts`.
 */

function approved(ensemble: Plan['ensemble'] = defaultEnsemble()): {
	score: Score;
	plan: Plan;
} {
	const plan: Plan = {
		...emptyPlan(),
		title: 'Rain',
		ensemble,
		sections: [
			{ name: 'Verse', bars: 4, harmony: 'i-VI', role: 'statement' },
			{ name: 'Chorus', bars: 4, harmony: 'VI-i', role: 'lift' }
		]
	};
	const before = emptyScore();
	const result = applyOps(before, planToOps(before, plan));
	const withSections = withCreatedIds(plan, result.diff.created);
	return {
		score: result.score,
		plan: withCreatedPartIds(withSections, before, result.diff.created)
	};
}

function defaultEnsemble(): Plan['ensemble'] {
	return [
		{ name: 'Flute', instrument: 'Flute' },
		{ name: 'Cello', instrument: 'Cello' },
		{ name: 'Piano', instrument: 'Acoustic Grand Piano' }
	];
}

/** Put a note into a part, as an arrangement would. */
function writeNote(score: Score, partId: string, tick = 0, pitch = 'C4'): Score {
	return applyOps(score, [
		{ op: 'insert_notes', args: { partId, notes: [{ tick, dur: 480, pitches: [pitch] }] } }
	]).score;
}

const melodyOf = (plan: Plan) => plan.ensemble[0].partId!;

describe('partChunks', () => {
	it('writes every ensemble part except the melody, in plan order', () => {
		const { score, plan } = approved();
		const chunks = partChunks(score, plan, melodyOf(plan));

		expect(chunks.map((c) => c.label)).toEqual(['Cello', 'Piano']);
		// The denominator the progress bar counts against.
		expect(chunks.every((c) => c.of === 2)).toBe(true);
	});

	it('never hands a run the melody part', () => {
		// The tune was approved a stage ago. A run that was given it as a target
		// could rewrite it while claiming to be arranging around it.
		const { score, plan } = approved();
		for (const entry of plan.ensemble) {
			const chunks = partChunks(score, plan, entry.partId!);
			expect(chunks.map((c) => c.partId)).not.toContain(entry.partId);
		}
	});

	it('takes the ensemble from the plan, not from the score', () => {
		// The stage realizes an ensemble that was already decided. A part added
		// in Bench is not part of the plan and is not something to arrange for.
		const { score, plan } = approved();
		const extended = applyOps(score, [
			{ op: 'add_part', args: { name: 'Uninvited', instrument: 'Tuba' } }
		]).score;

		const chunks = partChunks(extended, plan, melodyOf(plan));
		expect(chunks.map((c) => c.label)).toEqual(['Cello', 'Piano']);
	});

	it('skips a plan entry whose part was deleted', () => {
		const { score, plan } = approved();
		const cello = plan.ensemble[1].partId!;
		const without = applyOps(score, [{ op: 'remove_part', args: { partId: cello } }]).score;

		const chunks = partChunks(without, plan, melodyOf(plan));
		expect(chunks.map((c) => c.label)).toEqual(['Piano']);
	});

	it('restricts to the parts asked for', () => {
		const { score, plan } = approved();
		const piano = plan.ensemble[2].partId!;

		const chunks = partChunks(score, plan, melodyOf(plan), [piano]);
		expect(chunks.map((c) => c.partId)).toEqual([piano]);
		expect(chunks[0].of).toBe(1);
	});

	it('carries the instrument, so the prompt can name a range', () => {
		const { score, plan } = approved();
		expect(partChunks(score, plan, melodyOf(plan))[0].instrument).toBe('Cello');
	});
});

describe('partStates', () => {
	it('reads written and empty off the notes rather than a record', () => {
		const { score, plan } = approved();
		const cello = plan.ensemble[1].partId!;
		const after = writeNote(score, cello);

		const states = partStates(after, plan, melodyOf(plan));
		expect(states.find((s) => s.partId === cello)?.state).toBe('written');
		expect(states.find((s) => s.partId === plan.ensemble[2].partId)?.state).toBe('empty');
	});

	it('separates the melody, the plan ensemble, and a part nobody planned', () => {
		const { score, plan } = approved();
		const withExtra = applyOps(score, [
			{ op: 'add_part', args: { name: 'Uninvited', instrument: 'Tuba' } }
		]).score;

		const states = partStates(withExtra, plan, melodyOf(plan));
		expect(states.find((s) => s.name === 'Flute')?.role).toBe('melody');
		expect(states.find((s) => s.name === 'Cello')?.role).toBe('accompaniment');
		expect(states.find((s) => s.name === 'Uninvited')?.role).toBe('extra');
	});
});

describe('unwrittenParts', () => {
	it('is what a run with no explicit targets writes', () => {
		const { score, plan } = approved();
		const cello = plan.ensemble[1].partId!;
		const after = writeNote(score, cello);

		// Resuming is the same operation as starting: the finished part drops out
		// and the rest is still there to write.
		expect(unwrittenParts(after, plan, melodyOf(plan))).toEqual([plan.ensemble[2].partId]);
	});

	it('excludes the melody even when it has no notes', () => {
		const { score, plan } = approved();
		expect(unwrittenParts(score, plan, melodyOf(plan))).not.toContain(melodyOf(plan));
	});
});

describe('isArranged', () => {
	it('ignores the melody, which was written a stage ago', () => {
		const { score, plan } = approved();
		// A melody and nothing else is not an arrangement.
		const tuneOnly = writeNote(score, melodyOf(plan));
		expect(isArranged(tuneOnly, plan, melodyOf(plan))).toBe(false);

		expect(isArranged(writeNote(tuneOnly, plan.ensemble[1].partId!), plan, melodyOf(plan))).toBe(
			true
		);
	});
});

describe('noteIdsIn', () => {
	it('collects what rejecting a part deletes', () => {
		const { score, plan } = approved();
		const cello = plan.ensemble[1].partId!;
		const after = writeNote(writeNote(score, cello, 0), cello, 480);

		const ids = noteIdsIn(after, cello);
		expect(ids).toHaveLength(2);

		// Deleting them empties the part and leaves the part itself standing —
		// the ensemble is the plan's, and only the notes are this stage's.
		const cleared = applyOps(after, [{ op: 'delete_notes', args: { noteIds: ids } }]).score;
		expect(cleared.parts.some((p) => p.id === cello)).toBe(true);
		expect(noteIdsIn(cleared, cello)).toEqual([]);
	});

	it('is empty for a part that is not there', () => {
		const { score } = approved();
		expect(noteIdsIn(score, 'nope')).toEqual([]);
	});
});

describe('addedParts', () => {
	it('names an instrument the plan did not', () => {
		const { score } = approved();
		const after = applyOps(score, [
			{ op: 'add_part', args: { name: 'Harp', instrument: 'Orchestral Harp' } }
		]).score;

		expect(addedParts(score, after).map((p) => p.name)).toEqual(['Harp']);
	});

	it('is empty when a run only wrote notes', () => {
		const { score, plan } = approved();
		expect(addedParts(score, writeNote(score, plan.ensemble[1].partId!))).toEqual([]);
	});
});

describe('melodyChanged', () => {
	it('catches a run that rewrote the tune it was told not to touch', () => {
		const { score, plan } = approved();
		const melody = melodyOf(plan);
		const before = writeNote(score, melody, 0, 'C4');

		const transposed = applyOps(before, [
			{ op: 'transpose', args: { semitones: 2, selection: { partIds: [melody] } } }
		]).score;

		expect(melodyChanged(before, transposed, melody)).toBe(true);
	});

	it('ignores work in every other part', () => {
		const { score, plan } = approved();
		const melody = melodyOf(plan);
		const before = writeNote(score, melody);

		expect(melodyChanged(before, writeNote(before, plan.ensemble[1].partId!), melody)).toBe(
			false
		);
	});

	it('ignores a change that is not to the notes', () => {
		// Mix level is not the tune. Flagging it would make the warning noise,
		// and a warning nobody believes protects nothing.
		const { score, plan } = approved();
		const melody = melodyOf(plan);
		const before = writeNote(score, melody);
		const mixed = applyOps(before, [
			{ op: 'set_instrument', args: { partId: melody, volume: 0.4 } }
		]).score;

		expect(melodyChanged(before, mixed, melody)).toBe(false);
	});

	it('says nothing when there is no melody part to compare', () => {
		const { score } = approved();
		expect(melodyChanged(score, score, null)).toBe(false);
	});
});
