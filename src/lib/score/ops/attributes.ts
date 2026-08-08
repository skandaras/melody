import { resolveSelection } from '../query.js';
import type { Articulation, Dynamic, Selection } from '../types.js';
import { clampVel, emptyResult, selectionSchema, type OpDef } from './types.js';

/**
 * Expression operations — how notes are played rather than which notes they
 * are. All deterministic, all cheap, all Tier A: a model asked to "make this
 * more staccato" should call set_articulation, not rewrite the passage.
 */

export const setArticulation: OpDef<{
	selection?: Selection;
	articulations: Articulation[];
	mode?: 'replace' | 'add';
}> = {
	name: 'set_articulation',
	summary:
		'Set articulations (staccato, accent, tenuto, marcato, fermata, trill…) on the selected notes. Use mode "add" to keep existing ones, "replace" (default) to swap them out. Pass an empty array to clear.',
	schema: {
		type: 'object',
		properties: {
			selection: selectionSchema,
			articulations: { type: 'array', items: { type: 'string' } },
			mode: { type: 'string', enum: ['replace', 'add'] }
		},
		required: ['articulations'],
		additionalProperties: false
	},
	apply(score, args) {
		const res = emptyResult();
		for (const { note } of resolveSelection(score, args.selection)) {
			if (args.mode === 'add') {
				note.artic = [...new Set([...(note.artic ?? []), ...args.articulations])];
			} else {
				note.artic = args.articulations.length ? [...args.articulations] : undefined;
			}
			res.changed.push(note.id);
		}
		res.note = `Set articulation on ${res.changed.length} note(s)`;
		return res;
	}
};

export const setDynamic: OpDef<{ selection?: Selection; dynamic: Dynamic; firstOnly?: boolean }> = {
	name: 'set_dynamic',
	summary:
		'Attach a dynamic marking (ppp..fff, sfz) to the selection. By default only the first note gets the mark, which is how dynamics are notated — a marking applies until the next one. Set firstOnly false to mark every note.',
	schema: {
		type: 'object',
		properties: {
			selection: selectionSchema,
			dynamic: { type: 'string', enum: ['ppp', 'pp', 'p', 'mp', 'mf', 'f', 'ff', 'fff', 'sfz'] },
			firstOnly: { type: 'boolean' }
		},
		required: ['dynamic'],
		additionalProperties: false
	},
	apply(score, args) {
		const res = emptyResult();
		const notes = resolveSelection(score, args.selection).sort((a, b) => a.note.tick - b.note.tick);
		const firstOnly = args.firstOnly !== false;

		// Velocity follows the marking so playback matches the page. Without
		// this, a score marked pp still plays back at whatever velocity the
		// transcription happened to capture.
		const velFor: Record<string, number> = {
			ppp: 16, pp: 32, p: 48, mp: 64, mf: 80, f: 96, ff: 112, fff: 124, sfz: 118
		};
		const vel = velFor[args.dynamic] ?? 80;

		for (const [i, { note }] of notes.entries()) {
			if (!firstOnly || i === 0) note.dynamic = args.dynamic;
			note.vel = clampVel(vel);
			res.changed.push(note.id);
		}
		res.note = `${args.dynamic} across ${res.changed.length} note(s)`;
		return res;
	}
};

export const setVelocityCurve: OpDef<{
	selection?: Selection;
	from: number;
	to: number;
	shape?: 'linear' | 'ease-in' | 'ease-out';
}> = {
	name: 'set_velocity_curve',
	summary:
		'Ramp velocity across the selection, in time order — a crescendo (from low to high) or diminuendo (high to low). Values are MIDI velocities 1-127.',
	schema: {
		type: 'object',
		properties: {
			selection: selectionSchema,
			from: { type: 'integer', minimum: 1, maximum: 127 },
			to: { type: 'integer', minimum: 1, maximum: 127 },
			shape: { type: 'string', enum: ['linear', 'ease-in', 'ease-out'] }
		},
		required: ['from', 'to'],
		additionalProperties: false
	},
	apply(score, args) {
		const res = emptyResult();
		const notes = resolveSelection(score, args.selection).sort((a, b) => a.note.tick - b.note.tick);
		if (!notes.length) return res;

		const span = Math.max(1, notes.length - 1);
		for (const [i, { note }] of notes.entries()) {
			let t = i / span;
			if (args.shape === 'ease-in') t = t * t;
			else if (args.shape === 'ease-out') t = 1 - (1 - t) * (1 - t);
			note.vel = clampVel(args.from + (args.to - args.from) * t);
			res.changed.push(note.id);
		}
		res.note = `Velocity ${args.from}→${args.to} over ${notes.length} note(s)`;
		return res;
	}
};

export const setDuration: OpDef<{ selection?: Selection; ratio: number }> = {
	name: 'set_duration_ratio',
	summary:
		'Scale how long notes sound without moving them — 0.5 for staccato detachment, 1.0 for normal, up to 1.0+ for legato overlap. Does not change the notated rhythm, only the sounding length.',
	schema: {
		type: 'object',
		properties: {
			selection: selectionSchema,
			ratio: { type: 'number', minimum: 0.05, maximum: 2 }
		},
		required: ['ratio'],
		additionalProperties: false
	},
	apply(score, args) {
		const res = emptyResult();
		for (const { note } of resolveSelection(score, args.selection)) {
			note.dur = Math.max(1, Math.round(note.dur * args.ratio));
			res.changed.push(note.id);
		}
		res.note = `Duration ×${args.ratio} on ${res.changed.length} note(s)`;
		return res;
	}
};
