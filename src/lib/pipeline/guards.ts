import { isNote } from '$lib/score/query.js';
import type { Score } from '$lib/score/types.js';
import { melodyPartOf } from './realize.js';
import type { PipelineState } from './types.js';

/**
 * What an operation is allowed to touch, by stage.
 *
 * The agent loop consults a guard after applying each op on trial, and a
 * refusal goes back to the model as the tool's error. The loop has no opinion
 * about what is allowed; the stages do, and they say it here. Pure, so each
 * rule can be tested by applying a real op and judging the result.
 */

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

/**
 * Keep the form as it was approved.
 *
 * Refinement changes how the piece sounds, not what it is: notes, dynamics,
 * articulation, velocity and tempo are all fair game, but the parts, the
 * sections, the metre and the key are the shape of the piece, and changing
 * them belongs to the stages that set them. Tempo is left open on purpose —
 * a ritardando into the last bar is expression, not form.
 */
export function formLock(): OpGuard {
	return (before, after) => {
		const ids = (s: Score) => s.parts.map((p) => p.id).join(',');
		if (ids(before) !== ids(after)) {
			return (
				'Refinement changes how the piece sounds, not its form, so parts cannot be added ' +
				'or removed here. Work with the parts that are already there.'
			);
		}
		const form = (s: Score) => JSON.stringify([s.sections, s.timeSigs, s.keySigs]);
		if (form(before) !== form(after)) {
			return (
				'Refinement changes how the piece sounds, not its form, so the sections, metre ' +
				'and key stay as they are. Change the notes, dynamics, articulation or tempo instead.'
			);
		}
		return null;
	};
}

/**
 * The guard for everything run against a score at its current stage.
 *
 * Read off the stage the score is at, so a control or a typed request is held
 * to the same rule as the stage's own runs, whichever endpoint it came in by.
 * Stages with no rule of their own return null.
 */
export function guardForStage(doc: Score, pipeline: PipelineState): OpGuard | null {
	switch (pipeline.stage) {
		case 'arrangement':
			return pipeline.plan ? melodyLock(doc, melodyPartOf(doc, pipeline.plan, pipeline.brief)) : null;
		case 'refine':
			return formLock();
		default:
			return null;
	}
}
