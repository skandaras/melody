import type { KeySig, Mode } from './types.js';

/**
 * Pitch spelling.
 *
 * MIDI number 61 is both C# and Db, and which one you write changes how the
 * music reads. Rather than store a spelling on every note, we store one only
 * when someone made a deliberate choice, and derive the rest from the key
 * signature in force. That keeps documents small and keeps transposition from
 * producing things like E# major.
 */

export const SHARP_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
export const FLAT_NAMES = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'];

/** Circle-of-fifths position of each major tonic, indexed by pitch class. */
const MAJOR_FIFTHS: Record<number, number> = {
	0: 0, // C
	7: 1, // G
	2: 2, // D
	9: 3, // A
	4: 4, // E
	11: 5, // B
	6: 6, // F#
	1: -5, // Db
	8: -4, // Ab
	3: -3, // Eb
	10: -2, // Bb
	5: -1 // F
};

export function midiToPitchClass(midi: number): number {
	return ((midi % 12) + 12) % 12;
}

export function midiToOctave(midi: number): number {
	return Math.floor(midi / 12) - 1;
}

/** Prefer flats for flat keys, sharps for sharp keys. C uses sharps. */
export function spellMidi(midi: number, key?: KeySig): string {
	const pc = midiToPitchClass(midi);
	const oct = midiToOctave(midi);
	const useFlats = (key?.fifths ?? 0) < 0;
	const name = useFlats ? FLAT_NAMES[pc] : SHARP_NAMES[pc];
	return `${name}${oct}`;
}

/** Parse "Bb4" / "A#3" / "C-1" back to a MIDI number. Null if unparseable. */
export function parseSpelling(spell: string): number | null {
	const m = /^([A-Ga-g])([#b]*)(-?\d+)$/.exec(spell.trim());
	if (!m) return null;
	const base: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
	let midi = base[m[1].toUpperCase()];
	for (const ch of m[2]) midi += ch === '#' ? 1 : -1;
	midi += (Number(m[3]) + 1) * 12;
	return midi >= 0 && midi <= 127 ? midi : null;
}

/** Tonic pitch class of a key signature. */
export function keyTonic(key: KeySig): number {
	const majorPc = Object.entries(MAJOR_FIFTHS).find(([, f]) => f === key.fifths);
	const pc = majorPc ? Number(majorPc[0]) : 0;
	// The relative minor sits a minor third below its relative major.
	return key.mode === 'minor' ? midiToPitchClass(pc - 3) : pc;
}

/** Circle-of-fifths value for a tonic pitch class and mode. */
export function fifthsFor(tonicPc: number, mode: Mode): number {
	const majorPc = mode === 'minor' ? midiToPitchClass(tonicPc + 3) : tonicPc;
	return MAJOR_FIFTHS[majorPc] ?? 0;
}

export function keyName(key: KeySig): string {
	const pc = keyTonic(key);
	const names = key.fifths < 0 ? FLAT_NAMES : SHARP_NAMES;
	return `${names[pc]} ${key.mode}`;
}

const MAJOR_SCALE = [0, 2, 4, 5, 7, 9, 11];
const MINOR_SCALE = [0, 2, 3, 5, 7, 8, 10];

export function scaleOf(key: KeySig): number[] {
	const tonic = keyTonic(key);
	const steps = key.mode === 'minor' ? MINOR_SCALE : MAJOR_SCALE;
	return steps.map((s) => midiToPitchClass(tonic + s));
}

export function isDiatonic(midi: number, key: KeySig): boolean {
	return scaleOf(key).includes(midiToPitchClass(midi));
}

/** Nearest in-key pitch. Ties resolve downward, which sounds less jarring. */
export function snapToKey(midi: number, key: KeySig): number {
	if (isDiatonic(midi, key)) return midi;
	const scale = scaleOf(key);
	for (let d = 1; d <= 6; d++) {
		if (scale.includes(midiToPitchClass(midi - d))) return midi - d;
		if (scale.includes(midiToPitchClass(midi + d))) return midi + d;
	}
	return midi;
}

/**
 * Transpose within the key rather than by a fixed interval — moving up "one
 * step" from the leading note should land on the tonic, not a semitone above.
 */
export function diatonicTranspose(midi: number, steps: number, key: KeySig): number {
	const scale = scaleOf(key).sort((a, b) => a - b);
	const pc = midiToPitchClass(midi);
	let idx = scale.indexOf(pc);
	if (idx === -1) {
		// Chromatic note: snap first, then move.
		const snapped = snapToKey(midi, key);
		idx = scale.indexOf(midiToPitchClass(snapped));
		midi = snapped;
		if (idx === -1) return midi + steps;
	}
	const target = idx + steps;
	const octaveShift = Math.floor(target / scale.length);
	const wrapped = ((target % scale.length) + scale.length) % scale.length;
	const baseOctave = Math.floor(midi / 12);
	const candidate = baseOctave * 12 + scale[wrapped] + octaveShift * 12;
	return Math.max(0, Math.min(127, candidate));
}

/** Practical playing ranges, used by check_playability and orchestration. */
export const INSTRUMENT_RANGES: Record<string, { low: number; high: number }> = {
	piano: { low: 21, high: 108 },
	violin: { low: 55, high: 100 },
	viola: { low: 48, high: 91 },
	cello: { low: 36, high: 84 },
	contrabass: { low: 28, high: 67 },
	flute: { low: 60, high: 96 },
	oboe: { low: 58, high: 91 },
	clarinet: { low: 50, high: 91 },
	bassoon: { low: 34, high: 75 },
	trumpet: { low: 55, high: 87 },
	horn: { low: 34, high: 77 },
	trombone: { low: 40, high: 72 },
	tuba: { low: 28, high: 58 },
	guitar: { low: 40, high: 88 },
	bass: { low: 28, high: 67 },
	soprano: { low: 60, high: 81 },
	alto: { low: 55, high: 74 },
	tenor: { low: 48, high: 69 },
	baritone: { low: 45, high: 65 },
	voice: { low: 48, high: 79 }
};
