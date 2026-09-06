import { describe, it, expect } from 'vitest';
import { applyOps } from '$lib/score/apply.js';
import { emptyScore, type Score } from '$lib/score/types.js';
import { planToOps, withCreatedIds } from './plan.js';
import { chunksFor, melodyPartOf, sectionStates, unwrittenSections } from './realize.js';
import { emptyPlan, type Plan } from './types.js';

/**
 * Chunking, and the state the page reads back off the notes.
 *
 * Everything here works against a score that has really been through plan
 * approval, because the whole design rests on approval having already written
 * the section ticks — testing against hand-built sections would prove nothing
 * about the join these functions actually make.
 */

function approvedPlan(over: Partial<Plan> = {}): { score: Score; plan: Plan } {
	const plan: Plan = {
		...emptyPlan(),
		title: 'Rain',
		tempoBpm: 96,
		ensemble: [{ name: 'Piano', instrument: 'Acoustic Grand Piano' }],
		sections: [
			{ name: 'Verse', bars: 8, harmony: 'i-VI', role: 'statement' },
			{ name: 'Chorus', bars: 4, harmony: 'VI-VII-i', role: 'lift' }
		],
		...over
	};
	const before = emptyScore();
	const result = applyOps(before, planToOps(before, plan));
	return { score: result.score, plan: withCreatedIds(plan, result.diff.created) };
}

/** Put a note into the melody part at a tick, as a realization would. */
function writeNote(score: Score, partId: string, tick: number): Score {
	return applyOps(score, [
		{ op: 'insert_notes', args: { partId, notes: [{ tick, dur: 480, pitches: ['C4'] }] } }
	]).score;
}

describe('chunksFor', () => {
	it('takes its boundaries from the sections approval committed', () => {
		const { score, plan } = approvedPlan();
		const chunks = chunksFor(score, plan, 8);

		expect(chunks).toHaveLength(2);
		expect(chunks.map((c) => c.label)).toEqual(['Verse', 'Chorus']);
		// Exactly the spans in the document — nothing recomputed from bars.
		expect(chunks.map((c) => [c.startTick, c.endTick])).toEqual(
			score.sections.map((s) => [s.startTick, s.endTick])
		);
	});

	it('splits a long section and never spans two', () => {
		// compose_realize is told to write only that section, so a chunk
		// straddling a boundary contradicts its own instruction.
		const { score, plan } = approvedPlan({
			sections: [
				{ name: 'Verse', bars: 16, harmony: 'i-VI', role: 'statement' },
				{ name: 'Chorus', bars: 4, harmony: 'VI-i', role: 'lift' }
			]
		});
		const chunks = chunksFor(score, plan, 8);

		expect(chunks.map((c) => c.label)).toEqual(['Verse 1/2', 'Verse 2/2', 'Chorus']);
		for (const chunk of chunks) {
			const span = score.sections.find((s) => s.id === chunk.sectionId)!;
			expect(chunk.startTick).toBeGreaterThanOrEqual(span.startTick);
			expect(chunk.endTick).toBeLessThanOrEqual(span.endTick);
		}
	});

	it('ends the last slice exactly on the section end', () => {
		// 6 bars at a chunk size of 4 leaves a short tail; overrunning it would
		// write the tail into the next section.
		const { score, plan } = approvedPlan({
			sections: [{ name: 'Verse', bars: 6, harmony: '', role: '' }]
		});
		const chunks = chunksFor(score, plan, 4);

		expect(chunks).toHaveLength(2);
		expect(chunks[0].endTick).toBe(4 * 1920);
		expect(chunks[1].endTick).toBe(6 * 1920);
		expect(chunks[1].endTick).toBe(score.sections[0].endTick);
	});

	it('covers the section with no gaps and no overlaps', () => {
		const { score, plan } = approvedPlan({
			sections: [{ name: 'Verse', bars: 9, harmony: '', role: '' }]
		});
		const chunks = chunksFor(score, plan, 2);

		expect(chunks[0].startTick).toBe(score.sections[0].startTick);
		for (let i = 1; i < chunks.length; i++) {
			expect(chunks[i].startTick).toBe(chunks[i - 1].endTick);
		}
		expect(chunks[chunks.length - 1].endTick).toBe(score.sections[0].endTick);
	});

	it('restricts to the sections asked for', () => {
		const { score, plan } = approvedPlan();
		const chorus = plan.sections[1].sectionId!;
		const chunks = chunksFor(score, plan, 8, [chorus]);

		expect(chunks).toHaveLength(1);
		expect(chunks[0].sectionId).toBe(chorus);
	});

	it('skips a card whose section was deleted rather than inventing a span', () => {
		const { score, plan } = approvedPlan();
		const orphaned: Plan = {
			...plan,
			sections: plan.sections.map((s, i) => (i === 0 ? { ...s, sectionId: 'section-gone' } : s))
		};
		const chunks = chunksFor(score, orphaned, 8);

		expect(chunks).toHaveLength(1);
		expect(chunks[0].label).toBe('Chorus');
	});

	it('never produces a zero-width chunk, whatever the chunk size', () => {
		const { score, plan } = approvedPlan();
		for (const size of [0, 1, 8, 1000]) {
			for (const chunk of chunksFor(score, plan, size)) {
				expect(chunk.endTick).toBeGreaterThan(chunk.startTick);
			}
		}
	});
});

describe('sectionStates', () => {
	it('reads a half-finished realization off the notes', () => {
		// The reason resume needs no bookkeeping: a run that died after the
		// first section leaves a score that says exactly that.
		const { score, plan } = approvedPlan();
		const partId = score.parts[0].id;
		const written = writeNote(score, partId, 0);

		const states = sectionStates(written, plan, partId);
		expect(states.map((s) => s.state)).toEqual(['written', 'empty']);
		expect(unwrittenSections(written, plan, partId)).toEqual([plan.sections[1].sectionId]);
	});

	it('counts only notes inside the section span', () => {
		const { score, plan } = approvedPlan();
		const partId = score.parts[0].id;
		// One tick before the chorus begins is still the verse.
		const written = writeNote(score, partId, score.sections[1].startTick - 480);

		const states = sectionStates(written, plan, partId);
		expect(states[0].noteCount).toBe(1);
		expect(states[1].noteCount).toBe(0);
	});

	it('ignores notes in other parts', () => {
		// An audio seed sits in its own staff; it must not make a section that
		// has no melody in it look written.
		const { score, plan } = approvedPlan();
		const withSecond = applyOps(score, [
			{ op: 'add_part', args: { name: 'Cello', instrument: 'Cello' } }
		]).score;
		const other = withSecond.parts[1].id;
		const written = writeNote(withSecond, other, 0);

		expect(sectionStates(written, plan, withSecond.parts[0].id).every((s) => s.state === 'empty')).toBe(
			true
		);
	});

	it('reads everything as empty when no part carries the tune', () => {
		const { score, plan } = approvedPlan();
		expect(sectionStates(score, plan, null).every((s) => s.state === 'empty')).toBe(true);
	});
});

describe('melodyPartOf', () => {
	it('prefers the part the person hummed into', () => {
		const { score, plan } = approvedPlan();
		const seeded = applyOps(score, [
			{ op: 'add_part', args: { name: 'Voice', instrument: 'Violin' } }
		]).score;
		const seedPartId = seeded.parts[1].id;

		expect(melodyPartOf(seeded, plan, { description: '', seedPartId })).toBe(seedPartId);
	});

	it('honours an explicit choice over the seed', () => {
		const { score, plan } = approvedPlan();
		const chosen = score.parts[0].id;
		expect(
			melodyPartOf(score, { ...plan, melodyPartId: chosen }, { description: '', seedPartId: 'x' })
		).toBe(chosen);
	});

	it('falls back to the first ensemble part', () => {
		const { score, plan } = approvedPlan();
		expect(melodyPartOf(score, plan, null)).toBe(score.parts[0].id);
	});

	it('ignores a stored id whose part has gone', () => {
		const { score, plan } = approvedPlan();
		expect(melodyPartOf(score, { ...plan, melodyPartId: 'part-gone' }, null)).toBe(
			score.parts[0].id
		);
	});

	it('has nothing to offer on a score with no parts', () => {
		expect(melodyPartOf(emptyScore(), emptyPlan(), null)).toBeNull();
	});
});
