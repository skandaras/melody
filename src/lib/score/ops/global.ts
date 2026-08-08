import { fifthsFor } from '../pitch.js';
import type { Mode } from '../types.js';
import { emptyResult, type OpDef } from './types.js';

/**
 * Score-wide markings: tempo, key, time signature, sections.
 *
 * All four are tick-keyed lists rather than single values, so a piece can
 * change key at the bridge or slow down at the end without any special case.
 * Writing at a tick that already has an entry replaces it.
 */

function upsert<T extends { tick: number }>(list: T[], entry: T): void {
	const i = list.findIndex((x) => x.tick === entry.tick);
	if (i >= 0) list[i] = entry;
	else list.push(entry);
	list.sort((a, b) => a.tick - b.tick);
}

export const setTempo: OpDef<{ tick?: number; bpm: number }> = {
	name: 'set_tempo',
	summary:
		'Set the tempo in beats per minute, from the given tick onward. Omit tick to set the opening tempo.',
	schema: {
		type: 'object',
		properties: {
			tick: { type: 'integer', minimum: 0 },
			bpm: { type: 'number', minimum: 20, maximum: 300 }
		},
		required: ['bpm'],
		additionalProperties: false
	},
	apply(score, args) {
		const res = emptyResult();
		upsert(score.tempoMap, { tick: args.tick ?? 0, bpm: Math.round(args.bpm) });
		res.note = `Tempo ${Math.round(args.bpm)}bpm at tick ${args.tick ?? 0}`;
		return res;
	}
};

export const setKey: OpDef<{ tick?: number; tonic: string; mode: Mode }> = {
	name: 'set_key',
	summary:
		'Set the key signature from the given tick onward. tonic is a note name like "Eb" or "F#"; mode is major or minor. This changes the signature only — it does not transpose existing notes. Use transpose for that.',
	schema: {
		type: 'object',
		properties: {
			tick: { type: 'integer', minimum: 0 },
			tonic: { type: 'string', description: 'Note name without octave, e.g. "D", "Bb", "F#".' },
			mode: { type: 'string', enum: ['major', 'minor'] }
		},
		required: ['tonic', 'mode'],
		additionalProperties: false
	},
	apply(score, args) {
		const res = emptyResult();
		const base: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
		const m = /^([A-Ga-g])([#b]*)$/.exec(args.tonic.trim());
		if (!m) return res;
		let pc = base[m[1].toUpperCase()];
		for (const ch of m[2]) pc += ch === '#' ? 1 : -1;
		pc = ((pc % 12) + 12) % 12;

		upsert(score.keySigs, {
			tick: args.tick ?? 0,
			fifths: fifthsFor(pc, args.mode),
			mode: args.mode
		});
		res.note = `Key ${args.tonic} ${args.mode} at tick ${args.tick ?? 0}`;
		return res;
	}
};

export const setTimeSig: OpDef<{ tick?: number; num: number; den: number }> = {
	name: 'set_time_sig',
	summary:
		'Set the time signature from the given tick onward, e.g. num 3 den 4 for 3/4. Barlines are derived from this, so changing it re-bars everything after the tick.',
	schema: {
		type: 'object',
		properties: {
			tick: { type: 'integer', minimum: 0 },
			num: { type: 'integer', minimum: 1, maximum: 32 },
			den: { type: 'integer', enum: [1, 2, 4, 8, 16, 32] }
		},
		required: ['num', 'den'],
		additionalProperties: false
	},
	apply(score, args) {
		const res = emptyResult();
		upsert(score.timeSigs, { tick: args.tick ?? 0, num: args.num, den: args.den });
		res.note = `${args.num}/${args.den} at tick ${args.tick ?? 0}`;
		return res;
	}
};

export const setSection: OpDef<{
	name: string;
	startTick: number;
	endTick: number;
	sectionId?: string;
	color?: string;
}> = {
	name: 'set_section',
	summary:
		'Name a span of the piece — "Verse 1", "Chorus", "Bridge". Sections are how a user selects a whole passage in one click and how later edits are targeted, so label the form as you build it.',
	schema: {
		type: 'object',
		properties: {
			name: { type: 'string' },
			startTick: { type: 'integer', minimum: 0 },
			endTick: { type: 'integer', minimum: 0 },
			sectionId: { type: 'string', description: 'Supply to update an existing section.' },
			color: { type: 'string' }
		},
		required: ['name', 'startTick', 'endTick'],
		additionalProperties: false
	},
	apply(score, args, ctx) {
		const res = emptyResult();
		const existing = args.sectionId ? score.sections.find((s) => s.id === args.sectionId) : undefined;
		if (existing) {
			existing.name = args.name;
			existing.startTick = args.startTick;
			existing.endTick = args.endTick;
			if (args.color) existing.color = args.color;
		} else {
			score.sections.push({
				id: ctx.ids.next('section'),
				name: args.name,
				startTick: args.startTick,
				endTick: args.endTick,
				color: args.color
			});
		}
		score.sections.sort((a, b) => a.startTick - b.startTick);
		res.note = `Section "${args.name}" (${args.startTick}-${args.endTick})`;
		return res;
	}
};

export const removeSection: OpDef<{ sectionId: string }> = {
	name: 'remove_section',
	summary: 'Delete a section marker. The music it covered is untouched.',
	schema: {
		type: 'object',
		properties: { sectionId: { type: 'string' } },
		required: ['sectionId'],
		additionalProperties: false
	},
	apply(score, args) {
		const res = emptyResult();
		const before = score.sections.length;
		score.sections = score.sections.filter((s) => s.id !== args.sectionId);
		if (score.sections.length !== before) res.note = 'Removed section';
		return res;
	}
};

export const setTitle: OpDef<{ title?: string; composer?: string }> = {
	name: 'set_title',
	summary: 'Set the title and/or composer shown at the head of the score.',
	schema: {
		type: 'object',
		properties: { title: { type: 'string' }, composer: { type: 'string' } },
		required: [],
		additionalProperties: false
	},
	apply(score, args) {
		const res = emptyResult();
		if (args.title) score.title = args.title;
		if (args.composer != null) score.composer = args.composer;
		res.note = 'Updated score details';
		return res;
	}
};
