import { FLAT_NAMES, SHARP_NAMES, midiToOctave, midiToPitchClass } from '$lib/score/pitch';
import type { KeySig } from '$lib/score/types';

/**
 * MIDI numbers to VexFlow key strings ("c#/4", "bb/3") and the accidentals
 * that go with them.
 *
 * VexFlow wants the letter name and the accidental separately: the key string
 * carries the spelling, and an Accidental modifier is added only when the note
 * differs from what the key signature already implies. Adding one to every
 * note would litter the score with redundant sharps.
 */

/** Which pitch classes the key signature already alters. */
function alteredByKey(key: KeySig): Map<string, string> {
	const sharpOrder = ['f', 'c', 'g', 'd', 'a', 'e', 'b'];
	const flatOrder = ['b', 'e', 'a', 'd', 'g', 'c', 'f'];
	const out = new Map<string, string>();
	if (key.fifths > 0) {
		for (let i = 0; i < Math.min(7, key.fifths); i++) out.set(sharpOrder[i], '#');
	} else if (key.fifths < 0) {
		for (let i = 0; i < Math.min(7, -key.fifths); i++) out.set(flatOrder[i], 'b');
	}
	return out;
}

export interface VexKey {
	/** e.g. "c#/4" — what VexFlow's `keys` array wants. */
	key: string;
	/** "#", "b", "n" or null. Null means the key signature already covers it. */
	accidental: string | null;
}

/**
 * Spell a MIDI note for rendering.
 *
 * `spell` from the document wins when present — that's a deliberate human or
 * model choice. Otherwise flat keys get flats and sharp keys get sharps.
 */
export function midiToVexKey(midi: number, key: KeySig, spell?: string): VexKey {
	let letter: string;
	let accidental: string | null = null;
	let octave = midiToOctave(midi);

	const parsed = spell ? /^([A-Ga-g])([#b]*)(-?\d+)$/.exec(spell.trim()) : null;
	if (parsed) {
		letter = parsed[1].toLowerCase();
		accidental = parsed[2] ? (parsed[2][0] === '#' ? '#' : 'b') : null;
		octave = Number(parsed[3]);
	} else {
		const pc = midiToPitchClass(midi);
		const name = (key.fifths < 0 ? FLAT_NAMES : SHARP_NAMES)[pc];
		letter = name[0].toLowerCase();
		accidental = name.length > 1 ? name[1] : null;
	}

	const implied = alteredByKey(key).get(letter) ?? null;

	// Only draw an accidental when it differs from what the signature says.
	// A natural is needed when the signature alters this letter but this note
	// doesn't use that alteration.
	let show: string | null = null;
	if (accidental !== implied) {
		show = accidental ?? 'n';
	}

	return { key: `${letter}${accidental ?? ''}/${octave}`, accidental: show };
}

/** VexFlow's key-signature spec string, e.g. "Bb" or "F#m". */
export function vexKeySignature(key: KeySig): string {
	const majors: Record<number, string> = {
		0: 'C', 1: 'G', 2: 'D', 3: 'A', 4: 'E', 5: 'B', 6: 'F#', 7: 'C#',
		'-1': 'F', '-2': 'Bb', '-3': 'Eb', '-4': 'Ab', '-5': 'Db', '-6': 'Gb', '-7': 'Cb'
	};
	const minors: Record<number, string> = {
		0: 'Am', 1: 'Em', 2: 'Bm', 3: 'F#m', 4: 'C#m', 5: 'G#m', 6: 'D#m', 7: 'A#m',
		'-1': 'Dm', '-2': 'Gm', '-3': 'Cm', '-4': 'Fm', '-5': 'Bbm', '-6': 'Ebm', '-7': 'Abm'
	};
	const table = key.mode === 'minor' ? minors : majors;
	return table[key.fifths] ?? 'C';
}
