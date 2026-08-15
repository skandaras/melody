import { randomUUID } from 'node:crypto';
import { error } from '@sveltejs/kit';
import { and, asc, eq, isNull } from 'drizzle-orm';
import { describeClip } from '$lib/score/extract.js';
import { coerceScore } from '$lib/score/validate.js';
import type { Score } from '$lib/score/types.js';
import { db } from './db/index.js';
import { clips, folders } from './db/schema.js';

/**
 * The clip library.
 *
 * Every read and write is scoped to the owner, and a row belonging to someone
 * else is reported as missing rather than forbidden — the same rule as scores,
 * for the same reason: confirming that an id exists is itself a small leak.
 */

export interface ClipView {
	id: string;
	name: string;
	folderId: string | null;
	tags: string[];
	bars: number;
	keyHint: string | null;
	tempoHint: number | null;
	instrumentHint: string | null;
	summary: string;
	createdAt: number;
}

export interface FolderView {
	id: string;
	name: string;
	parentId: string | null;
	clipCount: number;
}

export function listFolders(userId: string): FolderView[] {
	const rows = db
		.select()
		.from(folders)
		.where(eq(folders.ownerId, userId))
		.orderBy(asc(folders.name))
		.all();
	const owned = db.select().from(clips).where(eq(clips.ownerId, userId)).all();

	return rows.map((f) => ({
		id: f.id,
		name: f.name,
		parentId: f.parentId,
		clipCount: owned.filter((c) => c.folderId === f.id).length
	}));
}

export function listClips(userId: string, folderId?: string | null): ClipView[] {
	const where =
		folderId === undefined
			? eq(clips.ownerId, userId)
			: folderId === null
				? and(eq(clips.ownerId, userId), isNull(clips.folderId))
				: and(eq(clips.ownerId, userId), eq(clips.folderId, folderId));

	return db
		.select()
		.from(clips)
		.where(where)
		.all()
		.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
		.map(toView);
}

function toView(row: typeof clips.$inferSelect): ClipView {
	return {
		id: row.id,
		name: row.name,
		folderId: row.folderId,
		tags: row.tags ?? [],
		bars: row.bars,
		keyHint: row.keyHint,
		tempoHint: row.tempoHint,
		instrumentHint: row.instrumentHint,
		summary: describeClip(row.fragment, row.bars),
		createdAt: row.createdAt.getTime()
	};
}

/** The whole row including the fragment. For insertion, not for listings. */
export function loadClip(id: string, userId: string) {
	const row = db.select().from(clips).where(eq(clips.id, id)).get();
	if (!row || row.ownerId !== userId) error(404, 'Clip not found');
	return { ...row, fragment: coerceScore(row.fragment, row.name) };
}

export interface SaveClipInput {
	name: string;
	fragment: Score;
	bars: number;
	folderId?: string | null;
	tags?: string[];
}

export function saveClip(userId: string, input: SaveClipInput): ClipView {
	// The fragment arrives from the browser, so it goes through the same
	// validator as an import rather than being trusted.
	const fragment = coerceScore(input.fragment, input.name);
	if (input.folderId) assertFolder(input.folderId, userId);

	const id = randomUUID();
	db.insert(clips)
		.values({
			id,
			ownerId: userId,
			folderId: input.folderId ?? null,
			name: input.name.trim() || 'Untitled clip',
			tags: input.tags?.filter((t) => t.trim()) ?? [],
			fragment,
			bars: Math.max(0, Math.round(input.bars)),
			// Denormalised so a listing does not have to parse every fragment.
			keyHint: fragment.keySigs[0] ? keyName(fragment.keySigs[0].fifths, fragment.keySigs[0].mode) : null,
			tempoHint: fragment.tempoMap[0] ? Math.round(fragment.tempoMap[0].bpm) : null,
			instrumentHint: fragment.parts[0]?.name ?? null,
			createdAt: new Date()
		})
		.run();

	return toView(db.select().from(clips).where(eq(clips.id, id)).get()!);
}

export function updateClip(
	id: string,
	userId: string,
	patch: { name?: string; folderId?: string | null; tags?: string[] }
): ClipView {
	loadClip(id, userId);
	const set: Record<string, unknown> = {};
	if (patch.name !== undefined && patch.name.trim()) set.name = patch.name.trim();
	if (patch.folderId !== undefined) {
		if (patch.folderId) assertFolder(patch.folderId, userId);
		set.folderId = patch.folderId;
	}
	if (patch.tags !== undefined) set.tags = patch.tags.filter((t) => t.trim());

	if (Object.keys(set).length) db.update(clips).set(set).where(eq(clips.id, id)).run();
	return toView(db.select().from(clips).where(eq(clips.id, id)).get()!);
}

export function deleteClip(id: string, userId: string): void {
	loadClip(id, userId);
	db.delete(clips).where(eq(clips.id, id)).run();
}

export function createFolder(userId: string, name: string, parentId?: string | null): FolderView {
	if (parentId) assertFolder(parentId, userId);
	const id = randomUUID();
	db.insert(folders)
		.values({
			id,
			ownerId: userId,
			parentId: parentId ?? null,
			name: name.trim() || 'New folder',
			createdAt: new Date()
		})
		.run();
	return { id, name: name.trim() || 'New folder', parentId: parentId ?? null, clipCount: 0 };
}

/**
 * Delete a folder, keeping its contents.
 *
 * Clips move to the root rather than being deleted with the folder. Losing a
 * saved riff because a folder was tidied away is not a trade anyone would
 * choose, and an empty-folder-only rule would just make people delete the
 * clips first.
 */
export function deleteFolder(id: string, userId: string): void {
	assertFolder(id, userId);
	db.update(clips)
		.set({ folderId: null })
		.where(and(eq(clips.ownerId, userId), eq(clips.folderId, id)))
		.run();
	db.update(folders)
		.set({ parentId: null })
		.where(and(eq(folders.ownerId, userId), eq(folders.parentId, id)))
		.run();
	db.delete(folders).where(eq(folders.id, id)).run();
}

function assertFolder(id: string, userId: string): void {
	const row = db.select().from(folders).where(eq(folders.id, id)).get();
	if (!row || row.ownerId !== userId) error(404, 'Folder not found');
}

const SHARP_KEYS = ['C', 'G', 'D', 'A', 'E', 'B', 'F#', 'C#'];
const FLAT_KEYS = ['C', 'F', 'Bb', 'Eb', 'Ab', 'Db', 'Gb', 'Cb'];
const SHARP_MINORS = ['A', 'E', 'B', 'F#', 'C#', 'G#', 'D#', 'A#'];
const FLAT_MINORS = ['A', 'D', 'G', 'C', 'F', 'Bb', 'Eb', 'Ab'];

function keyName(fifths: number, mode: 'major' | 'minor'): string {
	const i = Math.abs(fifths);
	if (i > 7) return mode === 'major' ? 'C major' : 'A minor';
	const table =
		mode === 'major' ? (fifths < 0 ? FLAT_KEYS : SHARP_KEYS) : fifths < 0 ? FLAT_MINORS : SHARP_MINORS;
	return `${table[i]} ${mode}`;
}
