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

/** Subdirectories of DATA_DIR that other modules assume already exist. */
export function ensureDataDirs(): void {
	for (const sub of ['recordings', 'skills', 'exports']) {
		mkdirSync(join(dataDir, sub), { recursive: true });
	}
}
