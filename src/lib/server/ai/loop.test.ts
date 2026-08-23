import { describe, it, expect } from 'vitest';
import { runAgentLoop, type LoopEvent } from './loop.js';
import { MockAdapter, type ScriptedTurn } from './mock.js';
import { applyOps } from '$lib/score/apply.js';
import { emptyScore, type Score } from '$lib/score/types.js';

/**
 * The loop is where a misbehaving model meets a real document, so these tests
 * are mostly about what happens when the model is wrong: bad JSON, unknown
 * tools, arguments that fail validation, never stopping. None of those may
 * throw, and none may corrupt the score.
 */

function fixture(): Score {
	let s = emptyScore('Loop Test');
	s = applyOps(s, [{ op: 'add_part', args: { name: 'Piano', instrument: 'Acoustic Grand Piano' } }])
		.score;
	const partId = s.parts[0].id;
	return applyOps(s, [
		{
			op: 'insert_notes',
			args: {
				partId,
				notes: [
					{ tick: 0, dur: 480, pitches: ['C4'] },
					{ tick: 480, dur: 480, pitches: ['E4'] },
					{ tick: 960, dur: 480, pitches: ['G4'] }
				]
			}
		}
	]).score;
}

function run(turns: ScriptedTurn[], overrides: Partial<Parameters<typeof runAgentLoop>[0]> = {}) {
	const adapter = new MockAdapter(turns);
	const events: LoopEvent[] = [];
	const promise = runAgentLoop({
		adapter,
		systemPrompt: 'You edit music.',
		userPrompt: 'Make it brighter.',
		score: fixture(),
		maxIterations: 8,
		maxOps: 50,
		onEvent: (e) => events.push(e),
		...overrides
	});
	return { adapter, events, promise };
}

describe('runAgentLoop — normal flow', () => {
	it('returns immediately when the model just answers', async () => {
		const { promise, adapter } = run([{ content: 'Nothing to change.', finishReason: 'stop' }]);
		const r = await promise;

		expect(r.stopReason).toBe('done');
		expect(r.ops).toEqual([]);
		expect(r.summary).toBe('Nothing to change.');
		expect(adapter.callCount).toBe(1);
	});

	it('collects an op and stops when the model is finished', async () => {
		const { promise } = run([
			{ toolCalls: [{ name: 'transpose', arguments: '{"semitones":12}' }] },
			{ content: 'Raised an octave.', finishReason: 'stop' }
		]);
		const r = await promise;

		expect(r.stopReason).toBe('done');
		expect(r.ops).toEqual([{ op: 'transpose', args: { semitones: 12 } }]);
		expect(r.summary).toBe('Raised an octave.');
		expect(r.iterations).toBe(2);
	});

	it('accumulates several ops across turns in call order', async () => {
		const { promise } = run([
			{ toolCalls: [{ name: 'transpose', arguments: '{"semitones":2}' }] },
			{ toolCalls: [{ name: 'quantise', arguments: '{"grid":16}' }] },
			{ content: 'Done.', finishReason: 'stop' }
		]);
		const r = await promise;
		expect(r.ops.map((o) => o.op)).toEqual(['transpose', 'quantise']);
	});

	it('handles several tool calls in one turn', async () => {
		const { promise } = run([
			{
				toolCalls: [
					{ name: 'transpose', arguments: '{"semitones":1}' },
					{ name: 'humanise', arguments: '{"amount":0.2}' }
				]
			},
			{ content: 'Both applied.', finishReason: 'stop' }
		]);
		const r = await promise;
		expect(r.ops.map((o) => o.op)).toEqual(['transpose', 'humanise']);
	});

	it('replies to every tool call, so the conversation stays valid', async () => {
		const { promise, adapter } = run([
			{
				toolCalls: [
					{ name: 'transpose', arguments: '{"semitones":1}', id: 'a' },
					{ name: 'read_score', arguments: '{}', id: 'b' }
				]
			},
			{ content: 'Done.', finishReason: 'stop' }
		]);
		await promise;

		const second = adapter.requests[1].messages;
		const toolMessages = second.filter((m) => m.role === 'tool');
		expect(toolMessages.map((m) => m.toolCallId)).toEqual(['a', 'b']);
	});

	it('sums usage across every call', async () => {
		const { promise } = run([
			{ toolCalls: [{ name: 'transpose', arguments: '{"semitones":1}' }], usage: { costUsd: 0.01 } },
			{ content: 'Done.', finishReason: 'stop', usage: { costUsd: 0.02 } }
		]);
		const r = await promise;

		expect(r.usage.promptTokens).toBe(200);
		expect(r.usage.costUsd).toBeCloseTo(0.03);
	});
});

describe('runAgentLoop — streaming', () => {
	it('emits prose as deltas, not only at the end', async () => {
		const { promise, events } = run([{ content: 'Brightened the melody.', finishReason: 'stop' }]);
		await promise;

		const deltas = events.filter((e) => e.type === 'delta');
		expect(deltas.length).toBeGreaterThan(0);
		expect(deltas.map((d) => (d as { text: string }).text).join('')).toBe('Brightened the melody.');
	});

	it('starts each iteration with its own prose', async () => {
		const { promise, events } = run([
			{
				content: 'First I will look.',
				toolCalls: [{ id: 'c1', name: 'read_score', arguments: '{}' }],
				finishReason: 'tool_calls'
			},
			{ content: 'Now done.', finishReason: 'stop' }
		]);
		await promise;

		// Two iterations, each announcing itself before its own deltas arrive.
		const order = events.filter((e) => e.type === 'iteration' || e.type === 'delta').map((e) => e.type);
		expect(order[0]).toBe('iteration');
		expect(order).toContain('delta');
		expect(order.filter((t) => t === 'iteration')).toHaveLength(2);
	});

	/**
	 * A stream that ends without a done chunk is a dropped connection, not an
	 * empty answer. Reporting it as "the model said nothing" would throw away a
	 * turn that was paid for and give no clue why.
	 */
	it('reports a stream that ends without a result rather than treating it as silence', async () => {
		const adapter = new MockAdapter([{ content: 'x', finishReason: 'stop' }]);
		// eslint-disable-next-line require-yield
		adapter.stream = async function* () {
			return;
		};

		const r = await runAgentLoop({
			adapter,
			systemPrompt: 'S',
			userPrompt: 'U',
			score: fixture(),
			maxIterations: 4,
			maxOps: 50
		});

		expect(r.stopReason).toBe('truncated');
		expect(r.warnings.join(' ')).toMatch(/stream ended/i);
	});
});

describe('runAgentLoop — read-only tools', () => {
	it('answers read_score without recording an op', async () => {
		const { promise, adapter } = run([
			{ toolCalls: [{ name: 'read_score', arguments: '{}' }] },
			{ content: 'I see three notes.', finishReason: 'stop' }
		]);
		const r = await promise;

		expect(r.ops).toEqual([]);
		const reply = adapter.requests[1].messages.find((m) => m.role === 'tool');
		expect(reply?.content).toContain('@0');
		expect(reply?.content).toContain('60');
	});

	it('answers analyse_range with a key reading', async () => {
		const { promise, adapter } = run([
			{ toolCalls: [{ name: 'analyse_range', arguments: '{}' }] },
			{ content: 'ok', finishReason: 'stop' }
		]);
		await promise;
		expect(adapter.requests[1].messages.find((m) => m.role === 'tool')?.content).toContain('Key:');
	});

	it('answers list_instruments', async () => {
		const { promise, adapter } = run([
			{ toolCalls: [{ name: 'list_instruments', arguments: '{}' }] },
			{ content: 'ok', finishReason: 'stop' }
		]);
		await promise;
		expect(adapter.requests[1].messages.find((m) => m.role === 'tool')?.content).toContain('Violin');
	});
});

describe('runAgentLoop — misbehaving models', () => {
	it('turns malformed JSON into a correctable error rather than throwing', async () => {
		const { promise, adapter, events } = run([
			{ toolCalls: [{ name: 'transpose', arguments: '{"semitones":' }] },
			{ toolCalls: [{ name: 'transpose', arguments: '{"semitones":3}' }] },
			{ content: 'Fixed.', finishReason: 'stop' }
		]);
		const r = await promise;

		expect(r.ops).toEqual([{ op: 'transpose', args: { semitones: 3 } }]);
		expect(r.warnings.join(' ')).toContain('malformed JSON');
		expect(adapter.requests[1].messages.find((m) => m.role === 'tool')?.content).toContain(
			'not valid JSON'
		);
		expect(events.some((e) => e.type === 'tool' && !e.ok)).toBe(true);
	});

	it('reports an op that fails validation and keeps going', async () => {
		const { promise, adapter } = run([
			{ toolCalls: [{ name: 'set_instrument', arguments: '{"partId":"nope","volume":0.5}' }] },
			{ content: 'Understood.', finishReason: 'stop' }
		]);
		const r = await promise;

		expect(r.ops).toEqual([]);
		expect(r.warnings.length).toBeGreaterThan(0);
		expect(adapter.requests[1].messages.find((m) => m.role === 'tool')?.content).toContain('Error');
	});

	it('tells the model when an op matched nothing', async () => {
		// Ops no-op rather than throw on a missing target, so without this the
		// model would be told its edit succeeded and move on.
		const { promise, adapter } = run([
			{ toolCalls: [{ name: 'transpose', arguments: '{"selection":{"noteIds":["nope"]},"semitones":2}' }] },
			{ content: 'Retrying.', finishReason: 'stop' }
		]);
		const r = await promise;

		expect(r.ops).toEqual([]);
		expect(adapter.requests[1].messages.find((m) => m.role === 'tool')?.content).toContain(
			'matched nothing'
		);
	});

	it('shows the model its own pending edits when it reads back', async () => {
		// read_score reflects ops collected so far, so the model is not
		// reasoning against a document that is already out of date.
		const { promise, adapter } = run([
			{ toolCalls: [{ name: 'transpose', arguments: '{"semitones":12}' }] },
			{ toolCalls: [{ name: 'read_score', arguments: '{}' }] },
			{ content: 'Confirmed.', finishReason: 'stop' }
		]);
		await promise;

		const readBack = adapter.requests[2].messages.filter((m) => m.role === 'tool').at(-1)?.content;
		expect(readBack).toContain('72'); // C4 + 12
		expect(readBack).not.toContain(' 60 ');
	});

	it('rejects an unknown tool name without corrupting anything', async () => {
		const { promise } = run([
			{ toolCalls: [{ name: 'delete_everything', arguments: '{}' }] },
			{ content: 'Sorry.', finishReason: 'stop' }
		]);
		const r = await promise;
		expect(r.ops).toEqual([]);
		expect(r.stopReason).toBe('done');
	});

	it('strips the explicit nulls strict mode forces the model to send', async () => {
		const { promise } = run([
			{
				toolCalls: [
					{
						name: 'add_part',
						arguments: '{"name":"Cello","instrument":"Cello","clef":null,"isDrum":null}'
					}
				]
			},
			{ content: 'Added.', finishReason: 'stop' }
		]);
		const r = await promise;
		expect(r.ops[0].args).toEqual({ name: 'Cello', instrument: 'Cello' });
	});

	it('treats empty arguments as an empty object', async () => {
		const { promise } = run([
			{ toolCalls: [{ name: 'retrograde', arguments: '' }] },
			{ content: 'Reversed.', finishReason: 'stop' }
		]);
		const r = await promise;
		expect(r.ops).toEqual([{ op: 'retrograde', args: {} }]);
	});
});

describe('runAgentLoop — bounds', () => {
	it('stops a model that never finishes', async () => {
		const turns: ScriptedTurn[] = Array.from({ length: 20 }, () => ({
			toolCalls: [{ name: 'read_score', arguments: '{}' }]
		}));
		const { promise, adapter } = run(turns, { maxIterations: 3 });
		const r = await promise;

		expect(r.stopReason).toBe('max_iterations');
		expect(r.iterations).toBe(3);
		expect(adapter.callCount).toBe(3);
		expect(r.warnings.join(' ')).toContain('3 model round-trips');
	});

	it('does not call a single-turn call hitting its cap a warning', async () => {
		// A prompt-tier control is one round trip by design, so ending at the
		// cap is the normal path — warning about it would make every working
		// control look like it had a problem.
		const { promise } = run([{ toolCalls: [{ name: 'transpose', arguments: '{"semitones":2}' }] }], {
			maxIterations: 1
		});
		const r = await promise;

		expect(r.stopReason).toBe('max_iterations');
		expect(r.ops).toHaveLength(1);
		expect(r.warnings).toEqual([]);
	});

	it('stops a model that tries to rewrite the whole piece', async () => {
		const turns: ScriptedTurn[] = Array.from({ length: 10 }, () => ({
			toolCalls: [{ name: 'transpose', arguments: '{"semitones":1}' }]
		}));
		const { promise } = run(turns, { maxOps: 3 });
		const r = await promise;

		expect(r.stopReason).toBe('max_ops');
		expect(r.ops.length).toBeLessThanOrEqual(4);
		expect(r.warnings.join(' ')).toContain('3 operations');
	});

	it('reports a truncated answer honestly', async () => {
		const { promise } = run([{ content: 'I was about to', finishReason: 'length' }]);
		const r = await promise;

		expect(r.stopReason).toBe('truncated');
		expect(r.warnings.join(' ')).toContain('output tokens');
	});

	it('reports a content filter as a refusal', async () => {
		const { promise } = run([{ content: '', finishReason: 'content_filter' }]);
		expect((await promise).stopReason).toBe('refused');
	});

	it('stops when aborted', async () => {
		const controller = new AbortController();
		controller.abort();
		const { promise } = run([{ content: 'never runs', finishReason: 'stop' }], {
			signal: controller.signal
		});
		expect((await promise).stopReason).toBe('aborted');
	});
});

describe('runAgentLoop — the request it builds', () => {
	it('marks the system prompt as the cache breakpoint', async () => {
		const { promise, adapter } = run([{ content: 'ok', finishReason: 'stop' }]);
		await promise;

		const system = adapter.requests[0].messages[0];
		expect(system.role).toBe('system');
		expect(system.cacheBreakpoint).toBe(true);
	});

	it('sends the same tool list on every iteration, so the prefix stays cached', async () => {
		const { promise, adapter } = run([
			{ toolCalls: [{ name: 'read_score', arguments: '{}' }] },
			{ content: 'ok', finishReason: 'stop' }
		]);
		await promise;

		expect(JSON.stringify(adapter.requests[0].tools)).toBe(
			JSON.stringify(adapter.requests[1].tools)
		);
	});

	it('grows the conversation rather than restarting it', async () => {
		const { promise, adapter } = run([
			{ toolCalls: [{ name: 'read_score', arguments: '{}' }] },
			{ content: 'ok', finishReason: 'stop' }
		]);
		await promise;

		expect(adapter.requests[1].messages.length).toBeGreaterThan(
			adapter.requests[0].messages.length
		);
		expect(adapter.requests[1].messages[0]).toEqual(adapter.requests[0].messages[0]);
	});

	it('never mutates the caller’s score', async () => {
		const score = fixture();
		const snapshot = JSON.stringify(score);
		const { promise } = run(
			[
				{ toolCalls: [{ name: 'transpose', arguments: '{"semitones":5}' }] },
				{ content: 'ok', finishReason: 'stop' }
			],
			{ score }
		);
		await promise;
		expect(JSON.stringify(score)).toBe(snapshot);
	});

	it('produces ops that apply cleanly as one batch', async () => {
		const score = fixture();
		const { promise } = run(
			[
				{ toolCalls: [{ name: 'transpose', arguments: '{"semitones":2}' }] },
				{ toolCalls: [{ name: 'quantise', arguments: '{"grid":8}' }] },
				{ content: 'ok', finishReason: 'stop' }
			],
			{ score }
		);
		const r = await promise;

		const applied = applyOps(score, r.ops);
		expect(applied.errors).toEqual([]);
	});

	it('propagates a transport failure rather than silently returning nothing', async () => {
		const { promise } = run([{ error: 'OpenRouter 502: upstream unavailable' }]);
		await expect(promise).rejects.toThrow('502');
	});
});
