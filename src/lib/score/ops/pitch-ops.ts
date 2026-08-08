import { keySigAt } from '../measures.js';
import { diatonicTranspose, snapToKey, spellMidi } from '../pitch.js';
import { resolveSelection } from '../query.js';
import type { Selection } from '../types.js';
import { clampMidi, emptyResult, selectionSchema, type OpDef } from './types.js';

/**
 * Pitch transformations. Deterministic, exactly reversible, and far more
 * accurate than asking a model to do the arithmetic — the model's job is to
 * decide *that* the music should go up a third, not to work out which notes
 * that produces.
 */

export const transpose: OpDef<{
	selection?: Selection;
	semitones?: number;
	scaleSteps?: number;
}> = {
	name: 'transpose',
	summary:
		'Move the selection up or down. Use semitones for a literal interval (12 = one octave up), or scaleSteps to move within the key so the music stays diatonic (2 = up a third in the current key). Supply exactly one.',
	schema: {
		type: 'object',
		properties: {
			selection: selectionSchema,
			semitones: { type: 'integer', minimum: -48, maximum: 48 },
			scaleSteps: { type: 'integer', minimum: -21, maximum: 21 }
		},
		required: [],
		additionalProperties: false
	},
	apply(score, args) {
		const res = emptyResult();
		for (const { note } of resolveSelection(score, args.selection)) {
			const key = keySigAt(score, note.tick);
			for (const p of note.pitches) {
				p.midi =
					args.scaleSteps != null
						? diatonicTranspose(p.midi, args.scaleSteps, key)
						: clampMidi(p.midi + (args.semitones ?? 0));
				// A stale spelling after transposition is worse than none: it
				// would render the old letter name against the new pitch.
				p.spell = spellMidi(p.midi, key);
			}
			res.changed.push(note.id);
		}
		const by = args.scaleSteps != null ? `${args.scaleSteps} scale step(s)` : `${args.semitones} semitone(s)`;
		res.note = `Transposed ${res.changed.length} note(s) by ${by}`;
		return res;
	}
};

export const fitToKey: OpDef<{ selection?: Selection }> = {
	name: 'fit_to_key',
	summary:
		'Snap every out-of-key note in the selection to the nearest note of the prevailing key signature. Useful straight after transcription, where pitch detection often lands a semitone out.',
	schema: {
		type: 'object',
		properties: { selection: selectionSchema },
		required: [],
		additionalProperties: false
	},
	apply(score, args) {
		const res = emptyResult();
		for (const { note } of resolveSelection(score, args.selection)) {
			const key = keySigAt(score, note.tick);
			let touched = false;
			for (const p of note.pitches) {
				const snapped = snapToKey(p.midi, key);
				if (snapped !== p.midi) {
					p.midi = snapped;
					p.spell = spellMidi(snapped, key);
					touched = true;
				}
			}
			if (touched) res.changed.push(note.id);
		}
		res.note = `Fitted ${res.changed.length} note(s) to key`;
		return res;
	}
};

export const invert: OpDef<{ selection?: Selection; axisMidi?: number }> = {
	name: 'invert',
	summary:
		'Mirror the selection around a pitch axis: intervals that went up now go down by the same amount. A classical development technique. Defaults to the first note as the axis.',
	schema: {
		type: 'object',
		properties: {
			selection: selectionSchema,
			axisMidi: { type: 'integer', minimum: 0, maximum: 127 }
		},
		required: [],
		additionalProperties: false
	},
	apply(score, args) {
		const res = emptyResult();
		const notes = resolveSelection(score, args.selection).sort((a, b) => a.note.tick - b.note.tick);
		if (!notes.length) return res;
		const axis = args.axisMidi ?? notes[0].note.pitches[0].midi;

		for (const { note } of notes) {
			const key = keySigAt(score, note.tick);
			for (const p of note.pitches) {
				p.midi = clampMidi(axis * 2 - p.midi);
				p.spell = spellMidi(p.midi, key);
			}
			res.changed.push(note.id);
		}
		res.note = `Inverted ${notes.length} note(s) around MIDI ${axis}`;
		return res;
	}
};

export const retrograde: OpDef<{ selection?: Selection }> = {
	name: 'retrograde',
	summary:
		'Reverse the selection in time — the last note becomes the first. Rhythms are mirrored along with pitches.',
	schema: {
		type: 'object',
		properties: { selection: selectionSchema },
		required: [],
		additionalProperties: false
	},
	apply(score, args) {
		const res = emptyResult();
		const notes = resolveSelection(score, args.selection).sort((a, b) => a.note.tick - b.note.tick);
		if (notes.length < 2) return res;

		const lo = notes[0].note.tick;
		const hi = Math.max(...notes.map((n) => n.note.tick + n.note.dur));

		// Reflect each note's span through the midpoint of the selection: a
		// note's new start is the mirror of its old *end*, which is what keeps
		// the rhythm reversed rather than merely reordered.
		for (const { note } of notes) {
			note.tick = lo + hi - (note.tick + note.dur);
			res.changed.push(note.id);
		}
		for (const part of score.parts) {
			for (const voice of part.voices) voice.events.sort((a, b) => a.tick - b.tick);
		}
		res.note = `Retrograded ${notes.length} note(s)`;
		return res;
	}
};

export const octaveShift: OpDef<{ selection?: Selection; octaves: number }> = {
	name: 'octave_shift',
	summary: 'Move the selection by whole octaves. Positive is up.',
	schema: {
		type: 'object',
		properties: {
			selection: selectionSchema,
			octaves: { type: 'integer', minimum: -4, maximum: 4 }
		},
		required: ['octaves'],
		additionalProperties: false
	},
	apply(score, args) {
		const res = emptyResult();
		for (const { note } of resolveSelection(score, args.selection)) {
			const key = keySigAt(score, note.tick);
			for (const p of note.pitches) {
				p.midi = clampMidi(p.midi + args.octaves * 12);
				p.spell = spellMidi(p.midi, key);
			}
			res.changed.push(note.id);
		}
		res.note = `Shifted ${res.changed.length} note(s) by ${args.octaves} octave(s)`;
		return res;
	}
};
