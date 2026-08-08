import type { Score, Selection } from '../types.js';
import { IdFactory } from '../ids.js';

/**
 * The operation contract.
 *
 * Everything that mutates a score — a human dragging a note, a deterministic
 * control, or a patch emitted by Claude — goes through an OpDef. That single
 * chokepoint is what gives us validation, undo, and the accept/reject diff for
 * free, and it's why the AI can never corrupt a document: it can only ask for
 * operations that already exist and already validate their arguments.
 */

/** A minimal JSON Schema subset — enough to drive Anthropic strict tool use. */
export interface JsonSchema {
	type: 'object';
	properties: Record<string, unknown>;
	required: string[];
	additionalProperties: false;
}

export interface OpContext {
	ids: IdFactory;
}

export interface OpResult {
	/** Note ids created by this op — rendered green in the diff. */
	added: string[];
	/** Note ids deleted — rendered as red ghosts. */
	removed: string[];
	/** Note ids modified in place — rendered amber. */
	changed: string[];
	/** One line for the revision log, e.g. "Transposed 14 notes by +2". */
	note?: string;
}

export interface OpDef<A = Record<string, unknown>> {
	name: string;
	/** Shown to the model as the tool/parameter description. Be specific: this
	 *  is the single biggest lever on whether it picks the right operation. */
	summary: string;
	schema: JsonSchema;
	/** Mutates `score` in place. applyOps has already cloned it. */
	apply(score: Score, args: A, ctx: OpContext): OpResult;
}

export const emptyResult = (): OpResult => ({ added: [], removed: [], changed: [] });

/** Reusable schema fragment so every op describes selection identically. */
export const selectionSchema = {
	type: 'object',
	description:
		'What to apply to. Omit entirely for the whole score. noteIds wins over every other field when present.',
	properties: {
		noteIds: { type: 'array', items: { type: 'string' } },
		partIds: { type: 'array', items: { type: 'string' } },
		sectionIds: { type: 'array', items: { type: 'string' } },
		startTick: { type: 'integer', minimum: 0 },
		endTick: { type: 'integer', minimum: 0 }
	},
	additionalProperties: false
} as const;

export interface SelectionArgs {
	selection?: Selection;
}

/** Keep a voice's events ordered; renderers and exporters both assume it. */
export function sortVoice(events: { tick: number }[]): void {
	events.sort((a, b) => a.tick - b.tick);
}

export function clampMidi(n: number): number {
	return Math.max(0, Math.min(127, Math.round(n)));
}

export function clampVel(n: number): number {
	return Math.max(1, Math.min(127, Math.round(n)));
}
