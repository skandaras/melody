import { describe, it, expect } from 'vitest';
import { applyOps } from './apply.js';
import { checkPlayability, describeIssue, playabilityReport } from './playability.js';
import { emptyScore, type Score } from './types.js';

/**
 * The range check the `Orchestrate as…` prompt has instructed the model to make
 * since it was written, on a tool that did not exist until now.
 */

function scoreWith(
	parts: { name: string; instrument: string; pitches: number[]; transpose?: number }[]
): Score {
	let score = emptyScore();
	for (const part of parts) {
		const result = applyOps(score, [
			{ op: 'add_part', args: { name: part.name, instrument: part.instrument } }
		]);
		score = result.score;
		const partId = result.diff.created?.find((c) => c.kind === 'part')!.id as string;

		if (part.transpose) {
			score = applyOps(score, [
				{ op: 'set_instrument', args: { partId, transpose: part.transpose } }
			]).score;
		}
		if (part.pitches.length) {
			score = applyOps(score, [
				{
					op: 'insert_notes',
					args: {
						partId,
						notes: part.pitches.map((midi, i) => ({
							tick: i * 480,
							dur: 480,
							pitches: [midi]
						}))
					}
				}
			]).score;
		}
	}
	return score;
}

describe('checkPlayability', () => {
	it('passes a part written inside its range', () => {
		// Cello is 36–84; these sit in the middle of it.
		expect(checkPlayability(scoreWith([{ name: 'Cello', instrument: 'Cello', pitches: [48, 55] }])))
			.toEqual([]);
	});

	it('catches the cello written an octave too low', () => {
		// The failure this exists for, and the one nothing caught before: a
		// cello part transposed down until it is under the instrument.
		const score = scoreWith([{ name: 'Cello', instrument: 'Cello', pitches: [24, 28, 48] }]);
		const [issue] = checkPlayability(score);

		expect(issue.below).toBe(2);
		expect(issue.above).toBe(0);
		expect(issue.lowest).toBe(24);
		expect(issue.low).toBe(36);
	});

	it('catches notes above the top', () => {
		const score = scoreWith([{ name: 'Tuba', instrument: 'Tuba', pitches: [40, 90] }]);
		const [issue] = checkPlayability(score);
		expect(issue.above).toBe(1);
		expect(issue.highest).toBe(90);
	});

	it('judges the sounding pitch, not the written one', () => {
		// A transposing instrument is notated in one key and sounds in another,
		// and the range is a fact about the instrument. Checking written pitches
		// would clear a part that is actually past the top of the horn.
		const written = 76;
		const score = scoreWith([
			{ name: 'Horn', instrument: 'French Horn', pitches: [written], transpose: 6 }
		]);
		// horn is 34–77; 76 written is fine, 82 sounding is not.
		expect(checkPlayability(score)).toHaveLength(1);

		const untransposed = scoreWith([
			{ name: 'Horn', instrument: 'French Horn', pitches: [written] }
		]);
		expect(checkPlayability(untransposed)).toEqual([]);
	});

	it('does not judge drum parts', () => {
		// On channel 9 a pitch names a kit piece, so "out of range" is a category
		// error — and every kit would otherwise be reported as broken.
		const score = scoreWith([
			{ name: 'Kit', instrument: 'Drum Kit', pitches: [24, 100] }
		]);
		expect(checkPlayability(score)).toEqual([]);
	});

	it('ignores an empty part', () => {
		expect(checkPlayability(scoreWith([{ name: 'Violin', instrument: 'Violin', pitches: [] }])))
			.toEqual([]);
	});

	it('scopes to the parts asked for', () => {
		const score = scoreWith([
			{ name: 'Cello', instrument: 'Cello', pitches: [24] },
			{ name: 'Tuba', instrument: 'Tuba', pitches: [90] }
		]);
		expect(checkPlayability(score)).toHaveLength(2);

		const cello = score.parts[0].id;
		const scoped = checkPlayability(score, [cello]);
		expect(scoped).toHaveLength(1);
		expect(scoped[0].partId).toBe(cello);
	});

	it('falls back to a permissive range for an instrument it has no entry for', () => {
		// Piano is 21–108, so an unknown instrument reports only notes no
		// keyboard has — near-silence rather than noise.
		const score = scoreWith([
			{ name: 'Kalimba', instrument: 'Kalimba', pitches: [60, 72] }
		]);
		expect(checkPlayability(score)).toEqual([]);
	});
});

describe('reporting', () => {
	it('names the part, the instrument and the worst note', () => {
		const score = scoreWith([{ name: 'Cello', instrument: 'Cello', pitches: [24] }]);
		const line = describeIssue(checkPlayability(score)[0]);

		expect(line).toContain('Cello');
		expect(line).toContain('36');
		expect(line).toContain('24');
	});

	it('says so plainly when everything is fine', () => {
		const score = scoreWith([{ name: 'Cello', instrument: 'Cello', pitches: [48] }]);
		expect(playabilityReport(score)).toContain('within');
	});

	it('lists every part with a problem', () => {
		const score = scoreWith([
			{ name: 'Cello', instrument: 'Cello', pitches: [24] },
			{ name: 'Tuba', instrument: 'Tuba', pitches: [90] }
		]);
		const report = playabilityReport(score);
		expect(report).toContain('Cello');
		expect(report).toContain('Tuba');
	});
});
