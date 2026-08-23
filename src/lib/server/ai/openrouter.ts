import { needsCacheBreakpoints, withCacheControl, worthCaching } from './cache.js';
import {
	applyEvent,
	finishCompletion,
	newStreamState,
	parseUsage,
	sseLines,
	type StreamState
} from './stream.js';
import type {
	Chunk,
	ChatMessage,
	Completion,
	CompletionRequest,
	ProviderAdapter
} from './types.js';
import { collectToolCalls } from './stream.js';

/**
 * The OpenRouter client.
 *
 * Written by hand rather than through a vendor SDK. The obvious alternative —
 * the OpenAI package pointed at OpenRouter's base URL — types the OpenAI
 * request shape, not OpenRouter's additions (`reasoning`, `provider`,
 * `models`, `usage.include`), so every field that matters here would need a
 * cast. This is a REST endpoint; typing our own request is both smaller and
 * honest about what we send.
 */

const BASE_URL = 'https://openrouter.ai/api/v1';

export interface OpenRouterConfig {
	apiKey: string;
	/** Primary model slug, e.g. "anthropic/claude-opus-5". */
	model: string;
	/** Tried in order if the primary is unavailable or rate-limited. */
	fallbackModels?: string[];
	baseUrl?: string;
	/** Sent as HTTP-Referer/X-Title so requests are identifiable in the
	 *  OpenRouter dashboard. Not required, but free attribution. */
	appUrl?: string;
	appName?: string;
}

export class OpenRouterAdapter implements ProviderAdapter {
	readonly name = 'openrouter';
	private config: OpenRouterConfig;

	constructor(config: OpenRouterConfig) {
		this.config = config;
	}

	async complete(req: CompletionRequest): Promise<Completion> {
		const res = await this.post(this.body(req, false), req.signal);
		const json = (await res.json()) as Record<string, unknown>;
		return this.fromResponse(json);
	}

	async *stream(req: CompletionRequest): AsyncIterable<Chunk> {
		const res = await this.post(this.body(req, true), req.signal);
		if (!res.body) throw new Error('OpenRouter returned no response body');

		const state: StreamState = newStreamState();
		for await (const payload of sseLines(res.body)) {
			let event: Record<string, unknown>;
			try {
				event = JSON.parse(payload);
			} catch {
				// A malformed frame is not worth failing a long generation over.
				continue;
			}
			// An error can arrive mid-stream after a 200, so it has to be
			// checked here as well as on the initial response.
			if (event.error) throw new Error(errorMessage(event));

			const before = state.content.length;
			const reasoningBefore = state.reasoning.length;
			applyEvent(state, event);

			if (state.content.length > before) {
				yield { type: 'content', text: state.content.slice(before) };
			}
			if (state.reasoning.length > reasoningBefore) {
				yield { type: 'reasoning', text: state.reasoning.slice(reasoningBefore) };
			}
		}

		yield { type: 'done', completion: finishCompletion(state) };
	}

	private async post(body: unknown, signal?: AbortSignal): Promise<Response> {
		const headers: Record<string, string> = {
			authorization: `Bearer ${this.config.apiKey}`,
			'content-type': 'application/json'
		};
		if (this.config.appUrl) headers['http-referer'] = this.config.appUrl;
		if (this.config.appName) headers['x-title'] = this.config.appName;

		const res = await fetch(`${this.config.baseUrl ?? BASE_URL}/chat/completions`, {
			method: 'POST',
			headers,
			body: JSON.stringify(body),
			signal
		});

		if (!res.ok) {
			const text = await res.text().catch(() => '');
			throw new Error(`OpenRouter ${res.status}: ${text.slice(0, 500) || res.statusText}`);
		}
		return res;
	}

	/** Build the request body. Kept separate from transport so it is testable. */
	body(req: CompletionRequest, stream: boolean): Record<string, unknown> {
		const explicitCache = needsCacheBreakpoints(this.config.model);
		// The tool payload is part of the cached prefix, and on an agent turn it
		// dwarfs the system message — so it has to count toward whether marking a
		// breakpoint is worth it.
		const toolBytes = req.tools?.length ? JSON.stringify(req.tools).length : 0;

		const body: Record<string, unknown> = {
			model: this.config.model,
			messages: req.messages.map((m) => toWireMessage(m, explicitCache, toolBytes)),
			stream,
			// Without this the response carries no cost or cache figures, and
			// the budget cap has nothing to enforce against.
			usage: { include: true },
			provider: {
				// The important one. OpenRouter picks an upstream provider per
				// request, and they differ in what they honour — without this a
				// request carrying tools can land on a provider that ignores
				// them, and the model just replies in prose while the agent
				// loop spins. Restricts routing to providers that support
				// everything we send.
				require_parameters: true
			}
		};

		if (this.config.fallbackModels?.length) body.models = this.config.fallbackModels;
		if (req.maxTokens) body.max_tokens = req.maxTokens;

		if (req.tools?.length) {
			body.tools = req.tools;
			body.tool_choice = req.toolChoice ?? 'auto';
		}

		if (req.responseSchema) {
			body.response_format = {
				type: 'json_schema',
				json_schema: {
					name: req.responseSchema.name,
					strict: true,
					schema: req.responseSchema.schema
				}
			};
		}

		const reasoning = reasoningParam(req);
		if (reasoning) body.reasoning = reasoning;

		return body;
	}

	private fromResponse(json: Record<string, unknown>): Completion {
		if (json.error) throw new Error(errorMessage(json));

		const choice = (json.choices as Record<string, unknown>[] | undefined)?.[0] ?? {};
		const message = (choice.message ?? {}) as Record<string, unknown>;
		const state = newStreamState();

		for (const [i, call] of ((message.tool_calls ?? []) as Record<string, unknown>[]).entries()) {
			const fn = (call.function ?? {}) as Record<string, unknown>;
			state.toolCalls.set(i, {
				id: String(call.id ?? `call_${i}`),
				name: String(fn.name ?? ''),
				arguments: typeof fn.arguments === 'string' ? fn.arguments : ''
			});
		}
		const toolCalls = collectToolCalls(state);

		return {
			model: String(json.model ?? this.config.model),
			provider: typeof json.provider === 'string' ? json.provider : undefined,
			content: typeof message.content === 'string' ? message.content : '',
			reasoning: typeof message.reasoning === 'string' ? message.reasoning : undefined,
			toolCalls,
			finishReason: toolCalls.length
				? 'tool_calls'
				: normaliseFinish(choice.finish_reason as string | undefined),
			usage: parseUsage((json.usage ?? {}) as Record<string, unknown>)
		};
	}
}

/**
 * Map our three-state reasoning setting onto OpenRouter's parameter.
 *
 * `hidden` is the interesting one: the model still reasons, we just don't pay
 * to ship the tokens back or have to filter them out of the UI.
 */
function reasoningParam(req: CompletionRequest): Record<string, unknown> | null {
	const mode = req.reasoning ?? 'hidden';
	if (mode === 'off') return { enabled: false };

	const reasoning: Record<string, unknown> = { enabled: true };
	if (req.effort) reasoning.effort = req.effort;
	if (mode === 'hidden') reasoning.exclude = true;
	return reasoning;
}

/** Our message shape → the wire shape, marking the cache breakpoint if asked. */
function toWireMessage(
	m: ChatMessage,
	explicitCache: boolean,
	toolBytes = 0
): Record<string, unknown> {
	const wire: Record<string, unknown> = { role: m.role };

	if (m.cacheBreakpoint && explicitCache && m.content && worthCaching(m.content, toolBytes)) {
		wire.content = withCacheControl(m.content);
	} else if (m.toolCalls?.length && !m.content) {
		// An assistant turn that only calls tools carries null content, not an
		// empty string — the OpenAI schema types it nullable and some
		// providers reject "" where they accept null.
		wire.content = null;
	} else {
		wire.content = m.content ?? '';
	}

	if (m.toolCallId) wire.tool_call_id = m.toolCallId;
	if (m.toolCalls?.length) {
		wire.tool_calls = m.toolCalls.map((c) => ({
			id: c.id,
			type: 'function',
			function: { name: c.name, arguments: c.arguments }
		}));
	}
	return wire;
}

function normaliseFinish(reason: string | undefined): Completion['finishReason'] {
	switch (reason) {
		case 'tool_calls':
		case 'length':
		case 'content_filter':
		case 'error':
			return reason;
		default:
			return 'stop';
	}
}

function errorMessage(json: Record<string, unknown>): string {
	const err = json.error as Record<string, unknown> | undefined;
	const message = err?.message ?? 'Unknown OpenRouter error';
	const code = err?.code;
	return code ? `OpenRouter error ${code}: ${message}` : `OpenRouter error: ${message}`;
}
