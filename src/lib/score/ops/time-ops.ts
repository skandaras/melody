import { resolveSelection } from '../query.js';
import type { Selection } from '../types.js';
import { clampVel, emptyResult, selectionSchema, type OpDef } from './types.js';

/**
 * Rhythm transformations.
 *
 * Every one of these is deterministic, including humanise: it takes a seed and
 * produces the same jitter every time. Random-by-default would make undo/redo
 * produce a different result each pass, and would make the AI diff view lie.
 */

/** Small xorshift PRNG so humanise is reproducible from a seed. */
function seeded(seed: number): () => number {
	let s = seed || 1;
	return () => {
		s ^= s << 13;
		s ^= s >>> 17;
		s ^= s << 5;
		return ((s >>> 0) % 100000) / 100000;
	};
}

export const quantise: OpDef<{ selection?: Selection; grid: number; strength?: number }> = {
	name: 'quantise',
	summary:
		'Pull note starts onto a rhythmic grid. grid is in ticks: 480=crotchet, 240=quaver, 120=semiquaver, 160=quaver triplet. strength 1 snaps exactly, 0.5 moves halfway (keeps some human feel).',
	schema: {
		type: 'object',
		properties: {
			selection: selectionSchema,
			grid: { type: 'integer', minimum: 1 },
			strength: { type: 'number', minimum: 0, maximum: 1 }
		},
		required: ['grid'],
		additionalProperties: false
	},
	apply(score, args) {
		const res = emptyResult();
		const strength = args.strength ?? 1;
		for (const { note } of resolveSelection(score, args.selection)) {
			const target = Math.round(note.tick / args.grid) * args.grid;
			note.tick = Math.max(0, Math.round(note.tick + (target - note.tick) * strength));
			// Snap the length too, or quantising starts leaves ragged ends that
			// look quantised but still sound loose.
			note.dur = Math.max(1, Math.round(note.dur / args.grid) * args.grid || args.grid);
			res.changed.push(note.id);
		}
		for (const part of score.parts) {
			for (const voice of part.voices) voice.events.sort((a, b) => a.tick - b.tick);
		}
		res.note = `Quantised ${res.changed.length} note(s) to ${args.grid} ticks`;
		return res;
	}
};

export const swing: OpDef<{ selection?: Selection; ratio: number; subdivision?: number }> = {
	name: 'swing',
	summary:
		'Delay every off-beat subdivision to create a swing feel. ratio 0.5 is straight, 0.67 is classic triplet swing, 0.6 is a light shuffle. subdivision defaults to quavers (240 ticks).',
	schema: {
		type: 'object',
		properties: {
			selection: selectionSchema,
			ratio: { type: 'number', minimum: 0.5, maximum: 0.8 },
			subdivision: { type: 'integer', minimum: 1 }
		},
		required: ['ratio'],
		additionalProperties: false
	},
	apply(score, args) {
		const res = emptyResult();
		const sub = args.subdivision ?? 240;
		const pair = sub * 2;
		for (const { note } of resolveSelection(score, args.selection)) {
			const posInPair = note.tick % pair;
			// Only the second half of each pair moves; the downbeat stays put,
			// which is what makes it swing rather than just drift late.
			if (Math.abs(posInPair - sub) < sub * 0.25) {
				note.tick = note.tick - sub + Math.round(pair * args.ratio);
				res.changed.push(note.id);
			}
		}
		for (const part of score.parts) {
			for (const voice of part.voices) voice.events.sort((a, b) => a.tick - b.tick);
		}
		res.note = `Swung ${res.changed.length} off-beat note(s) at ${args.ratio}`;
		return res;
	}
};

export const humanise: OpDef<{
	selection?: Selection;
	timingTicks?: number;
	velocityRange?: number;
	seed?: number;
}> = {
	name: 'humanise',
	summary:
		'Add small random-feeling variation to timing and velocity so playback stops sounding mechanical. Deterministic for a given seed, so it undoes and redoes identically.',
	schema: {
		type: 'object',
		properties: {
			selection: selectionSchema,
			timingTicks: { type: 'integer', minimum: 0, maximum: 120 },
			velocityRange: { type: 'integer', minimum: 0, maximum: 40 },
			seed: { type: 'integer' }
		},
		required: [],
		additionalProperties: false
	},
	apply(score, args) {
		const res = emptyResult();
		const rand = seeded(args.seed ?? 12345);
		const t = args.timingTicks ?? 12;
		const v = args.velocityRange ?? 10;

		for (const { note } of resolveSelection(score, args.selection)) {
			if (t > 0) note.tick = Math.max(0, note.tick + Math.round((rand() * 2 - 1) * t));
			if (v > 0) note.vel = clampVel(note.vel + Math.round((rand() * 2 - 1) * v));
			res.changed.push(note.id);
		}
		for (const part of score.parts) {
			for (const voice of part.voices) voice.events.sort((a, b) => a.tick - b.tick);
		}
		res.note = `Humanised ${res.changed.length} note(s)`;
		return res;
	}
};

export const scaleTime: OpDef<{ selection?: Selection; factor: number }> = {
	name: 'scale_time',
	summary:
		'Stretch or compress the selection in time. factor 2 is half-time (everything twice as long), 0.5 is double-time. Also known as augmentation and diminution.',
	schema: {
		type: 'object',
		properties: {
			selection: selectionSchema,
			factor: { type: 'number', minimum: 0.125, maximum: 8 }
		},
		required: ['factor'],
		additionalProperties: false
	},
	apply(score, args) {
		const res = emptyResult();
		const notes = resolveSelection(score, args.selection).sort((a, b) => a.note.tick - b.note.tick);
		if (!notes.length) return res;
		// Scale relative to the selection's own start, so stretching bars 5-8
		// doesn't fling them to the far end of the piece.
		const origin = notes[0].note.tick;

		for (const { note } of notes) {
			note.tick = Math.max(0, Math.round(origin + (note.tick - origin) * args.factor));
			note.dur = Math.max(1, Math.round(note.dur * args.factor));
			res.changed.push(note.id);
		}
		for (const part of score.parts) {
			for (const voice of part.voices) voice.events.sort((a, b) => a.tick - b.tick);
		}
		res.note = `Time ×${args.factor} on ${notes.length} note(s)`;
		return res;
	}
};

export const shiftTime: OpDef<{ selection?: Selection; deltaTicks: number }> = {
	name: 'shift_time',
	summary: 'Move the selection earlier or later without changing durations.',
	schema: {
		type: 'object',
		properties: {
			selection: selectionSchema,
			deltaTicks: { type: 'integer' }
		},
		required: ['deltaTicks'],
		additionalProperties: false
	},
	apply(score, args) {
		const res = emptyResult();
		for (const { note } of resolveSelection(score, args.selection)) {
			note.tick = Math.max(0, note.tick + args.deltaTicks);
			res.changed.push(note.id);
		}
		for (const part of score.parts) {
			for (const voice of part.voices) voice.events.sort((a, b) => a.tick - b.tick);
		}
		res.note = `Shifted ${res.changed.length} note(s) by ${args.deltaTicks} ticks`;
		return res;
	}
};
