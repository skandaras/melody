import { describe, it, expect } from 'vitest';
import { applyOps, type Op } from '$lib/score/apply.js';
import {
	accompanimentParts,
	clearPartOps,
	syncPlanSections,
	unwrittenParts
} from './arrange.js';
import { onlyPart } from './guards.js';
import { approved, judge, notes } from './testing.js';

/** Which parts an arrangement has to write, and what clearing one does. */

describe('accompanimentParts', () => {
	it('is the plan\'s ensemble minus the tune, in plan order', () => {
		const { score, plan } = approved();
		const parts = accompanimentParts(score, plan, null);
		// melodyPartOf falls back to the first ensemble entry.
		expect(parts.map((p) => p.name)).toEqual(['Strings', 'Bass']);
		expect(parts.every((p) => p.state === 'empty')).toBe(true);
	});

	it('follows the melody part chosen on the melody page', () => {
		const { score, plan } = approved();
		const strings = plan.ensemble[1].partId!;
		const parts = accompanimentParts(score, { ...plan, melodyPartId: strings }, null);
		expect(parts.map((p) => p.name)).toEqual(['Flute', 'Bass']);
	});

	it('leaves out the hummed seed, which is a recording rather than a part to write', () => {
		const { score, plan } = approved();
		const [flute, , bass] = plan.ensemble.map((e) => e.partId!);
		// The tune chosen elsewhere: with no choice, the seed would *be* the tune.
		const chosen = { ...plan, melodyPartId: flute };
		const parts = accompanimentParts(score, chosen, { description: '', seedPartId: bass });
		expect(parts.map((p) => p.name)).toEqual(['Strings']);
	});

	it('reads written from notes, and skips a part deleted since', () => {
		const { score: s0, plan } = approved();
		const [, strings, bass] = plan.ensemble.map((e) => e.partId!);
		let score = notes(s0, strings, 'C4', 'E4');
		score = applyOps(score, [{ op: 'remove_part', args: { partId: bass } }]).score;

		const parts = accompanimentParts(score, plan, null);
		expect(parts).toEqual([
			expect.objectContaining({ partId: strings, state: 'written', noteCount: 2 })
		]);
		expect(unwrittenParts(score, plan, null)).toEqual([]);
	});
});

describe('clearPartOps', () => {
	it('removes every note in the part and nothing else', () => {
		const { score: s0, plan } = approved();
		const [melody, strings] = plan.ensemble.map((e) => e.partId!);
		const score = notes(notes(s0, melody, 'C5'), strings, 'C4', 'E4', 'G4');

		const ops = clearPartOps(score, strings);
		const after = applyOps(score, ops);
		expect(after.diff.removed).toHaveLength(3);
		expect(accompanimentParts(after.score, plan, null)[0].state).toBe('empty');
		expect(judge(onlyPart(strings), score, ops[0])).toBeNull();
	});

	it('has nothing to do for an empty part', () => {
		const { score, plan } = approved();
		expect(clearPartOps(score, plan.ensemble[1].partId!)).toEqual([]);
		expect(clearPartOps(score, 'nope')).toEqual([]);
	});
});

describe('syncPlanSections', () => {
	it('returns the same plan when the score has no new sections', () => {
		const { score, plan } = approved();
		expect(syncPlanSections(plan, score)).toBe(plan);
	});

	it('adds a card for a section written while arranging, in tick order', () => {
		const { score: s0, plan } = approved();
		// The verse is four bars of 4/4: ticks 0 to 7680. A two-bar bridge after
		// it, and a zero-length section, which spans nothing and gets no card.
		let score = applyOps(s0, [
			{ op: 'set_section', args: { name: 'Bridge', startTick: 7680, endTick: 11520 } }
		]).score;
		score = { ...score, sections: [...score.sections, { id: 'intro', name: 'Intro', startTick: 0, endTick: 0 }] };

		const synced = syncPlanSections(plan, score);
		expect(synced.sections.map((s) => s.name)).toEqual(['Verse', 'Bridge']);
		expect(synced.sections[1]).toMatchObject({ bars: 2, harmony: '', sectionId: expect.any(String) });
		// Running it again finds nothing new.
		expect(syncPlanSections(synced, score)).toBe(synced);
	});

	it('puts an earlier section before the cards it precedes', () => {
		const { score: s0, plan } = approved();
		const verse = s0.sections[0];
		const shifted = {
			...s0,
			sections: [
				{ id: 'intro', name: 'Intro', startTick: 0, endTick: 1920 },
				{ ...verse, startTick: 1920, endTick: 9600 }
			]
		};
		expect(syncPlanSections(plan, shifted).sections.map((s) => s.name)).toEqual(['Intro', 'Verse']);
	});
});
