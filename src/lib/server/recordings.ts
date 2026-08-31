import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { readFile, unlink, writeFile } from 'node:fs/promises';
import { and, desc, eq } from 'drizzle-orm';
import { db, dataDir } from './db/index.js';
import { recordings } from './db/schema.js';
import { getSetting, DEFAULT_RETENTION, type RetentionSettings } from './settings.js';

/**
 * Source audio, kept only by explicit choice.
 *
 * The transcription design keeps the heavy work in the browser: what normally
 * reaches the server is the finished note fragment, and no bytes of audio ever
 * land on disk. The one thing that design loses is the take itself — "what did
 * I actually hum?" — so a user who wants the recording kept can upload it
 * alongside the transcription, and `keepRecordings` decides how long it stays.
 * When the setting is off, the upload is a courtesy copy that the client
 * deletes after the transcription lands; this sweep is what catches the ones
 * whose browser died first.
 */

/** Under the 64M reverse-proxy body limit, with headroom for the multipart
 *  envelope. At MediaRecorder's default opus bitrate that is ~45 minutes. */
export const MAX_RECORDING_BYTES = 60 * 1024 * 1024;

const EXTENSIONS: Record<string, string> = {
	'audio/webm': '.webm',
	'audio/ogg': '.ogg',
	'audio/wav': '.wav',
	'audio/x-wav': '.wav',
	'audio/mpeg': '.mp3',
	'audio/mp4': '.m4a',
	'audio/x-m4a': '.m4a',
	'audio/flac': '.flac',
	'audio/x-flac': '.flac'
};

export function recordingsPath(fileName: string): string {
	return join(dataDir, 'recordings', fileName);
}

export function retention(): RetentionSettings {
	return getSetting('retention', DEFAULT_RETENTION);
}

export async function saveRecording(opts: {
	userId: string;
	scoreId: string;
	file: File;
	durationMs?: number | null;
}): Promise<{ id: string; name: string; mime: string; size: number; kept: boolean }> {
	const mime = (opts.file.type || '').split(';')[0].trim();
	if (!mime.startsWith('audio/')) {
		throw new Error('Only audio uploads are accepted');
	}
	if (opts.file.size <= 0 || opts.file.size > MAX_RECORDING_BYTES) {
		throw new Error(`Recording must be between 1 byte and ${Math.floor(MAX_RECORDING_BYTES / (1024 * 1024))} MB`);
	}

	const id = randomUUID();
	const fileName = id + (EXTENSIONS[mime] ?? '.bin');
	const path = recordingsPath(fileName);
	await writeFile(path, Buffer.from(await opts.file.arrayBuffer()));

	try {
		db.insert(recordings)
			.values({
				id,
				ownerId: opts.userId,
				scoreId: opts.scoreId,
				name: opts.file.name || 'Recording',
				mime,
				size: opts.file.size,
				path,
				durationMs: opts.durationMs ?? null,
				createdAt: new Date()
			})
			.run();
	} catch (err) {
		await unlink(path).catch(() => {});
		throw err;
	}

	return {
		id,
		name: opts.file.name || 'Recording',
		mime,
		size: opts.file.size,
		kept: retention().keepRecordings
	};
}

export function listRecordings(userId: string, scoreId?: string) {
	const where = scoreId
		? and(eq(recordings.ownerId, userId), eq(recordings.scoreId, scoreId))
		: eq(recordings.ownerId, userId);
	return db.select().from(recordings).where(where).orderBy(desc(recordings.createdAt)).all();
}

/** The row and its bytes, or null when the file has already been swept away. */
export async function loadRecording(
	id: string,
	userId: string
): Promise<{ row: typeof recordings.$inferSelect; bytes: Buffer } | null> {
	const row = db
		.select()
		.from(recordings)
		.where(and(eq(recordings.id, id), eq(recordings.ownerId, userId)))
		.get();
	if (!row) return null;
	try {
		return { row, bytes: await readFile(row.path) };
	} catch {
		return null;
	}
}

export async function deleteRecording(id: string, userId: string): Promise<void> {
	const row = db
		.select({ path: recordings.path })
		.from(recordings)
		.where(and(eq(recordings.id, id), eq(recordings.ownerId, userId)))
		.get();
	if (!row) return;
	await unlink(row.path).catch(() => {});
	db.delete(recordings).where(eq(recordings.id, id)).run();
}

/** Every recording tied to a score — called when the score itself is deleted,
 *  so audio cannot outlive the music it belongs to. */
export async function deleteScoreRecordings(scoreId: string): Promise<void> {
	const rows = db
		.select({ path: recordings.path })
		.from(recordings)
		.where(eq(recordings.scoreId, scoreId))
		.all();
	await Promise.all(rows.map((r) => unlink(r.path).catch(() => {})));
	db.delete(recordings).where(eq(recordings.scoreId, scoreId)).run();
}

/**
 * The keepRecordings enforcement half.
 *
 * A recording uploaded while the setting is off is expected to be deleted by
 * the client once its transcription is accepted; anything still here after a
 * day was orphaned by a closed tab, so the sweep takes it. When the setting is
 * on, recordings stay until their score is deleted — disk is the operator's
 * explicit choice at that point.
 */
export async function sweepRecordings(
	r: RetentionSettings = retention()
): Promise<number> {
	if (r.keepRecordings) return 0;
	const cutoff = Date.now() - 86_400_000;
	// The table is small by construction — an upload only lands here when a
	// user asked for it — so filter in the mapped rows rather than fighting
	// Drizzle's timestamp_ms Date mapping with raw epoch SQL.
	const stale = db
		.select({ id: recordings.id, path: recordings.path, createdAt: recordings.createdAt })
		.from(recordings)
		.all()
		.filter((row) => row.createdAt.getTime() < cutoff);

	let deleted = 0;
	for (const row of stale) {
		await unlink(row.path).catch(() => {});
		db.delete(recordings).where(eq(recordings.id, row.id)).run();
		deleted++;
	}
	return deleted;
}
