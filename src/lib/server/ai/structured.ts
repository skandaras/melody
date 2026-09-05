import type { ReasoningEffort } from '../db/schema.js';
import type { Completion, ProviderAdapter, Usage } from './types.js';
import { emptyUsage } from './types.js';

/**
 * One model call that must come back as JSON.
 *
 * The counterpart to `runAgentLoop`, not a mode of it. A structured run has no
 * tools, collects no operations and commits nothing, so folding it into the
 * loop would mean a code path where `LoopResult.ops` is permanently empty —
 * collapsing exactly the `done`-versus-`no_effect` distinction the loop exists
 * to draw. What the two genuinely share is `jobs.ts`, and they both use it.
 *
 * Shaped like the loop deliberately: adapter in, events out, never throws on
 * anything the model did. A provider that will not honour a response schema is
 * a bad day, not a bad request, and it should degrade rather than fail.
 */

export interface StructuredOptions {
	adapter: ProviderAdapter;
	systemPrompt: string;
	userPrompt: string;
	/** Run it through `toStrictSchema` first — strict mode is not optional. */
	schema: { name: string; schema: Record<string, unknown> };
	maxTokens?: number;
	effort?: ReasoningEffort;
	reasoning?: 'on' | 'hidden' | 'off';
	/** Progress for the SSE stream. Must not throw. */
	onEvent?: (event: StructuredEvent) => void;
	signal?: AbortSignal;
}

export type StructuredEvent =
	| { type: 'delta'; text: string }
	| { type: 'reasoning'; text: string }
	| { type: 'status'; message: string }
	| { type: 'usage'; usage: Usage };

export interface StructuredResult<T> {
	/** Null whenever `stopReason` is anything but `done`. */
	value: T | null;
	/** What the model actually said, kept for diagnosis when parsing failed. */
	raw: string;
	usage: Usage;
	stopReason: 'done' | 'unparsable' | 'refused' | 'truncated' | 'aborted';
	warnings: string[];
}

/**
 * The output contract, appended to whatever system prompt is stored.
 *
 * It lives here rather than in the prompt on purpose. Prompts are seeded
 * insert-if-absent and then edited freely in admin, so a prompt written before
 * this existed keeps its old instructions forever — `compose_plan`'s still ends
 * "Return the plan as prose". More importantly, an admin editing a text box
 * must not be able to break JSON parsing: the contract is machinery, and the
 * prompt is the part that is meant to be tuned.
 */
export function structuredContract(): string {
	return [
		'Return your answer as a single JSON object matching the supplied schema.',
		'No commentary, no markdown fence, no explanation before or after it.'
	].join(' ');
}

export async function runStructured<T>(opts: StructuredOptions): Promise<StructuredResult<T>> {
	const usage = emptyUsage();
	const warnings: string[] = [];
	const system = `${opts.systemPrompt.trim()}\n\n${structuredContract()}`.trim();

	// Two attempts at most. The second drops the response schema, because that
	// is the part providers disagree about: `require_parameters: true` restricts
	// routing to providers honouring everything sent, and reasoning combined
	// with structured output is the patchiest such combination there is. The
	// failure is a hard error rather than degradation, so the retry is what
	// turns an outage into a slightly less reliable parse.
	for (const withSchema of [true, false]) {
		if (opts.signal?.aborted) return done('aborted');

		let completion: Completion | null = null;
		try {
			completion = await collect(opts, system, withSchema);
		} catch (err) {
			if (opts.signal?.aborted) return done('aborted');
			if (!withSchema) throw err;
			warnings.push(
				`The provider rejected a structured response, so it was asked again in plain text. (${message(err)})`
			);
			opts.onEvent?.({ type: 'status', message: 'Retrying without a response schema…' });
			continue;
		}

		if (!completion) {
			warnings.push('The model stream ended without a result.');
			return done('truncated');
		}

		addUsage(usage, completion.usage);
		opts.onEvent?.({ type: 'usage', usage: completion.usage });

		if (completion.finishReason === 'content_filter') return done('refused', completion.content);
		if (completion.finishReason === 'length') {
			// Truncated JSON is unparsable JSON, and retrying without the schema
			// would only truncate again — the ceiling is the problem, not the format.
			warnings.push('The model ran out of output tokens before finishing.');
			return done('truncated', completion.content);
		}

		const value = extractJson<T>(completion.content);
		if (value !== null) {
			return { value, raw: completion.content, usage, stopReason: 'done', warnings };
		}

		if (withSchema) {
			warnings.push('The model returned something that was not JSON; asked again in plain text.');
			opts.onEvent?.({ type: 'status', message: 'Re-reading the answer…' });
			continue;
		}
		return done('unparsable', completion.content);
	}

	return done('unparsable');

	function done(stopReason: StructuredResult<T>['stopReason'], raw = ''): StructuredResult<T> {
		return { value: null, raw, usage, stopReason, warnings };
	}
}

/** Stream one attempt to completion, forwarding deltas as they arrive. */
async function collect(
	opts: StructuredOptions,
	system: string,
	withSchema: boolean
): Promise<Completion | null> {
	let completion: Completion | null = null;

	for await (const chunk of opts.adapter.stream({
		messages: [
			// Marked like the loop's, so families needing an explicit breakpoint
			// can cache the prefix. The contract line is part of it and constant.
			{ role: 'system', content: system, cacheBreakpoint: true },
			{ role: 'user', content: opts.userPrompt }
		],
		responseSchema: withSchema ? opts.schema : undefined,
		maxTokens: opts.maxTokens,
		effort: opts.effort,
		reasoning: opts.reasoning,
		signal: opts.signal
	})) {
		if (chunk.type === 'content') opts.onEvent?.({ type: 'delta', text: chunk.text });
		else if (chunk.type === 'reasoning') opts.onEvent?.({ type: 'reasoning', text: chunk.text });
		else completion = chunk.completion;
	}
	return completion;
}

/**
 * Find a JSON object in whatever the model said.
 *
 * Needed for the no-schema retry, where the reply is prose that happens to
 * contain JSON. Scans for the first balanced object rather than reaching for
 * the last `}` in the string, because a model that explains itself afterwards
 * would otherwise swallow the explanation into the parse and fail.
 *
 * Pure and exported so the awkward shapes can be tested directly.
 */
export function extractJson<T>(text: string): T | null {
	const trimmed = text.trim();
	if (!trimmed) return null;

	const direct = parse<T>(trimmed);
	if (direct !== null) return direct;

	// ```json … ``` is what a model reaches for the moment it is not being held
	// to a schema, which is precisely the retry case.
	const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed);
	if (fenced) {
		const inside = parse<T>(fenced[1].trim());
		if (inside !== null) return inside;
	}

	for (let i = trimmed.indexOf('{'); i >= 0; i = trimmed.indexOf('{', i + 1)) {
		const end = matchingBrace(trimmed, i);
		if (end < 0) continue;
		const candidate = parse<T>(trimmed.slice(i, end + 1));
		if (candidate !== null) return candidate;
	}
	return null;
}

/** The index of the `}` closing the `{` at `start`, or -1. */
function matchingBrace(text: string, start: number): number {
	let depth = 0;
	let inString = false;
	let escaped = false;

	for (let i = start; i < text.length; i++) {
		const ch = text[i];
		if (escaped) {
			escaped = false;
			continue;
		}
		if (ch === '\\' && inString) {
			escaped = true;
			continue;
		}
		if (ch === '"') {
			inString = !inString;
			continue;
		}
		// A brace inside a string is text — "i-VI-III-VII {resolving}" is a
		// harmony sketch a model could plausibly write.
		if (inString) continue;
		if (ch === '{') depth++;
		else if (ch === '}' && --depth === 0) return i;
	}
	return -1;
}

/** JSON.parse, but only objects count and nothing throws. */
function parse<T>(text: string): T | null {
	try {
		const value = JSON.parse(text);
		return value && typeof value === 'object' && !Array.isArray(value) ? (value as T) : null;
	} catch {
		return null;
	}
}

function message(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

function addUsage(total: Usage, add: Usage): void {
	total.promptTokens += add.promptTokens;
	total.completionTokens += add.completionTokens;
	total.cacheReadTokens += add.cacheReadTokens;
	total.cacheWriteTokens += add.cacheWriteTokens;
	if (add.costUsd != null) total.costUsd = (total.costUsd ?? 0) + add.costUsd;
}
