import { describe, it, expect } from 'vitest';
import { OpenRouterAdapter } from './openrouter.js';
import { needsCacheBreakpoints, worthCaching } from './cache.js';
import { opTools } from './tools.js';
import type { ChatMessage } from './types.js';

/**
 * The request body, tested without a transport.
 *
 * `require_parameters` is the one that matters most: without it OpenRouter can
 * route a tool-bearing request to a provider that ignores tools, and the
 * symptom is a model that "won't follow instructions" rather than anything
 * that looks like a routing bug.
 */

const adapter = (model = 'anthropic/claude-opus-5', fallbacks: string[] = []) =>
	new OpenRouterAdapter({ apiKey: 'sk-test', model, fallbackModels: fallbacks });

const user: ChatMessage[] = [{ role: 'user', content: 'make it brighter' }];

describe('request body', () => {
	it('restricts routing to providers that honour what we send', () => {
		const body = adapter().body({ messages: user, tools: opTools() }, false);
		expect(body.provider).toEqual({ require_parameters: true });
	});

	it('always asks for usage accounting, so cost is measured not estimated', () => {
		expect(adapter().body({ messages: user }, false).usage).toEqual({ include: true });
	});

	it('sends the model and its fallback list', () => {
		const body = adapter('anthropic/claude-opus-5', ['openai/gpt-5']).body({ messages: user }, false);
		expect(body.model).toBe('anthropic/claude-opus-5');
		expect(body.models).toEqual(['openai/gpt-5']);
	});

	it('omits the fallback list when there is none', () => {
		expect(adapter().body({ messages: user }, false).models).toBeUndefined();
	});

	it('passes tools through with tool_choice', () => {
		const body = adapter().body({ messages: user, tools: opTools() }, false);
		expect(Array.isArray(body.tools)).toBe(true);
		expect(body.tool_choice).toBe('auto');
	});

	it('omits tool_choice when no tools are sent', () => {
		const body = adapter().body({ messages: user }, false);
		expect(body.tools).toBeUndefined();
		expect(body.tool_choice).toBeUndefined();
	});

	it('builds a strict structured-output request', () => {
		const body = adapter().body(
			{ messages: user, responseSchema: { name: 'plan', schema: { type: 'object' } } },
			false
		);
		expect(body.response_format).toEqual({
			type: 'json_schema',
			json_schema: { name: 'plan', strict: true, schema: { type: 'object' } }
		});
	});
});

describe('reasoning parameter', () => {
	it('hides reasoning by default, so we do not pay to ship it back', () => {
		expect(adapter().body({ messages: user }, false).reasoning).toEqual({
			enabled: true,
			exclude: true
		});
	});

	it('returns reasoning when explicitly asked for', () => {
		const body = adapter().body({ messages: user, reasoning: 'on', effort: 'high' }, false);
		expect(body.reasoning).toEqual({ enabled: true, effort: 'high' });
	});

	it('turns reasoning off entirely', () => {
		expect(adapter().body({ messages: user, reasoning: 'off' }, false).reasoning).toEqual({
			enabled: false
		});
	});

	it('carries the effort level through', () => {
		const body = adapter().body({ messages: user, effort: 'minimal', reasoning: 'on' }, false);
		expect((body.reasoning as Record<string, unknown>).effort).toBe('minimal');
	});
});

describe('message mapping', () => {
	it('sends null content on an assistant turn that only calls tools', () => {
		const body = adapter().body(
			{
				messages: [
					{
						role: 'assistant',
						content: null,
						toolCalls: [{ id: 'a', name: 'transpose', arguments: '{}' }]
					}
				]
			},
			false
		);
		const message = (body.messages as Record<string, unknown>[])[0];
		expect(message.content).toBeNull();
		expect(message.tool_calls).toEqual([
			{ id: 'a', type: 'function', function: { name: 'transpose', arguments: '{}' } }
		]);
	});

	it('ties a tool result back to its call', () => {
		const body = adapter().body(
			{ messages: [{ role: 'tool', toolCallId: 'a', content: 'Transposed 2 notes' }] },
			false
		);
		expect((body.messages as Record<string, unknown>[])[0]).toEqual({
			role: 'tool',
			content: 'Transposed 2 notes',
			tool_call_id: 'a'
		});
	});
});

describe('cache breakpoints', () => {
	const long = 'x'.repeat(5000);

	it('marks the stable prefix for a family that needs it', () => {
		const body = adapter('anthropic/claude-opus-5').body(
			{ messages: [{ role: 'system', content: long, cacheBreakpoint: true }] },
			false
		);
		const content = (body.messages as Record<string, unknown>[])[0].content;
		expect(content).toEqual([
			{ type: 'text', text: long, cache_control: { type: 'ephemeral' } }
		]);
	});

	it('leaves it as a plain string for families that cache automatically', () => {
		const body = adapter('openai/gpt-5').body(
			{ messages: [{ role: 'system', content: long, cacheBreakpoint: true }] },
			false
		);
		expect((body.messages as Record<string, unknown>[])[0].content).toBe(long);
	});

	/**
	 * The regression that mattered: melody's system prompts are around 1k
	 * characters, well under the threshold, while the tool payload in front of
	 * them is tens of thousands. Judged on the prompt alone, no agent turn ever
	 * got a breakpoint and every iteration re-paid for the whole registry.
	 */
	it('counts the tool payload toward the threshold', () => {
		const shortPrompt = 'x'.repeat(600);
		const tools = [
			{
				type: 'function' as const,
				function: {
					name: 'insert_notes',
					description: 'y'.repeat(8000),
					parameters: { type: 'object', properties: {}, required: [] },
					strict: true as const
				}
			}
		];

		const withoutTools = adapter('anthropic/claude-opus-5').body(
			{ messages: [{ role: 'system', content: shortPrompt, cacheBreakpoint: true }] },
			false
		);
		expect((withoutTools.messages as Record<string, unknown>[])[0].content).toBe(shortPrompt);

		const withTools = adapter('anthropic/claude-opus-5').body(
			{ messages: [{ role: 'system', content: shortPrompt, cacheBreakpoint: true }], tools },
			false
		);
		expect((withTools.messages as Record<string, unknown>[])[0].content).toEqual([
			{ type: 'text', text: shortPrompt, cache_control: { type: 'ephemeral' } }
		]);
	});

	it('does not mark a prefix too short to be worth caching', () => {
		const body = adapter('anthropic/claude-opus-5').body(
			{ messages: [{ role: 'system', content: 'short', cacheBreakpoint: true }] },
			false
		);
		expect((body.messages as Record<string, unknown>[])[0].content).toBe('short');
	});

	it('knows which families need explicit breakpoints', () => {
		expect(needsCacheBreakpoints('anthropic/claude-opus-5')).toBe(true);
		expect(needsCacheBreakpoints('qwen/qwen3-max')).toBe(true);
		expect(needsCacheBreakpoints('openai/gpt-5')).toBe(false);
		expect(needsCacheBreakpoints('google/gemini-3-pro')).toBe(false);
	});

	it('is case-insensitive about the slug', () => {
		expect(needsCacheBreakpoints('Anthropic/Claude-Opus-5')).toBe(true);
	});

	it('only bothers caching a prefix big enough to pay for itself', () => {
		expect(worthCaching('x'.repeat(100))).toBe(false);
		expect(worthCaching('x'.repeat(5000))).toBe(true);
	});
});

describe('streaming flag', () => {
	it('is set only when streaming was requested', () => {
		expect(adapter().body({ messages: user }, true).stream).toBe(true);
		expect(adapter().body({ messages: user }, false).stream).toBe(false);
	});
});
