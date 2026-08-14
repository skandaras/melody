import { describe, it, expect } from 'vitest';
import {
	applyEvent,
	collectToolCalls,
	finishCompletion,
	newStreamState,
	parseUsage,
	sseLines
} from './stream.js';

/**
 * Driven by recorded fragment shapes rather than a live call. This is the code
 * most likely to break subtly, and its symptom — a tool call that never runs —
 * looks like a prompting problem rather than a parsing one, so it gets the
 * most detailed coverage in the AI layer.
 */

/** A byte stream from string chunks, split wherever the caller says. */
function streamOf(chunks: string[]): ReadableStream<Uint8Array> {
	const enc = new TextEncoder();
	return new ReadableStream({
		start(controller) {
			for (const c of chunks) controller.enqueue(enc.encode(c));
			controller.close();
		}
	});
}

async function collect(stream: ReadableStream<Uint8Array>): Promise<string[]> {
	const out: string[] = [];
	for await (const line of sseLines(stream)) out.push(line);
	return out;
}

describe('sseLines', () => {
	it('yields data payloads and stops at the terminator', async () => {
		expect(
			await collect(streamOf(['data: {"a":1}\n\n', 'data: {"a":2}\n\n', 'data: [DONE]\n\n']))
		).toEqual(['{"a":1}', '{"a":2}']);
	});

	it('skips OpenRouter keep-alive comments', async () => {
		// A queued request emits these until the upstream provider responds.
		const lines = await collect(
			streamOf([': OPENROUTER PROCESSING\n\n', ': OPENROUTER PROCESSING\n\n', 'data: {"a":1}\n\n'])
		);
		expect(lines).toEqual(['{"a":1}']);
	});

	it('reassembles a payload split across chunk boundaries', async () => {
		// The network splits wherever it likes, including mid-token.
		expect(await collect(streamOf(['data: {"a"', ':1}\n', '\ndata: [DONE]\n\n']))).toEqual([
			'{"a":1}'
		]);
	});

	it('handles several events arriving in one chunk', async () => {
		expect(await collect(streamOf(['data: {"a":1}\n\ndata: {"a":2}\n\n']))).toEqual([
			'{"a":1}',
			'{"a":2}'
		]);
	});

	it('ignores anything that is not a data line', async () => {
		expect(await collect(streamOf(['event: message\n', 'id: 1\n', 'data: {"a":1}\n\n']))).toEqual([
			'{"a":1}'
		]);
	});

	it('ends cleanly when the stream closes without a terminator', async () => {
		expect(await collect(streamOf(['data: {"a":1}\n\n']))).toEqual(['{"a":1}']);
	});
});

describe('applyEvent — text', () => {
	it('accumulates content deltas in order', () => {
		const s = newStreamState();
		for (const text of ['Here', ' is', ' a melody']) {
			applyEvent(s, { choices: [{ delta: { content: text } }] });
		}
		expect(s.content).toBe('Here is a melody');
	});

	it('keeps reasoning separate from the answer', () => {
		const s = newStreamState();
		applyEvent(s, { choices: [{ delta: { reasoning: 'thinking...' } }] });
		applyEvent(s, { choices: [{ delta: { content: 'answer' } }] });
		expect(s.reasoning).toBe('thinking...');
		expect(s.content).toBe('answer');
	});

	it('records which model and provider actually served the request', () => {
		const s = newStreamState();
		applyEvent(s, { model: 'anthropic/claude-opus-5', provider: 'Anthropic' });
		expect(s.model).toBe('anthropic/claude-opus-5');
		expect(s.provider).toBe('Anthropic');
	});

	it('ignores an unrecognised finish reason rather than trusting it', () => {
		const s = newStreamState();
		applyEvent(s, { choices: [{ finish_reason: 'something_new' }] });
		expect(s.finishReason).toBe('stop');
	});
});

describe('applyEvent — tool call fragments', () => {
	it('assembles one call from many argument fragments', () => {
		const s = newStreamState();
		// Exactly how a provider streams it: id and name once, then the
		// argument JSON a few characters at a time.
		applyEvent(s, {
			choices: [
				{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'transpose' } }] } }
			]
		});
		for (const frag of ['{"sem', 'itones', '": 5}']) {
			applyEvent(s, {
				choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: frag } }] } }]
			});
		}

		expect(collectToolCalls(s)).toEqual([
			{ id: 'call_1', name: 'transpose', arguments: '{"semitones": 5}' }
		]);
	});

	it('keeps two parallel calls apart by index, even interleaved', () => {
		const s = newStreamState();
		applyEvent(s, {
			choices: [
				{
					delta: {
						tool_calls: [
							{ index: 0, id: 'a', function: { name: 'transpose' } },
							{ index: 1, id: 'b', function: { name: 'quantise' } }
						]
					}
				}
			]
		});
		applyEvent(s, {
			choices: [{ delta: { tool_calls: [{ index: 1, function: { arguments: '{"grid"' } }] } }]
		});
		applyEvent(s, {
			choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"sem' } }] } }]
		});
		applyEvent(s, {
			choices: [{ delta: { tool_calls: [{ index: 1, function: { arguments: ':16}' } }] } }]
		});
		applyEvent(s, {
			choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'itones":2}' } }] } }]
		});

		expect(collectToolCalls(s)).toEqual([
			{ id: 'a', name: 'transpose', arguments: '{"semitones":2}' },
			{ id: 'b', name: 'quantise', arguments: '{"grid":16}' }
		]);
	});

	it('returns calls in index order regardless of arrival order', () => {
		const s = newStreamState();
		applyEvent(s, {
			choices: [{ delta: { tool_calls: [{ index: 2, id: 'c', function: { name: 'third' } }] } }]
		});
		applyEvent(s, {
			choices: [{ delta: { tool_calls: [{ index: 0, id: 'a', function: { name: 'first' } }] } }]
		});
		expect(collectToolCalls(s).map((c) => c.name)).toEqual(['first', 'third']);
	});

	it('falls back to position when a provider omits the index', () => {
		const s = newStreamState();
		applyEvent(s, {
			choices: [{ delta: { tool_calls: [{ id: 'a', function: { name: 'transpose' } }] } }]
		});
		applyEvent(s, {
			choices: [{ delta: { tool_calls: [{ function: { arguments: '{"semitones":1}' } }] } }]
		});
		expect(collectToolCalls(s)).toEqual([
			{ id: 'a', name: 'transpose', arguments: '{"semitones":1}' }
		]);
	});

	it('synthesises an id when the provider omits one', () => {
		const s = newStreamState();
		applyEvent(s, {
			choices: [{ delta: { tool_calls: [{ index: 0, function: { name: 'transpose' } }] } }]
		});
		expect(collectToolCalls(s)[0].id).toBe('call_0');
	});

	it('drops a fragment that never named a function', () => {
		const s = newStreamState();
		applyEvent(s, {
			choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{}' } }] } }]
		});
		expect(collectToolCalls(s)).toEqual([]);
	});

	it('leaves malformed argument JSON intact for the caller to handle', () => {
		// Parsing is the loop's job — the parser must not swallow the evidence.
		const s = newStreamState();
		applyEvent(s, {
			choices: [
				{
					delta: {
						tool_calls: [{ index: 0, id: 'x', function: { name: 'transpose', arguments: '{"a":' } }]
					}
				}
			]
		});
		expect(collectToolCalls(s)[0].arguments).toBe('{"a":');
	});
});

describe('finishCompletion', () => {
	it('reports tool_calls whenever calls are present, whatever the label says', () => {
		// Some providers send finish_reason "stop" alongside tool calls.
		const s = newStreamState();
		applyEvent(s, {
			choices: [
				{
					delta: { tool_calls: [{ index: 0, id: 'a', function: { name: 'transpose' } }] },
					finish_reason: 'stop'
				}
			]
		});
		expect(finishCompletion(s).finishReason).toBe('tool_calls');
	});

	it('preserves a genuine length cut-off', () => {
		const s = newStreamState();
		applyEvent(s, { choices: [{ delta: { content: 'half a sen' }, finish_reason: 'length' }] });
		expect(finishCompletion(s).finishReason).toBe('length');
	});

	it('carries model, content and usage through', () => {
		const s = newStreamState();
		applyEvent(s, { model: 'openai/gpt-5', choices: [{ delta: { content: 'hi' } }] });
		applyEvent(s, { usage: { prompt_tokens: 10, completion_tokens: 2, cost: 0.0004 } });

		const done = finishCompletion(s);
		expect(done.model).toBe('openai/gpt-5');
		expect(done.content).toBe('hi');
		expect(done.usage.promptTokens).toBe(10);
		expect(done.usage.costUsd).toBeCloseTo(0.0004);
	});

	it('omits reasoning when none was returned', () => {
		expect(finishCompletion(newStreamState()).reasoning).toBeUndefined();
	});
});

describe('parseUsage', () => {
	it('reads cache accounting from prompt_tokens_details', () => {
		const u = parseUsage({
			prompt_tokens: 1200,
			completion_tokens: 300,
			prompt_tokens_details: { cached_tokens: 1000, cache_write_tokens: 200 },
			cost: 0.0123
		});
		expect(u).toEqual({
			promptTokens: 1200,
			completionTokens: 300,
			cacheReadTokens: 1000,
			cacheWriteTokens: 200,
			costUsd: 0.0123
		});
	});

	it('accepts cache fields at the top level too', () => {
		const u = parseUsage({ prompt_tokens: 5, cached_tokens: 4, cache_write_tokens: 1 });
		expect(u.cacheReadTokens).toBe(4);
		expect(u.cacheWriteTokens).toBe(1);
	});

	it('defaults missing counts to zero and an absent cost to null', () => {
		expect(parseUsage({})).toEqual({
			promptTokens: 0,
			completionTokens: 0,
			cacheReadTokens: 0,
			cacheWriteTokens: 0,
			costUsd: null
		});
	});

	it('ignores non-numeric junk rather than propagating NaN into the budget', () => {
		const u = parseUsage({ prompt_tokens: 'lots', cost: 'free' });
		expect(u.promptTokens).toBe(0);
		expect(u.costUsd).toBeNull();
	});
});
