import { IdFactory, collectIds } from './ids.js';
import { getOp, OP_NAMES } from './ops/index.js';
import type { OpResult } from './ops/types.js';
import type { Score } from './types.js';

/**
 * The one place a score is ever mutated.
 *
 * Humans, deterministic controls and the model all funnel through applyOps.
 * That is what makes undo, the accept/reject diff and validation universal
 * rather than something each feature has to remember to do.
 */

export interface Op {
	op: string;
	args?: Record<string, unknown>;
}

export interface ApplyResult {
	score: Score;
	/** Merged diff across every op in the batch, for the UI overlay. */
	diff: OpResult;
	/** One line per op, for the revision log. */
	log: string[];
	/** Ops that were rejected, with why. Never throws — a bad op in a batch
	 *  shouldn't discard the good ones, and the model needs to be told. */
	errors: { op: string; reason: string }[];
}

function clone<T>(v: T): T {
	return typeof structuredClone === 'function'
		? structuredClone(v)
		: (JSON.parse(JSON.stringify(v)) as T);
}

/**
 * Apply a batch of operations to a copy of the score.
 *
 * The input score is never mutated: callers keep the original for the "reject"
 * half of accept/reject, and cloning once per batch is far cheaper than the
 * bugs from aliasing a live document into an undo stack.
 */
export function applyOps(score: Score, ops: Op[]): ApplyResult {
	const next = clone(score);
	const ids = new IdFactory(collectIds(next));
	const diff: OpResult = { added: [], removed: [], changed: [] };
	const log: string[] = [];
	const errors: { op: string; reason: string }[] = [];

	for (const entry of ops) {
		const def = getOp(entry.op);
		if (!def) {
			errors.push({
				op: entry.op,
				reason: `Unknown operation. Available: ${OP_NAMES.join(', ')}`
			});
			continue;
		}
		try {
			const r = def.apply(next, (entry.args ?? {}) as never, { ids });
			diff.added.push(...r.added);
			diff.removed.push(...r.removed);
			diff.changed.push(...r.changed);
			if (r.created?.length) (diff.created ??= []).push(...r.created);
			if (r.note) log.push(r.note);
		} catch (err) {
			errors.push({ op: entry.op, reason: err instanceof Error ? err.message : String(err) });
		}
	}

	// A note created and then deleted inside one batch is not a change the user
	// should see highlighted; collapse those before the diff reaches the UI.
	const added = new Set(diff.added);
	const removed = new Set(diff.removed);
	for (const id of [...added]) {
		if (removed.has(id)) {
			added.delete(id);
			removed.delete(id);
		}
	}
	diff.added = [...added];
	diff.removed = [...removed];
	diff.changed = [...new Set(diff.changed)].filter((id) => !added.has(id) && !removed.has(id));

	return { score: next, diff, log, errors };
}

/** Bump every part's voices back into tick order. Cheap insurance after any
 *  hand-written mutation that bypassed an op. */
export function normalise(score: Score): Score {
	for (const part of score.parts) {
		for (const voice of part.voices) {
			voice.events.sort((a, b) => a.tick - b.tick);
		}
	}
	score.tempoMap.sort((a, b) => a.tick - b.tick);
	score.timeSigs.sort((a, b) => a.tick - b.tick);
	score.keySigs.sort((a, b) => a.tick - b.tick);
	score.sections.sort((a, b) => a.startTick - b.startTick);
	return score;
}
