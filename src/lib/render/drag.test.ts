import { describe, it, expect } from 'vitest';
import { clampTickDelta, dragOps } from './drag.js';
import type { Position } from './locate.js';

/**
 * The two things a drag gets silently wrong: which way is up, and what happens
 * when you drag a group off the left-hand end. Both are arithmetic, so both are
 * provable here rather than discovered by dragging a note and squinting.
 */

const at = (step: number, tick: number, midi = 60, partId = 'p1'): Position => ({
	partId,
	partIndex: 0,
	tick,
	midi,
	step
});

describe('direction', () => {
	it('raises pitch when dragged up the stave', () => {
		// `step` counts downward from the top line, so up the screen is a
		// smaller step and must come out as a positive transposition.
		const ops = dragOps({ noteIds: ['n1'], from: at(6, 0), to: at(4, 0), minTick: 0 });

		expect(ops).toHaveLength(1);
		expect(ops[0].op).toBe('transpose');
		expect((ops[0].args as { scaleSteps: number }).scaleSteps).toBe(2);
	});

	it('lowers pitch when dragged down the stave', () => {
		const ops = dragOps({ noteIds: ['n1'], from: at(4, 0), to: at(7, 0), minTick: 0 });
		expect((ops[0].args as { scaleSteps: number }).scaleSteps).toBe(-3);
	});

	it('stays in key by default', () => {
		const ops = dragOps({ noteIds: ['n1'], from: at(6, 0, 60), to: at(5, 0, 62), minTick: 0 });
		const args = ops[0].args as { scaleSteps?: number; semitones?: number };
		expect(args.scaleSteps).toBe(1);
		expect(args.semitones).toBeUndefined();
	});

	it('never emits a literal-semitone move', () => {
		// transpose respells what it moves and spellMidi prefers sharps, so a
		// semitone drag lands on D# — which renders on the D line, not the E
		// line the pointer was over. A gesture that disobeys the pointer is
		// worse than one that only moves diatonically.
		const ops = dragOps({ noteIds: ['n1'], from: at(6, 0, 60), to: at(5, 0, 61), minTick: 0 });
		expect((ops[0].args as { semitones?: number }).semitones).toBeUndefined();
	});
});

describe('time', () => {
	it('shifts later by the tick difference', () => {
		const ops = dragOps({ noteIds: ['n1'], from: at(4, 480), to: at(4, 960), minTick: 480 });
		expect(ops).toHaveLength(1);
		expect(ops[0].op).toBe('shift_time');
		expect((ops[0].args as { deltaTicks: number }).deltaTicks).toBe(480);
	});

	it('will not drag a group off the front of the piece', () => {
		// shift_time clamps each note at zero independently, so an unclamped
		// delta would pile the whole selection onto tick 0 and destroy the
		// spacing between them — irreversibly, since every note lands on 0.
		const ops = dragOps({ noteIds: ['a', 'b'], from: at(4, 960), to: at(4, 0), minTick: 240 });
		expect((ops[0].args as { deltaTicks: number }).deltaTicks).toBe(-240);
	});

	it('clamps to exactly the earliest note, not to zero', () => {
		expect(clampTickDelta(-5000, 240)).toBe(-240);
		expect(clampTickDelta(-100, 240)).toBe(-100);
		expect(clampTickDelta(480, 240)).toBe(480);
	});
});

describe('both axes', () => {
	it('shifts time before transposing', () => {
		// transpose reads the key signature at each note's tick, so a drag that
		// crosses a key change has to arrive in the new key first or it is
		// transposed against the old one.
		const ops = dragOps({ noteIds: ['n1'], from: at(6, 0), to: at(4, 480), minTick: 0 });
		expect(ops.map((o) => o.op)).toEqual(['shift_time', 'transpose']);
	});

	it('emits nothing when the note landed where it started', () => {
		// A click that wandered a pixel and snapped back should not cost a
		// revision, and should not appear in the history as an edit.
		expect(dragOps({ noteIds: ['n1'], from: at(4, 480), to: at(4, 480), minTick: 480 })).toEqual([]);
	});

	it('emits nothing with no notes to move', () => {
		expect(dragOps({ noteIds: [], from: at(4, 0), to: at(1, 960), minTick: 0 })).toEqual([]);
	});

	it('addresses notes by id, so ties and slurs survive the move', () => {
		const ops = dragOps({ noteIds: ['n1', 'n2'], from: at(6, 0), to: at(4, 480), minTick: 0 });
		for (const op of ops) {
			expect((op.args as { selection: { noteIds: string[] } }).selection.noteIds).toEqual([
				'n1',
				'n2'
			]);
		}
	});
});
