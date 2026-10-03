import { describe, it, expect, beforeAll } from 'vitest';
import { eq } from 'drizzle-orm';
import { db, runMigrations } from './db/index.js';
import { planToOps, withCreatedIds, withCreatedPartIds } from '$lib/pipeline/plan.js';
import { emptyPlan, type Plan } from '$lib/pipeline/types.js';
import { revisions } from './db/schema.js';
import {
	commitOps,
	createScore,
	listRevisions,
	acceptRevision,
	analysisOf,
	loadScore,
	rejectRevision,
	restoreRevision,
	setAnalysis,
	setPipeline,
	stagedRevision
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

/**
 * Approving a plan, against the real write path.
 *
 * The pure half is covered in `$lib/pipeline/plan.test.ts`; this is the part
 * that only shows up once a database is involved — that the stage moves, that
 * the plan is stored beside the music it created, and that undoing past the
 * approval takes both back together.
 */
describe('approving a plan', () => {
	function planFor(over: Partial<Plan> = {}): Plan {
		return {
			...emptyPlan(),
			title: 'Rain on a Window',
			key: { tonic: 'A', mode: 'minor' },
			tempoBpm: 92,
			ensemble: [{ name: 'Piano', instrument: 'Acoustic Grand Piano' }],
			sections: [
				{ name: 'Verse', bars: 8, harmony: 'i-VI-III-VII', role: 'statement' },
				{ name: 'Chorus', bars: 8, harmony: 'VI-VII-i', role: 'lift' }
			],
			...over
		};
	}

	/** What the route does, without the route. */
	function approve(scoreId: string, plan: Plan, previous: Plan | null = null) {
		const before = loadScore(scoreId, user).doc;
		const result = commitOps(scoreId, user, planToOps(before, plan, previous), {
			source: 'user',
			label: `Approved plan: ${plan.title}`,
			accepted: true
		});
		const recorded = withCreatedPartIds(
			withCreatedIds(plan, result.created),
			before,
			result.created
		);
		setPipeline(scoreId, user, { plan: recorded, stage: 'melody' });
		return recorded;
	}

	it('writes the plan onto the score and moves the stage on', () => {
		const row = createScore(user, 'Planned');
		setPipeline(row.id, user, { stage: 'plan', brief: { description: 'A slow waltz' } });

		approve(row.id, planFor());
		const after = loadScore(row.id, user);

		expect(after.pipeline.stage).toBe('melody');
		expect(after.pipeline.plan?.approved).toBe(true);
		expect(after.doc.title).toBe('Rain on a Window');
		expect(after.doc.tempoMap[0].bpm).toBe(92);
		expect(after.doc.parts).toHaveLength(1);
		expect(after.doc.sections.map((s) => s.name)).toEqual(['Verse', 'Chorus']);
		// Eight 4/4 bars, so the chorus starts on the barline at 15360.
		expect(after.doc.sections[1].startTick).toBe(15360);
	});

	it('records the ids it created, so a second approval updates in place', () => {
		const row = createScore(user, 'Twice');
		setPipeline(row.id, user, { stage: 'plan', brief: { description: 'A slow waltz' } });

		const first = approve(row.id, planFor());
		expect(first.sections.every((s) => s.sectionId)).toBe(true);
		expect(first.ensemble[0].partId).toBeTruthy();

		const edited: Plan = {
			...first,
			sections: [{ ...first.sections[0], bars: 12 }, first.sections[1]]
		};
		approve(row.id, edited, first);

		const after = loadScore(row.id, user);
		expect(after.doc.sections).toHaveLength(2);
		expect(after.doc.parts).toHaveLength(1);
		expect(after.doc.sections[0].endTick).toBe(12 * 1920);
	});

	it('never strands the score at melody when the approval is undone', () => {
		// The gap the revisions.pipeline column exists to close. Undoing the
		// music without the stage would leave a score claiming to be at melody
		// with an approved plan whose parts and sections had just gone.
		const row = createScore(user, 'Undone');
		setPipeline(row.id, user, { stage: 'plan', brief: { description: 'A slow waltz' } });
		// Written at creation, so it snapshots the stage the score was at then —
		// nothing writes a revision for a stage change, only for music.
		const atCreation = listRevisions(row.id, user, 40)[0];

		approve(row.id, planFor());
		expect(loadScore(row.id, user).pipeline.stage).toBe('melody');

		restoreRevision(row.id, user, atCreation.id);
		const after = loadScore(row.id, user);
		expect(after.pipeline.stage).toBe('brief');
		expect(after.pipeline.plan).toBeNull();
		expect(after.doc.sections).toHaveLength(0);
		expect(after.doc.parts).toHaveLength(0);
	});

	it('restores the stage the approval itself was made at', () => {
		// The approval commits while the score is still at the plan, and only
		// then moves on — so its own revision carries `plan`. Going back to it
		// puts you where you were when you approved, holding what it wrote.
		const row = createScore(user, 'Back to the approval');
		setPipeline(row.id, user, { stage: 'plan', brief: { description: 'A slow waltz' } });

		approve(row.id, planFor());
		const approval = listRevisions(row.id, user, 40).find((r) =>
			r.label.startsWith('Approved plan')
		)!;

		// Move on and change something, then come back.
		setPipeline(row.id, user, { stage: 'refine' });
		restoreRevision(row.id, user, approval.id);

		const after = loadScore(row.id, user);
		expect(after.pipeline.stage).toBe('plan');
		expect(after.doc.sections).toHaveLength(2);
	});
});

describe('the staged change', () => {
	const addPiano = { op: 'add_part', args: { name: 'Piano', instrument: 'Piano' } } as const;

	it('is the newest revision while it is unaccepted', () => {
		const row = createScore(user, 'Staged');
		expect(stagedRevision(row.id, user)).toBeNull();

		const commit = commitOps(row.id, user, [addPiano], {
			source: 'control',
			label: 'Reharmonise',
			accepted: false
		});
		expect(stagedRevision(row.id, user)).toMatchObject({
			revisionId: commit.revisionId,
			label: 'Reharmonise'
		});

		acceptRevision(row.id, user, commit.revisionId);
		expect(stagedRevision(row.id, user)).toBeNull();
	});

	it('is gone once rejected, though the rejected row stays unaccepted', () => {
		const row = createScore(user, 'Rejected');
		commitOps(row.id, user, [addPiano], { source: 'user', label: 'Piano' });
		const staged = commitOps(row.id, user, [{ op: 'set_tempo', args: { bpm: 70 } }], {
			source: 'control',
			label: 'Slower',
			accepted: false
		});

		rejectRevision(row.id, user, staged.revisionId);

		const rejected = db.select().from(revisions).where(eq(revisions.id, staged.revisionId)).get();
		expect(rejected?.accepted).toBe(false);
		expect(stagedRevision(row.id, user)).toBeNull();
	});
});

describe('the stored explanation', () => {
	it('is fresh until the music changes, then out of date', () => {
		const row = createScore(user, 'Explained');
		expect(analysisOf(loadScore(row.id, user))).toBeNull();

		setAnalysis(row.id, user, 'It sits in C major throughout.', loadScore(row.id, user).doc);
		expect(analysisOf(loadScore(row.id, user))).toMatchObject({
			text: 'It sits in C major throughout.',
			stale: false
		});

		commitOps(row.id, user, [{ op: 'set_tempo', args: { bpm: 80 } }], {
			source: 'user',
			label: 'Slower'
		});
		expect(analysisOf(loadScore(row.id, user))?.stale).toBe(true);
	});

	it('is not made out of date by a new name', () => {
		const row = createScore(user, 'Renamed');
		setAnalysis(row.id, user, 'Short and bright.', loadScore(row.id, user).doc);
		commitOps(row.id, user, [{ op: 'set_title', args: { title: 'Bright Morning' } }], {
			source: 'user',
			label: 'Named it'
		});
		expect(analysisOf(loadScore(row.id, user))?.stale).toBe(false);
	});

	it('describes the music it was shown, not what arrived meanwhile', () => {
		const row = createScore(user, 'Raced');
		const shown = loadScore(row.id, user).doc;
		commitOps(row.id, user, [{ op: 'set_tempo', args: { bpm: 140 } }], {
			source: 'user',
			label: 'Edited while it was writing'
		});
		setAnalysis(row.id, user, 'Written about the version before.', shown);
		expect(analysisOf(loadScore(row.id, user))?.stale).toBe(true);
	});

	it('is not restored with an older version', () => {
		const row = createScore(user, 'Not rewound');
		commitOps(row.id, user, [{ op: 'set_tempo', args: { bpm: 90 } }], {
			source: 'user',
			label: 'Slower'
		});
		const first = listRevisions(row.id, user).at(-1)!;
		setAnalysis(row.id, user, 'Written about the newest version.', loadScore(row.id, user).doc);

		restoreRevision(row.id, user, first.id);
		// Still there, and marked as describing something newer than this.
		expect(analysisOf(loadScore(row.id, user))).toMatchObject({
			text: 'Written about the newest version.',
			stale: true
		});
	});
});
