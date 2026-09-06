import { measureTicks, timeSigAt } from '$lib/score/measures.js';
import { isNote } from '$lib/score/query.js';
import type { Score } from '$lib/score/types.js';
import type { Brief, Plan, PlanSection } from './types.js';

/**
 * Cutting a plan into the chunks a realization writes, one at a time.
 *
 * Pure, so the part worth trusting can be tested without a model, a database or
 * a browser — which is the bar this repo holds everywhere else.
 */

/** One call's worth of writing: a span of one section, never more. */
export interface Chunk {
	/** The score section this belongs to. */
	sectionId: string;
	/** For the progress phase list, e.g. "Chorus" or "Verse 2 of 3". */
	label: string;
	startTick: number;
	endTick: number;
	/** The plan card, for harmony and role. */
	section: PlanSection;
	/** Which slice of its section this is, when the section was split. */
	part: number;
	of: number;
}

/**
 * The chunks for a realization, in playing order.
 *
 * Boundaries come from `score.sections`, not from bar arithmetic. Approving a
 * plan already committed `set_section` with real tick spans, so the conversion
 * the epic warns about has happened once, in the place that owns it — doing it
 * again here would be two sources of truth for the same fact.
 *
 * `only` restricts the run to particular sections, which is what regenerating
 * one section and answering feedback on one both need.
 */
export function chunksFor(
	score: Score,
	plan: Plan,
	chunkBars: number,
	only?: readonly string[]
): Chunk[] {
	const wanted = only?.length ? new Set(only) : null;
	const chunks: Chunk[] = [];

	for (const card of plan.sections) {
		if (!card.sectionId) continue;
		if (wanted && !wanted.has(card.sectionId)) continue;

		const span = score.sections.find((s) => s.id === card.sectionId);
		// A card whose section was deleted in the editor has nowhere to write.
		// Silently skipping beats inventing a span and writing into a neighbour.
		if (!span || span.endTick <= span.startTick) continue;

		const slices = sliceSpan(score, span.startTick, span.endTick, chunkBars);
		for (const [i, slice] of slices.entries()) {
			chunks.push({
				sectionId: card.sectionId,
				label: slices.length > 1 ? `${card.name} ${i + 1}/${slices.length}` : card.name,
				startTick: slice.startTick,
				endTick: slice.endTick,
				section: card,
				part: i + 1,
				of: slices.length
			});
		}
	}
	return chunks;
}

/**
 * Split one section's span into chunk-sized pieces.
 *
 * Bar arithmetic survives here and nowhere else in this stage. Reading the
 * score's metre is right this time — unlike in `$lib/pipeline/plan.ts`, where
 * the same-looking walk would have been wrong because `set_time_sig` in the
 * same commit was about to change the answer. By now the metre is committed and
 * nothing in a realization touches it.
 *
 * Never spans two sections: `compose_realize`'s prompt says "Write only that
 * section", so a chunk straddling a boundary contradicts its own instruction.
 */
function sliceSpan(
	score: Score,
	startTick: number,
	endTick: number,
	chunkBars: number
): { startTick: number; endTick: number }[] {
	const bars = Math.max(1, Math.floor(chunkBars));
	const out: { startTick: number; endTick: number }[] = [];
	let tick = startTick;

	while (tick < endTick) {
		let next = tick;
		for (let i = 0; i < bars && next < endTick; i++) {
			next += Math.max(1, measureTicks(score.ppq, timeSigAt(score, next)));
		}
		// The last slice stops at the section end even mid-bar, rather than
		// overrunning into whatever comes next.
		out.push({ startTick: tick, endTick: Math.min(next, endTick) });
		tick = next;
	}
	return out.length ? out : [{ startTick, endTick }];
}

export type SectionState = 'written' | 'empty';

/** What each plan section looks like on the page right now. */
export interface SectionStatus {
	sectionId: string;
	name: string;
	startTick: number;
	endTick: number;
	bars: number;
	state: SectionState;
	noteCount: number;
}

/**
 * Read each section's state off the notes themselves.
 *
 * Nothing is recorded, so nothing can fall out of step with the document — and
 * resuming a half-finished realization needs no bookkeeping at all: the
 * sections that got written read as written, and the next run takes the rest.
 * A run that died after three of six sections leaves a score that says so.
 */
export function sectionStates(
	score: Score,
	plan: Plan,
	melodyPartId: string | null
): SectionStatus[] {
	const part = melodyPartId ? score.parts.find((p) => p.id === melodyPartId) : undefined;
	const ticks = part
		? part.voices.flatMap((v) => v.events.filter(isNote).map((e) => e.tick))
		: [];

	const out: SectionStatus[] = [];
	for (const card of plan.sections) {
		const span = card.sectionId ? score.sections.find((s) => s.id === card.sectionId) : undefined;
		if (!span) continue;

		const noteCount = ticks.filter((t) => t >= span.startTick && t < span.endTick).length;
		out.push({
			sectionId: span.id,
			name: card.name,
			startTick: span.startTick,
			endTick: span.endTick,
			bars: card.bars,
			state: noteCount > 0 ? 'written' : 'empty',
			noteCount
		});
	}
	return out;
}

/** The sections still to write, for a run that was not given explicit targets. */
export function unwrittenSections(
	score: Score,
	plan: Plan,
	melodyPartId: string | null
): string[] {
	return sectionStates(score, plan, melodyPartId)
		.filter((s) => s.state === 'empty')
		.map((s) => s.sectionId);
}

/**
 * Which part carries the tune.
 *
 * The recording when there was one — writing the melody into a different staff
 * than the one the person hummed into would be a strange thing to do — and
 * otherwise the plan's first instrument. Both are only defaults; the page
 * offers the choice, and the answer is stored on the plan.
 */
export function melodyPartOf(score: Score, plan: Plan, brief: Brief | null): string | null {
	const exists = (id: string | undefined): id is string =>
		Boolean(id) && score.parts.some((p) => p.id === id);

	if (exists(plan.melodyPartId)) return plan.melodyPartId;
	if (exists(brief?.seedPartId)) return brief!.seedPartId!;

	for (const entry of plan.ensemble) {
		if (exists(entry.partId)) return entry.partId;
	}
	return score.parts[0]?.id ?? null;
}
