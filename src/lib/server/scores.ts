import { and, desc, eq, isNull, lt, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';
import { error } from '@sveltejs/kit';
import { applyOps, type Op } from '$lib/score/apply';
import { emptyScore, type Score } from '$lib/score/types';
import { coerceScore } from '$lib/score/validate';
import { db } from './db/index.js';
import { revisions, scores, type RevisionSource } from './db/schema.js';
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
	return { ...row, doc: coerceScore(row.doc, row.title) };
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
	return row;
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

	const revisionId = writeRevision(scoreId, {
		source: opts.source,
		label: opts.label,
		score: result.score,
		ops,
		diff: result.diff,
		accepted: opts.accepted ?? true,
		jobId: opts.jobId
	});

	return {
		score: result.score,
		revisionId,
		diff: result.diff,
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
	source: RevisionSource = 'import'
): CommitResult {
	loadScore(scoreId, userId);
	const clean = coerceScore(doc, doc.title);
	db.update(scores)
		.set({ doc: clean, title: clean.title, updatedAt: new Date() })
		.where(eq(scores.id, scoreId))
		.run();
	const revisionId = writeRevision(scoreId, { source, label, score: clean, accepted: true });
	return { score: clean, revisionId, diff: { added: [], removed: [], changed: [] }, log: [label], errors: [] };
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

/** Restore a past revision. Recorded as a new revision, never a rewind — the
 *  history stays append-only so an accidental undo is itself undoable. */
export function restoreRevision(scoreId: string, userId: string, revisionId: string): CommitResult {
	loadScore(scoreId, userId);
	const snapshot = snapshotOf(revisionId);
	if (!snapshot) error(404, 'That revision has no snapshot to restore');
	return replaceScore(scoreId, userId, snapshot, 'Restored an earlier version', 'user');
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
	return replaceScore(scoreId, userId, snapshot, `Rejected: ${target.label}`, 'user');
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
