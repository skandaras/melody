import { describe, it, expect } from 'vitest';
import { applyOps } from '$lib/score/apply.js';
import { resolveSelection } from '$lib/score/query.js';
import { emptyScore, type Score } from '$lib/score/types.js';
import { editScope } from './refine.js';

/**
 * Scoping an expressive edit.
 *
 * Every test here is really one assertion in disguise: that the words on the
 * button and the notes the operation reaches are the same claim. The failure
 * this guards is not a crash — it is a control labelled "12 notes" quietly
 * rewriting the whole piece.
 */

function scoreWithParts(): Score {
	let score = emptyScore();
	const ids: string[] = [];

	for (const [name, instrument] of [
		['Flute', 'Flute'],
		['Cello', 'Cello'],
		['Silent', 'Violin']
	]) {
		const result = applyOps(score, [{ op: 'add_part', args: { name, instrument } }]);
		score = result.score;
		ids.push(result.diff.created?.find((c) => c.kind === 'part')!.id as string);
	}

	// Two notes in the flute, three in the cello, none in the third part.
	score = applyOps(score, [
		{
			op: 'insert_notes',
			args: {
				partId: ids[0],
				notes: [
					{ tick: 0, dur: 480, pitches: [72] },
					{ tick: 480, dur: 480, pitches: [74] }
				]
			}
		},
		{
			op: 'insert_notes',
			args: {
				partId: ids[1],
				notes: [
					{ tick: 0, dur: 480, pitches: [48] },
					{ tick: 480, dur: 480, pitches: [50] },
					{ tick: 960, dur: 480, pitches: [52] }
				]
			}
		}
	]).score;

	return score;
}

const noteIdsOf = (score: Score, partId: string) =>
	resolveSelection(score, { partIds: [partId] }).map((r) => r.note.id);

describe('editScope', () => {
	it('says "whole piece" out loud rather than defaulting to it silently', () => {
		// The epic's gotcha: `{}` is a legitimate target here, unlike in the
		// arrangement stage — it just has to be stated.
		const score = scoreWithParts();
		const scope = editScope(score);

		expect(scope.kind).toBe('whole');
		expect(scope.label).toBe('whole piece');
		expect(scope.selection).toEqual({});
		expect(scope.noteCount).toBe(5);
	});

	it('counts the notes it names', () => {
		const score = scoreWithParts();
		const picked = noteIdsOf(score, score.parts[1].id).slice(0, 2);
		const scope = editScope(score, { noteIds: picked });

		expect(scope.kind).toBe('selection');
		expect(scope.label).toBe('2 notes');
		expect(scope.noteCount).toBe(2);
	});

	it('says note, not notes, for one', () => {
		const score = scoreWithParts();
		const scope = editScope(score, { noteIds: noteIdsOf(score, score.parts[0].id).slice(0, 1) });
		expect(scope.label).toBe('1 note');
	});

	it('names a part by its name', () => {
		const score = scoreWithParts();
		const scope = editScope(score, { partId: score.parts[1].id });

		expect(scope.kind).toBe('part');
		expect(scope.label).toBe('Cello');
		expect(scope.noteCount).toBe(3);
	});

	it('reports zero for a part with nothing in it, rather than everything', () => {
		// The trap this module exists for. `resolveSelection` reads a missing OR
		// empty partIds as the whole score, so "is anything selected" cannot be
		// answered by looking at the query — only by resolving it. A caller that
		// trusted the shape would fire a control at the entire piece here.
		const score = scoreWithParts();
		const scope = editScope(score, { partId: score.parts[2].id });

		expect(scope.kind).toBe('part');
		expect(scope.label).toBe('Silent');
		expect(scope.noteCount).toBe(0);
		// And it is emphatically not the whole piece, which is 5.
		expect(scope.noteCount).not.toBe(5);
	});

	it('falls back to the whole piece for a part that is gone, and says so', () => {
		// Deleting a part in Bench leaves this page holding a stale id. Silently
		// widening to everything under the old label is the bad outcome; widening
		// while saying "whole piece" is honest.
		const score = scoreWithParts();
		const scope = editScope(score, { partId: 'deleted' });

		expect(scope.kind).toBe('whole');
		expect(scope.label).toBe('whole piece');
	});

	it('lets an explicit note pick beat a part', () => {
		// Most specific wins, which is what clicking one thing after another means.
		const score = scoreWithParts();
		const picked = noteIdsOf(score, score.parts[0].id);
		const scope = editScope(score, { noteIds: picked, partId: score.parts[1].id });

		expect(scope.kind).toBe('selection');
		expect(scope.noteCount).toBe(2);
	});

	it('ignores note ids that are no longer in the score', () => {
		const score = scoreWithParts();
		const real = noteIdsOf(score, score.parts[0].id).slice(0, 1);
		const scope = editScope(score, { noteIds: [...real, 'ghost'] });

		expect(scope.noteCount).toBe(1);
		expect(scope.label).toBe('1 note');
	});

	it('never lets the words and the notes disagree', () => {
		// The property the whole module is for, asserted directly across every
		// shape: whatever the label claims, the selection resolves to exactly the
		// count beside it.
		const score = scoreWithParts();
		const picks = [
			{},
			{ partId: score.parts[0].id },
			{ partId: score.parts[2].id },
			{ partId: 'gone' },
			{ noteIds: noteIdsOf(score, score.parts[1].id) },
			{ noteIds: [] as string[] }
		];

		for (const pick of picks) {
			const scope = editScope(score, pick);
			expect(resolveSelection(score, scope.selection)).toHaveLength(scope.noteCount);
		}
	});
});
