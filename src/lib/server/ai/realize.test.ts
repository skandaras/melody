import { describe, it, expect } from 'vitest';
import { applyOps } from '$lib/score/apply.js';
import { chunksFor } from '$lib/pipeline/realize.js';
import { planToOps, withCreatedIds } from '$lib/pipeline/plan.js';
import { emptyPlan, type Plan } from '$lib/pipeline/types.js';
import { emptyScore, type Score } from '$lib/score/types.js';
import { MockAdapter, type ScriptedTurn } from './mock.js';
import { realizeChunks } from './realize.js';

/**
 * The chunked run.
 *
 * Everything here works against a score that has really been through plan
 * approval, because the design rests on approval having written the section
 * ticks — hand-built sections would prove nothing about the join.
 */

function approved(sections: Plan['sections'] = defaultSections()): { score: Score; plan: Plan } {
	const plan: Plan = {
		...emptyPlan(),
		title: 'Rain',
		ensemble: [{ name: 'Piano', instrument: 'Acoustic Grand Piano' }],
		sections
	};
	const before = emptyScore();
	const result = applyOps(before, planToOps(before, plan));
	return { score: result.score, plan: withCreatedIds(plan, result.diff.created) };
}

function defaultSections(): Plan['sections'] {
	return [
		{ name: 'Verse', bars: 4, harmony: 'i-VI', role: 'statement' },
		{ name: 'Chorus', bars: 4, harmony: 'VI-i', role: 'lift' }
	];
}

/** A turn that writes one note at `tick` into the melody part. */
function writes(partId: string, tick: number): ScriptedTurn {
	return {
		toolCalls: [
			{
				name: 'insert_notes',
				arguments: JSON.stringify({
					partId,
					notes: [{ tick, dur: 480, pitches: ['C4'] }]
				})
			}
		]
	};
}

/** The turn after a tool call, ending the loop. */
const finishes: ScriptedTurn = { content: 'Done.', finishReason: 'stop' };

function run(adapter: MockAdapter, over: Partial<Parameters<typeof realizeChunks>[0]> = {}) {
	const { score, plan } = over.score && over.plan ? { score: over.score, plan: over.plan } : approved();
	const partId = score.parts[0].id;
	return realizeChunks({
		adapter,
		systemPrompt: 'You write sections.',
		score,
		plan,
		chunks: chunksFor(score, plan, 8),
		partId,
		maxIterations: 4,
		maxOps: 400,
		...over
	});
}

describe('realizeChunks', () => {
	it('writes each section and collects the ops for one commit', async () => {
		const { score, plan } = approved();
		const partId = score.parts[0].id;
		const adapter = new MockAdapter([
			writes(partId, 0),
			finishes,
			writes(partId, 7680),
			finishes
		]);

		const result = await run(adapter, { score, plan });

		expect(result.stopReason).toBe('done');
		expect(result.ops).toHaveLength(2);
		expect(result.done).toHaveLength(2);
		// The working score carries both, ready for a single commitOps.
		const notes = result.working.parts[0].voices[0].events;
		expect(notes).toHaveLength(2);
	});

	it('applies chunk one before building chunk two, so the tail is visible', async () => {
		// The failure this guards is silent: without applying between chunks,
		// every chunk is written against the original empty score and the prompt's
		// "connect to what came before" has nothing to connect to. The only place
		// it shows is in what the second request was actually told.
		const { score, plan } = approved();
		const partId = score.parts[0].id;
		const adapter = new MockAdapter([
			writes(partId, 7680 - 480),
			finishes,
			writes(partId, 7680),
			finishes
		]);

		await run(adapter, { score, plan });

		const secondChunkOpening = adapter.requests[2].messages[1].content ?? '';
		expect(secondChunkOpening).toContain('The bars immediately before this section:');
		// The note chunk one wrote is in chunk two's prompt.
		expect(secondChunkOpening).toContain('@7200');
	});

	it('sends a byte-identical tool list on every call', async () => {
		// tools.ts sorts and fixes the list because it renders at the very front
		// of the prompt: a list that varied per chunk would invalidate the cached
		// prefix on every single call of the run.
		const { score, plan } = approved();
		const partId = score.parts[0].id;
		const adapter = new MockAdapter([writes(partId, 0), finishes, writes(partId, 7680), finishes]);

		await run(adapter, { score, plan });

		const shapes = adapter.requests.map((r) => JSON.stringify(r.tools));
		expect(new Set(shapes).size).toBe(1);
	});

	it('declares one phase per chunk before writing anything', async () => {
		const { score, plan } = approved();
		const partId = score.parts[0].id;
		const adapter = new MockAdapter([writes(partId, 0), finishes, writes(partId, 7680), finishes]);
		const events: { type: string; data: unknown }[] = [];

		await run(adapter, {
			score,
			plan,
			onEvent: (type, data) => events.push({ type, data })
		});

		const phases = events.filter((e) => e.type === 'phase');
		expect(phases).toHaveLength(2);
		// An honest denominator from the first frame, which is the whole point of
		// chunking by section rather than by bar count.
		expect(phases.every((p) => (p.data as { total: number }).total === 2)).toBe(true);
	});

	it('emits the document so far after each chunk', async () => {
		const { score, plan } = approved();
		const partId = score.parts[0].id;
		const adapter = new MockAdapter([writes(partId, 0), finishes, writes(partId, 7680), finishes]);
		const progress: { doc: Score; done: string[] }[] = [];

		await run(adapter, {
			score,
			plan,
			onEvent: (type, data) => {
				if (type === 'progress') progress.push(data as { doc: Score; done: string[] });
			}
		});

		expect(progress).toHaveLength(2);
		expect(progress[0].doc.parts[0].voices[0].events).toHaveLength(1);
		expect(progress[1].doc.parts[0].voices[0].events).toHaveLength(2);
		expect(progress[1].done).toHaveLength(2);
	});

	it('checks before every chunk, not once for the run', async () => {
		const { score, plan } = approved();
		const partId = score.parts[0].id;
		const adapter = new MockAdapter([writes(partId, 0), finishes, writes(partId, 7680), finishes]);
		let checks = 0;

		await run(adapter, { score, plan, onBeforeChunk: () => void checks++ });
		expect(checks).toBe(2);
	});

	it('stops at the chunk where the budget runs out, keeping earlier work', async () => {
		const { score, plan } = approved();
		const partId = score.parts[0].id;
		const adapter = new MockAdapter([writes(partId, 0), finishes, writes(partId, 7680), finishes]);
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
		expect(result.warnings.join(' ')).toContain('budget');
		// Only the first chunk was ever sent.
		expect(adapter.requests).toHaveLength(2);
	});

	it('caps operations across the whole run, not per chunk', async () => {
		// maxOpsPerTurn is a per-loop limit, so without an accumulated budget six
		// chunks could land 2400 ops in one commit nobody could review.
		const { score, plan } = approved();
		const partId = score.parts[0].id;
		const adapter = new MockAdapter([writes(partId, 0), finishes, writes(partId, 7680), finishes]);

		const result = await run(adapter, { score, plan, maxOps: 1 });

		expect(result.stopReason).toBe('max_ops');
		expect(result.ops).toHaveLength(1);
		expect(result.warnings.join(' ')).toContain('across the whole run');
	});

	it('stops on an aborted signal without collecting more ops', async () => {
		const { score, plan } = approved();
		const partId = score.parts[0].id;
		const adapter = new MockAdapter([writes(partId, 0), finishes]);
		const controller = new AbortController();
		controller.abort();

		const result = await run(adapter, { score, plan, signal: controller.signal });

		expect(result.stopReason).toBe('aborted');
		expect(result.ops).toHaveLength(0);
		expect(adapter.requests).toHaveLength(0);
	});

	it('names a chunk that wrote nothing rather than passing over it', async () => {
		const { score, plan } = approved();
		const partId = score.parts[0].id;
		const adapter = new MockAdapter([
			{ content: 'I had a look at the harmony.', finishReason: 'stop' },
			writes(partId, 7680),
			finishes
		]);

		const result = await run(adapter, { score, plan });

		expect(result.done).toHaveLength(1);
		expect(result.warnings.join(' ')).toContain('Verse');
		// The run carries on to the next section rather than giving up.
		expect(result.ops).toHaveLength(1);
	});

	it('reports rejected edits differently from an answer with no edits', async () => {
		// "It tried four edits and every one matched nothing" is what looked, from
		// outside, like reading the score and then doing nothing at all.
		const { score, plan } = approved();
		const adapter = new MockAdapter([
			{
				toolCalls: [
					{
						name: 'insert_notes',
						arguments: JSON.stringify({ partId: 'part-gone', notes: [{ tick: 0, dur: 480, pitches: ['C4'] }] })
					}
				]
			},
			{ content: 'Could not.', finishReason: 'stop' },
			{ content: 'Nor this one.', finishReason: 'stop' }
		]);

		const result = await run(adapter, { score, plan });
		expect(result.warnings.join(' ')).toContain('rejected');
	});

	it('tells each chunk the window and the single part it may write to', async () => {
		const { score, plan } = approved();
		const partId = score.parts[0].id;
		const adapter = new MockAdapter([writes(partId, 0), finishes, writes(partId, 7680), finishes]);

		await run(adapter, { score, plan });

		const first = adapter.requests[0].messages[1].content ?? '';
		expect(first).toContain(`Write into part ${partId} only`);
		expect(first).toContain('from tick 0 up to but not including tick 7680');
	});

	it('forwards the hummed theme to every chunk', async () => {
		const { score, plan } = approved();
		const seeded = applyOps(score, [
			{ op: 'add_part', args: { name: 'Voice', instrument: 'Violin' } }
		]).score;
		const motifPartId = seeded.parts[1].id;
		const withMotif = applyOps(seeded, [
			{ op: 'insert_notes', args: { partId: motifPartId, notes: [{ tick: 0, dur: 480, pitches: ['E4'] }] } }
		]).score;
		const partId = withMotif.parts[0].id;

		const adapter = new MockAdapter([writes(partId, 0), finishes, writes(partId, 7680), finishes]);
		await run(adapter, { score: withMotif, plan, partId, motifPartId });

		// Chunk five forgetting the theme is exactly what forwarding prevents, so
		// it has to be in the last chunk as well as the first.
		for (const i of [0, 2]) {
			expect(adapter.requests[i].messages[1].content).toContain('The theme this piece is built on:');
		}
	});

	it('keeps what earlier chunks wrote when a later one fails', async () => {
		// Sections are the unit of this stage precisely so a run that dies partway
		// leaves usable work. Losing three finished sections because the fourth
		// call dropped its connection would be the worst reading of "one commit".
		const { score, plan } = approved([
			{ name: 'Verse', bars: 4, harmony: '', role: '' },
			{ name: 'Chorus', bars: 4, harmony: '', role: '' }
		]);
		const partId = score.parts[0].id;
		const adapter = new MockAdapter([
			writes(partId, 0),
			finishes,
			{ error: 'the connection dropped' }
		]);

		const result = await run(adapter, { score, plan });

		expect(result.stopReason).toBe('failed');
		expect(result.ops).toHaveLength(1);
		expect(result.done).toEqual([plan.sections[0].sectionId]);
		expect(result.working.parts[0].voices[0].events).toHaveLength(1);
		expect(result.warnings.join(' ')).toContain('the connection dropped');
	});

	it('names replace_range when rewriting a section that already has notes', async () => {
		// insert_notes adds to what is there, so a rewrite that reached for it
		// would layer the new phrase on top of the old one and sound like both at
		// once. This is exactly the moment not to leave the choice to inference.
		const { score, plan } = approved();
		const partId = score.parts[0].id;
		const filled = applyOps(score, [
			{ op: 'insert_notes', args: { partId, notes: [{ tick: 0, dur: 480, pitches: ['C4'] }] } }
		]).score;

		const adapter = new MockAdapter([writes(partId, 0), finishes, writes(partId, 7680), finishes]);
		await run(adapter, { score: filled, plan });

		const first = adapter.requests[0].messages[1].content ?? '';
		expect(first).toContain('This section already has notes in it:');
		expect(first).toContain('Use replace_range');
		expect(first).toContain('insert_notes would add your new phrase on top');

		// The empty second section gets no such instruction — there is nothing
		// there to replace, and telling it otherwise would be noise.
		expect(adapter.requests[2].messages[1].content).not.toContain('Use replace_range');
	});

	it('passes free-text direction through to the chunk', async () => {
		const { score, plan } = approved();
		const partId = score.parts[0].id;
		const adapter = new MockAdapter([writes(partId, 0), finishes, writes(partId, 7680), finishes]);

		await run(adapter, { score, plan, instruction: 'lift the chorus' });
		expect(adapter.requests[0].messages[1].content).toContain('lift the chorus');
	});
});
