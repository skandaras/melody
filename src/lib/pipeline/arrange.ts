import type { Op } from '$lib/score/apply.js';
import { measureTicks, timeSigAt } from '$lib/score/measures.js';
import { isNote } from '$lib/score/query.js';
import type { Score } from '$lib/score/types.js';
import { melodyPartOf } from './realize.js';
import type { Brief, Plan, PlanSection } from './types.js';

/**
 * The arrangement stage, in the part that can be trusted without a model.
 *
 * Which parts there are to write, and whether each has been written — read off
 * the document, like `sectionStates`, so no recorded state can fall out of step
 * with it. What a run may touch while writing them is in `guards.ts`.
 *
 * Pure, and shared: the server writes the parts, and the page shows the same
 * part list the server will write.
 */

// --------------------------------------------------------------- parts

export type PartState = 'written' | 'empty';

export interface PartStatus {
	partId: string;
	name: string;
	/** The plan's instrument name, for the label. */
	instrument: string;
	state: PartState;
	noteCount: number;
}

/**
 * The parts this stage writes, in the plan's order.
 *
 * The plan's ensemble, minus the tune and minus the hummed seed: the first is
 * what the arrangement is built around, and the second is a recording of
 * what someone sang, not a part to be composed. An entry whose part no longer
 * exists — deleted in Bench — has nowhere to be written and is left out
 * rather than resurrected.
 */
export function accompanimentParts(score: Score, plan: Plan, brief: Brief | null): PartStatus[] {
	const melody = melodyPartOf(score, plan, brief);
	const seed = brief?.seedPartId;
	const seen = new Set<string>();
	const out: PartStatus[] = [];

	for (const entry of plan.ensemble) {
		const id = entry.partId;
		if (!id || id === melody || id === seed || seen.has(id)) continue;
		const part = score.parts.find((p) => p.id === id);
		if (!part) continue;
		seen.add(id);

		const noteCount = countNotes(score, id);
		out.push({
			partId: id,
			name: part.name,
			instrument: entry.instrument,
			state: noteCount > 0 ? 'written' : 'empty',
			noteCount
		});
	}
	return out;
}

/** Parts still to write, which is what "write what is left" means. */
export function unwrittenParts(score: Score, plan: Plan, brief: Brief | null): string[] {
	return accompanimentParts(score, plan, brief)
		.filter((p) => p.state === 'empty')
		.map((p) => p.partId);
}

/** Notes, not events: a part holding only rests has not been written. */
export function countNotes(score: Score, partId: string): number {
	const part = score.parts.find((p) => p.id === partId);
	if (!part) return 0;
	let n = 0;
	for (const voice of part.voices) for (const e of voice.events) if (isNote(e)) n++;
	return n;
}

/**
 * Empty a part of its notes, as operations.
 *
 * This is per-part reject. Each arrangement run is held to one part, so
 * clearing a part undoes that run's work and touches nothing else. It is also
 * how a rewrite starts: the server clears the part itself rather than asking
 * the model to remember replace_range, because insert_notes into a part that
 * still has notes lays the new line over the old one and sounds like both.
 */
export function clearPartOps(score: Score, partId: string): Op[] {
	const part = score.parts.find((p) => p.id === partId);
	if (!part) return [];
	const noteIds: string[] = [];
	for (const voice of part.voices) {
		for (const e of voice.events) if (isNote(e)) noteIds.push(e.id);
	}
	return noteIds.length ? [{ op: 'delete_notes', args: { noteIds } }] : [];
}

// --------------------------------------------------------------- form

/**
 * Give the plan a card for every section the score has gained since approval.
 *
 * `Add section` lives at this stage — wanting a bridge usually only becomes
 * obvious once the thing can be heard — but the form is the plan's, and a
 * section the plan does not know about is invisible to everything that reads
 * the plan: the melody stage's section list, and the next approval, which
 * would lay the form out without it. So the plan is told.
 *
 * Cards go in by tick, before the first card whose section starts later. Bars
 * come from the committed metre, which is correct here for the reason
 * `sliceSpan` gives in realize.ts: by now the metre is settled, unlike at plan
 * approval. Returns the same plan object when there is nothing to add, so a
 * caller can tell whether anything needs saving.
 */
export function syncPlanSections(plan: Plan, score: Score): Plan {
	const known = new Set(plan.sections.map((c) => c.sectionId).filter(Boolean));
	const fresh = score.sections.filter((s) => !known.has(s.id) && s.endTick > s.startTick);
	if (!fresh.length) return plan;

	const startOf = (card: PlanSection) =>
		score.sections.find((s) => s.id === card.sectionId)?.startTick ?? null;

	const cards = [...plan.sections];
	for (const section of [...fresh].sort((a, b) => a.startTick - b.startTick)) {
		const bar = measureTicks(score.ppq, timeSigAt(score, section.startTick));
		const card: PlanSection = {
			name: section.name,
			bars: Math.max(1, Math.round((section.endTick - section.startTick) / bar)),
			harmony: '',
			role: 'added while arranging',
			sectionId: section.id
		};
		const at = cards.findIndex((c) => {
			const start = startOf(c);
			return start !== null && start > section.startTick;
		});
		if (at < 0) cards.push(card);
		else cards.splice(at, 0, card);
	}
	return { ...plan, sections: cards };
}
