import { findPart, findVoice, isNote } from '../query.js';
import { parseSpelling } from '../pitch.js';
import type { Note, Score, ScoreEvent } from '../types.js';
import {
	clampMidi,
	clampVel,
	emptyResult,
	sortVoice,
	type OpDef,
	type OpResult,
	type OpContext
} from './types.js';

/**
 * Operations that add and remove notes. These are the ones the model reaches
 * for most, so their schemas carry the most descriptive weight.
 */

/** Loose shape the model is allowed to send for a note. */
interface NoteInput {
	tick: number;
	dur: number;
	/** Either MIDI numbers or spellings like "Bb4" — models are better at the
	 *  latter, sequencers at the former, so accept both. */
	pitches: (number | string)[];
	vel?: number;
	artic?: string[];
	dynamic?: string;
	lyric?: string;
}

const noteInputSchema = {
	type: 'object',
	properties: {
		tick: { type: 'integer', minimum: 0, description: 'Absolute position in ticks (480 per quarter note).' },
		dur: { type: 'integer', minimum: 1, description: 'Length in ticks. 480=crotchet, 240=quaver, 960=minim.' },
		pitches: {
			type: 'array',
			minItems: 1,
			items: { type: 'string' },
			description:
				'Note names with octave, e.g. ["C4"] for a single note or ["C4","E4","G4"] for a chord. Middle C is C4.'
		},
		vel: { type: 'integer', minimum: 1, maximum: 127, description: 'MIDI velocity. Default 80.' },
		artic: { type: 'array', items: { type: 'string' } },
		dynamic: { type: 'string' },
		lyric: { type: 'string' }
	},
	required: ['tick', 'dur', 'pitches'],
	additionalProperties: false
};

function toNote(input: NoteInput, ctx: OpContext): Note | null {
	const pitches = input.pitches
		.map((p) => (typeof p === 'number' ? clampMidi(p) : parseSpelling(p)))
		.filter((m): m is number => m !== null)
		.map((midi, i) => ({
			midi,
			spell: typeof input.pitches[i] === 'string' ? (input.pitches[i] as string) : undefined
		}));
	// A note with no parseable pitch is a rest at best and a corruption at
	// worst — drop it rather than write a note with an empty pitches array,
	// which every downstream consumer assumes cannot happen.
	if (!pitches.length) return null;

	return {
		id: ctx.ids.next('note'),
		kind: 'note',
		tick: Math.max(0, Math.round(input.tick)),
		dur: Math.max(1, Math.round(input.dur)),
		pitches,
		vel: clampVel(input.vel ?? 80),
		artic: input.artic?.length ? (input.artic as Note['artic']) : undefined,
		dynamic: input.dynamic as Note['dynamic'],
		lyric: input.lyric
	};
}

export const insertNotes: OpDef<{ partId: string; voiceId?: string; notes: NoteInput[] }> = {
	name: 'insert_notes',
	summary:
		'Add notes to a part. Existing notes are left alone, so use this to layer a counter-melody or fill a gap. To overwrite a passage use replace_range instead.',
	schema: {
		type: 'object',
		properties: {
			partId: { type: 'string' },
			voiceId: { type: 'string' },
			notes: { type: 'array', items: noteInputSchema, minItems: 1 }
		},
		required: ['partId', 'notes'],
		additionalProperties: false
	},
	apply(score, args, ctx) {
		const res = emptyResult();
		const part = findPart(score, args.partId);
		if (!part) return res;
		const voice = findVoice(part, args.voiceId);
		if (!voice) return res;

		for (const input of args.notes) {
			const note = toNote(input, ctx);
			if (!note) continue;
			voice.events.push(note);
			res.added.push(note.id);
		}
		sortVoice(voice.events);
		res.note = `Inserted ${res.added.length} note(s) into ${part.name}`;
		return res;
	}
};

export const deleteNotes: OpDef<{ noteIds: string[] }> = {
	name: 'delete_notes',
	summary: 'Remove specific notes by id.',
	schema: {
		type: 'object',
		properties: { noteIds: { type: 'array', items: { type: 'string' }, minItems: 1 } },
		required: ['noteIds'],
		additionalProperties: false
	},
	apply(score, args) {
		const res = emptyResult();
		const wanted = new Set(args.noteIds);
		for (const part of score.parts) {
			for (const voice of part.voices) {
				const before = voice.events.length;
				voice.events = voice.events.filter((e) => {
					if (wanted.has(e.id)) {
						res.removed.push(e.id);
						return false;
					}
					return true;
				});
				if (voice.events.length !== before) sortVoice(voice.events);
			}
		}
		res.note = `Deleted ${res.removed.length} note(s)`;
		return res;
	}
};

export const replaceRange: OpDef<{
	partId: string;
	voiceId?: string;
	startTick: number;
	endTick: number;
	notes: NoteInput[];
}> = {
	name: 'replace_range',
	summary:
		'Replace everything in one part between startTick (inclusive) and endTick (exclusive) with the supplied notes. This is the operation to use when rewriting a passage — reharmonising, changing a rhythm, or replacing a phrase.',
	schema: {
		type: 'object',
		properties: {
			partId: { type: 'string' },
			voiceId: { type: 'string' },
			startTick: { type: 'integer', minimum: 0 },
			endTick: { type: 'integer', minimum: 0 },
			notes: { type: 'array', items: noteInputSchema }
		},
		required: ['partId', 'startTick', 'endTick', 'notes'],
		additionalProperties: false
	},
	apply(score, args, ctx) {
		const res = emptyResult();
		const part = findPart(score, args.partId);
		if (!part) return res;
		const voice = findVoice(part, args.voiceId);
		if (!voice) return res;

		const kept: ScoreEvent[] = [];
		for (const e of voice.events) {
			if (e.tick >= args.startTick && e.tick < args.endTick) {
				if (isNote(e)) res.removed.push(e.id);
			} else {
				kept.push(e);
			}
		}
		voice.events = kept;

		for (const input of args.notes) {
			const note = toNote(input, ctx);
			if (!note) continue;
			voice.events.push(note);
			res.added.push(note.id);
		}
		sortVoice(voice.events);
		res.note = `Replaced ticks ${args.startTick}-${args.endTick} in ${part.name} (${res.removed.length} out, ${res.added.length} in)`;
		return res;
	}
};

export const setLyric: OpDef<{ noteId: string; lyric: string }> = {
	name: 'set_lyric',
	summary: 'Attach or replace the lyric syllable on one note.',
	schema: {
		type: 'object',
		properties: { noteId: { type: 'string' }, lyric: { type: 'string' } },
		required: ['noteId', 'lyric'],
		additionalProperties: false
	},
	apply(score, args): OpResult {
		const res = emptyResult();
		for (const part of score.parts) {
			for (const voice of part.voices) {
				for (const e of voice.events) {
					if (e.id === args.noteId && isNote(e)) {
						e.lyric = args.lyric;
						res.changed.push(e.id);
					}
				}
			}
		}
		return res;
	}
};
