import { isNote } from '$lib/score/query.js';
import type { Score } from '$lib/score/types.js';
import { melodyPartOf } from './realize.js';
import type { Brief, Plan } from './types.js';

/**
 * The arrangement stage, in the part that can be trusted without a model.
 *
 * Two kinds of thing live here. Which parts there are to write, and whether
 * each has been written — read off the document, like `sectionStates`, so no
 * recorded state can fall out of step with it. And the guards an arrangement
 * run is held to, which decide what an operation may touch.
 *
 * Pure, and shared: the server enforces the guards, and the page shows the
 * same part list the server will write.
 */

// --------------------------------------------------------------- guards

/** The diff `applyOps` reports for one operation. */
export interface OpDiff {
	added: string[];
	removed: string[];
	changed: string[];
}

/**
 * Decides whether one operation may land, given the score before and after it.
 *
 * Returns null to allow it, or a reason the model is shown as the tool's
 * error — so it is written to the model, and says what to do instead. Judged
 * on the result rather than on the op's name or arguments, the way the loop
 * already judges "matched nothing": an op added to the registry later is
 * covered without anyone remembering to list it.
 */
export type OpGuard = (before: Score, after: Score, diff: OpDiff) => string | null;

/** Every guard must allow it; the first refusal is the one reported. */
export function allOf(...guards: (OpGuard | null | undefined)[]): OpGuard {
	const active = guards.filter((g): g is OpGuard => Boolean(g));
	return (before, after, diff) => {
		for (const guard of active) {
			const reason = guard(before, after, diff);
			if (reason) return reason;
		}
		return null;
	};
}

/**
 * Keep the approved tune as it was approved.
 *
 * Protects the melody's notes as they stood when the run began: none may be
 * removed or changed. New notes in the melody part are allowed, because
 * `Add section` writing a bridge has to give the bridge a tune — the lock is
 * on what was approved, not on the staff.
 */
export function melodyLock(score: Score, melodyPartId: string | null): OpGuard | null {
	if (!melodyPartId) return null;
	const part = score.parts.find((p) => p.id === melodyPartId);
	if (!part) return null;

	const locked = new Set<string>();
	for (const voice of part.voices) {
		for (const event of voice.events) if (isNote(event)) locked.add(event.id);
	}
	if (!locked.size) return null;

	return (_before, _after, diff) => {
		const touched = [...diff.removed, ...diff.changed].filter((id) => locked.has(id));
		if (!touched.length) return null;
		return (
			`The melody in part ${melodyPartId} (${part.name}) was approved in the previous stage ` +
			`and cannot be changed here — this would have altered ${touched.length} of its notes. ` +
			`Write around it instead.`
		);
	};
}

/**
 * Hold a run to one part.
 *
 * What makes per-part review mean something: a run that writes the strings
 * leaves the bass exactly as it was, so clearing the strings afterwards undoes
 * that run and nothing else. It also refuses new parts, which is the stage
 * brief's "should not silently invent new instruments" — the ensemble was
 * decided in the plan, and wanting another instrument is a plan change.
 */
export function onlyPart(partId: string): OpGuard {
	return (before, after) => {
		const target = before.parts.find((p) => p.id === partId);
		const name = target ? `${partId} (${target.name})` : partId;

		const beforeIds = before.parts.map((p) => p.id).join(',');
		const afterIds = after.parts.map((p) => p.id).join(',');
		if (beforeIds !== afterIds) {
			return (
				`This run writes only part ${name}. The ensemble comes from the plan, so parts ` +
				`cannot be added or removed here — if the arrangement needs another instrument, ` +
				`say so in your summary instead.`
			);
		}

		for (const [i, part] of before.parts.entries()) {
			if (part.id === partId) continue;
			if (JSON.stringify(part) !== JSON.stringify(after.parts[i])) {
				return `This run writes only part ${name}. Leave part ${part.id} (${part.name}) as it is.`;
			}
		}

		const shape = (s: Score) =>
			JSON.stringify([s.title, s.tempoMap, s.timeSigs, s.keySigs, s.sections]);
		if (shape(before) !== shape(after)) {
			return (
				`This run writes only part ${name}. The title, tempo, metre, key and sections ` +
				`were settled by the plan and stay as they are.`
			);
		}
		return null;
	};
}

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
