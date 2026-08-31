import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync } from 'node:fs';
import { unlink } from 'node:fs/promises';
import { eq } from 'drizzle-orm';
import { db, runMigrations, ensureDataDirs } from './db/index.js';
import { recordings } from './db/schema.js';
import { DEFAULT_RETENTION, setSetting } from './settings.js';
import {
	saveRecording,
	loadRecording,
	deleteRecording,
	deleteScoreRecordings,
	sweepRecordings,
	MAX_RECORDING_BYTES
} from './recordings.js';

/**
 * Recordings are the retention story's exception: the one place the server
 * willingly stores audio, and only because a user asked. These tests check
 * that the promise runs both ways — files land when kept, and nothing
 * outlives the setting or the score it belongs to.
 */

beforeAll(() => {
	runMigrations();
	ensureDataDirs();
});

afterAll(async () => {
	for (const row of db.select().from(recordings).all()) {
		await unlink(row.path).catch(() => {});
	}
	db.delete(recordings).run();
});

function take(name = 'take.webm', mime = 'audio/webm'): File {
	return new File([new Uint8Array([1, 2, 3, 4]).buffer], name, { type: mime });
}

describe('saveRecording', () => {
	it('keeps the bytes and names the file by MIME', async () => {
		setSetting('retention', { ...DEFAULT_RETENTION, keepRecordings: true });
		const saved = await saveRecording({ userId: 'u1', scoreId: 's1', file: take() });
		expect(saved.kept).toBe(true);
		expect(saved.mime).toBe('audio/webm');
		expect(saved.size).toBe(4);

		const loaded = await loadRecording(saved.id, 'u1');
		expect(loaded).not.toBeNull();
		expect(loaded!.row.path.endsWith('.webm')).toBe(true);
		expect([...loaded!.bytes]).toEqual([1, 2, 3, 4]);
	});

	it('maps known audio types to extensions and unknown ones to .bin', async () => {
		const flac = await saveRecording({ userId: 'u1', scoreId: 's1', file: take('x', 'audio/flac') });
		expect((await loadRecording(flac.id, 'u1'))!.row.path.endsWith('.flac')).toBe(true);

		const odd = await saveRecording({ userId: 'u1', scoreId: 's1', file: take('y', 'audio/x-custom') });
		expect((await loadRecording(odd.id, 'u1'))!.row.path.endsWith('.bin')).toBe(true);
	});

	it('refuses non-audio and oversized uploads', async () => {
		const text = new File([new Uint8Array([65]).buffer], 'notes.txt', { type: 'text/plain' });
		await expect(saveRecording({ userId: 'u1', scoreId: 's1', file: text })).rejects.toThrow('audio');

		const big = { type: 'audio/wav', size: MAX_RECORDING_BYTES + 1, name: 'big.wav' } as unknown as File;
		await expect(saveRecording({ userId: 'u1', scoreId: 's1', file: big })).rejects.toThrow('MB');
	});

	it('is scoped to its owner', async () => {
		const saved = await saveRecording({ userId: 'u1', scoreId: 's1', file: take() });
		expect(await loadRecording(saved.id, 'u2')).toBeNull();

		// Deleting as the wrong owner is a no-op, not an error leak.
		await deleteRecording(saved.id, 'u2');
		expect(await loadRecording(saved.id, 'u1')).not.toBeNull();
	});
});

describe('sweepRecordings', () => {
	it('deletes orphaned courtesy copies once keepRecordings is off', async () => {
		setSetting('retention', { ...DEFAULT_RETENTION, keepRecordings: false });
		const saved = await saveRecording({ userId: 'u1', scoreId: 's1', file: take() });

		// A tab that closed before the client could tidy up.
		db.update(recordings)
			.set({ createdAt: new Date(Date.now() - 2 * 86_400_000) })
			.where(eq(recordings.id, saved.id))
			.run();

		expect(await sweepRecordings()).toBe(1);
		expect(await loadRecording(saved.id, 'u1')).toBeNull();
	});

	it('leaves everything alone while keepRecordings is on', async () => {
		setSetting('retention', { ...DEFAULT_RETENTION, keepRecordings: true });
		const saved = await saveRecording({ userId: 'u1', scoreId: 's1', file: take() });
		expect(await sweepRecordings()).toBe(0);
		expect(await loadRecording(saved.id, 'u1')).not.toBeNull();
	});
});

describe('deletion', () => {
	it('deleteRecording removes the bytes too', async () => {
		const saved = await saveRecording({ userId: 'u1', scoreId: 's1', file: take() });
		const path = (await loadRecording(saved.id, 'u1'))!.row.path;

		await deleteRecording(saved.id, 'u1');
		expect(existsSync(path)).toBe(false);
		expect(await loadRecording(saved.id, 'u1')).toBeNull();
	});

	it('deleting a score never leaves audio behind it', async () => {
		setSetting('retention', { ...DEFAULT_RETENTION, keepRecordings: true });
		const a = await saveRecording({ userId: 'u1', scoreId: 's1', file: take() });
		const b = await saveRecording({ userId: 'u1', scoreId: 's2', file: take() });
		const pathA = (await loadRecording(a.id, 'u1'))!.row.path;

		await deleteScoreRecordings('s1');
		expect(existsSync(pathA)).toBe(false);
		expect(await loadRecording(a.id, 'u1')).toBeNull();
		expect(await loadRecording(b.id, 'u1')).not.toBeNull();
	});
});
