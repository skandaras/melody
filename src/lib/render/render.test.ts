import { describe, it, expect } from 'vitest';
import { ticksToDuration, splitAcrossBar } from './duration.js';
import { midiToVexKey, vexKeySignature } from './keys.js';
import { layoutScore, DEFAULT_LAYOUT } from './layout.js';
import { hitTest, hitsInRect, type NoteHit } from './render.js';
import { applyOps } from '$lib/score/apply';
import { emptyScore, PPQ, type Score } from '$lib/score/types';

/**
 * Layout, duration mapping and hit-testing are pure, so they get real tests.
 * The VexFlow drawing itself needs a DOM and is covered by the manual pass.
 */

function scoreWith(noteTicks: number[], dur = 480): Score {
	let s = emptyScore('T');
	s = applyOps(s, [{ op: 'add_part', args: { name: 'P', instrument: 'Piano' } }]).score;
	const partId = s.parts[0].id;
	return applyOps(s, [
		{
			op: 'insert_notes',
			args: { partId, notes: noteTicks.map((tick) => ({ tick, dur, pitches: ['C4'] })) }
		}
	]).score;
}

describe('ticksToDuration', () => {
	it('maps the plain durations exactly', () => {
		expect(ticksToDuration(PPQ * 4)).toMatchObject({ duration: 'w', dots: 0 });
		expect(ticksToDuration(PPQ * 2)).toMatchObject({ duration: 'h', dots: 0 });
		expect(ticksToDuration(PPQ)).toMatchObject({ duration: 'q', dots: 0 });
		expect(ticksToDuration(PPQ / 2)).toMatchObject({ duration: '8', dots: 0 });
		expect(ticksToDuration(PPQ / 4)).toMatchObject({ duration: '16', dots: 0 });
	});

	it('finds dotted durations', () => {
		expect(ticksToDuration(PPQ * 1.5)).toMatchObject({ duration: 'q', dots: 1 });
		expect(ticksToDuration(PPQ * 3)).toMatchObject({ duration: 'h', dots: 1 });
		expect(ticksToDuration(PPQ * 1.75)).toMatchObject({ duration: 'q', dots: 2 });
	});

	it('snaps an unnotatable length to the nearest rather than failing', () => {
		// Raw transcription produces lengths like this constantly.
		const d = ticksToDuration(503);
		expect(d.duration).toBe('q');
		expect(d.dots).toBe(0);
	});

	it('never returns a zero or negative duration', () => {
		for (const t of [0, 1, 7, 13]) {
			expect(ticksToDuration(t).ticks).toBeGreaterThan(0);
		}
	});
});

describe('splitAcrossBar', () => {
	it('leaves a note that fits alone', () => {
		expect(splitAcrossBar(0, 480, 1920)).toEqual([480]);
	});
	it('splits a note that crosses the barline', () => {
		expect(splitAcrossBar(1680, 480, 1920)).toEqual([240, 240]);
	});
});

describe('midiToVexKey', () => {
	const cMajor = { tick: 0, fifths: 0, mode: 'major' as const };
	const dMajor = { tick: 0, fifths: 2, mode: 'major' as const };
	const fMajor = { tick: 0, fifths: -1, mode: 'major' as const };

	it('produces VexFlow key strings', () => {
		expect(midiToVexKey(60, cMajor).key).toBe('c/4');
		expect(midiToVexKey(69, cMajor).key).toBe('a/4');
	});

	it('omits accidentals the key signature already implies', () => {
		// F# is in D major's signature, so no sharp should be drawn.
		expect(midiToVexKey(66, dMajor).accidental).toBeNull();
		// Bb is in F major's signature.
		expect(midiToVexKey(70, fMajor).accidental).toBeNull();
	});

	it('draws an accidental when the note departs from the signature', () => {
		expect(midiToVexKey(61, cMajor).accidental).toBe('#');
		// A flat-side key spells the same pitch as Db, so the accidental is a
		// flat — not a sharp on C.
		expect(midiToVexKey(61, fMajor).key).toBe('db/4');
		expect(midiToVexKey(61, fMajor).accidental).toBe('b');
	});

	it('spells chromatic notes from the key signature side, not from context', () => {
		// A sharp-side key spells pitch class 10 as A#, a flat-side key as Bb.
		// This is the documented rule and it is deliberately context-free: a
		// human or the AI cleanup pass sets `spell` explicitly where the
		// musically-correct choice depends on the surrounding line.
		expect(midiToVexKey(70, cMajor).key).toBe('a#/4');
		expect(midiToVexKey(70, { tick: 0, fifths: -2, mode: 'major' }).key).toBe('bb/4');
	});

	it('draws a natural when the signature alters that letter but the note does not', () => {
		// F natural in D major, whose signature sharpens F.
		expect(midiToVexKey(65, dMajor).accidental).toBe('n');
	});

	it('honours an explicit spelling over the key default', () => {
		const k = midiToVexKey(61, cMajor, 'Db4');
		expect(k.key).toBe('db/4');
		expect(k.accidental).toBe('b');
	});

	it('maps key signatures for both modes', () => {
		expect(vexKeySignature({ tick: 0, fifths: 0, mode: 'major' })).toBe('C');
		expect(vexKeySignature({ tick: 0, fifths: -2, mode: 'major' })).toBe('Bb');
		expect(vexKeySignature({ tick: 0, fifths: 0, mode: 'minor' })).toBe('Am');
		expect(vexKeySignature({ tick: 0, fifths: 3, mode: 'minor' })).toBe('F#m');
	});
});

describe('layout', () => {
	it('puts a short score on one system', () => {
		const l = layoutScore(scoreWith([0, 480, 960, 1440]), { width: 900 });
		expect(l.systems).toHaveLength(1);
		expect(l.systems[0].measures).toHaveLength(1);
	});

	it('breaks into multiple systems when measures overflow the width', () => {
		// 16 bars of crotchets at a narrow width must wrap.
		const ticks = Array.from({ length: 64 }, (_, i) => i * 480);
		const l = layoutScore(scoreWith(ticks), { width: 600 });
		expect(l.systems.length).toBeGreaterThan(1);
		for (const sys of l.systems) expect(sys.measures.length).toBeGreaterThan(0);
	});

	it('marks exactly one leading measure per system', () => {
		const ticks = Array.from({ length: 64 }, (_, i) => i * 480);
		const l = layoutScore(scoreWith(ticks), { width: 600 });
		for (const sys of l.systems) {
			expect(sys.measures.filter((m) => m.leading)).toHaveLength(1);
			expect(sys.measures[0].leading).toBe(true);
		}
	});

	it('justifies every system except the last to the full width', () => {
		const ticks = Array.from({ length: 64 }, (_, i) => i * 480);
		const l = layoutScore(scoreWith(ticks), { width: 600 });
		for (const sys of l.systems.slice(0, -1)) {
			const end = sys.measures.at(-1)!;
			expect(end.x + end.width).toBeCloseTo(600, 0);
		}
	});

	it('lays measures out left to right without gaps', () => {
		const ticks = Array.from({ length: 32 }, (_, i) => i * 480);
		const l = layoutScore(scoreWith(ticks), { width: 700 });
		for (const sys of l.systems) {
			let x = 0;
			for (const m of sys.measures) {
				expect(m.x).toBeCloseTo(x, 3);
				x += m.width;
			}
		}
	});

	it('grows height with part count', () => {
		let s = scoreWith([0, 480]);
		const one = layoutScore(s).height;
		s = applyOps(s, [{ op: 'add_part', args: { name: 'B', instrument: 'Cello' } }]).score;
		expect(layoutScore(s).height).toBeGreaterThan(one);
	});

	it('paginates when a page height is set', () => {
		const ticks = Array.from({ length: 200 }, (_, i) => i * 480);
		const l = layoutScore(scoreWith(ticks), { width: 600, pageHeight: 500 });
		expect(l.pages).toBeGreaterThan(1);
		// No system may start below the bottom of its own page.
		for (const sys of l.systems) expect(sys.y).toBeLessThan(500);
	});

	it('handles an empty score without dividing by zero', () => {
		const l = layoutScore(emptyScore());
		expect(l.systems.length).toBeGreaterThanOrEqual(1);
		expect(Number.isFinite(l.height)).toBe(true);
		expect(l.height).toBeGreaterThan(0);
	});

	it('respects a custom stave height', () => {
		const s = scoreWith([0]);
		const a = layoutScore(s, { staveHeight: 100 });
		const b = layoutScore(s, { staveHeight: 200 });
		expect(b.height).toBeGreaterThan(a.height);
		expect(DEFAULT_LAYOUT.staveHeight).toBeGreaterThan(0);
	});
});

describe('hit testing', () => {
	const hits: NoteHit[] = [
		{ noteId: 'n1', partId: 'p1', tick: 0, x: 10, y: 10, width: 12, height: 12 },
		{ noteId: 'n2', partId: 'p1', tick: 480, x: 60, y: 10, width: 12, height: 12 },
		{ noteId: 'n3', partId: 'p1', tick: 960, x: 110, y: 40, width: 12, height: 12 }
	];

	it('finds a note under the cursor', () => {
		expect(hitTest(hits, 15, 15)?.noteId).toBe('n1');
		expect(hitTest(hits, 65, 15)?.noteId).toBe('n2');
	});

	it('finds a nearby note within tolerance', () => {
		expect(hitTest(hits, 28, 16)?.noteId).toBe('n1');
	});

	it('returns null when nothing is close', () => {
		expect(hitTest(hits, 300, 300)).toBeNull();
	});

	it('picks the nearer of two candidates', () => {
		expect(hitTest(hits, 40, 16, 40)?.noteId).toBe('n1');
		expect(hitTest(hits, 50, 16, 40)?.noteId).toBe('n2');
	});

	it('selects everything inside a rubber band', () => {
		expect(hitsInRect(hits, 0, 0, 80, 30).map((h) => h.noteId)).toEqual(['n1', 'n2']);
		expect(hitsInRect(hits, 0, 0, 200, 200)).toHaveLength(3);
		expect(hitsInRect(hits, 200, 200, 300, 300)).toHaveLength(0);
	});

	it('accepts a rectangle dragged in any direction', () => {
		expect(hitsInRect(hits, 80, 30, 0, 0).map((h) => h.noteId)).toEqual(['n1', 'n2']);
	});
});
