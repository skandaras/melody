import { SCORE_VERSION, type Score, type ScoreEvent } from './types.js';
import { normalise } from './apply.js';
import { emptyScore } from './types.js';

/**
 * Structural validation and repair for score documents.
 *
 * Two callers, both untrusting:
 *  - the database, loading a document written by an older build;
 *  - the AI layer, which must never be able to persist a malformed score even
 *    if the model returns something strange.
 *
 * The posture is repair, not reject: a score with one broken note should lose
 * that note, not the whole piece. Anything genuinely unusable returns null.
 */

export interface ValidationIssue {
	path: string;
	problem: string;
	repaired: boolean;
}

export interface ValidationResult {
	score: Score | null;
	issues: ValidationIssue[];
}

const isObj = (v: unknown): v is Record<string, unknown> =>
	typeof v === 'object' && v !== null && !Array.isArray(v);

const num = (v: unknown, fallback: number): number =>
	typeof v === 'number' && Number.isFinite(v) ? v : fallback;

export function validateScore(raw: unknown): ValidationResult {
	const issues: ValidationIssue[] = [];
	if (!isObj(raw)) {
		return { score: null, issues: [{ path: '', problem: 'Not an object', repaired: false }] };
	}

	const out = emptyScore(typeof raw.title === 'string' ? raw.title : 'Untitled');
	out.v = SCORE_VERSION;
	out.ppq = num(raw.ppq, 480);
	if (typeof raw.composer === 'string') out.composer = raw.composer;

	// Every tick-keyed map must have an entry at 0, or "what's in force here?"
	// has no answer for the opening bar and every lookup downstream returns
	// undefined.
	const tempoMap = Array.isArray(raw.tempoMap) ? raw.tempoMap : [];
	out.tempoMap = tempoMap
		.filter(isObj)
		.map((t) => ({ tick: Math.max(0, num(t.tick, 0)), bpm: num(t.bpm, 120) }));
	if (!out.tempoMap.some((t) => t.tick === 0)) {
		out.tempoMap.unshift({ tick: 0, bpm: 120 });
		if (tempoMap.length) issues.push({ path: 'tempoMap', problem: 'No entry at tick 0', repaired: true });
	}

	const timeSigs = Array.isArray(raw.timeSigs) ? raw.timeSigs : [];
	out.timeSigs = timeSigs
		.filter(isObj)
		.map((t) => ({
			tick: Math.max(0, num(t.tick, 0)),
			num: Math.max(1, num(t.num, 4)),
			den: [1, 2, 4, 8, 16, 32].includes(num(t.den, 4)) ? num(t.den, 4) : 4
		}));
	if (!out.timeSigs.some((t) => t.tick === 0)) {
		out.timeSigs.unshift({ tick: 0, num: 4, den: 4 });
		if (timeSigs.length) issues.push({ path: 'timeSigs', problem: 'No entry at tick 0', repaired: true });
	}

	const keySigs = Array.isArray(raw.keySigs) ? raw.keySigs : [];
	out.keySigs = keySigs.filter(isObj).map((k) => ({
		tick: Math.max(0, num(k.tick, 0)),
		fifths: Math.max(-7, Math.min(7, num(k.fifths, 0))),
		mode: k.mode === 'minor' ? ('minor' as const) : ('major' as const)
	}));
	if (!out.keySigs.some((k) => k.tick === 0)) {
		out.keySigs.unshift({ tick: 0, fifths: 0, mode: 'major' });
		if (keySigs.length) issues.push({ path: 'keySigs', problem: 'No entry at tick 0', repaired: true });
	}

	const seenIds = new Set<string>();
	let idFixes = 0;
	const uniqueId = (candidate: unknown, prefix: string): string => {
		let id = typeof candidate === 'string' && candidate ? candidate : '';
		if (!id || seenIds.has(id)) {
			// Duplicate ids are the one corruption that silently breaks
			// everything downstream — patches would hit the wrong note and the
			// diff would highlight the wrong bar.
			let n = seenIds.size + 1;
			while (seenIds.has(`${prefix}${n}`)) n++;
			id = `${prefix}${n}`;
			idFixes++;
		}
		seenIds.add(id);
		return id;
	};

	const parts = Array.isArray(raw.parts) ? raw.parts : [];
	out.parts = parts.filter(isObj).map((p) => {
		const voices = Array.isArray(p.voices) ? p.voices : [];
		return {
			id: uniqueId(p.id, 'p'),
			name: typeof p.name === 'string' ? p.name : 'Part',
			gmProgram: Math.max(0, Math.min(127, Math.round(num(p.gmProgram, 0)))),
			channel: Math.max(0, Math.min(15, Math.round(num(p.channel, 0)))),
			isDrum: p.isDrum === true,
			clef: (['treble', 'bass', 'alto', 'tenor', 'percussion'] as const).includes(p.clef as never)
				? (p.clef as Score['parts'][number]['clef'])
				: 'treble',
			transpose: Math.round(num(p.transpose, 0)),
			volume: Math.max(0, Math.min(1, num(p.volume, 0.8))),
			muted: p.muted === true,
			voices: (voices.length ? voices : [{ id: undefined, events: [] }]).filter(isObj as never).map((v: unknown) => {
				const vo = isObj(v) ? v : {};
				const events = Array.isArray(vo.events) ? vo.events : [];
				return {
					id: uniqueId(vo.id, 'v'),
					events: events.filter(isObj).flatMap((e): ScoreEvent[] => {
						const tick = Math.max(0, Math.round(num(e.tick, 0)));
						const dur = Math.max(1, Math.round(num(e.dur, 480)));
						if (e.kind === 'rest') {
							return [{ id: uniqueId(e.id, 'r'), kind: 'rest' as const, tick, dur }];
						}
						const pitches = (Array.isArray(e.pitches) ? e.pitches : [])
							.filter(isObj)
							.map((pt) => ({
								midi: Math.max(0, Math.min(127, Math.round(num(pt.midi, 60)))),
								spell: typeof pt.spell === 'string' ? pt.spell : undefined,
								tie: (['start', 'stop', 'both'] as const).includes(pt.tie as never)
									? (pt.tie as 'start' | 'stop' | 'both')
									: undefined
							}));
						// A note with no pitches is not representable; drop it
						// rather than emit one every consumer must guard against.
						if (!pitches.length) {
							issues.push({ path: `note ${String(e.id)}`, problem: 'No valid pitches', repaired: true });
							return [];
						}
						return [{
							id: uniqueId(e.id, 'n'),
							kind: 'note' as const,
							tick,
							dur,
							pitches,
							vel: Math.max(1, Math.min(127, Math.round(num(e.vel, 80)))),
							artic: Array.isArray(e.artic) && e.artic.length ? (e.artic as never) : undefined,
							dynamic: typeof e.dynamic === 'string' ? (e.dynamic as never) : undefined,
							slur: e.slur === 'start' || e.slur === 'stop' ? e.slur : undefined,
							lyric: typeof e.lyric === 'string' ? e.lyric : undefined,
							tuplet: isObj(e.tuplet)
								? { num: num(e.tuplet.num, 3), den: num(e.tuplet.den, 2) }
								: undefined
						}];
					})
				};
			})
		};
	}) as Score['parts'];

	const sections = Array.isArray(raw.sections) ? raw.sections : [];
	out.sections = sections.filter(isObj).map((s) => ({
		id: uniqueId(s.id, 's'),
		name: typeof s.name === 'string' ? s.name : 'Section',
		startTick: Math.max(0, Math.round(num(s.startTick, 0))),
		endTick: Math.max(0, Math.round(num(s.endTick, 0))),
		color: typeof s.color === 'string' ? s.color : undefined
	}));

	if (idFixes) {
		issues.push({ path: 'ids', problem: `${idFixes} missing or duplicate id(s)`, repaired: true });
	}

	return { score: normalise(out), issues };
}

/** Convenience for load paths that just want a usable score or a fresh one. */
export function coerceScore(raw: unknown, title = 'Untitled'): Score {
	const { score } = validateScore(raw);
	return score ?? emptyScore(title);
}
