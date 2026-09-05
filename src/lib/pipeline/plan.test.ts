import { describe, it, expect } from 'vitest';
import { emptyScore } from '$lib/score/types.js';
import { applyOps } from '$lib/score/apply.js';
import {
	coercePlan,
	droppedSectionIds,
	estimateSeconds,
	formatDuration,
	planToOps,
	MAX_ENSEMBLE,
	sectionSpans,
	withCreatedIds,
	withCreatedPartIds
} from './plan.js';
import { emptyPlan, type Plan } from './types.js';

/**
 * Approving a plan is the only thing in this stage that writes to the score,
 * so it is the only thing here worth testing hard.
 */

function planOf(over: Partial<Plan> = {}): Plan {
	return {
		...emptyPlan(),
		title: 'Rain on a Window',
		tempoBpm: 96,
		sections: [
			{ name: 'Verse', bars: 8, harmony: 'i-VI-III-VII', role: 'statement' },
			{ name: 'Chorus', bars: 8, harmony: 'VI-VII-i', role: 'lift' }
		],
		...over
	};
}

const names = (ops: { op: string }[]) => ops.map((o) => o.op);

describe('sectionSpans', () => {
	it('lays sections end to end from the plan metre', () => {
		const spans = sectionSpans(emptyScore(), planOf());
		expect(spans.map((s) => [s.startTick, s.endTick])).toEqual([
			[0, 15360],
			[15360, 30720]
		]);
	});

	it('measures in the plan metre, not the metre the score has now', () => {
		// The regression this whole design turns on. A 3/4 plan approved onto a
		// 4/4 score must lay out 1440-tick bars, because set_time_sig in the same
		// commit is about to re-bar the score. Walking the score instead would
		// give 1920-tick bars and put the chorus two thirds through bar 11.
		const score = emptyScore();
		expect(score.timeSigs[0]).toMatchObject({ num: 4, den: 4 });

		const spans = sectionSpans(score, planOf({ timeSig: { num: 3, den: 4 } }));
		expect(spans[0].endTick).toBe(8 * 1440);
		expect(spans[1].startTick).toBe(11520);
		// Every boundary lands on a barline of the metre that will be in force.
		for (const s of spans) expect(s.startTick % 1440).toBe(0);
	});

	it('refuses to give a section zero width', () => {
		const spans = sectionSpans(emptyScore(), planOf({
			sections: [{ name: 'Nothing', bars: 0, harmony: '', role: '' }]
		}));
		expect(spans[0].endTick).toBeGreaterThan(spans[0].startTick);
	});
});

describe('planToOps', () => {
	it('sets the header facts before anything measured against them', () => {
		const ops = planToOps(emptyScore(), planOf({ ensemble: [] }));
		expect(names(ops)).toEqual([
			'set_title',
			'set_tempo',
			'set_time_sig',
			'set_key',
			'set_section',
			'set_section'
		]);
	});

	it('adds a part for an ensemble entry that names no existing one', () => {
		const ops = planToOps(
			emptyScore(),
			planOf({ ensemble: [{ name: 'Piano', instrument: 'Acoustic Grand Piano' }] })
		);
		expect(ops.filter((o) => o.op === 'add_part')).toHaveLength(1);
	});

	it('leaves a seeded part alone rather than duplicating it', () => {
		// The audio-seeded flow: a part already exists and the plan stands for it.
		const seeded = applyOps(emptyScore(), [
			{ op: 'add_part', args: { name: 'Voice', instrument: 'Violin' } }
		]).score;
		const partId = seeded.parts[0].id;

		const ops = planToOps(
			seeded,
			planOf({ ensemble: [{ name: 'Voice', instrument: 'Violin', partId }] })
		);
		expect(ops.some((o) => o.op === 'add_part')).toBe(false);
	});

	it('treats an id that no longer resolves as a part to create', () => {
		// A hallucinated id must cost a part, never a failed approval.
		const ops = planToOps(
			emptyScore(),
			planOf({ ensemble: [{ name: 'Cello', instrument: 'Cello', partId: 'part-gone' }] })
		);
		expect(ops.filter((o) => o.op === 'add_part')).toHaveLength(1);
	});
});

describe('re-approving an edited plan', () => {
	/** Approve a plan for real and hand back the score and the recorded ids. */
	function approve(plan: Plan, score = emptyScore(), previous: Plan | null = null) {
		const result = applyOps(score, planToOps(score, plan, previous));
		const recorded = withCreatedIds(plan, result.diff.created);
		return { score: result.score, plan: recorded };
	}

	it('updates the sections it made instead of adding a second set', () => {
		const first = approve(planOf());
		expect(first.score.sections).toHaveLength(2);
		expect(first.plan.sections.every((s) => s.sectionId)).toBe(true);

		// Lengthen the verse and approve again.
		const edited: Plan = {
			...first.plan,
			sections: [{ ...first.plan.sections[0], bars: 12 }, first.plan.sections[1]]
		};
		const second = approve(edited, first.score, first.plan);

		expect(second.score.sections).toHaveLength(2);
		expect(second.score.sections.map((s) => s.id)).toEqual(
			first.score.sections.map((s) => s.id)
		);
		expect(second.score.sections[0].endTick).toBe(12 * 1920);
	});

	it('removes a section the edited plan dropped', () => {
		const first = approve(planOf());
		const dropped = first.plan.sections[1].sectionId!;

		const edited: Plan = { ...first.plan, sections: [first.plan.sections[0]] };
		expect(droppedSectionIds(edited, first.plan)).toEqual([dropped]);

		const second = approve(edited, first.score, first.plan);
		expect(second.score.sections.map((s) => s.id)).not.toContain(dropped);
		expect(second.score.sections).toHaveLength(1);
	});

	it('never removes a part, even when the ensemble row is gone', () => {
		// Dropping a text field must not delete the music the user hummed.
		const withPart = planOf({ ensemble: [{ name: 'Piano', instrument: 'Acoustic Grand Piano' }] });
		const first = approve(withPart);
		expect(first.score.parts).toHaveLength(1);

		const edited: Plan = { ...first.plan, ensemble: [] };
		const second = approve(edited, first.score, first.plan);
		expect(second.score.parts).toHaveLength(1);
	});
});

describe('withCreatedPartIds', () => {
	it('adopts the ids of the parts approval just made', () => {
		const before = emptyScore();
		const plan = planOf({ ensemble: [{ name: 'Piano', instrument: 'Acoustic Grand Piano' }] });
		const result = applyOps(before, planToOps(before, plan));

		const recorded = withCreatedPartIds(plan, before, result.diff.created);
		expect(recorded.ensemble[0].partId).toBe(result.score.parts[0].id);
	});
});

describe('estimateSeconds', () => {
	it('reads sixteen 4/4 bars at 96bpm as forty seconds', () => {
		expect(estimateSeconds(planOf())).toBeCloseTo(40, 5);
	});

	it('counts a 6/8 bar as three quarter-note beats, not six', () => {
		const plan = planOf({ timeSig: { num: 6, den: 8 }, tempoBpm: 120 });
		expect(estimateSeconds(plan)).toBeCloseTo(24, 5);
	});

	it('formats as minutes and seconds', () => {
		expect(formatDuration(127)).toBe('2:07');
		expect(formatDuration(0)).toBe('0:00');
	});
});

describe('coercePlan', () => {
	const score = emptyScore();

	it('reads a well-formed reply through unchanged', () => {
		const plan = coercePlan(
			{
				title: 'Rain',
				key: { tonic: 'A', mode: 'minor' },
				tempoBpm: 92,
				timeSig: { num: 3, den: 4 },
				ensemble: [{ name: 'Piano', instrument: 'Acoustic Grand Piano' }],
				sections: [{ name: 'Verse', bars: 8, harmony: 'i-VI', role: 'statement' }]
			},
			score
		);
		expect(plan).toMatchObject({
			title: 'Rain',
			key: { tonic: 'A', mode: 'minor' },
			tempoBpm: 92,
			timeSig: { num: 3, den: 4 },
			approved: false
		});
		expect(plan!.sections).toHaveLength(1);
	});

	it('refuses a reply with no sections, which would approve to nothing', () => {
		expect(coercePlan({ title: 'Rain', sections: [] }, score)).toBeNull();
		expect(coercePlan(null, score)).toBeNull();
		expect(coercePlan('a slow waltz', score)).toBeNull();
	});

	it('drops a partId the score does not have', () => {
		// Strict mode makes every optional property nullable, so an explicit
		// null is a legal answer — and the no-schema retry has no rules at all.
		const plan = coercePlan(
			{
				sections: [{ name: 'Verse', bars: 4, harmony: '', role: '' }],
				ensemble: [
					{ name: 'A', instrument: 'Violin', partId: null },
					{ name: 'B', instrument: 'Cello', partId: 'part-nope' }
				]
			},
			score
		);
		expect(plan!.ensemble.every((p) => p.partId === undefined)).toBe(true);
	});

	it('keeps a partId that resolves', () => {
		const seeded = applyOps(emptyScore(), [
			{ op: 'add_part', args: { name: 'Voice', instrument: 'Violin' } }
		]).score;
		const plan = coercePlan(
			{
				sections: [{ name: 'Verse', bars: 4, harmony: '', role: '' }],
				ensemble: [{ name: 'Voice', instrument: 'Violin', partId: seeded.parts[0].id }]
			},
			seeded
		);
		expect(plan!.ensemble[0].partId).toBe(seeded.parts[0].id);
	});

	it('clamps nonsense rather than rejecting a plan a person could fix', () => {
		const plan = coercePlan(
			{
				tempoBpm: 9000,
				timeSig: { num: 99, den: 7 },
				sections: [{ name: 'Verse', bars: 1e6, harmony: '', role: '' }]
			},
			score
		);
		expect(plan!.tempoBpm).toBe(300);
		expect(plan!.timeSig.num).toBe(32);
		// 7 is not a note value; a bar of 7ths would misplace every boundary.
		expect(plan!.timeSig.den).toBe(4);
		expect(plan!.sections[0].bars).toBe(64);
	});

	it('caps the ensemble at the number of non-drum MIDI channels', () => {
		const plan = coercePlan(
			{
				sections: [{ name: 'Verse', bars: 4, harmony: '', role: '' }],
				ensemble: Array.from({ length: 40 }, (_, i) => ({ name: `P${i}`, instrument: 'Violin' }))
			},
			score
		);
		expect(plan!.ensemble).toHaveLength(MAX_ENSEMBLE);
	});

	it('supplies defaults for fields the model left out', () => {
		const plan = coercePlan({ sections: [{ name: 'Verse' }] }, score);
		expect(plan).toMatchObject({
			key: { tonic: 'C', mode: 'major' },
			tempoBpm: 100,
			timeSig: { num: 4, den: 4 }
		});
		expect(plan!.sections[0].bars).toBe(8);
	});
});
