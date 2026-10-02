import { describe, it, expect } from 'vitest';
import { applyOps } from '$lib/score/apply.js';
import { accompanimentParts } from '$lib/pipeline/arrange.js';
import { planToOps, withCreatedIds, withCreatedPartIds } from '$lib/pipeline/plan.js';
import { emptyPlan, type Plan } from '$lib/pipeline/types.js';
import { emptyScore, type Score } from '$lib/score/types.js';
import { MockAdapter, type ScriptedTurn } from './mock.js';
import { arrangeParts, NothingToArrangeError, pickTargets, type ArrangeTarget } from './arrange.js';

/**
 * The per-part run.
 *
 * Against a score that has really been through plan approval and has a melody
 * in it, because what matters is how a run treats the parts it is *not*
 * writing — and that needs real ones.
 */

function arranged(): { score: Score; plan: Plan; melody: string; strings: string; bass: string } {
	const plan: Plan = {
		...emptyPlan(),
		title: 'Rain',
		ensemble: [
			{ name: 'Flute', instrument: 'Flute' },
			{ name: 'Strings', instrument: 'String Ensemble 1' },
			{ name: 'Bass', instrument: 'Acoustic Bass' }
		],
		sections: [{ name: 'Verse', bars: 4, harmony: 'i-VI', role: 'statement' }]
	};
	const before = emptyScore();
	const result = applyOps(before, planToOps(before, plan));
	const created = result.diff.created;
	const approved = withCreatedPartIds(withCreatedIds(plan, created), before, created);
	const [melody, strings, bass] = approved.ensemble.map((e) => e.partId!);
	const score = applyOps(result.score, [
		{ op: 'insert_notes', args: { partId: melody, notes: [{ tick: 0, dur: 480, pitches: ['C5'] }] } }
	]).score;
	return { score, plan: { ...approved, approved: true }, melody, strings, bass };
}

function writes(partId: string, tick = 0, pitch = 'C3'): ScriptedTurn {
	return {
		toolCalls: [
			{
				name: 'insert_notes',
				arguments: JSON.stringify({ partId, notes: [{ tick, dur: 480, pitches: [pitch] }] })
			}
		]
	};
}

const finishes: ScriptedTurn = { content: 'Done.', finishReason: 'stop' };

function targetsOf(score: Score, plan: Plan): ArrangeTarget[] {
	return pickTargets(accompanimentParts(score, plan, null));
}

function run(
	adapter: MockAdapter,
	fixture: ReturnType<typeof arranged>,
	over: Partial<Parameters<typeof arrangeParts>[0]> = {}
) {
	return arrangeParts({
		adapter,
		systemPrompt: 'You arrange.',
		score: fixture.score,
		plan: fixture.plan,
		targets: targetsOf(fixture.score, fixture.plan),
		melodyPartId: fixture.melody,
		maxIterations: 4,
		maxOps: 400,
		...over
	});
}

describe('arrangeParts', () => {
	it('writes each part in plan order and collects one commit\'s worth', async () => {
		const f = arranged();
		const adapter = new MockAdapter([writes(f.strings), finishes, writes(f.bass), finishes]);
		const result = await run(adapter, f);

		expect(result.stopReason).toBe('done');
		expect(result.done).toEqual([f.strings, f.bass]);
		expect(result.ops).toHaveLength(2);
	});

	it('declares one phase per part, labelled by name', async () => {
		const f = arranged();
		const adapter = new MockAdapter([writes(f.strings), finishes, writes(f.bass), finishes]);
		const phases: unknown[] = [];
		await run(adapter, f, { onEvent: (type, data) => type === 'phase' && phases.push(data) });

		expect(phases).toEqual([
			{ id: f.strings, index: 0, total: 2, label: 'Strings' },
			{ id: f.bass, index: 1, total: 2, label: 'Bass' }
		]);
	});

	it('tells the second part what the first one wrote', async () => {
		const f = arranged();
		const adapter = new MockAdapter([writes(f.strings), finishes, writes(f.bass), finishes]);
		await run(adapter, f);

		const second = adapter.requests[2].messages[1].content ?? '';
		expect(second).toContain('Already arranged');
		expect(second).toContain(`${f.strings} Strings: 1 notes`);
		// The first part's own prompt had nothing arranged yet.
		expect(adapter.requests[0].messages[1].content).not.toContain('Already arranged');
	});

	it('shows every part the melody, and says it cannot change', async () => {
		const f = arranged();
		const adapter = new MockAdapter([writes(f.strings), finishes, writes(f.bass), finishes]);
		await run(adapter, f);

		for (const i of [0, 2]) {
			const prompt = adapter.requests[i].messages[1].content ?? '';
			expect(prompt).toContain(`The melody, in part ${f.melody}`);
			expect(prompt).toContain('cannot be changed');
		}
	});

	it('refuses an edit to a part other than the one being written', async () => {
		const f = arranged();
		const adapter = new MockAdapter([
			writes(f.bass),
			writes(f.strings),
			finishes,
			writes(f.bass),
			finishes
		]);
		const result = await run(adapter, f);

		// The stray bass note during the strings' turn never landed.
		expect(adapter.requests[1].messages.at(-1)?.content).toMatch(/writes only part/);
		expect(result.ops).toHaveLength(2);
		const bassNotes = result.working.parts.find((p) => p.id === f.bass)!.voices[0].events;
		expect(bassNotes).toHaveLength(1);
	});

	it('refuses a rewrite of the melody, even from the part being written', async () => {
		const f = arranged();
		const melodyNote = f.score.parts.find((p) => p.id === f.melody)!.voices[0].events[0].id;
		const adapter = new MockAdapter([
			{
				toolCalls: [
					{
						name: 'transpose',
						arguments: JSON.stringify({ semitones: 2, selection: { noteIds: [melodyNote] } })
					}
				]
			},
			finishes,
			finishes
		]);
		const result = await run(adapter, f);
		expect(result.ops).toEqual([]);
		expect(result.working.parts.find((p) => p.id === f.melody)).toEqual(
			f.score.parts.find((p) => p.id === f.melody)
		);
	});

	it('clears a part before rewriting it, so the new line replaces the old', async () => {
		const f = arranged();
		const withStrings = applyOps(f.score, [
			{ op: 'insert_notes', args: { partId: f.strings, notes: [{ tick: 0, dur: 480, pitches: ['G3'] }] } }
		]).score;
		const adapter = new MockAdapter([writes(f.strings, 480, 'E3'), finishes]);
		const result = await run(adapter, f, {
			score: withStrings,
			targets: [{ partId: f.strings, name: 'Strings', instrument: 'String Ensemble 1' }]
		});

		const notes = result.working.parts.find((p) => p.id === f.strings)!.voices[0].events;
		expect(notes).toHaveLength(1);
		expect(notes[0]).toMatchObject({ tick: 480 });
		// The clear is part of the commit, so applying the ops reproduces it.
		expect(applyOps(withStrings, result.ops).score).toEqual(result.working);
		// And the model was shown the part empty.
		expect(adapter.requests[0].messages[1].content).not.toContain('Already arranged');
	});

	it('keeps the old part when a rewrite writes nothing', async () => {
		const f = arranged();
		const withStrings = applyOps(f.score, [
			{ op: 'insert_notes', args: { partId: f.strings, notes: [{ tick: 0, dur: 480, pitches: ['G3'] }] } }
		]).score;
		const adapter = new MockAdapter([{ content: 'I would leave it.', finishReason: 'stop' }]);
		const result = await run(adapter, f, {
			score: withStrings,
			targets: [{ partId: f.strings, name: 'Strings', instrument: 'String Ensemble 1' }]
		});

		expect(result.ops).toEqual([]);
		expect(result.working).toBe(withStrings);
		expect(result.warnings.join(' ')).toContain('Strings: the model wrote nothing');
	});

	it('checks the budget before every part and keeps what landed', async () => {
		const f = arranged();
		const adapter = new MockAdapter([writes(f.strings), finishes, writes(f.bass), finishes]);
		let calls = 0;
		const result = await run(adapter, f, {
			onBeforePart: () => {
				if (++calls > 1) throw new Error('AI budget reached');
			}
		});

		expect(calls).toBe(2);
		expect(result.stopReason).toBe('budget');
		expect(result.done).toEqual([f.strings]);
		expect(adapter.requests).toHaveLength(2);
	});

	it('caps operations across the whole run', async () => {
		const f = arranged();
		const adapter = new MockAdapter([writes(f.strings), finishes, writes(f.bass), finishes]);
		const result = await run(adapter, f, { maxOps: 1 });
		expect(result.stopReason).toBe('max_ops');
		expect(result.ops).toHaveLength(1);
	});

	it('collects nothing once aborted', async () => {
		const f = arranged();
		const controller = new AbortController();
		controller.abort();
		const adapter = new MockAdapter([writes(f.strings), finishes]);
		const result = await run(adapter, f, { signal: controller.signal });
		expect(result.stopReason).toBe('aborted');
		expect(result.ops).toEqual([]);
		expect(adapter.requests).toHaveLength(0);
	});

	it('keeps earlier parts when a later call fails', async () => {
		const f = arranged();
		const adapter = new MockAdapter([writes(f.strings), finishes, { error: 'the connection dropped' }]);
		const result = await run(adapter, f);
		expect(result.stopReason).toBe('failed');
		expect(result.done).toEqual([f.strings]);
		expect(result.warnings.join(' ')).toContain('Bass: the connection dropped');
	});

	it('passes the person\'s direction through', async () => {
		const f = arranged();
		const adapter = new MockAdapter([writes(f.strings), finishes, writes(f.bass), finishes]);
		await run(adapter, f, { instruction: 'keep the bass walking' });
		expect(adapter.requests[0].messages[1].content).toContain(
			'The person asked for: keep the bass walking'
		);
	});
});

describe('pickTargets', () => {
	it('takes every empty part when none are named', () => {
		const f = arranged();
		const withStrings = applyOps(f.score, [
			{ op: 'insert_notes', args: { partId: f.strings, notes: [{ tick: 0, dur: 480, pitches: ['G3'] }] } }
		]).score;
		expect(targetsOf(withStrings, f.plan).map((t) => t.partId)).toEqual([f.bass]);
	});

	it('refuses the melody, which this stage does not write', () => {
		const f = arranged();
		expect(() => pickTargets(accompanimentParts(f.score, f.plan, null), [f.melody])).toThrow(
			NothingToArrangeError
		);
	});
});
