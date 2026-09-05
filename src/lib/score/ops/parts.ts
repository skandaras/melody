import { GM_INSTRUMENTS, gmProgramFor } from '../instruments.js';
import { findPart } from '../query.js';
import type { Clef, Part } from '../types.js';
import { emptyResult, type OpDef } from './types.js';

/**
 * Part-level operations. These are what "Orchestrate as a string quartet"
 * decomposes into: add_part four times, then insert_notes into each.
 */

export const addPart: OpDef<{
	name: string;
	instrument: string;
	clef?: Clef;
	isDrum?: boolean;
}> = {
	name: 'add_part',
	summary:
		'Add an empty instrumental part (staff). Give the instrument by General MIDI name, e.g. "Acoustic Grand Piano", "Violin", "String Ensemble 1", "Acoustic Bass". Returns nothing — insert notes into it afterwards with insert_notes.',
	schema: {
		type: 'object',
		properties: {
			name: { type: 'string', description: 'Display name on the staff, e.g. "Violin I".' },
			instrument: { type: 'string', description: 'General MIDI instrument name.' },
			clef: { type: 'string', enum: ['treble', 'bass', 'alto', 'tenor', 'percussion'] },
			isDrum: { type: 'boolean' }
		},
		required: ['name', 'instrument'],
		additionalProperties: false
	},
	apply(score, args, ctx) {
		const res = emptyResult();
		const isDrum = args.isDrum ?? /drum|percussion|kit/i.test(args.instrument);

		// Channel 9 is the GM drum channel; everything else takes the next free
		// non-drum channel.
		//
		// The search is bounded rather than "keep going until one is free":
		// there are fifteen non-drum channels, so once fifteen parts hold them
		// all, every candidate satisfies the condition and an unbounded loop
		// never exits — a hang inside a request handler rather than the wrap it
		// looks like. Past that we share a channel, which costs correct playback
		// for the sixteenth part and nothing else. Notation is unaffected either
		// way; channels are a MIDI limit, not a musical one.
		const used = new Set(score.parts.map((p) => p.channel));
		let channel = 9;
		if (!isDrum) {
			channel = 0;
			for (let i = 0; i < 16 && (used.has(channel) || channel === 9); i++) {
				channel = (channel + 1) % 16;
			}
		}

		const part: Part = {
			id: ctx.ids.next('part'),
			name: args.name,
			gmProgram: gmProgramFor(args.instrument),
			channel,
			isDrum,
			clef: args.clef ?? guessClef(args.instrument),
			transpose: 0,
			volume: 0.8,
			muted: false,
			voices: [{ id: ctx.ids.next('voice'), events: [] }]
		};
		score.parts.push(part);
		res.created = [{ kind: 'part', id: part.id, name: part.name }];
		res.note = `Added part "${part.name}" (${args.instrument})`;
		return res;
	}
};

/** Pick a clef from the instrument's typical range rather than defaulting to
 *  treble, which puts a cello or bass permanently on ledger lines. */
function guessClef(instrument: string): Clef {
	const s = instrument.toLowerCase();
	if (/drum|percussion|kit/.test(s)) return 'percussion';
	if (/bass|tuba|contrabass|bassoon|cello|trombone|baritone/.test(s)) return 'bass';
	if (/viola/.test(s)) return 'alto';
	return 'treble';
}

export const removePart: OpDef<{ partId: string }> = {
	name: 'remove_part',
	summary: 'Delete a part and everything in it.',
	schema: {
		type: 'object',
		properties: { partId: { type: 'string' } },
		required: ['partId'],
		additionalProperties: false
	},
	apply(score, args) {
		const res = emptyResult();
		const part = findPart(score, args.partId);
		if (!part) return res;
		for (const v of part.voices) for (const e of v.events) res.removed.push(e.id);
		score.parts = score.parts.filter((p) => p.id !== args.partId);
		res.note = `Removed part "${part.name}"`;
		return res;
	}
};

export const setInstrument: OpDef<{
	partId: string;
	instrument?: string;
	name?: string;
	clef?: Clef;
	volume?: number;
	muted?: boolean;
	transpose?: number;
}> = {
	name: 'set_instrument',
	summary:
		'Change a part\'s instrument, display name, clef, mix level or mute state. Use this rather than removing and re-adding a part, which would destroy its notes.',
	schema: {
		type: 'object',
		properties: {
			partId: { type: 'string' },
			instrument: { type: 'string' },
			name: { type: 'string' },
			clef: { type: 'string', enum: ['treble', 'bass', 'alto', 'tenor', 'percussion'] },
			volume: { type: 'number', minimum: 0, maximum: 1 },
			muted: { type: 'boolean' },
			transpose: { type: 'integer', minimum: -24, maximum: 24 }
		},
		required: ['partId'],
		additionalProperties: false
	},
	apply(score, args) {
		const res = emptyResult();
		const part = findPart(score, args.partId);
		if (!part) return res;
		if (args.instrument) part.gmProgram = gmProgramFor(args.instrument);
		if (args.name) part.name = args.name;
		if (args.clef) part.clef = args.clef;
		if (args.volume != null) part.volume = Math.max(0, Math.min(1, args.volume));
		if (args.muted != null) part.muted = args.muted;
		if (args.transpose != null) part.transpose = args.transpose;
		res.note = `Updated part "${part.name}"`;
		return res;
	}
};

export const listInstrumentNames = () => GM_INSTRUMENTS;
