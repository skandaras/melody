import { gmName } from '$lib/score/instruments.js';
import { isNote } from '$lib/score/query.js';
import type { Score } from '$lib/score/types.js';
import type { Plan, PlanPart } from './types.js';

/**
 * Spreading the melody across the ensemble the plan named.
 *
 * Pure, for the same reason `realize.ts` is: the part worth trusting should be
 * testable without a model, a database or a browser.
 *
 * **The unit here is the part, where melody's was the section.** Both come from
 * the prompt that will be run, not from a preference: `compose_realize` says
 * "Write only that section", and `orchestrate` says "write one part at a time,
 * checking each stays in range". Chunking against the grain of the instruction
 * would have each call contradict its own prompt.
 *
 * Choosing the part as the unit also answers the epic's open question about
 * per-part accept and reject without any new machinery. A part is what one call
 * writes, so it is also what can be kept or thrown away — no splitting a
 * revision's diff by part at review time, and no second pending slot.
 */

/** One call's worth of arranging: one part, across the whole piece. */
export interface PartChunk {
	partId: string;
	/** For the progress phase list, e.g. "Cello". */
	label: string;
	/** The General MIDI instrument, for the range the prompt must respect. */
	instrument: string;
	/** The plan entry this part stands for, when it has one. */
	entry?: PlanPart;
	index: number;
	of: number;
}

/**
 * What a part is doing in this arrangement.
 *
 * `extra` is not a hypothetical. `Orchestrate as…` is told to call `add_part`,
 * and `Add section` can too, so a part that the plan never named can appear
 * mid-stage. Naming that case is what lets the page say so — the epic asks that
 * an ensemble change "should say so" rather than be silently absorbed.
 */
export type PartRole = 'melody' | 'accompaniment' | 'extra';
export type PartState = 'written' | 'empty';

export interface PartStatus {
	partId: string;
	name: string;
	instrument: string;
	role: PartRole;
	state: PartState;
	noteCount: number;
	isDrum: boolean;
}

/**
 * Every part in the score, with its role and whether it has been written.
 *
 * Walks `score.parts` rather than `plan.ensemble`, because the score is the
 * document and the plan is a description of it. A plan entry whose part was
 * deleted in Bench should vanish from this list; a part the plan never named
 * should appear in it. Reading the plan instead would get both backwards.
 *
 * State is counted off the notes rather than recorded, exactly as the melody
 * stage does it, so nothing can fall out of step with the document and a run
 * that died after two of five parts leaves a score that says so.
 */
export function partStates(
	score: Score,
	plan: Plan,
	melodyPartId: string | null
): PartStatus[] {
	const planned = new Set(
		plan.ensemble.map((e) => e.partId).filter((id): id is string => Boolean(id))
	);

	return score.parts.map((part) => {
		const noteCount = part.voices.reduce((n, v) => n + v.events.filter(isNote).length, 0);
		const role: PartRole =
			part.id === melodyPartId ? 'melody' : planned.has(part.id) ? 'accompaniment' : 'extra';

		return {
			partId: part.id,
			name: part.name,
			instrument: gmName(part.gmProgram),
			role,
			state: noteCount > 0 ? 'written' : 'empty',
			noteCount,
			isDrum: part.isDrum
		};
	});
}

/**
 * The chunks for an arrangement run, in ensemble order.
 *
 * Driven from `plan.ensemble` and not from the score's part list, which is the
 * one place the plan is the right source: the epic's first gotcha is that the
 * ensemble was already decided in the Plan and this stage realizes it rather
 * than inventing instruments. Ordering by the plan also means the run writes
 * parts in the order someone chose, which is usually top to bottom.
 *
 * `only` restricts the run to particular parts — what rewriting one part and
 * answering feedback on one both need.
 */
export function partChunks(
	score: Score,
	plan: Plan,
	melodyPartId: string | null,
	only?: readonly string[]
): PartChunk[] {
	const wanted = only?.length ? new Set(only) : null;
	const chunks: PartChunk[] = [];

	for (const entry of plan.ensemble) {
		if (!entry.partId) continue;
		// Never the melody. The tune was approved a stage ago, and arranging is
		// not the moment to quietly rewrite it — the epic's second open question,
		// answered by never handing a run the part in the first place.
		if (entry.partId === melodyPartId) continue;
		if (wanted && !wanted.has(entry.partId)) continue;

		// A plan entry whose part was deleted in Bench has nowhere to write.
		// Skipping beats inventing a part the plan's approval did not create.
		const part = score.parts.find((p) => p.id === entry.partId);
		if (!part) continue;

		chunks.push({
			partId: part.id,
			label: part.name,
			instrument: gmName(part.gmProgram),
			entry,
			index: chunks.length,
			of: 0
		});
	}

	// `of` is the run's denominator, so it can only be known once the list is
	// complete.
	return chunks.map((c) => ({ ...c, of: chunks.length }));
}

/**
 * The accompaniment parts still empty.
 *
 * What a run with no explicit targets writes, which makes resuming an
 * interrupted arrangement the same operation as starting one — the same
 * property the melody stage gets from counting notes per section.
 */
export function unwrittenParts(
	score: Score,
	plan: Plan,
	melodyPartId: string | null
): string[] {
	const empty = new Set(
		partStates(score, plan, melodyPartId)
			.filter((s) => s.state === 'empty')
			.map((s) => s.partId)
	);
	return partChunks(score, plan, melodyPartId)
		.filter((c) => empty.has(c.partId))
		.map((c) => c.partId);
}

/** True once any accompaniment part has notes — the test for continuing. */
export function isArranged(score: Score, plan: Plan, melodyPartId: string | null): boolean {
	return partStates(score, plan, melodyPartId).some(
		(s) => s.role === 'accompaniment' && s.state === 'written'
	);
}

/**
 * Note ids in a part, for clearing it.
 *
 * Rejecting one part's arrangement deletes its notes rather than the part
 * itself: the part is the plan's, created when the plan was approved, and only
 * the notes in it are this stage's proposal. Removing the part would edit the
 * ensemble — a plan change — and would leave "arrange what is left" with one
 * fewer instrument than the person approved.
 */
export function noteIdsIn(score: Score, partId: string): string[] {
	const part = score.parts.find((p) => p.id === partId);
	if (!part) return [];
	return part.voices.flatMap((v) => v.events.filter(isNote).map((e) => e.id));
}

/**
 * Parts that appeared during a run and were not in the plan.
 *
 * The epic asks that an `Orchestrate as…` wanting an instrument the plan did
 * not name "should say so". This is the saying: the run compares the part list
 * before and after and reports what arrived, rather than either silently
 * keeping it or throwing away work the model did.
 *
 * Not prevented, deliberately. Withholding `add_part` from the tool list is the
 * obvious alternative and is ruled out by `tools.ts`, which keeps the tool list
 * identical for every task so the cached prefix survives — the comment there is
 * explicit that scope differences belong in the prompt, not the tool list.
 */
export function addedParts(before: Score, after: Score): { id: string; name: string }[] {
	const known = new Set(before.parts.map((p) => p.id));
	return after.parts.filter((p) => !known.has(p.id)).map((p) => ({ id: p.id, name: p.name }));
}

/**
 * Whether a run changed the approved tune.
 *
 * The epic's open question is whether the melody should be locked at this
 * stage. It is not locked — no op refuses to touch it — but a run is never
 * given it as a target and every chunk's prompt says which single part it may
 * write into. That leaves one gap: a model that ignores the instruction. This
 * closes it by checking rather than trusting, which costs a note comparison and
 * turns a silent rewrite into a warning someone can act on.
 */
export function melodyChanged(
	before: Score,
	after: Score,
	melodyPartId: string | null
): boolean {
	if (!melodyPartId) return false;
	const fingerprint = (score: Score) => {
		const part = score.parts.find((p) => p.id === melodyPartId);
		if (!part) return null;
		return part.voices
			.flatMap((v) => v.events.filter(isNote))
			.map((n) => `${n.tick}:${n.dur}:${n.pitches.map((p) => p.midi).join(',')}`)
			.sort()
			.join('|');
	};
	return fingerprint(before) !== fingerprint(after);
}
