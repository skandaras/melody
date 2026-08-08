import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import * as schema from './schema.js';
import { getTableConfig } from 'drizzle-orm/sqlite-core';

/**
 * Migration journal integrity.
 *
 * Adapted from galaxy, where this test was written after a real incident: two
 * branches each generated a migration numbered 0011, git resolved the journal
 * by taking one side, and the loser's .sql sat committed and inert until a
 * "no such column" error at runtime months later. Drizzle will not catch that
 * — the journal is the only thing that decides what runs.
 */

const DRIZZLE_DIR = join(process.cwd(), 'drizzle');
const JOURNAL = join(DRIZZLE_DIR, 'meta', '_journal.json');

interface JournalEntry {
	idx: number;
	tag: string;
	when: number;
}

function readJournal(): JournalEntry[] {
	if (!existsSync(JOURNAL)) return [];
	return (JSON.parse(readFileSync(JOURNAL, 'utf8')) as { entries: JournalEntry[] }).entries ?? [];
}

function sqlFiles(): string[] {
	if (!existsSync(DRIZZLE_DIR)) return [];
	return readdirSync(DRIZZLE_DIR)
		.filter((f) => f.endsWith('.sql'))
		.sort();
}

describe('migrations', () => {
	it('has a generated migration set at all', () => {
		// If this fails, someone changed schema.ts without running db:generate,
		// and a fresh install would boot against an empty database.
		expect(sqlFiles().length, 'run `npm run db:generate`').toBeGreaterThan(0);
		expect(readJournal().length).toBeGreaterThan(0);
	});

	it('lists every .sql file on disk in the journal', () => {
		const tags = new Set(readJournal().map((e) => e.tag));
		for (const file of sqlFiles()) {
			const tag = file.replace(/\.sql$/, '');
			expect(tags.has(tag), `${file} is on disk but not in _journal.json — it will never run`).toBe(
				true
			);
		}
	});

	it('has no duplicate idx or tag in the journal', () => {
		const entries = readJournal();
		expect(new Set(entries.map((e) => e.idx)).size).toBe(entries.length);
		expect(new Set(entries.map((e) => e.tag)).size).toBe(entries.length);
	});

	it('numbers files in the same order the journal applies them', () => {
		const entries = [...readJournal()].sort((a, b) => a.idx - b.idx);
		entries.forEach((entry, i) => {
			expect(entry.tag.startsWith(String(i).padStart(4, '0')), `${entry.tag} at index ${i}`).toBe(
				true
			);
		});
	});

	it('applying the journal produces every table and column the schema declares', () => {
		const db = new Database(':memory:');
		for (const entry of [...readJournal()].sort((a, b) => a.idx - b.idx)) {
			const sql = readFileSync(join(DRIZZLE_DIR, `${entry.tag}.sql`), 'utf8');
			// Drizzle separates statements with this marker.
			for (const stmt of sql.split('--> statement-breakpoint')) {
				const trimmed = stmt.trim();
				if (trimmed) db.exec(trimmed);
			}
		}

		const tables = new Set(
			db
				.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'`)
				.all()
				.map((r) => (r as { name: string }).name)
		);

		// The first draft of this test passed while looking at zero tables.
		expect(tables.size).toBeGreaterThan(10);

		for (const value of Object.values(schema)) {
			// Const tuples and helpers live in this module too; only tables have
			// a Drizzle table config.
			let config;
			try {
				config = getTableConfig(value as never);
			} catch {
				continue;
			}
			expect(tables.has(config.name), `table ${config.name} missing after migrations`).toBe(true);

			const cols = new Set(
				db
					.prepare(`PRAGMA table_info("${config.name}")`)
					.all()
					.map((r) => (r as { name: string }).name)
			);
			for (const col of config.columns) {
				expect(cols.has(col.name), `${config.name}.${col.name} missing after migrations`).toBe(
					true
				);
			}
		}

		db.close();
	});
});
