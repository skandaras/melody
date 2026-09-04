import { describe, it, expect } from 'vitest';
import { playheadAt } from './playhead.js';
import type { NoteHit, StaveBox } from './render.js';

/**
 * A playhead is a continuous claim about what is sounding, so being a few
 * pixels off reads as the audio being out of sync with the notation — which is
 * exactly the complaint it exists to answer. These pin it to the noteheads the
 * renderer actually drew rather than to an even division of the bar.
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

const hit = (tick: number, x: number, partId = 'p1'): NoteHit => ({
	noteId: `n${tick}`,
	partId,
	tick,
	x,
	y: 50,
	width: 10,
	height: 10
});

describe('playheadAt', () => {
	it('returns nothing when nothing is playing', () => {
		expect(playheadAt([box()], [], null)).toBeNull();
	});

	it('returns nothing past the end of the score', () => {
		// measuresOf only pads to the end of the content, so a position in a
		// decaying final chord can fall outside every measure.
		expect(playheadAt([box()], [], 5000)).toBeNull();
	});

	it('divides an empty bar evenly, because there is nothing to anchor to', () => {
		const p = playheadAt([box()], [], 960);
		expect(p?.x).toBeCloseTo(300, 6); // halfway across 100..500
	});

	it('sits exactly on a notehead at that note tick', () => {
		// The whole point: VexFlow does not space notes evenly, so an even
		// division would put the line beside the note rather than on it.
		const hits = [hit(0, 120), hit(480, 180), hit(960, 400)];
		expect(playheadAt([box()], hits, 960)?.x).toBeCloseTo(400, 6);
		expect(playheadAt([box()], hits, 480)?.x).toBeCloseTo(180, 6);
	});

	it('interpolates between two noteheads, not across the bar', () => {
		// Between 480 (x=180) and 960 (x=400): halfway in time is halfway in x
		// between those two notes — 290, not the 300 an even division gives.
		const hits = [hit(0, 120), hit(480, 180), hit(960, 400)];
		expect(playheadAt([box()], hits, 720)?.x).toBeCloseTo(290, 6);
	});

	it('runs from the barline to the first note, and from the last to the next barline', () => {
		const hits = [hit(480, 180)];
		// Before the first note: interpolating from the bar's left edge.
		expect(playheadAt([box()], hits, 240)?.x).toBeCloseTo(140, 6);
		// After the last note: on towards the right edge.
		expect(playheadAt([box()], hits, 1200)?.x).toBeCloseTo(180 + (720 / 1440) * 320, 6);
	});

	it('ignores notes belonging to another part', () => {
		// Otherwise a busier stave below would drag the line off the one above.
		const hits = [hit(960, 400, 'p1'), hit(960, 999, 'p2')];
		expect(playheadAt([box()], hits, 960)?.x).toBeCloseTo(400, 6);
	});

	it('spans every stave of the system, not just one', () => {
		// One line through the score reads as a position in the music; one line
		// per part reads as several unrelated cursors.
		const upper = box({ partId: 'p1', topLineY: 50 });
		const lower = box({ partId: 'p2', partIndex: 1, topLineY: 200 });

		const p = playheadAt([upper, lower], [], 480)!;
		expect(p.y).toBeCloseTo(30, 6); // two line-spacings above the top stave
		// Down to two below the lower stave's bottom line (200 + 40 + 20).
		expect(p.y + p.height).toBeCloseTo(260, 6);
	});

	it('does not stretch across a different measure at the same y', () => {
		const first = box({ startTick: 0, endTick: 1920, x: 100 });
		const second = box({ startTick: 1920, endTick: 3840, x: 500 });
		const p = playheadAt([first, second], [], 2400)!;
		expect(p.x).toBeGreaterThanOrEqual(500);
	});
});
