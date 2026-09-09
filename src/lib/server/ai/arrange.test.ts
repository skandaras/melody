import { describe, it, expect } from 'vitest';
import { applyOps } from '$lib/score/apply.js';
import { partChunks } from '$lib/pipeline/arrange.js';
import { planToOps, withCreatedIds, withCreatedPartIds } from '$lib/pipeline/plan.js';
import { emptyPlan, type Plan } from '$lib/pipeline/types.js';
import { emptyScore, type Score } from '$lib/score/types.js';
import { MockAdapter, type ScriptedTurn } from './mock.js';
import { arrangeParts } from './arrange.js';

/**
 * The per-part run.
 *
 * The sibling of realize.test.ts, and it guards the same four hazards plus the
 * three this stage adds: an invented instrument, a rewritten melody and a part
 * written outside its instrument's range. All against a score that has really
 * been through plan approval, because the design rests on approval having
 * created the parts.
 */

function approved(ensemble: Plan['ensemble'] = defaultEnsemble()): {
	score: Score;
	plan: Plan;
} {
	const plan: Plan = {
		...emptyPlan(),
		title: 'Rain',
		ensemble,
		sections: [{ name: 'Verse', bars: 4, harmony: 'i-VI', role: 'statement' }]
	};
	const before = emptyScore();
	const result = applyOps(before, planToOps(before, plan));
	const withSections = withCreatedIds(plan, result.diff.created);
	return {
		score: result.score,
		plan: withCreatedPartIds(withSections, before, result.diff.created)
	};
}

function defaultEnsemble(): Plan['ensemble'] {
	return [
		{ name: 'Flute', instrument: 'Flute' },
		{ name: 'Cello', instrument: 'Cello' },
		{ name: 'Piano', instrument: 'Acoustic Grand Piano' }
	];
}

/** A turn that writes one note into `partId`. */
function writes(partId: string, tick: number, pitch = 60): ScriptedTurn {
	return {
		toolCalls: [
			{
				name: 'insert_notes',
				arguments: JSON.stringify({
					partId,
					notes: [{ tick, dur: 480, pitches: [pitch] }]
				})
			}
		]
	};
}

/** The turn after a tool call, ending the loop. */
const finishes: ScriptedTurn = { content: 'Done.', finishReason: 'stop' };

function run(
	adapter: MockAdapter,
	over: Partial<Parameters<typeof arrangeParts>[0]> & { score: Score; plan: Plan }
) {
	const melodyPartId = over.melodyPartId ?? over.plan.ensemble[0].partId!;
	return arrangeParts({
		adapter,
		systemPrompt: 'You arrange music.',
		chunks: partChunks(over.score, over.plan, melodyPartId),
		maxIterations: 4,
		maxOps: 400,
		...over,
		melodyPartId
	});
}

describe('arrangeParts', () => {
	it('writes each accompaniment part and collects the ops for one commit', async () => {
		const { score, plan } = approved();
		const [, cello, piano] = plan.ensemble;
		const adapter = new MockAdapter([
			writes(cello.partId!, 0),
			finishes,
			writes(piano.partId!, 0),
			finishes
		]);

		const result = await run(adapter, { score, plan });

		expect(result.stopReason).toBe('done');
		expect(result.ops).toHaveLength(2);
		expect(result.done).toEqual([cello.partId, piano.partId]);
	});

	it('never gives a chunk the melody part', async () => {
		// The tune was approved a stage ago. Nothing here should be able to
		// target it, and the phase list is where that becomes visible.
		const { score, plan } = approved();
		const adapter = new MockAdapter([]);
		const phases: string[] = [];

		await run(adapter, {
			score,
			plan,
			onEvent: (type, data) => {
				if (type === 'phase') phases.push((data as { id: string }).id);
			}
		});

		expect(phases).not.toContain(plan.ensemble[0].partId);
		expect(phases).toHaveLength(2);
	});

	it('applies part one before building part two, so the second can make room', async () => {
		// The failure this guards is silent, exactly as in a realization: without
		// applying between chunks, every part is written as though it were the
		// only accompaniment, and "make room rather than doubling" has nothing to
		// refer to. The only place it shows is in what the second request was
		// told.
		const { score, plan } = approved();
		const [, cello, piano] = plan.ensemble;
		const adapter = new MockAdapter([
			writes(cello.partId!, 960),
			finishes,
			writes(piano.partId!, 0),
			finishes
		]);

		await run(adapter, { score, plan });

		const secondPartOpening = adapter.requests[2].messages[1].content ?? '';
		expect(secondPartOpening).toContain('The accompaniment written so far');
		// The note part one wrote is in part two's prompt.
		expect(secondPartOpening).toContain('@960');
	});

	it('shows every chunk the melody, and tells it not to edit it', async () => {
		const { score, plan } = approved();
		const [flute, cello] = plan.ensemble;
		const withTune = applyOps(score, [
			{
				op: 'insert_notes',
				args: { partId: flute.partId!, notes: [{ tick: 0, dur: 480, pitches: [72] }] }
			}
		]).score;

		const adapter = new MockAdapter([writes(cello.partId!, 0), finishes]);
		await run(adapter, { score: withTune, plan });

		const opening = adapter.requests[0].messages[1].content ?? '';
		expect(opening).toContain('The melody, which this part accompanies. Do not edit it');
		expect(opening).toContain(`Write into part ${cello.partId} only`);
	});

	it('sends a byte-identical tool list on every call', async () => {
		const { score, plan } = approved();
		const [, cello, piano] = plan.ensemble;
		const adapter = new MockAdapter([
			writes(cello.partId!, 0),
			finishes,
			writes(piano.partId!, 0),
			finishes
		]);

		await run(adapter, { score, plan });

		const shapes = adapter.requests.map((r) => JSON.stringify(r.tools));
		expect(new Set(shapes).size).toBe(1);
	});

	it('declares one phase per part before writing anything', async () => {
		const { score, plan } = approved();
		const [, cello, piano] = plan.ensemble;
		const adapter = new MockAdapter([
			writes(cello.partId!, 0),
			finishes,
			writes(piano.partId!, 0),
			finishes
		]);
		const events: { type: string; data: unknown }[] = [];

		await run(adapter, { score, plan, onEvent: (type, data) => events.push({ type, data }) });

		const phases = events.filter((e) => e.type === 'phase');
		expect(phases).toHaveLength(2);
		expect(phases.every((p) => (p.data as { total: number }).total === 2)).toBe(true);
	});

	it('emits the document so far after each part', async () => {
		const { score, plan } = approved();
		const [, cello, piano] = plan.ensemble;
		const adapter = new MockAdapter([
			writes(cello.partId!, 0),
			finishes,
			writes(piano.partId!, 0),
			finishes
		]);
		const progress: { doc: Score; done: string[] }[] = [];

		await run(adapter, {
			score,
			plan,
			onEvent: (type, data) => {
				if (type === 'progress') progress.push(data as { doc: Score; done: string[] });
			}
		});

		expect(progress).toHaveLength(2);
		expect(progress[1].done).toHaveLength(2);
	});

	it('checks before every part, not once for the run', async () => {
		// run.ts checks the budget once when a job starts, which for a five-part
		// arrangement leaves the cap four calls behind the spending.
		const { score, plan } = approved();
		const [, cello, piano] = plan.ensemble;
		const adapter = new MockAdapter([
			writes(cello.partId!, 0),
			finishes,
			writes(piano.partId!, 0),
			finishes
		]);
		let checks = 0;

		await run(adapter, { score, plan, onBeforeChunk: () => void checks++ });
		expect(checks).toBe(2);
	});

	it('stops where the budget runs out, keeping earlier parts', async () => {
		const { score, plan } = approved();
		const [, cello, piano] = plan.ensemble;
		const adapter = new MockAdapter([
			writes(cello.partId!, 0),
			finishes,
			writes(piano.partId!, 0),
			finishes
		]);
		let calls = 0;

		const result = await run(adapter, {
			score,
			plan,
			onBeforeChunk: () => {
				if (++calls > 1) throw new Error('AI budget reached');
			}
		});

		expect(result.stopReason).toBe('budget');
		expect(result.ops).toHaveLength(1);
		expect(result.done).toEqual([cello.partId]);
		expect(adapter.requests).toHaveLength(2);
	});

	it('caps operations across the whole run, not per part', async () => {
		const { score, plan } = approved();
		const [, cello, piano] = plan.ensemble;
		const adapter = new MockAdapter([
			writes(cello.partId!, 0),
			finishes,
			writes(piano.partId!, 0),
			finishes
		]);

		const result = await run(adapter, { score, plan, maxOps: 1 });

		expect(result.stopReason).toBe('max_ops');
		expect(result.ops).toHaveLength(1);
		expect(result.warnings.join(' ')).toContain('across the whole run');
	});

	it('keeps the parts already written when a call throws', async () => {
		// Losing a finished part because the next call dropped its connection
		// would be the worst possible reading of "one commit", and would make
		// per-part accept and reject a strange promise to have made.
		const { score, plan } = approved();
		const [, cello] = plan.ensemble;
		const adapter = new MockAdapter([
			writes(cello.partId!, 0),
			finishes,
			{ error: 'connection reset' }
		]);

		const result = await run(adapter, { score, plan });

		expect(result.stopReason).toBe('failed');
		expect(result.ops).toHaveLength(1);
		expect(result.done).toEqual([cello.partId]);
		expect(result.warnings.join(' ')).toContain('connection reset');
	});

	it('stops on an aborted signal without collecting ops', async () => {
		const { score, plan } = approved();
		const [, cello] = plan.ensemble;
		const adapter = new MockAdapter([writes(cello.partId!, 0), finishes]);
		const controller = new AbortController();
		controller.abort();

		const result = await run(adapter, { score, plan, signal: controller.signal });

		expect(result.stopReason).toBe('aborted');
		expect(result.ops).toEqual([]);
		expect(adapter.requests).toHaveLength(0);
	});

	it('says so when a part is added that the plan did not name', async () => {
		// The epic's first gotcha: the ensemble was decided in the Plan, and an
		// instrument that appears here is a plan change. Reported rather than
		// reverted — reverting would leave notes pointing at a part that had
		// been taken away again.
		const { score, plan } = approved();
		const [, cello] = plan.ensemble;
		const adapter = new MockAdapter([
			{
				toolCalls: [
					{
						name: 'add_part',
						arguments: JSON.stringify({ name: 'Harp', instrument: 'Orchestral Harp' })
					}
				]
			},
			finishes,
			writes(cello.partId!, 0),
			finishes
		]);

		const result = await run(adapter, { score, plan });

		expect(result.warnings.join(' ')).toContain('which the plan did not name');
		expect(result.warnings.join(' ')).toContain('Harp');
		// Kept, not discarded.
		expect(result.working.parts.some((p) => p.name === 'Harp')).toBe(true);
	});

	it('says so when a run changes the melody it was told to leave alone', async () => {
		// Nothing enforces the instruction, and a silently rewritten tune is the
		// worst outcome of a stage whose premise is that the melody was approved.
		const { score, plan } = approved();
		const [flute, cello] = plan.ensemble;
		const withTune = applyOps(score, [
			{
				op: 'insert_notes',
				args: { partId: flute.partId!, notes: [{ tick: 0, dur: 480, pitches: [72] }] }
			}
		]).score;

		const adapter = new MockAdapter([
			{
				toolCalls: [
					{
						name: 'transpose',
						arguments: JSON.stringify({
							semitones: 5,
							selection: { partIds: [flute.partId!] }
						})
					}
				]
			},
			finishes,
			writes(cello.partId!, 0),
			finishes
		]);

		const result = await run(adapter, { score: withTune, plan });
		expect(result.warnings.join(' ')).toContain('also changed the melody');
	});

	it('reports a part written outside its instrument range', async () => {
		// The check `Orchestrate as…` has always asked for. A cello written an
		// octave too low used to be caught by nothing at all.
		const { score, plan } = approved();
		const [, cello] = plan.ensemble;
		const adapter = new MockAdapter([writes(cello.partId!, 0, 24), finishes]);

		const result = await run(adapter, {
			score,
			plan,
			chunks: partChunks(score, plan, plan.ensemble[0].partId!, [cello.partId!])
		});

		expect(result.warnings.join(' ')).toContain('Cello');
		expect(result.warnings.join(' ')).toContain('below');
	});

	it('separates writing nothing from having every edit rejected', async () => {
		// "It read the score, analysed the range and then nothing" is the second
		// of these, and the two need different answers.
		const { score, plan } = approved();
		const [, cello] = plan.ensemble;

		const silent = new MockAdapter([{ content: 'I would rather not.', finishReason: 'stop' }]);
		const quiet = await run(silent, {
			score,
			plan,
			chunks: partChunks(score, plan, plan.ensemble[0].partId!, [cello.partId!])
		});
		expect(quiet.warnings.join(' ')).toContain('wrote nothing');

		const missing = new MockAdapter([
			{
				toolCalls: [
					{
						name: 'transpose',
						arguments: JSON.stringify({ semitones: 2, selection: { noteIds: ['nope'] } })
					}
				]
			},
			finishes
		]);
		const rejected = await run(missing, {
			score,
			plan,
			chunks: partChunks(score, plan, plan.ensemble[0].partId!, [cello.partId!])
		});
		expect(rejected.warnings.join(' ')).toContain('rejected');
	});

	it('appends the style reference to every part', async () => {
		// The brief is the one place the person actually named a style, and a
		// pipeline run has no control parameters for skills.ts to read it from.
		const { score, plan } = approved();
		const [, cello, piano] = plan.ensemble;
		const adapter = new MockAdapter([
			writes(cello.partId!, 0),
			finishes,
			writes(piano.partId!, 0),
			finishes
		]);

		await run(adapter, {
			score,
			plan,
			styleReference: '<style_reference name="bossa-nova">…</style_reference>'
		});

		for (const i of [0, 2]) {
			expect(adapter.requests[i].messages[1].content ?? '').toContain('bossa-nova');
		}
	});
});
