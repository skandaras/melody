import { existsSync, readFileSync } from 'node:fs';
import { eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { styleSkills } from '../db/schema.js';

/**
 * Style knowledge, attached to a prompt when it is relevant.
 *
 * A style skill is a markdown file describing an idiom's actual devices — its
 * rhythm cells, typical voicings, bass movement, instrumentation. Without one,
 * asking for "bossa nova" gets a generic impression of bossa nova; with one it
 * gets the real thing.
 *
 * They live on disk rather than in the database so that writing a new genre is
 * writing a file. The table is only an index.
 */

/** Fuzzy match, because the style arrives as free text from a user or a model. */
export function findSkill(query: string): { name: string; body: string } | null {
	const wanted = normalise(query);
	if (!wanted) return null;

	const rows = db.select().from(styleSkills).where(eq(styleSkills.enabled, true)).all();

	// Exact slug first, then a containment match either way round, so both
	// "bossa" and "Bossa Nova (Brazilian)" find `bossa-nova`.
	const exact = rows.find((r) => normalise(r.name) === wanted);
	const loose =
		exact ??
		rows.find((r) => {
			const name = normalise(r.name);
			return name.includes(wanted) || wanted.includes(name);
		});

	if (!loose || !existsSync(loose.path)) return null;
	return { name: loose.name, body: readFileSync(loose.path, 'utf8') };
}

/** Wrap a skill for inclusion in a prompt, clearly fenced from the request. */
export function skillBlock(skill: { name: string; body: string }): string {
	return [`<style_reference name="${skill.name}">`, skill.body.trim(), '</style_reference>'].join(
		'\n'
	);
}

function normalise(s: string): string {
	return s
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '');
}
