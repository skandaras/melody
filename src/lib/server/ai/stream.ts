import type { Completion, FinishReason, ToolCall, Usage } from './types.js';
import { emptyUsage } from './types.js';

/**
 * Parsing OpenRouter's streaming response.
 *
 * This is the sharpest edge in the AI layer, and its failure mode is
 * misleading: a tool call reassembled wrongly looks exactly like "the model
 * ignored the tools". Three things make it fiddly.
 *
 *  1. Tool calls arrive in fragments. Each delta carries an `index`, and the
 *     `function.arguments` string is built up across many chunks — often one
 *     brace or one key at a time. Only the first fragment for an index carries
 *     the id and name.
 *  2. OpenRouter emits `: OPENROUTER PROCESSING` comment lines as keep-alives
 *     while a request queues. An SSE reader that treats every line as data
 *     will try to parse those as JSON.
 *  3. The stream ends with a literal `data: [DONE]` sentinel, not EOF.
 *
 * Kept in its own module, free of `fetch`, so it can be tested against
 * recorded chunks rather than a live call.
 */

export interface StreamState {
	content: string;
	reasoning: string;
	/** Keyed by the delta index, because fragments interleave across calls. */
	toolCalls: Map<number, { id: string; name: string; arguments: string }>;
	finishReason: FinishReason;
	model: string;
	provider?: string;
	usage: Usage;
}

export const newStreamState = (): StreamState => ({
	content: '',
	reasoning: '',
	toolCalls: new Map(),
	finishReason: 'stop',
	model: '',
	usage: emptyUsage()
});

interface DeltaToolCall {
	index?: number;
	id?: string;
	function?: { name?: string; arguments?: string };
}

interface StreamEvent {
	model?: string;
	provider?: string;
	choices?: {
		delta?: { content?: string | null; reasoning?: string | null; tool_calls?: DeltaToolCall[] };
		finish_reason?: string | null;
	}[];
	usage?: Record<string, unknown>;
}

const FINISH_REASONS: FinishReason[] = ['stop', 'tool_calls', 'length', 'content_filter', 'error'];

/**
 * Fold one decoded SSE payload into the accumulator.
 *
 * Exported so tests can drive it with recorded fragments directly, with no
 * transport in the way.
 */
export function applyEvent(state: StreamState, event: StreamEvent): void {
	if (event.model) state.model = event.model;
	if (event.provider) state.provider = event.provider;
	if (event.usage) state.usage = parseUsage(event.usage);

	const choice = event.choices?.[0];
	if (!choice) return;

	if (choice.delta?.content) state.content += choice.delta.content;
	if (choice.delta?.reasoning) state.reasoning += choice.delta.reasoning;

	for (const [i, call] of (choice.delta?.tool_calls ?? []).entries()) {
		// The index is what ties fragments together. Some providers omit it
		// when there is only one call in flight, so fall back to position.
		const index = call.index ?? i;
		const existing = state.toolCalls.get(index) ?? { id: '', name: '', arguments: '' };
		if (call.id) existing.id = call.id;
		if (call.function?.name) existing.name = call.function.name;
		// Concatenated, never replaced: this is the fragment stream.
		if (call.function?.arguments) existing.arguments += call.function.arguments;
		state.toolCalls.set(index, existing);
	}

	const finish = choice.finish_reason;
	if (finish && (FINISH_REASONS as string[]).includes(finish)) {
		state.finishReason = finish as FinishReason;
	}
}

/** Tool calls in index order, dropping any that never received a name. */
export function collectToolCalls(state: StreamState): ToolCall[] {
	return [...state.toolCalls.entries()]
		.sort((a, b) => a[0] - b[0])
		.map(([index, c]) => ({
			// A provider that omits ids still needs something stable to tie the
			// result back to the call.
			id: c.id || `call_${index}`,
			name: c.name,
			arguments: c.arguments
		}))
		.filter((c) => c.name !== '');
}

export function finishCompletion(state: StreamState): Completion {
	const toolCalls = collectToolCalls(state);
	return {
		model: state.model,
		provider: state.provider,
		content: state.content,
		reasoning: state.reasoning || undefined,
		toolCalls,
		// Some providers report `stop` even while emitting tool calls. What the
		// loop needs to know is whether there is work to do, so trust the
		// payload over the label.
		finishReason: toolCalls.length > 0 ? 'tool_calls' : state.finishReason,
		usage: state.usage
	};
}

/**
 * Normalise the several shapes usage arrives in.
 *
 * Cache accounting in particular is nested differently per provider: reads
 * appear as `prompt_tokens_details.cached_tokens`, writes sometimes at the top
 * level and sometimes alongside. Reading both keeps the usage log honest
 * whichever model served the request.
 */
export function parseUsage(raw: Record<string, unknown>): Usage {
	const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
	const details = (raw.prompt_tokens_details ?? {}) as Record<string, unknown>;

	return {
		promptTokens: num(raw.prompt_tokens),
		completionTokens: num(raw.completion_tokens),
		cacheReadTokens: num(details.cached_tokens ?? raw.cached_tokens),
		cacheWriteTokens: num(details.cache_write_tokens ?? raw.cache_write_tokens),
		costUsd: typeof raw.cost === 'number' ? raw.cost : null
	};
}

/**
 * Split a byte stream into SSE payloads.
 *
 * Yields only `data:` lines that are not the terminator. Comment lines — which
 * is how OpenRouter keeps a queued connection alive — are skipped, and a
 * partial line is held until its remainder arrives, because chunk boundaries
 * fall wherever the network puts them and not on line breaks.
 */
export async function* sseLines(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
	const reader = body.getReader();
	const decoder = new TextDecoder();
	let buffer = '';

	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			buffer += decoder.decode(value, { stream: true });

			let newline: number;
			while ((newline = buffer.indexOf('\n')) !== -1) {
				const line = buffer.slice(0, newline).trim();
				buffer = buffer.slice(newline + 1);
				if (line === '' || line.startsWith(':')) continue;
				if (!line.startsWith('data:')) continue;
				const payload = line.slice(5).trim();
				if (payload === '[DONE]') return;
				yield payload;
			}
		}
	} finally {
		reader.releaseLock();
	}
}
