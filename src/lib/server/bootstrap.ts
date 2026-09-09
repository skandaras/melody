import { randomUUID } from 'node:crypto';
import { mkdirSync, readdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { and, eq, isNull } from 'drizzle-orm';
import { db, dataDir } from './db/index.js';
import {
	CORE_TASKS,
	controls,
	styleSkills,
	taskConfigs,
	type CoreTask,
	type TaskOptions
} from './db/schema.js';
import { BUILTIN_CONTROLS } from './controls/builtin.js';
import { DEFAULT_PROMPTS } from './ai/prompts.js';
import { SEED_SKILLS } from './controls/seed-skills.js';

/**
 * First-boot seeding. Every function here is idempotent and insert-if-absent:
 * an upgrade must never overwrite a prompt or control the user has edited.
 */

/**
 * Starting effort per task, matched to how much thinking the job is worth.
 *
 * Naming a title or reading back an analysis is close to lookup work and gets
 * nothing from deep reasoning; orchestration and composition are exactly where
 * it pays. These are only defaults — every one is editable in the admin panel,
 * and the right values are workload-specific enough that they should be tuned
 * against real use rather than guessed once.
 */
const TASK_EFFORT: Record<CoreTask, TaskOptions> = {
	title: { effort: 'minimal', reasoning: 'off', maxTokens: 200 },
	analyse: { effort: 'low', reasoning: 'hidden' },
	transcribe_cleanup: { effort: 'medium', reasoning: 'hidden' },
	control_prompt: { effort: 'medium', reasoning: 'hidden' },
	// Medium rather than high: this is the Ask box, where most requests are a
	// bar or two and the wait is felt directly. Raise it per task in Admin when
	// a job deserves more thought.
	edit_selection: { effort: 'medium', reasoning: 'hidden' },
	compose_plan: { effort: 'high', reasoning: 'hidden' },
	compose_realize: { effort: 'high', reasoning: 'hidden' },
	orchestrate: { effort: 'high', reasoning: 'hidden' }
};

export function seedTaskConfigs(): void {
	const existing = new Set(
		db.select({ task: taskConfigs.task }).from(taskConfigs).all().map((r) => r.task)
	);
	for (const task of CORE_TASKS) {
		if (existing.has(task)) continue;
		db.insert(taskConfigs)
			.values({
				task,
				systemPrompt: DEFAULT_PROMPTS[task as CoreTask] ?? '',
				options: TASK_EFFORT[task] ?? { effort: 'medium', reasoning: 'hidden' }
			})
			.run();
	}
}

export function seedControls(): void {
	const existing = new Set(db.select({ name: controls.name }).from(controls).all().map((r) => r.name));
	for (const [i, c] of BUILTIN_CONTROLS.entries()) {
		if (existing.has(c.name)) continue;
		db.insert(controls)
			.values({
				id: randomUUID(),
				name: c.name,
				category: c.category,
				kind: c.kind,
				icon: c.icon,
				description: c.description,
				opName: c.opName ?? null,
				promptTemplate: c.promptTemplate ?? null,
				systemPrompt: c.systemPrompt ?? null,
				paramsSchema: c.paramsSchema ?? null,
				defaultParams: c.defaultParams ?? null,
				stages: c.stages,
				builtin: true,
				enabled: true,
				sortOrder: i
			})
			.run();
	}
	backfillControlStages();
}

/**
 * Give the built-in rows of an existing install the stage list they were
 * seeded before this column existed.
 *
 * Needed because `seedControls` is insert-if-absent by name: every one of the
 * 29 built-ins is already present in any install that has booted once, so the
 * loop above skips all of them and their `stages` stays null — which reads as
 * "every stage" and would put all 29 on every stage page, the exact thing
 * scoping exists to prevent.
 *
 * Narrow on purpose, and idempotent for the same reason the seed is. Only
 * built-in rows, and only those still null: an admin who has scoped a control
 * by hand — including to `[]`, which is not null — keeps their answer, and a
 * second boot finds nothing left to do.
 */
function backfillControlStages(): void {
	const byName = new Map(BUILTIN_CONTROLS.map((c) => [c.name, c.stages]));

	const stale = db
		.select({ id: controls.id, name: controls.name })
		.from(controls)
		.where(and(eq(controls.builtin, true), isNull(controls.stages)))
		.all();

	for (const row of stale) {
		const stages = byName.get(row.name);
		// A built-in row whose name is no longer in the list was renamed in the
		// admin panel. Leaving it null keeps it everywhere, which is where it is
		// today — a guess at what it used to be would be worse.
		if (!stages) continue;
		db.update(controls).set({ stages }).where(eq(controls.id, row.id)).run();
	}
}

/**
 * Style knowledge lives as markdown on disk so a new genre is a file, not a
 * deploy. The DB row is only an index — the body is read at prompt time.
 */
export function seedStyleSkills(): void {
	const root = join(dataDir, 'skills');
	mkdirSync(root, { recursive: true });

	for (const skill of SEED_SKILLS) {
		const dir = join(root, skill.category, skill.name);
		const file = join(dir, 'SKILL.md');
		if (!existsSync(file)) {
			mkdirSync(dir, { recursive: true });
			writeFileSync(file, skill.body, 'utf8');
		}
	}
	reindexStyleSkills();
}

/** Rescan the skills directory into the index. Safe to call at any time. */
export function reindexStyleSkills(): void {
	const root = join(dataDir, 'skills');
	if (!existsSync(root)) return;

	const found: { name: string; category: string; path: string; summary: string }[] = [];
	for (const category of readdirSync(root, { withFileTypes: true })) {
		if (!category.isDirectory()) continue;
		const catDir = join(root, category.name);
		for (const entry of readdirSync(catDir, { withFileTypes: true })) {
			if (!entry.isDirectory()) continue;
			const path = join(catDir, entry.name, 'SKILL.md');
			if (!existsSync(path)) continue;
			const body = readFileSync(path, 'utf8');
			found.push({
				name: entry.name,
				category: category.name,
				path,
				summary: firstLine(body)
			});
		}
	}

	const now = new Date();
	const existing = db.select().from(styleSkills).all();
	const byPath = new Map(existing.map((s) => [s.path, s]));

	for (const s of found) {
		const row = byPath.get(s.path);
		if (row) {
			// Summary is derived from the file, so refresh it — but leave the
			// enabled flag alone, since that's a user decision.
			if (row.summary !== s.summary) {
				db.update(styleSkills)
					.set({ summary: s.summary, updatedAt: now })
					.where(eq(styleSkills.id, row.id))
					.run();
			}
			byPath.delete(s.path);
		} else {
			db.insert(styleSkills)
				.values({ id: randomUUID(), ...s, enabled: true, updatedAt: now })
				.run();
		}
	}

	// Rows whose file has gone are stale index entries, not user data.
	for (const orphan of byPath.values()) {
		db.delete(styleSkills).where(eq(styleSkills.id, orphan.id)).run();
	}
}

/** The `> summary` line, or the first prose line, from a SKILL.md. */
function firstLine(body: string): string {
	for (const raw of body.split('\n')) {
		const line = raw.trim();
		if (!line || line.startsWith('#')) continue;
		return line.replace(/^>\s*/, '').slice(0, 300);
	}
	return '';
}
