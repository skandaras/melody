import { and, desc, eq, isNull, lt, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';
import { error } from '@sveltejs/kit';
import { applyOps, type Op } from '$lib/score/apply';
import type { CreatedEntity } from '$lib/score/ops/types';
import {
	FIRST_STAGE,
	pipelineOf,
	type Brief,
	type PipelineState,
	type Plan,
	type Stage
} from '$lib/pipeline/types';
import { mergeParts } from '$lib/score/merge';
import { emptyScore, type Score } from '$lib/score/types';
import { coerceScore } from '$lib/score/validate';
import { db } from './db/index.js';
import { revisions, scores, type RevisionSource } from './db/schema.js';
import { deleteScoreRecordings } from './recordings.js';
import { DEFAULT_RETENTION, getSetting, type RetentionSettings } from './settings.js';

/**
 * Score persistence, revisions and undo.
 *
 * Every mutation goes through commitOps, which is what makes the undo stack
 * and the accept/reject diff universal rather than something each feature has
 * to remember to maintain.
 */

export interface ScoreRow {
	id: string;
	ownerId: string;
	title: string;
	doc: Score;
	createdAt: Date;
	updatedAt: Date;
	/** Where this score is in the pipeline. Always present, even for rows that
	 *  predate it — see pipelineOf. */
	pipeline: PipelineState;
}

/**
 * Load a score, enforcing ownership.
 *
 * Returns 404 rather than 403 for someone else's score: telling an
 * unauthorised caller that an id exists is itself a small leak, and there is
 * no legitimate flow that needs the distinction.
 */
export function loadScore(scoreId: string, userId: string): ScoreRow {
	const row = db.select().from(scores).where(eq(scores.id, scoreId)).get();
	if (!row || row.ownerId !== userId) error(404, 'Score not found');
	return { ...row, doc: coerceScore(row.doc, row.title), pipeline: pipelineOf(row) };
}

/**
 * The pipeline state as stored, without an ownership check.
 *
 * Internal: every caller has already loaded the score. Split out so a revision
 * can snapshot the state at the moment it is written without threading it
 * through every write path by hand.
 */
function currentPipeline(scoreId: string): PipelineState | null {
	const row = db
		.select({ stage: scores.stage, brief: scores.brief, plan: scores.plan })
		.from(scores)
		.where(eq(scores.id, scoreId))
		.get();
	return row ? pipelineOf(row) : null;
}

/**
 * Move a score through the pipeline.
 *
 * Separate from commitOps because a stage change is not a change to the music:
 * approving a brief writes no notes, and the operations that *do* write notes
 * should not have to know which stage asked for them.
 */
export function setPipeline(
	scoreId: string,
	userId: string,
	patch: { stage?: Stage; brief?: Brief | null; plan?: Plan | null }
): PipelineState {
	loadScore(scoreId, userId);

	const set: Record<string, unknown> = { updatedAt: new Date() };
	if (patch.stage !== undefined) set.stage = patch.stage;
	if (patch.brief !== undefined) set.brief = patch.brief;
	if (patch.plan !== undefined) set.plan = patch.plan;

	db.update(scores).set(set).where(eq(scores.id, scoreId)).run();
	return currentPipeline(scoreId) ?? pipelineOf({});
}

export function listScores(userId: string, includeArchived = false) {
	const where = includeArchived
		? eq(scores.ownerId, userId)
		: and(eq(scores.ownerId, userId), isNull(scores.archivedAt));
	return db
		.select({
			id: scores.id,
			title: scores.title,
			createdAt: scores.createdAt,
			updatedAt: scores.updatedAt,
			archivedAt: scores.archivedAt
		})
		.from(scores)
		.where(where)
		.orderBy(desc(scores.updatedAt))
		.all();
}

export function createScore(userId: string, title = 'Untitled', doc?: Score): ScoreRow {
	const now = new Date();
	const row = {
		id: randomUUID(),
		ownerId: userId,
		title,
		doc: doc ?? emptyScore(title),
		// Named explicitly rather than left to the column default: this insert
		// lists every column, so a notNull addition breaks it at the type level
		// if it is not here — which is the behaviour we want.
		stage: FIRST_STAGE,
		brief: null,
		plan: null,
		createdAt: now,
		updatedAt: now,
		archivedAt: null
	};
	db.insert(scores).values(row).run();
	writeRevision(row.id, {
		source: 'user',
		label: 'Created',
		score: row.doc,
		accepted: true
	});
	return { ...row, pipeline: pipelineOf(row) };
}

export function renameScore(scoreId: string, userId: string, title: string): void {
	loadScore(scoreId, userId);
	db.update(scores).set({ title, updatedAt: new Date() }).where(eq(scores.id, scoreId)).run();
}

export function archiveScore(scoreId: string, userId: string, archived: boolean): void {
	loadScore(scoreId, userId);
	db.update(scores)
		.set({ archivedAt: archived ? new Date() : null, updatedAt: new Date() })
		.where(eq(scores.id, scoreId))
		.run();
}

export function deleteScore(scoreId: string, userId: string): void {
	loadScore(scoreId, userId);
	db.delete(revisions).where(eq(revisions.scoreId, scoreId)).run();
	db.delete(scores).where(eq(scores.id, scoreId)).run();
	void deleteScoreRecordings(scoreId);
}

// --------------------------------------------------------------- revisions

function nextSeq(scoreId: string): number {
	const row = db
		.select({ max: sql<number>`COALESCE(MAX(${revisions.seq}), 0)` })
		.from(revisions)
		.where(eq(revisions.scoreId, scoreId))
		.get();
	return (row?.max ?? 0) + 1;
}

interface WriteRevisionArgs {
	source: RevisionSource;
	label: string;
	score: Score;
	ops?: Op[];
	diff?: { added: string[]; removed: string[]; changed: string[] };
	accepted: boolean;
	jobId?: string;
	/** Where the pipeline stood. Restoring puts this back with the document. */
	pipeline?: PipelineState;
}

function writeRevision(scoreId: string, args: WriteRevisionArgs): string {
	const id = randomUUID();
	db.insert(revisions)
		.values({
			id,
			scoreId,
			seq: nextSeq(scoreId),
			source: args.source,
			label: args.label,
			ops: args.ops ?? null,
			diff: args.diff ?? null,
			// Gzip because a score is repetitive JSON: a few hundred KB becomes
			// tens of KB, which makes storing whole snapshots cheaper than
			// maintaining inverse operations for every op in the registry.
			snapshotGz: gzipSync(Buffer.from(JSON.stringify(args.score), 'utf8')),
			// Read here rather than passed by every caller: a revision records
			// where the whole score stood, and a write path that forgot to
			// mention the pipeline would silently record the wrong thing.
			pipeline: args.pipeline ?? currentPipeline(scoreId),
			accepted: args.accepted,
			jobId: args.jobId ?? null,
			createdAt: new Date()
		})
		.run();
	pruneRevisions(scoreId);
	return id;
}

function pruneRevisions(scoreId: string): void {
	const { revisionsPerScore } = getSetting<RetentionSettings>('retention', DEFAULT_RETENTION);
	if (revisionsPerScore <= 0) return;

	const all = db
		.select({ id: revisions.id, seq: revisions.seq })
		.from(revisions)
		.where(eq(revisions.scoreId, scoreId))
		.orderBy(desc(revisions.seq))
		.all();

	if (all.length <= revisionsPerScore) return;
	const cutoff = all[revisionsPerScore].seq;
	db.delete(revisions)
		.where(and(eq(revisions.scoreId, scoreId), lt(revisions.seq, cutoff + 1)))
		.run();
}

export interface CommitResult {
	score: Score;
	revisionId: string;
	diff: { added: string[]; removed: string[]; changed: string[] };
	/**
	 * Parts and sections this commit brought into existence.
	 *
	 * Deliberately not folded into `diff`, which is persisted on the revision
	 * and shaped for the overlay: this is answering "what did I just make" for
	 * the caller that is still holding the request, not something to read back
	 * later. Approving a composition plan is the case that needs it — it emits
	 * add_part and set_section and must map the result to its own sections.
	 */
	created?: CreatedEntity[];
	log: string[];
	errors: { op: string; reason: string }[];
}

/**
 * The single write path for score content.
 *
 * `accepted: false` stages an AI change: the document is saved so the editor
 * can render it, but the previous revision remains the one to fall back to if
 * the user rejects. That is what makes review non-destructive.
 */
export function commitOps(
	scoreId: string,
	userId: string,
	ops: Op[],
	opts: { source: RevisionSource; label: string; accepted?: boolean; jobId?: string }
): CommitResult {
	const current = loadScore(scoreId, userId);
	const result = applyOps(current.doc, ops);

	db.update(scores)
		.set({ doc: result.score, title: result.score.title, updatedAt: new Date() })
		.where(eq(scores.id, scoreId))
		.run();

	// Only the three note-id arrays are persisted. `created` is an answer to
	// "what did I just make" for the caller still holding this request, and the
	// revision's diff column is typed for the overlay — storing a field the
	// schema does not declare would be invisible until it confused someone.
	const diff = {
		added: result.diff.added,
		removed: result.diff.removed,
		changed: result.diff.changed
	};

	const revisionId = writeRevision(scoreId, {
		source: opts.source,
		label: opts.label,
		score: result.score,
		ops,
		diff,
		accepted: opts.accepted ?? true,
		jobId: opts.jobId
	});

	return {
		score: result.score,
		revisionId,
		diff,
		created: result.diff.created,
		log: result.log,
		errors: result.errors
	};
}

/** Replace the document wholesale. For imports and transcription drafts. */
export function replaceScore(
	scoreId: string,
	userId: string,
	doc: Score,
	label: string,
	source: RevisionSource = 'import',
	pipeline?: PipelineState | null
): CommitResult {
	loadScore(scoreId, userId);
	const clean = coerceScore(doc, doc.title);

	const set: Record<string, unknown> = { doc: clean, title: clean.title, updatedAt: new Date() };
	// Restoring a document without the pipeline it belonged to would leave a
	// score claiming to be at a later stage than its contents support — an
	// approved plan whose parts and sections have just been undone away.
	if (pipeline) {
		set.stage = pipeline.stage;
		set.brief = pipeline.brief;
		set.plan = pipeline.plan;
	}

	db.update(scores).set(set).where(eq(scores.id, scoreId)).run();
	const revisionId = writeRevision(scoreId, { source, label, score: clean, accepted: true });
	return { score: clean, revisionId, diff: { added: [], removed: [], changed: [] }, log: [label], errors: [] };
}

/**
 * Graft a transcribed (or imported) fragment onto a score as new parts.
 *
 * Staged unaccepted, like an AI edit, so the existing review UI handles it:
 * pitch detection on a hummed melody is a draft by nature, and being able to
 * reject the whole thing in one click is more useful than deleting fifty
 * wrong notes by hand.
 */
export function mergeIntoScore(
	scoreId: string,
	userId: string,
	fragment: unknown,
	opts: { label: string; atTick?: number; adoptGlobals?: boolean } = { label: 'Transcription' }
): CommitResult {
	const current = loadScore(scoreId, userId);
	// The fragment is built in the browser, so it is untrusted input like any
	// other request body and goes through the same validator as an import.
	const incoming = coerceScore(fragment, current.title);
	const { score, addedIds, addedParts, addedPartIds } = mergeParts(current.doc, incoming, {
		atTick: opts.atTick,
		adoptGlobals: opts.adoptGlobals
	});

	db.update(scores)
		.set({ doc: score, updatedAt: new Date() })
		.where(eq(scores.id, scoreId))
		.run();

	const diff = { added: addedIds, removed: [], changed: [] };
	const revisionId = writeRevision(scoreId, {
		source: 'import',
		label: opts.label,
		score,
		diff,
		accepted: false
	});

	return {
		score,
		revisionId,
		diff,
		created: addedPartIds.map((id) => ({ kind: 'part' as const, id })),
		log: [`${opts.label}: ${addedParts} part(s), ${addedIds.length} event(s)`],
		errors: []
	};
}

export function listRevisions(scoreId: string, userId: string, limit = 60) {
	loadScore(scoreId, userId);
	return db
		.select({
			id: revisions.id,
			seq: revisions.seq,
			source: revisions.source,
			label: revisions.label,
			diff: revisions.diff,
			accepted: revisions.accepted,
			createdAt: revisions.createdAt
		})
		.from(revisions)
		.where(eq(revisions.scoreId, scoreId))
		.orderBy(desc(revisions.seq))
		.limit(limit)
		.all();
}

function snapshotOf(revisionId: string): Score | null {
	const row = db.select().from(revisions).where(eq(revisions.id, revisionId)).get();
	if (!row?.snapshotGz) return null;
	try {
		return coerceScore(JSON.parse(gunzipSync(row.snapshotGz as Buffer).toString('utf8')));
	} catch {
		return null;
	}
}

/** Where the pipeline stood at a revision, if it recorded that at all. */
function pipelineOfRevision(revisionId: string): PipelineState | null {
	const row = db
		.select({ pipeline: revisions.pipeline })
		.from(revisions)
		.where(eq(revisions.id, revisionId))
		.get();
	return row?.pipeline ?? null;
}

/** Restore a past revision. Recorded as a new revision, never a rewind — the
 *  history stays append-only so an accidental undo is itself undoable. */
export function restoreRevision(scoreId: string, userId: string, revisionId: string): CommitResult {
	loadScore(scoreId, userId);
	const snapshot = snapshotOf(revisionId);
	if (!snapshot) error(404, 'That revision has no snapshot to restore');
	return replaceScore(
		scoreId,
		userId,
		snapshot,
		'Restored an earlier version',
		'user',
		// Null for a revision written before the pipeline existed, which leaves
		// the current stage alone rather than resetting it to the first.
		pipelineOfRevision(revisionId)
	);
}

/**
 * Reject a staged AI change by restoring the revision immediately before it.
 */
export function rejectRevision(scoreId: string, userId: string, revisionId: string): CommitResult {
	loadScore(scoreId, userId);
	const target = db.select().from(revisions).where(eq(revisions.id, revisionId)).get();
	if (!target || target.scoreId !== scoreId) error(404, 'Revision not found');

	const previous = db
		.select()
		.from(revisions)
		.where(and(eq(revisions.scoreId, scoreId), lt(revisions.seq, target.seq)))
		.orderBy(desc(revisions.seq))
		.limit(1)
		.get();

	if (!previous?.snapshotGz) error(409, 'Nothing to roll back to');
	const snapshot = snapshotOf(previous.id);
	if (!snapshot) error(409, 'The previous revision has no usable snapshot');

	db.update(revisions).set({ accepted: false }).where(eq(revisions.id, revisionId)).run();
	return replaceScore(
		scoreId,
		userId,
		snapshot,
		`Rejected: ${target.label}`,
		'user',
		pipelineOfRevision(previous.id)
	);
}

export function acceptRevision(scoreId: string, userId: string, revisionId: string): void {
	loadScore(scoreId, userId);
	db.update(revisions).set({ accepted: true }).where(eq(revisions.id, revisionId)).run();
}

/** Staged-but-unreviewed AI revisions, newest first. */
export function pendingRevisions(scoreId: string, userId: string) {
	loadScore(scoreId, userId);
	return db
		.select()
		.from(revisions)
		.where(and(eq(revisions.scoreId, scoreId), eq(revisions.accepted, false)))
		.orderBy(desc(revisions.seq))
		.all();
}
