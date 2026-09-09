import { resolveSelection } from '$lib/score/query.js';
import type { Score, Selection } from '$lib/score/types.js';

/**
 * What an expressive edit is aimed at, and the words for it.
 *
 * The whole of Refinement's pure logic, and it is one function, because
 * Refinement has no unit. Melody's was the section and Arrangement's was the
 * part; expression is diffuse — there is nothing to chunk, nothing to count as
 * "written", and no resume semantics. The file is short because the stage has
 * no structure to model, not because it was under-designed.
 *
 * What it does have is the epic's sharpest gotcha:
 *
 * > Selection defaults to the whole score. `resolveSelection(score, {})` returns
 * > everything. A control fired here with no selection would darken the entire
 * > piece — which is sometimes what you want, so make it *stated* rather than
 * > defaulted.
 *
 * That is why the `Selection` and the label describing it are produced together
 * rather than derived separately. Two expressions of the same intent can
 * disagree, and the shape of that disagreement is a button reading "Darken ·
 * selection" that darkens the whole piece. Here they cannot: the words come from
 * the same resolution the operation will use.
 *
 * The count is the other half. An empty `partIds` does **not** mean "no parts" —
 * `resolveSelection` reads a missing *or empty* list as every part — so "is
 * anything actually selected" can only be answered by resolving, never by
 * inspecting the shape of the query. A caller that trusts the shape ships the
 * bug this module exists to prevent.
 */

export type ScopeKind = 'whole' | 'selection' | 'part';

export interface EditScope {
	/** What to send. `{}` only ever when `kind` is `whole`. */
	selection: Selection;
	/** The words for it: "whole piece", "12 notes", "Cello". */
	label: string;
	kind: ScopeKind;
	/**
	 * Notes this really resolves to.
	 *
	 * Zero means refuse, never "everything". The distinction is the point: a
	 * scope that matches nothing and a scope that matches the whole piece are
	 * the same JSON, and only this number tells them apart.
	 */
	noteCount: number;
}

export interface ScopePick {
	/** Notes the person clicked. Wins over `partId` — an explicit pick is exact. */
	noteIds?: Iterable<string>;
	/** A part chosen from a list, when no individual notes are selected. */
	partId?: string | null;
}

/**
 * Resolve a pick into something safe to fire a control at.
 *
 * Notes beat a part, and a part beats the whole piece — most specific wins,
 * which is what a person means by clicking one thing after another. Anything
 * that resolves to nothing (a deleted part, a stale note id) falls back to
 * naming itself with a count of zero rather than silently widening: widening is
 * how "edit this part" becomes "edit everything".
 *
 * Note that Refinement deliberately does **not** exclude the melody, unlike
 * Arrangement. That rule was stage-4-specific — arranging around a tune is not
 * the moment to rewrite it — whereas changing how the tune *sounds* is exactly
 * what this stage is for.
 */
export function editScope(score: Score, pick: ScopePick = {}): EditScope {
	const noteIds = pick.noteIds ? [...pick.noteIds] : [];

	if (noteIds.length) {
		const selection: Selection = { noteIds };
		const noteCount = resolveSelection(score, selection).length;
		return {
			selection,
			kind: 'selection',
			label: `${noteCount} ${noteCount === 1 ? 'note' : 'notes'}`,
			noteCount
		};
	}

	const part = pick.partId ? score.parts.find((p) => p.id === pick.partId) : undefined;
	if (part) {
		const selection: Selection = { partIds: [part.id] };
		return {
			selection,
			kind: 'part',
			label: part.name,
			noteCount: resolveSelection(score, selection).length
		};
	}

	// The default, and the one that has to be said out loud. `{}` is correct
	// here — it is the only case where meaning "everything" is the intent rather
	// than an accident.
	return {
		selection: {},
		kind: 'whole',
		label: 'whole piece',
		noteCount: resolveSelection(score, {}).length
	};
}
