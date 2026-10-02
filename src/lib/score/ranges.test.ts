import { describe, it, expect } from 'vitest';
import { applyOps } from './apply.js';
import { playability, playabilityReport, rangeOf } from './ranges.js';
import { emptyScore, type Score } from './types.js';

function withParts(): Score {
	let s = emptyScore();
	s = applyOps(s, [
		{ op: 'add_part', args: { name: 'Violin', instrument: 'Violin' } },
		{ op: 'add_part', args: { name: 'Kit', instrument: 'Drums', isDrum: true } }
	]).score;
	const [violin] = s.parts;
	return applyOps(s, [
		{
			op: 'insert_notes',
			args: {
				partId: violin.id,
				notes: [
					{ tick: 0, dur: 480, pitches: ['G3'] },
					{ tick: 480, dur: 480, pitches: ['C3'] },
					{ tick: 960, dur: 480, pitches: ['A4'] }
				]
			}
		}
	]).score;
}

describe('ranges', () => {
	it('has an entry for every program, specific where it matters', () => {
		for (let p = 0; p < 128; p++) {
			const r = rangeOf(p);
			expect(r.low).toBeLessThan(r.high);
		}
		expect(rangeOf(40)).toEqual({ low: 55, high: 103 }); // violin
		expect(rangeOf(44)).toEqual(rangeOf(47 - 3)); // family default
	});

	it('lists what is outside the range, by how far', () => {
		const score = withParts();
		const [violin] = playability(score);
		expect(violin.notes).toBe(3);
		// C3 is 48, seven below the violin's G3.
		expect(violin.outside).toEqual([expect.objectContaining({ midi: 48, by: -7 })]);
	});

	it('skips drum parts, whose pitches are kit pieces', () => {
		const score = withParts();
		expect(playability(score).map((p) => p.name)).toEqual(['Violin']);
	});

	it('reports to the model in text, and says when all is well', () => {
		const score = withParts();
		expect(playabilityReport(score)).toMatch(/1 pitch\(es\) out of range/);
		expect(playabilityReport(score)).toMatch(/7 below/);

		const clean = applyOps(emptyScore(), [
			{ op: 'add_part', args: { name: 'Flute', instrument: 'Flute' } }
		]).score;
		expect(playabilityReport(clean)).toMatch(/no notes yet/);
	});
});
