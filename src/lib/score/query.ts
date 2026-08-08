import type { Note, Part, Score, ScoreEvent, Selection, Voice } from './types.js';

/**
 * Resolving a Selection into concrete notes.
 *
 * Every control and every operation takes a Selection rather than raw ids, so
 * the same "Darken" control works on one note, one part, a named section, or
 * the whole piece with no special-casing at the call site.
 */

export interface ResolvedNote {
	note: Note;
	part: Part;
	voice: Voice;
}

export function isNote(e: ScoreEvent): e is Note {
	return e.kind === 'note';
}

/**
 * Notes matching a selection.
 *
 * Precedence is deliberate: an explicit `noteIds` list wins outright, because
 * a user who shift-clicked five notes means those five, not "those five and
 * everything else in the bar". Otherwise part/section/tick filters intersect,
 * and an empty selection means the whole score.
 */
export function resolveSelection(score: Score, sel: Selection = {}): ResolvedNote[] {
	const out: ResolvedNote[] = [];

	if (sel.noteIds?.length) {
		const wanted = new Set(sel.noteIds);
		for (const part of score.parts) {
			for (const voice of part.voices) {
				for (const e of voice.events) {
					if (isNote(e) && wanted.has(e.id)) out.push({ note: e, part, voice });
				}
			}
		}
		return out;
	}

	const parts = sel.partIds?.length
		? score.parts.filter((p) => sel.partIds!.includes(p.id))
		: score.parts;

	// Section ids widen the tick window rather than replacing it, so
	// "section A, bars 3-4" narrows as a user would expect.
	let lo = sel.startTick ?? -Infinity;
	let hi = sel.endTick ?? Infinity;
	if (sel.sectionIds?.length) {
		const secs = score.sections.filter((s) => sel.sectionIds!.includes(s.id));
		if (secs.length) {
			const sLo = Math.min(...secs.map((s) => s.startTick));
			const sHi = Math.max(...secs.map((s) => s.endTick));
			lo = Math.max(lo === -Infinity ? sLo : lo, sLo);
			hi = Math.min(hi === Infinity ? sHi : hi, sHi);
		}
	}

	for (const part of parts) {
		for (const voice of part.voices) {
			for (const e of voice.events) {
				if (!isNote(e)) continue;
				// A note counts as inside the window if it starts inside it.
				// Using overlap instead would drag in a whole-note tied across
				// the boundary, which surprises people editing bar by bar.
				if (e.tick >= lo && e.tick < hi) out.push({ note: e, part, voice });
			}
		}
	}
	return out;
}

/** The tick span a selection actually covers, or null when it's empty. */
export function selectionBounds(
	score: Score,
	sel: Selection
): { startTick: number; endTick: number } | null {
	const notes = resolveSelection(score, sel);
	if (!notes.length) {
		if (sel.startTick != null && sel.endTick != null) {
			return { startTick: sel.startTick, endTick: sel.endTick };
		}
		return null;
	}
	let lo = Infinity;
	let hi = -Infinity;
	for (const { note } of notes) {
		lo = Math.min(lo, note.tick);
		hi = Math.max(hi, note.tick + note.dur);
	}
	return { startTick: lo, endTick: hi };
}

export function findPart(score: Score, partId: string): Part | undefined {
	return score.parts.find((p) => p.id === partId);
}

export function findVoice(part: Part, voiceId?: string): Voice | undefined {
	return voiceId ? part.voices.find((v) => v.id === voiceId) : part.voices[0];
}

export function findNote(score: Score, noteId: string): ResolvedNote | undefined {
	for (const part of score.parts) {
		for (const voice of part.voices) {
			for (const e of voice.events) {
				if (e.id === noteId && isNote(e)) return { note: e, part, voice };
			}
		}
	}
	return undefined;
}

/** Every note in the score, ordered by tick then part. */
export function allNotes(score: Score): ResolvedNote[] {
	return resolveSelection(score, {}).sort((a, b) => a.note.tick - b.note.tick);
}
