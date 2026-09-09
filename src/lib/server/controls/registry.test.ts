import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { db, runMigrations } from '../db/index.js';
import { controls } from '../db/schema.js';
import { seedControls } from '../bootstrap.js';
import { BUILTIN_CONTROLS } from './builtin.js';
import { listControls, offeredAt } from './registry.js';
import { updateControl } from './admin.js';

/**
 * Scoping the rack to a stage.
 *
 * The epic's argument is that the 29 controls are not reduced but assigned:
 * all of them in one rack is meaningless at any given moment, and a short
 * relevant list is the whole point. The mapping is data rather than a
 * `CATEGORY_TO_STAGE` map in the client, so this suite is about the data
 * behaving — including on an install that was seeded before the column existed,
 * which is every existing install.
 */

beforeAll(() => {
	runMigrations();
});

beforeEach(() => {
	db.delete(controls).run();
	seedControls();
});

const namesAt = (stage: Parameters<typeof listControls>[0]) =>
	listControls(stage).map((c) => c.name);

describe('listControls', () => {
	it('gives the editor everything, as it always has', () => {
		expect(listControls()).toHaveLength(BUILTIN_CONTROLS.length);
	});

	it('gives the melody stage its eleven', () => {
		const names = namesAt('melody');
		expect(names).toHaveLength(11);
		// Nine of the eleven are code-tier: the stage people iterate on most is
		// almost entirely free and needs no API key.
		expect(listControls('melody').filter((c) => c.free)).toHaveLength(9);
		expect(names).toContain('Transpose');
		expect(names).toContain('Extend');
	});

	it('gives the arrangement stage its ten', () => {
		const names = namesAt('arrangement');
		expect(names).toHaveLength(10);
		expect(names).toEqual(
			expect.arrayContaining([
				'Orchestrate as…',
				'Add section',
				'Enrich harmony',
				'Simplify harmony',
				'Reharmonise',
				'Modal interchange',
				'Add counter-melody',
				'Add genre influence',
				'Increase energy',
				'Reduce energy'
			])
		);
	});

	it('gives refinement seven of its own plus two reprised', () => {
		const names = namesAt('refine');
		expect(names).toHaveLength(9);
		expect(names).toContain('Crescendo');
		// Humanise and Swing appear in two stages, which is why `stages` is a
		// list rather than a single column.
		expect(names).toContain('Humanise');
		expect(namesAt('melody')).toContain('Humanise');
	});

	it('offers nothing to a stage nothing was assigned to', () => {
		// Brief and Plan have no rack. Their pages do not ask for one, and if
		// they ever do the answer should be empty rather than all 29.
		expect(namesAt('brief')).toEqual([]);
		expect(namesAt('plan')).toEqual([]);
	});

	it('retires Compose from seed from every stage but keeps it in the editor', () => {
		// That agent control *is* the pipeline, so offering it inside the stages
		// that now do the same job would be two contradictory routes to one
		// result. It stays enabled, because the unscoped editor still needs it.
		for (const stage of ['brief', 'plan', 'melody', 'arrangement', 'refine', 'finish'] as const) {
			expect(namesAt(stage)).not.toContain('Compose from seed');
		}
		expect(listControls().map((c) => c.name)).toContain('Compose from seed');
	});

	it('hides a disabled control from its stage', () => {
		const orchestrate = listControls('arrangement').find((c) => c.name === 'Orchestrate as…')!;
		updateControl(orchestrate.id, { enabled: false });
		expect(namesAt('arrangement')).not.toContain('Orchestrate as…');
	});
});

describe('offeredAt', () => {
	it('treats null as every stage', () => {
		// The upgrade path, and the default for a control someone adds from the
		// admin panel without thinking about stages: it keeps appearing rather
		// than quietly disappearing.
		expect(offeredAt(null, 'arrangement')).toBe(true);
		expect(offeredAt(null, 'melody')).toBe(true);
	});

	it('treats an empty list as no stage', () => {
		// Not the same as null, and the difference is what retires a control.
		expect(offeredAt([], 'arrangement')).toBe(false);
		expect(offeredAt([], undefined)).toBe(true);
	});

	it('ignores a name that is not a stage', () => {
		expect(offeredAt(['nonsense'], 'melody')).toBe(false);
		expect(offeredAt(['nonsense', 'melody'], 'melody')).toBe(true);
	});
});

describe('the backfill', () => {
	/** An install seeded before the column existed: every row null. */
	function asLegacyInstall() {
		db.update(controls).set({ stages: null }).run();
	}

	const nullCount = () =>
		db
			.select({ n: sql<number>`count(*)` })
			.from(controls)
			.where(isNull(controls.stages))
			.get()!.n;

	it('stamps rows that were seeded before the column existed', () => {
		// seedControls is insert-if-absent by name, so on an existing install it
		// skips all 29 and their stages stay null — which reads as "every stage"
		// and would put all 29 on every stage page.
		asLegacyInstall();
		expect(nullCount()).toBe(BUILTIN_CONTROLS.length);
		expect(namesAt('arrangement')).toHaveLength(BUILTIN_CONTROLS.length);

		seedControls();

		expect(nullCount()).toBe(0);
		expect(namesAt('arrangement')).toHaveLength(10);
	});

	it('leaves a control the admin has already scoped alone', () => {
		const transpose = listControls('melody').find((c) => c.name === 'Transpose')!;
		updateControl(transpose.id, { stages: ['finish'] });

		seedControls();

		expect(namesAt('finish')).toContain('Transpose');
		expect(namesAt('melody')).not.toContain('Transpose');
	});

	it('leaves an admin\'s empty list alone, because [] is not null', () => {
		// Clearing every stage is a decision, and re-stamping it from the
		// built-in list would silently undo it on the next boot.
		const transpose = listControls('melody').find((c) => c.name === 'Transpose')!;
		updateControl(transpose.id, { stages: [] });

		seedControls();

		expect(namesAt('melody')).not.toContain('Transpose');
	});

	it('does not touch a control the admin created', () => {
		// A user row has no entry in BUILTIN_CONTROLS to be stamped from, and
		// null is the right answer for it anyway: show it everywhere.
		db.insert(controls)
			.values({
				id: 'user-made',
				name: 'Mine',
				category: 'Custom',
				kind: 'prompt',
				description: '',
				promptTemplate: 'do a thing',
				builtin: false,
				enabled: true,
				sortOrder: 99
			})
			.run();

		seedControls();

		const row = db.select().from(controls).where(eq(controls.id, 'user-made')).get()!;
		expect(row.stages).toBeNull();
		expect(namesAt('arrangement')).toContain('Mine');
	});

	it('leaves a renamed built-in null rather than guessing', () => {
		const transpose = listControls('melody').find((c) => c.name === 'Transpose')!;
		updateControl(transpose.id, { name: 'Shift', stages: null });

		seedControls();

		const row = db
			.select()
			.from(controls)
			.where(and(eq(controls.id, transpose.id), isNull(controls.stages)))
			.get();
		expect(row).toBeTruthy();
	});

	it('is idempotent, like the seed it runs inside', () => {
		asLegacyInstall();
		seedControls();
		const first = namesAt('arrangement');
		seedControls();
		seedControls();
		expect(namesAt('arrangement')).toEqual(first);
	});
});
