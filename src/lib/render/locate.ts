import { keySigAt } from '$lib/score/measures';
import type { Score } from '$lib/score/types';
import type { StaveBox } from './render.js';

/**
 * Turning a point on the page back into a musical position.
 *
 * The inverse of hitTest: that answers "which note did I click", this answers
 * "where would a note go if I clicked here". Needed for note entry, and kept
 * apart from the renderer so it can be tested without a DOM — every input is a
 * plain number and the output is a tick and a MIDI pitch.
 *
 * Geometry comes from the StaveBoxes the renderer recorded, not from the
 * layout constants, so a stave with a clef change or an extra signature still
 * maps correctly.
 */

export interface Position {
	partId: string;
	partIndex: number;
	/** Absolute tick, already snapped to the requested grid. */
	tick: number;
	midi: number;
	/** Diatonic staff position: 0 is the top line, 1 the space below it. */
	step: number;
}

/**
 * The MIDI pitch of the top stave line, per clef.
 *
 * Treble's top line is F5 (77), bass's is A3 (57), alto's is G4 (67), tenor's
 * is F4 (65). Everything below follows by counting diatonic steps down.
 */
const TOP_LINE_MIDI: Record<string, number> = {
	treble: 77,
	bass: 57,
	alto: 67,
	tenor: 65,
	percussion: 71
};

/** Semitones above C for each diatonic degree, C major. */
const MAJOR_SEMITONES = [0, 2, 4, 5, 7, 9, 11];

/** Which diatonic degrees carry a sharp, in the order sharps are applied. */
const SHARP_ORDER = [3, 0, 4, 1, 5, 2, 6]; // F C G D A E B
/** …and flats, in their order. */
const FLAT_ORDER = [6, 2, 5, 1, 4, 0, 3]; // B E A D G C F

/**
 * Diatonic step below the top line → MIDI, honouring the key signature.
 *
 * Working in diatonic steps rather than semitones is what makes this match
 * what a musician expects: clicking the third space in E major gives the note
 * on that space *in E major*, sharps included, rather than a white key that
 * then has to be corrected.
 */
export function stepToMidi(step: number, clef: string, fifths: number): number {
	const topMidi = TOP_LINE_MIDI[clef] ?? TOP_LINE_MIDI.treble;

	// Diatonic degree and octave of the top line, derived from its MIDI value.
	const topOctave = Math.floor(topMidi / 12);
	const topPc = topMidi % 12;
	const topDegree = MAJOR_SEMITONES.indexOf(topPc);
	// Every clef's top line lands on a natural, so this always resolves.
	const degreeFromC = topDegree < 0 ? 0 : topDegree;

	const absoluteDegree = degreeFromC - step;
	const octaveShift = Math.floor(absoluteDegree / 7);
	const degree = ((absoluteDegree % 7) + 7) % 7;

	let midi = (topOctave + octaveShift) * 12 + MAJOR_SEMITONES[degree];

	// Apply the key signature to this degree.
	if (fifths > 0 && SHARP_ORDER.slice(0, Math.min(7, fifths)).includes(degree)) midi += 1;
	if (fifths < 0 && FLAT_ORDER.slice(0, Math.min(7, -fifths)).includes(degree)) midi -= 1;

	return midi;
}

export interface LocateOptions {
	/** Snap ticks to this many divisions per whole note. 16 is a semiquaver. */
	grid?: number;
	/** Triplet snapping, when the palette asks for it. */
	triplets?: boolean;
}

/**
 * Which stave is under this point, and what note would land there.
 *
 * Returns null outside every stave rather than guessing at the nearest one —
 * placing a note in the gap between systems is never what was meant.
 */
export function pointToPosition(
	staves: StaveBox[],
	score: Score,
	x: number,
	y: number,
	opts: LocateOptions = {}
): Position | null {
	const box = findStave(staves, x, y);
	if (!box) return null;

	// Vertical: half a line spacing per diatonic step, so lines and spaces
	// alternate and the click lands on whichever is nearest.
	const half = box.lineSpacing / 2;
	const step = Math.round((y - box.topLineY) / half);

	const key = keySigAt(score, box.startTick);
	const midi = stepToMidi(step, box.clef, key.fifths);

	// Horizontal: linear across the measure. Notes are not spaced linearly once
	// a bar is full, but for placement the difference is well under one grid
	// division, and snapping absorbs it.
	const fraction = Math.max(0, Math.min(1, (x - box.x) / box.width));
	const raw = box.startTick + fraction * (box.endTick - box.startTick);

	return {
		partId: box.partId,
		partIndex: box.partIndex,
		tick: snapTick(raw, box.startTick, box.endTick, score.ppq, opts),
		midi: Math.max(0, Math.min(127, midi)),
		step
	};
}

/**
 * The stave a point falls in.
 *
 * Vertical tolerance runs well past the five lines, because ledger-line notes
 * are placed above and below the stave and would otherwise be unreachable.
 * Bounded at roughly two octaves either way, which is where a reasonable
 * person stops using ledger lines and adds a part instead.
 */
function findStave(staves: StaveBox[], x: number, y: number): StaveBox | null {
	let best: StaveBox | null = null;
	let bestDistance = Infinity;

	for (const box of staves) {
		if (x < box.x - box.lineSpacing || x > box.x + box.width + box.lineSpacing) continue;

		const top = box.topLineY;
		const bottom = box.topLineY + box.lineSpacing * 4;
		const reach = box.lineSpacing * 7;
		if (y < top - reach || y > bottom + reach) continue;

		// Distance to the stave proper, so overlapping reaches resolve to the
		// stave the point is actually nearest.
		const distance = y < top ? top - y : y > bottom ? y - bottom : 0;
		if (distance < bestDistance) {
			best = box;
			bestDistance = distance;
		}
	}
	return best;
}

/** Snap a tick to the grid, clamped inside the measure it came from. */
function snapTick(
	raw: number,
	startTick: number,
	endTick: number,
	ppq: number,
	opts: LocateOptions
): number {
	const divisions = opts.grid ?? 16;
	// A whole note is 4 quarters; ppq*4 divided by the grid gives the step.
	let stepTicks = (ppq * 4) / divisions;
	if (opts.triplets) stepTicks = (stepTicks * 2) / 3;

	const snapped = startTick + Math.round((raw - startTick) / stepTicks) * stepTicks;
	// Never past the barline: a note placed at endTick belongs to the next bar,
	// which is not where the pointer was.
	return Math.max(startTick, Math.min(endTick - stepTicks, Math.round(snapped)));
}
