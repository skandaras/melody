import { describe, it, expect } from 'vitest';
import { MockAdapter } from './mock.js';
import { extractJson, runProse, runStructured, structuredContract } from './structured.js';

/**
 * The structured run, and the retry that exists because
 * `provider.require_parameters: true` plus reasoning plus a response schema is
 * the patchiest combination OpenRouter routes, and it fails hard.
 */

const schema = {
	name: 'plan',
	schema: { type: 'object', properties: { title: { type: 'string' } } }
};

const base = { systemPrompt: 'You plan music.', userPrompt: 'Something wistful.', schema };

describe('extractJson', () => {
	it('reads a bare object', () => {
		expect(extractJson('{"title":"Rain"}')).toEqual({ title: 'Rain' });
	});

	it('reads a fenced object, which is what a model reaches for without a schema', () => {
		expect(extractJson('```json\n{"title":"Rain"}\n```')).toEqual({ title: 'Rain' });
		expect(extractJson('```\n{"title":"Rain"}\n```')).toEqual({ title: 'Rain' });
	});

	it('digs an object out of prose on both sides', () => {
		const said = 'Here is the plan:\n{"title":"Rain"}\nLet me know what you think.';
		expect(extractJson(said)).toEqual({ title: 'Rain' });
	});

	it('does not swallow a trailing explanation into the parse', () => {
		// Scanning to the last brace instead of the matching one would take
		// "…} … {" as one object and fail the whole extraction.
		const said = '{"title":"Rain"} — I chose that because {reasons} felt right.';
		expect(extractJson(said)).toEqual({ title: 'Rain' });
	});

	it('ignores braces inside strings', () => {
		const said = '{"harmony":"i-VI {resolving} VII","title":"Rain"}';
		expect(extractJson(said)).toEqual({ harmony: 'i-VI {resolving} VII', title: 'Rain' });
	});

	it('returns null rather than guessing', () => {
		expect(extractJson('')).toBeNull();
		expect(extractJson('I could not make a plan.')).toBeNull();
		expect(extractJson('{"title": unquoted}')).toBeNull();
	});

	it('refuses a bare array, which is never the shape asked for', () => {
		expect(extractJson('[1,2,3]')).toBeNull();
	});
});

describe('runStructured', () => {
	it('parses the reply and reports the schema it sent', async () => {
		const adapter = new MockAdapter([{ content: '{"title":"Rain on a Window"}' }]);
		const result = await runStructured<{ title: string }>({ adapter, ...base });

		expect(result.stopReason).toBe('done');
		expect(result.value).toEqual({ title: 'Rain on a Window' });
		expect(adapter.requests[0].responseSchema).toEqual(schema);
		// No tools: a structured run is the alternative to calling something.
		expect(adapter.requests[0].tools).toBeUndefined();
	});

	it('appends the output contract to a stored prompt that asks for prose', async () => {
		// The seeded compose_plan prompt still ends "Return the plan as prose",
		// and seeding is insert-if-absent, so every existing install keeps it.
		const adapter = new MockAdapter([{ content: '{"title":"Rain"}' }]);
		await runStructured({
			adapter,
			...base,
			systemPrompt: 'You plan pieces of music.\n\nReturn the plan as prose, not operations.'
		});

		const system = adapter.requests[0].messages[0];
		expect(system.role).toBe('system');
		expect(system.content).toContain('Return the plan as prose');
		expect(system.content).toContain(structuredContract());
		// The contract comes last, so it is the instruction in force.
		expect(system.content!.trim().endsWith(structuredContract())).toBe(true);
	});

	it('retries without the schema when the provider rejects it', async () => {
		const adapter = new MockAdapter([
			{ error: 'OpenRouter 400: response_format is not supported' },
			{ content: '```json\n{"title":"Rain"}\n```' }
		]);
		const result = await runStructured<{ title: string }>({ adapter, ...base });

		expect(result.stopReason).toBe('done');
		expect(result.value).toEqual({ title: 'Rain' });
		expect(adapter.requests).toHaveLength(2);
		expect(adapter.requests[0].responseSchema).toEqual(schema);
		expect(adapter.requests[1].responseSchema).toBeUndefined();
		expect(result.warnings.join(' ')).toContain('plain text');
	});

	it('retries when the first reply is not JSON at all', async () => {
		const adapter = new MockAdapter([
			{ content: 'The plan is a slow waltz in A minor.' },
			{ content: '{"title":"Rain"}' }
		]);
		const result = await runStructured<{ title: string }>({ adapter, ...base });

		expect(result.stopReason).toBe('done');
		expect(adapter.requests).toHaveLength(2);
	});

	it('gives up rather than looping when the retry also fails', async () => {
		const adapter = new MockAdapter([{ content: 'no.' }, { content: 'still no.' }]);
		const result = await runStructured({ adapter, ...base });

		expect(result.stopReason).toBe('unparsable');
		expect(result.value).toBeNull();
		expect(result.raw).toBe('still no.');
		expect(adapter.requests).toHaveLength(2);
	});

	it('rethrows when the plain-text attempt also fails at transport', async () => {
		const adapter = new MockAdapter([{ error: 'first down' }, { error: 'second down' }]);
		await expect(runStructured({ adapter, ...base })).rejects.toThrow('second down');
	});

	it('does not retry a truncated answer, which would only truncate again', async () => {
		const adapter = new MockAdapter([{ content: '{"title":"Rai', finishReason: 'length' }]);
		const result = await runStructured({ adapter, ...base });

		expect(result.stopReason).toBe('truncated');
		expect(adapter.requests).toHaveLength(1);
	});

	it('reports a refusal as a refusal', async () => {
		const adapter = new MockAdapter([{ content: '', finishReason: 'content_filter' }]);
		expect((await runStructured({ adapter, ...base })).stopReason).toBe('refused');
	});

	it('stops on an aborted signal without calling the model', async () => {
		const adapter = new MockAdapter([{ content: '{"title":"Rain"}' }]);
		const controller = new AbortController();
		controller.abort();

		const result = await runStructured({ adapter, ...base, signal: controller.signal });
		expect(result.stopReason).toBe('aborted');
		expect(adapter.requests).toHaveLength(0);
	});

	it('accumulates usage across both attempts', async () => {
		const adapter = new MockAdapter([
			{ content: 'not json', usage: { promptTokens: 10, completionTokens: 5 } },
			{ content: '{"title":"Rain"}', usage: { promptTokens: 10, completionTokens: 7 } }
		]);
		const result = await runStructured({ adapter, ...base });

		// The first attempt was paid for whether or not it parsed.
		expect(result.usage.promptTokens).toBe(20);
		expect(result.usage.completionTokens).toBe(12);
	});
});

describe('runProse', () => {
	const prose = { systemPrompt: 'You explain music.', userPrompt: 'A summary.' };

	it('returns what the model said', async () => {
		const adapter = new MockAdapter([
			{ content: 'It is in A minor and never leaves.', finishReason: 'stop' }
		]);
		const result = await runProse({ adapter, ...prose });

		expect(result.stopReason).toBe('done');
		expect(result.text).toBe('It is in A minor and never leaves.');
	});

	it('does not report a successful answer as having changed nothing', async () => {
		// The whole reason this runner exists rather than a no-tools agent loop.
		// `runAgentLoop` demotes done to no_effect whenever it produced no ops, and
		// a prose task never produces any — so every real answer would arrive
		// labelled as one that said nothing.
		const adapter = new MockAdapter([{ content: 'A page of insight.', finishReason: 'stop' }]);
		const result = await runProse({ adapter, ...prose });

		expect(result.stopReason).toBe('done');
		expect(result.stopReason).not.toBe('no_effect');
		expect(result.text).not.toBe('');
	});

	it('sends no tools and no response schema', async () => {
		// A tool list would invite a tool call there is nothing to do with, and a
		// schema would contradict a prompt whose product is prose.
		const adapter = new MockAdapter([{ content: 'Fine.', finishReason: 'stop' }]);
		await runProse({ adapter, ...prose });

		const [req] = adapter.requests;
		expect(req.tools).toBeUndefined();
		expect(req.responseSchema).toBeUndefined();
	});

	it('leaves the stored prompt alone', async () => {
		// `runStructured` appends a JSON contract. Doing that here would tell a
		// prompt that ends "Return only the title" to return an object instead.
		const adapter = new MockAdapter([{ content: 'Slow Light in November', finishReason: 'stop' }]);
		await runProse({ adapter, ...prose });

		const system = adapter.requests[0].messages[0].content ?? '';
		expect(system).toBe('You explain music.');
		expect(system).not.toContain(structuredContract());
	});

	it('separates an empty answer from a real one', async () => {
		const adapter = new MockAdapter([{ content: '   ', finishReason: 'stop' }]);
		const result = await runProse({ adapter, ...prose });

		expect(result.stopReason).toBe('empty');
		expect(result.text).toBe('');
	});

	it('keeps prose that ran out of room, and says so', async () => {
		// Truncated JSON is unusable; truncated prose is merely short.
		const adapter = new MockAdapter([
			{ content: 'The bridge modulates to', finishReason: 'length' }
		]);
		const result = await runProse({ adapter, ...prose });

		expect(result.stopReason).toBe('truncated');
		expect(result.text).toBe('The bridge modulates to');
		expect(result.warnings.join(' ')).toContain('output tokens');
	});

	it('reports a refusal as a refusal', async () => {
		const adapter = new MockAdapter([{ content: '', finishReason: 'content_filter' }]);
		expect((await runProse({ adapter, ...prose })).stopReason).toBe('refused');
	});

	it('does not call the model at all once aborted', async () => {
		const adapter = new MockAdapter([{ content: 'Too late.', finishReason: 'stop' }]);
		const controller = new AbortController();
		controller.abort();

		const result = await runProse({ adapter, ...prose, signal: controller.signal });

		expect(result.stopReason).toBe('aborted');
		expect(adapter.requests).toHaveLength(0);
	});

	it('counts the tokens it spent', async () => {
		const adapter = new MockAdapter([
			{ content: 'Brief.', finishReason: 'stop', usage: { promptTokens: 40, completionTokens: 9 } }
		]);
		const result = await runProse({ adapter, ...prose });

		expect(result.usage.promptTokens).toBe(40);
		expect(result.usage.completionTokens).toBe(9);
	});

	it('forwards deltas so the page has something to show', async () => {
		const adapter = new MockAdapter([{ content: 'Streaming.', finishReason: 'stop' }]);
		const seen: string[] = [];
		await runProse({
			adapter,
			...prose,
			onEvent: (e) => {
				if (e.type === 'delta') seen.push(e.text);
			}
		});

		expect(seen.join('')).toBe('Streaming.');
	});
});
