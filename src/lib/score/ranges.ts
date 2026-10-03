import { isNote } from './query.js';
import type { Score } from './types.js';

/**
 * Practical sounding ranges, by General MIDI program.
 *
 * Practical, not theoretical: where a competent player is comfortable, which
 * is narrower than what the instrument can be made to do. Approximate by
 * nature — a range is a convention, not a fact — and used only to *report*,
 * never to refuse an edit. A note outside it is something to look at, not
 * something wrong.
 *
 * GM groups programs in families of eight, so each family has a default and
 * the instruments an arrangement actually leans on get their own entry.
 */

export interface Range {
	low: number;
	high: number;
}

const FAMILY: Range[] = [
	{ low: 21, high: 108 }, //   0 piano
	{ low: 48, high: 96 }, //    8 chromatic percussion
	{ low: 36, high: 96 }, //   16 organ
	{ low: 40, high: 88 }, //   24 guitar
	{ low: 28, high: 67 }, //   32 bass
	{ low: 36, high: 96 }, //   40 strings
	{ low: 36, high: 96 }, //   48 ensemble
	{ low: 34, high: 84 }, //   56 brass
	{ low: 44, high: 91 }, //   64 reed
	{ low: 60, high: 96 }, //   72 pipe
	{ low: 36, high: 96 }, //   80 synth lead
	{ low: 36, high: 96 }, //   88 synth pad
	{ low: 36, high: 96 }, //   96 synth effects
	{ low: 48, high: 88 }, //  104 ethnic
	{ low: 36, high: 96 }, //  112 percussive
	{ low: 0, high: 127 } //   120 sound effects — no meaningful range
];

const PROGRAM: Record<number, Range> = {
	9: { low: 79, high: 108 }, // glockenspiel
	11: { low: 53, high: 89 }, // vibraphone
	12: { low: 45, high: 96 }, // marimba
	13: { low: 65, high: 108 }, // xylophone
	14: { low: 60, high: 77 }, // tubular bells
	21: { low: 53, high: 89 }, // accordion
	22: { low: 60, high: 96 }, // harmonica
	40: { low: 55, high: 103 }, // violin
	41: { low: 48, high: 91 }, // viola
	42: { low: 36, high: 76 }, // cello
	43: { low: 28, high: 60 }, // contrabass
	45: { low: 28, high: 96 }, // pizzicato strings
	46: { low: 24, high: 103 }, // harp
	47: { low: 40, high: 57 }, // timpani
	48: { low: 28, high: 96 }, // string ensemble 1
	49: { low: 28, high: 96 }, // string ensemble 2
	52: { low: 40, high: 81 }, // choir aahs
	53: { low: 40, high: 81 }, // voice oohs
	56: { low: 54, high: 82 }, // trumpet
	57: { low: 40, high: 72 }, // trombone
	58: { low: 28, high: 58 }, // tuba
	59: { low: 54, high: 82 }, // muted trumpet
	60: { low: 34, high: 77 }, // french horn
	64: { low: 56, high: 87 }, // soprano sax
	65: { low: 49, high: 81 }, // alto sax
	66: { low: 44, high: 76 }, // tenor sax
	67: { low: 36, high: 69 }, // baritone sax
	68: { low: 58, high: 91 }, // oboe
	69: { low: 52, high: 81 }, // english horn
	70: { low: 34, high: 75 }, // bassoon
	71: { low: 50, high: 91 }, // clarinet
	72: { low: 74, high: 108 }, // piccolo
	73: { low: 60, high: 96 }, // flute
	74: { low: 72, high: 98 }, // recorder
	105: { low: 48, high: 84 }, // banjo
	109: { low: 55, high: 77 }, // bagpipe
	110: { low: 55, high: 96 } // fiddle
};

export function rangeOf(gmProgram: number): Range {
	const program = Math.max(0, Math.min(127, Math.round(gmProgram)));
	return PROGRAM[program] ?? FAMILY[Math.floor(program / 8)];
}

export interface OutOfRange {
	noteId: string;
	tick: number;
	midi: number;
	/** How far outside, in semitones; negative is below. */
	by: number;
}

export interface PartPlayability {
	partId: string;
	name: string;
	range: Range;
	notes: number;
	outside: OutOfRange[];
}

/**
 * Every pitched part, with the notes that fall outside its range.
 *
 * Drum parts are skipped: their "pitches" are kit pieces, and a range means
 * nothing there.
 */
export function playability(score: Score, partIds?: readonly string[]): PartPlayability[] {
	const wanted = partIds?.length ? new Set(partIds) : null;
	const out: PartPlayability[] = [];

	for (const part of score.parts) {
		if (part.isDrum || (wanted && !wanted.has(part.id))) continue;
		const range = rangeOf(part.gmProgram);
		const outside: OutOfRange[] = [];
		let notes = 0;

		for (const voice of part.voices) {
			for (const event of voice.events) {
				if (!isNote(event)) continue;
				notes++;
				for (const pitch of event.pitches) {
					const by =
						pitch.midi < range.low
							? pitch.midi - range.low
							: pitch.midi > range.high
								? pitch.midi - range.high
								: 0;
					if (by) outside.push({ noteId: event.id, tick: event.tick, midi: pitch.midi, by });
				}
			}
		}
		out.push({ partId: part.id, name: part.name, range, notes, outside });
	}
	return out;
}

/** As text, for the model. Long lists are cut — the count says the rest. */
export function playabilityReport(score: Score, partIds?: readonly string[], max = 20): string {
	const parts = playability(score, partIds);
	if (!parts.length) return '(no pitched parts)';

	return parts
		.map((p) => {
			const head = `${p.partId} ${p.name} — practical range ${p.range.low}–${p.range.high}`;
			if (!p.notes) return `${head}: no notes yet`;
			if (!p.outside.length) return `${head}: all ${p.notes} notes in range`;
			const lines = p.outside
				.slice(0, max)
				.map(
					(o) =>
						`  ${o.noteId} @${o.tick} midi ${o.midi} (${Math.abs(o.by)} ${o.by < 0 ? 'below' : 'above'})`
				);
			if (p.outside.length > max) lines.push(`  …and ${p.outside.length - max} more`);
			return [`${head}: ${p.outside.length} pitch(es) out of range`, ...lines].join('\n');
		})
		.join('\n');
}
