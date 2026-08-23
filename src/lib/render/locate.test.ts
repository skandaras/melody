import { describe, it, expect } from 'vitest';
import { pointToPosition, stepToMidi } from './locate.js';
import type { StaveBox } from './render.js';
import { emptyScore, type Score } from '$lib/score/types.js';

/**
 * Placing a note by clicking is only trustworthy if the pitch under the
 * pointer is the pitch you get. These are the cases where an off-by-one is
 * invisible in a screenshot and obvious the moment you play it back.
 */

const box = (over: Partial<StaveBox> = {}): StaveBox => ({
	partId: 'p1',
	partIndex: 0,
	clef: 'treble',
	x: 100,
	width: 400,
	topLineY: 50,
	lineSpacing: 10,
	startTick: 0,
	endTick: 1920,
	...over
});

function scoreWith(fifths: number): Score {
	const s = emptyScore('T');
	s.keySigs = [{ tick: 0, fifths, mode: fifths < 0 ? 'minor' : 'major' }];
	return s;
}

describe('stepToMidi', () => {
	it('puts the treble top line on F5 and counts down by step', () => {
		expect(stepToMidi(0, 'treble', 0)).toBe(77); // F5, top line
		expect(stepToMidi(1, 'treble', 0)).toBe(76); // E5, first space
		expect(stepToMidi(2, 'treble', 0)).toBe(74); // D5
		expect(stepToMidi(8, 'treble', 0)).toBe(64); // E4, bottom line
		expect(stepToMidi(10, 'treble', 0)).toBe(60); // C4, one ledger below
	});

	it('places the other clefs on their own reference lines', () => {
		expect(stepToMidi(0, 'bass', 0)).toBe(57); // A3
		expect(stepToMidi(8, 'bass', 0)).toBe(43); // G2, bottom line
		expect(stepToMidi(0, 'alto', 0)).toBe(67); // G4
		expect(stepToMidi(0, 'tenor', 0)).toBe(65); // F4
	});

	it('reads sharps from the key signature', () => {
		// D major: F# and C#. The top line is F, so it should sharpen.
		expect(stepToMidi(0, 'treble', 2)).toBe(78); // F#5
		// B is untouched by two sharps.
		expect(stepToMidi(4, 'treble', 2)).toBe(71); // B4
	});

	it('reads flats from the key signature', () => {
		// F major: one flat, B.
		expect(stepToMidi(4, 'treble', -1)).toBe(70); // Bb4
		expect(stepToMidi(0, 'treble', -1)).toBe(77); // F5, unaffected
	});

	it('is stable across the octave boundary in both directions', () => {
		// A run of steps must fall monotonically with no repeats or jumps.
		const run = Array.from({ length: 22 }, (_, i) => stepToMidi(i - 4, 'treble', 0));
		for (let i = 1; i < run.length; i++) {
			expect(run[i]).toBeLessThan(run[i - 1]);
			expect(run[i - 1] - run[i]).toBeLessThanOrEqual(2);
		}
	});
});

describe('pointToPosition', () => {
	const score = scoreWith(0);

	it('maps the top line to F5', () => {
		const p = pointToPosition([box()], score, 110, 50);
		expect(p?.midi).toBe(77);
		expect(p?.step).toBe(0);
	});

	it('rounds to the nearest line or space', () => {
		// 4px below the top line is still nearer the line than the space.
		expect(pointToPosition([box()], score, 110, 54)?.step).toBe(1);
		// Dead centre of the first space.
		expect(pointToPosition([box()], score, 110, 55)?.step).toBe(1);
	});

	it('snaps ticks to the requested grid', () => {
		// Halfway across a 4/4 bar is tick 960.
		expect(pointToPosition([box()], score, 300, 50, { grid: 4 })?.tick).toBe(960);
		// A nudge right still snaps back to the crotchet grid.
		expect(pointToPosition([box()], score, 320, 50, { grid: 4 })?.tick).toBe(960);
		// A finer grid keeps more of the difference.
		expect(pointToPosition([box()], score, 320, 50, { grid: 16 })?.tick).toBe(1080);
	});

	it('never places a note past the barline', () => {
		// Just inside the right edge of the measure. Snapping would round this
		// up to 1920, which is the next bar's downbeat rather than this bar.
		const p = pointToPosition([box()], score, 499, 50, { grid: 4 });
		expect(p?.tick).toBe(1440); // last crotchet of the bar, not 1920
	});

	it('supports triplet snapping', () => {
		// Quaver triplets in 4/4 divide the bar into twelve 160-tick units.
		const p = pointToPosition([box()], score, 100 + 400 / 12, 50, {
			grid: 8,
			triplets: true
		});
		expect(p?.tick).toBe(160);
	});

	it('reaches notes on ledger lines above and below', () => {
		// Half a line spacing per step, so 10px above the top line is two steps:
		// F5 → G5 → A5.
		expect(pointToPosition([box()], score, 110, 40)?.midi).toBe(81); // A5
		// Middle C, one ledger line below the stave.
		expect(pointToPosition([box()], score, 110, 100)?.midi).toBe(60);
	});

	it('returns null well outside any stave', () => {
		expect(pointToPosition([box()], score, 110, 400)).toBeNull();
		expect(pointToPosition([box()], score, 900, 50)).toBeNull();
		expect(pointToPosition([], score, 110, 50)).toBeNull();
	});

	it('picks the nearer stave when two are stacked', () => {
		const upper = box({ partId: 'p1', partIndex: 0, topLineY: 50 });
		const lower = box({ partId: 'p2', partIndex: 1, clef: 'bass', topLineY: 200 });

		expect(pointToPosition([upper, lower], score, 110, 60)?.partId).toBe('p1');
		expect(pointToPosition([upper, lower], score, 110, 210)?.partId).toBe('p2');
		// In the gap, whichever stave is closer wins.
		expect(pointToPosition([upper, lower], score, 110, 190)?.partId).toBe('p2');
	});

	it('carries the measure it landed in, not just the first', () => {
		const bar2 = box({ x: 520, width: 400, startTick: 1920, endTick: 3840 });
		const p = pointToPosition([box(), bar2], score, 530, 50, { grid: 4 });
		expect(p?.tick).toBe(1920);
	});

	it('honours the key signature at that point in the score', () => {
		// D major: the top line F should come back sharpened.
		expect(pointToPosition([box()], scoreWith(2), 110, 50)?.midi).toBe(78);
	});
});
