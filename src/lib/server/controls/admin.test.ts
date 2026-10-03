import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { db, runMigrations } from '../db/index.js';
import { controls, styleSkills } from '../db/schema.js';
import { seedControls, seedStyleSkills } from '../bootstrap.js';
import {
	createControl,
	updateControl,
	deleteControl,
	ControlValidationError
} from './admin.js';
import { listControls } from './registry.js';
import {
	createSkill,
	writeSkill,
	readSkill,
	setSkillEnabled,
	deleteSkill,
	SkillValidationError
} from '../ai/skills-admin.js';

/**
 * Admin CRUD for controls and skills — the validation rules are the product
 * here. Controls respect the kind split (code controls have no prompt to
 * edit); skills keep the file-is-the-truth rule. Runs against the real
 * migrated schema in this worker's own DATA_DIR, with seeds for realism.
 */

beforeAll(() => {
	runMigrations();
	seedControls();
	seedStyleSkills();
});

beforeEach(() => {
	// Each test starts from the seeded state.
	db.delete(controls).run();
	db.delete(styleSkills).run();
	seedControls();
	seedStyleSkills();
});

describe('control CRUD', () => {
	it('creates a prompt control with generated sort order', () => {
		const made = createControl({
			name: 'Testify',
			category: 'Custom',
			kind: 'prompt',
			promptTemplate: 'Add {{count}} variations'
		});
		expect(made.builtin).toBe(false);
		expect(made.enabled).toBe(true);
		expect(made.promptTemplate).toBe('Add {{count}} variations');
	});

	it('refuses to create code controls — they are deploys, not data', () => {
		expect(() =>
			createControl({
				name: 'X',
				category: 'Custom',
				kind: 'code',
				promptTemplate: 'nope'
			})
		).toThrow(/deploy|cannot be created/i);
	});

	it('validates required params against the schema', () => {
		expect(() =>
			createControl({
				name: 'Strict',
				category: 'Custom',
				kind: 'prompt',
				promptTemplate: 'Do {{thing}}',
				paramsSchema: {
					type: 'object',
					required: ['thing'],
					properties: { thing: { type: 'string' } }
				},
				defaultParams: {}
			})
		).toThrow(/default value for "thing"/);
	});

	it('lets built-in prompt controls be edited but not deleted', () => {
		const seeded = db.select().from(controls).all().find((c) => c.kind === 'prompt');
		expect(seeded).toBeTruthy();
		const updated = updateControl(seeded!.id, { description: 'Updated description' });
		expect(updated.description).toBe('Updated description');

		expect(() => deleteControl(seeded!.id)).toThrow(/disabled, not deleted/i);
	});

	it('protects a code control from prompt edits', () => {
		const code = db.select().from(controls).all().find((c) => c.kind === 'code');
		expect(code).toBeTruthy();
		expect(() =>
			updateControl(code!.id, { promptTemplate: 'not allowed' })
		).toThrow(/no prompt to edit/i);
		// Display fields stay editable.
		expect(updateControl(code!.id, { name: 'Renamed' }).name).toBe('Renamed');
	});

	it('deletes a user-created control', () => {
		const made = createControl({
			name: 'Disposable',
			category: 'Custom',
			kind: 'agent',
			promptTemplate: 'Do things to {{part}}'
		});
		deleteControl(made.id);
		expect(db.select().from(controls).all().some((c) => c.id === made.id)).toBe(false);
	});
});

describe('control stages', () => {
	const byName = (name: string) =>
		db.select().from(controls).where(eq(controls.name, name)).get()!;

	it('scopes the epic\'s ten controls to the arrangement', () => {
		expect(listControls('arrangement').map((c) => c.name).sort()).toEqual(
			[
				'Add counter-melody',
				'Add genre influence',
				'Add section',
				'Enrich harmony',
				'Increase energy',
				'Modal interchange',
				'Orchestrate as…',
				'Reduce energy',
				'Reharmonise',
				'Simplify harmony'
			].sort()
		);
		expect(listControls('melody')).toHaveLength(11);
		// Humanise and Swing are reprised in refinement.
		expect(listControls('refine').map((c) => c.name)).toEqual(
			expect.arrayContaining(['Humanise', 'Swing', 'Crescendo', 'Release'])
		);
	});

	it('shows every enabled control when no stage is asked for', () => {
		expect(listControls().length).toBe(
			db.select().from(controls).all().filter((c) => c.enabled).length
		);
	});

	it('backfills rows seeded before stages existed, and only those', () => {
		db.update(controls).set({ stages: null }).where(eq(controls.name, 'Transpose')).run();
		db.update(controls).set({ stages: [] }).where(eq(controls.name, 'Darken')).run();
		db.update(controls).set({ stages: ['melody'] }).where(eq(controls.name, 'Reharmonise')).run();

		seedControls();

		expect(byName('Transpose').stages).toEqual(['melody']);
		// An admin's "everywhere" and an admin's own choice both survive.
		expect(byName('Darken').stages).toEqual([]);
		expect(byName('Reharmonise').stages).toEqual(['melody']);
	});

	it('offers a control with no stages everywhere', () => {
		db.update(controls).set({ stages: [] }).where(eq(controls.name, 'Darken')).run();
		expect(listControls('melody').some((c) => c.name === 'Darken')).toBe(true);
		expect(listControls('arrangement').some((c) => c.name === 'Darken')).toBe(true);
	});

	it('retires Compose from seed once, without overriding a later re-enable', () => {
		// As an install that predates the pipeline has it.
		db.insert(controls)
			.values({
				id: randomUUID(),
				name: 'Compose from seed',
				category: 'Form',
				kind: 'agent',
				description: '',
				promptTemplate: 'Compose',
				builtin: true,
				enabled: true,
				sortOrder: 99
			})
			.run();

		seedControls();
		expect(byName('Compose from seed').enabled).toBe(false);

		updateControl(byName('Compose from seed').id, { enabled: true });
		seedControls();
		expect(byName('Compose from seed').enabled).toBe(true);
	});

	it('stores an admin\'s stage choice, and refuses a stage that does not exist', () => {
		const id = byName('Darken').id;
		expect(updateControl(id, { stages: ['arrangement'] }).stages).toEqual(['arrangement']);
		expect(updateControl(id, { stages: [] }).stages).toEqual([]);
		expect(() => updateControl(id, { stages: ['mastering' as never] })).toThrow(/Unknown stage/);
	});

	it('records a new control as everywhere unless told otherwise', () => {
		const made = createControl({
			name: 'Anywhere',
			category: 'Custom',
			kind: 'prompt',
			promptTemplate: 'Do it'
		});
		expect(made.stages).toEqual([]);
	});
});

describe('skill CRUD', () => {
	it('writes a body and reads back the same file', () => {
		const seeded = db.select().from(styleSkills).all()[0];
		const updated = writeSkill(seeded.id, '# Heading\n\nNew body text.');
		const back = readSkill(seeded.id);
		expect(back.body).toContain('New body text.');
		expect(updated.updatedAt).toBeGreaterThanOrEqual(seeded.updatedAt.getTime());
	});

	it('refuses an empty body', () => {
		const seeded = db.select().from(styleSkills).all()[0];
		expect(() => writeSkill(seeded.id, '   \n\n  ')).toThrow(SkillValidationError);
	});

	it('toggles enabled without touching the file', () => {
		const seeded = db.select().from(styleSkills).all()[0];
		const before = readSkill(seeded.id);
		const off = setSkillEnabled(seeded.id, false);
		expect(off.enabled).toBe(false);
		const after = readSkill(seeded.id);
		expect(after.body).toBe(before.body);
	});

	it('creates a skill on disk with a heading, then deletes it cleanly', () => {
		const made = createSkill('Test Genre', 'style', 'Characteristic rhythms abound.');
		expect(made.summary.length).toBeGreaterThan(0);
		const body = readSkill(made.id).body;
		expect(body).toMatch(/^# /);

		deleteSkill(made.id);
		expect(() => readSkill(made.id)).toThrow(SkillValidationError);
	});

	it('refuses a duplicate name', () => {
		createSkill('Dup Genre', 'style', 'One.');
		expect(() => createSkill('Dup Genre', 'style', 'Two.')).toThrow(/already exists/i);
	});
});
