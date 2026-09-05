import { describe, it, expect, beforeAll } from 'vitest';
import { eq } from 'drizzle-orm';
import { db, runMigrations } from './db/index.js';
import { revisions } from './db/schema.js';
import {
	commitOps,
	createScore,
	listRevisions,
	loadScore,
	restoreRevision,
	setPipeline
} from './scores.js';

/**
 * Pipeline state travels with the document.
 *
 * Restoring a score used to put the notes back and leave the stage where it
 * was, so undoing past a plan approval would leave a score claiming to be at
 * the melody stage with an approved plan, while the parts and sections that
 * approval created had just been undone away. These pin the fix.
 */

const user = 'pipeline-user';

beforeAll(() => runMigrations());

describe('pipeline state', () => {
	it('starts a new score at the brief with nothing filled in', () => {
		const row = createScore(user, 'Fresh');
		expect(row.pipeline).toEqual({ stage: 'brief', brief: null, plan: null });
	});

	it('records a stage change without touching the music', () => {
		const row = createScore(user, 'Advancing');
		const before = loadScore(row.id, user).doc;

		const brief = { description: 'A slow waltz', seedRole: 'theme' as const };
		setPipeline(row.id, user, { stage: 'plan', brief });

		const after = loadScore(row.id, user);
		expect(after.pipeline.stage).toBe('plan');
		expect(after.pipeline.brief).toEqual(brief);
		// Approving a brief writes no notes.
		expect(after.doc).toEqual(before);
	});

	it('carries the stage back when a revision is restored', () => {
		const row = createScore(user, 'Undoable');
		setPipeline(row.id, user, { stage: 'brief', brief: { description: 'first thoughts' } });

		// Something happens at the brief stage...
		commitOps(row.id, user, [{ op: 'add_part', args: { name: 'Piano', instrument: 'Piano' } }], {
			source: 'user',
			label: 'Added a part'
		});

		// ...then the score moves on and changes again.
		setPipeline(row.id, user, { stage: 'melody', brief: { description: 'second thoughts' } });
		commitOps(row.id, user, [{ op: 'set_tempo', args: { bpm: 96 } }], {
			source: 'user',
			label: 'Tempo'
		});

		// Roll back to the revision written while still at the brief.
		const history = listRevisions(row.id, user, 40);
		const atBrief = history.find((r) => r.label === 'Added a part')!;
		restoreRevision(row.id, user, atBrief.id);

		const after = loadScore(row.id, user);
		expect(after.pipeline.stage).toBe('brief');
		expect(after.pipeline.brief?.description).toBe('first thoughts');
	});

	it('leaves the stage alone when restoring a revision written before the pipeline existed', () => {
		// Every revision in an existing install has null here. Resetting those
		// scores to the first stage on any undo would be worse than doing
		// nothing, so the guard has to be exercised with a genuinely null
		// column rather than a freshly written one.
		const row = createScore(user, 'Legacy');
		const history = listRevisions(row.id, user, 40);
		const oldest = history[history.length - 1];

		db.update(revisions).set({ pipeline: null }).where(eq(revisions.id, oldest.id)).run();
		setPipeline(row.id, user, { stage: 'refine' });

		restoreRevision(row.id, user, oldest.id);
		expect(loadScore(row.id, user).pipeline.stage).toBe('refine');
	});
});
