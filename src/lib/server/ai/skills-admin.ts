import { mkdirSync, readdirSync, existsSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join, relative } from 'node:path';
import { eq } from 'drizzle-orm';
import { db, dataDir } from '../db/index.js';
import { styleSkills } from '../db/schema.js';
import { reindexStyleSkills } from '../bootstrap.js';

/**
 * Admin CRUD for style skills.
 *
 * The rule this module exists to keep: the file is the truth, the row is the
 * index. Writing a skill's body writes the file and lets the reindex refresh
 * the summary; enabling is the one thing that lives only in the database,
 * because it is a decision about the file, not part of it.
 */

export class SkillValidationError extends Error {}

const SKILLS_ROOT = () => join(dataDir, 'skills');

export interface AdminSkillView {
	id: string;
	name: string;
	category: string;
	summary: string;
	enabled: boolean;
	updatedAt: number;
}

export function listAdminSkills(): AdminSkillView[] {
	return db
		.select()
		.from(styleSkills)
		.all()
		.map((s) => ({
			id: s.id,
			name: s.name,
			category: s.category,
			summary: s.summary,
			enabled: s.enabled,
			updatedAt: s.updatedAt.getTime()
		}))
		.sort((a, b) => a.category.localeCompare(b.category) || a.name.localeCompare(b.name));
}

function rowOf(id: string) {
	const row = db.select().from(styleSkills).where(eq(styleSkills.id, id)).get();
	if (!row) throw new SkillValidationError('Skill not found.');
	return row;
}

/** Paths must stay under the skills root — the row is data, not trusted. */
function safePath(row: { path: string }): string {
	const root = SKILLS_ROOT();
	const rel = relative(root, row.path);
	if (rel.startsWith('..') || !row.path.endsWith('SKILL.md')) {
		throw new SkillValidationError('That skill has an invalid path.');
	}
	return join(root, rel);
}

export function readSkill(id: string): AdminSkillView & { body: string } {
	const row = rowOf(id);
	const path = safePath(row);
	const body = existsSync(path) ? readFileSync(path, 'utf8') : '';
	return { id: row.id, name: row.name, category: row.category, summary: row.summary, enabled: row.enabled, updatedAt: row.updatedAt.getTime(), body };
}

export function writeSkill(id: string, body: string): AdminSkillView {
	const row = rowOf(id);
	const text = body.replace(/\r\n/g, '\n');
	if (!text.trim()) throw new SkillValidationError('A skill needs some content.');
	if (text.length > 200_000) throw new SkillValidationError('That skill is too large.');
	writeFileSync(safePath(row), text, 'utf8');
	// The reindex refreshes summary/updatedAt from the file, which keeps the
	// "file is the truth" rule honest even if another writer touched it.
	reindexStyleSkills();
	const updated = db.select().from(styleSkills).where(eq(styleSkills.id, id)).get();
	return {
		id: updated!.id,
		name: updated!.name,
		category: updated!.category,
		summary: updated!.summary,
		enabled: updated!.enabled,
		updatedAt: updated!.updatedAt.getTime()
	};
}

export function setSkillEnabled(id: string, enabled: boolean): AdminSkillView {
	rowOf(id);
	db.update(styleSkills).set({ enabled }).where(eq(styleSkills.id, id)).run();
	const updated = db.select().from(styleSkills).where(eq(styleSkills.id, id)).get();
	return {
		id: updated!.id,
		name: updated!.name,
		category: updated!.category,
		summary: updated!.summary,
		enabled: updated!.enabled,
		updatedAt: updated!.updatedAt.getTime()
	};
}

/** Slug for directory names — the same normalisation findSkill matches on. */
function slug(s: string): string {
	return s
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '')
		.slice(0, 60);
}

export function createSkill(name: string, category: string, body: string): AdminSkillView {
	const dirName = slug(name);
	const catName = slug(category) || 'style';
	if (!dirName) throw new SkillValidationError('Give the skill a name.');

	const text = body.replace(/\r\n/g, '\n').trim();
	if (!text) throw new SkillValidationError('A skill needs some content.');

	const dir = join(SKILLS_ROOT(), catName, dirName);
	const file = join(dir, 'SKILL.md');
	if (existsSync(file)) throw new SkillValidationError('A skill with that name already exists.');

	mkdirSync(dir, { recursive: true });
	// A new skill starts with a heading so the file is self-describing.
	writeFileSync(file, text.startsWith('#') ? text + '\n' : `# ${name.trim() || dirName}\n\n${text}\n`, 'utf8');
	reindexStyleSkills();

	const created = db.select().from(styleSkills).where(eq(styleSkills.path, file)).get();
	if (!created) throw new SkillValidationError('The skill was written but could not be indexed.');
	return {
		id: created.id,
		name: created.name,
		category: created.category,
		summary: created.summary,
		enabled: created.enabled,
		updatedAt: created.updatedAt.getTime()
	};
}

/** Removes the file and its directory, then reindexes the row away. */
export function deleteSkill(id: string): void {
	const row = rowOf(id);
	const path = safePath(row);
	const dir = join(path, '..');
	rmSync(path, { force: true });
	try {
		// The skill's directory holds only SKILL.md, but tolerate strays
		// rather than failing the delete over them.
		if (readdirSync(dir).length === 0) rmSync(dir);
	} catch {
		/* leave a non-empty directory alone */
	}
	reindexStyleSkills();
}
