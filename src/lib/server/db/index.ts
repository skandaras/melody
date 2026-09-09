import { env } from '$env/dynamic/private';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import * as schema from './schema.js';

export const dataDir = env.DATA_DIR || process.env.DATA_DIR || './data';
mkdirSync(dataDir, { recursive: true });

const sqlite = new Database(join(dataDir, 'melody.db'));

/**
 * WAL matters here because playback and autosave write while the UI reads.
 * Set defensively: a lost race against another process must not take the whole
 * app down, so we check what mode we actually ended up in and warn rather than
 * throw.
 */
try {
	sqlite.pragma('journal_mode = WAL');
} catch (err) {
	const mode = String(sqlite.pragma('journal_mode', { simple: true }) ?? '').toLowerCase();
	if (mode !== 'wal') {
		console.warn(`[db] could not switch to WAL (now: ${mode || 'unknown'}):`, err);
	}
}
sqlite.pragma('foreign_keys = ON');

export const db = drizzle(sqlite, { schema });
export { sqlite };

/**
 * Migrations ship inside the image and run on every boot.
 *
 * They must stay forward-compatible (expand-migrate-contract): a rollback to
 * the previous image has to meet a schema it can still write to. In practice
 * that means new columns are nullable or defaulted, and nothing is dropped in
 * the same release that stops using it.
 */
export function runMigrations(): void {
	migrate(db, { migrationsFolder: 'drizzle' });
}

/**
 * Subdirectories of DATA_DIR that other modules assume already exist.
 *
 * `exports` used to be here and never should have been. Nothing has ever
 * written to it: every exporter in `$lib/export` runs in the browser against
 * the document the page already holds, there is no export route, and
 * `RetentionSettings` has no field for it despite stages/6-finish.md warning
 * that exports "are subject to retention". It was a directory created for a
 * feature that was never built — the same latent intent this epic keeps finding
 * — so it goes rather than being left for someone to rediscover.
 */
export function ensureDataDirs(): void {
	for (const sub of ['recordings', 'skills']) {
		mkdirSync(join(dataDir, sub), { recursive: true });
	}
}
