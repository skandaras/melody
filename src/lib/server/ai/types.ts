import type { ReasoningEffort } from '../db/schema.js';
import type { FunctionDef } from './tools.js';

/**
 * The shape the rest of the app talks to.
 *
 * Deliberately thin. OpenRouter already *is* the multi-provider abstraction —
 * one key, one endpoint, 400+ models — so building an adapter zoo on top of it
 * would be abstraction for its own sake. This interface exists for one
 * concrete reason: the test suite has to run with no API key and no network,
 * which needs something for a mock to implement.
 */

export type Role = 'system' | 'user' | 'assistant' | 'tool';

export interface ToolCall {
	id: string;
	name: string;
	/** Raw JSON text as the model emitted it. Parsed by the caller, defensively
	 *  — models do produce malformed JSON here and it must not throw. */
	arguments: string;
}

export interface ChatMessage {
	role: Role;
	content?: string | null;
	/** Assistant turns only. */
	toolCalls?: ToolCall[];
	/** Tool turns only — ties the result back to the call. */
	toolCallId?: string;
	/** Set on the last stable message to mark a cache breakpoint. Only some
	 *  model families read it; see cache.ts. */
	cacheBreakpoint?: boolean;
}

export type FinishReason = 'stop' | 'tool_calls' | 'length' | 'content_filter' | 'error';

export interface Usage {
	promptTokens: number;
	completionTokens: number;
	/** Prompt tokens served from cache. Zero across repeated calls means the
	 *  prefix is varying — worth alerting on, it is a silent cost leak. */
	cacheReadTokens: number;
	cacheWriteTokens: number;
	/** Actual USD for this generation, as reported by the provider. Recorded
	 *  rather than estimated, so the budget cap is exact. */
	costUsd: number | null;
}

export interface CompletionRequest {
	messages: ChatMessage[];
	tools?: FunctionDef[];
	/** Force, forbid, or leave tool use to the model. */
	toolChoice?: 'auto' | 'none' | 'required';
	/** A JSON Schema the reply must satisfy. Mutually exclusive with tools in
	 *  practice — a structured reply is the alternative to calling something. */
	responseSchema?: { name: string; schema: Record<string, unknown> };
	maxTokens?: number;
	effort?: ReasoningEffort;
	reasoning?: 'on' | 'hidden' | 'off';
	signal?: AbortSignal;
}

export interface Completion {
	/** Which model actually served this — OpenRouter may have fallen back. */
	model: string;
	/** Which upstream provider served it. Useful when a capability silently
	 *  differs between them. */
	provider?: string;
	content: string;
	reasoning?: string;
	toolCalls: ToolCall[];
	finishReason: FinishReason;
	usage: Usage;
}

/** Incremental output, for streaming a long generation to the browser. */
export type Chunk =
	| { type: 'content'; text: string }
	| { type: 'reasoning'; text: string }
	| { type: 'done'; completion: Completion };

export interface ProviderAdapter {
	readonly name: string;
	complete(req: CompletionRequest): Promise<Completion>;
	stream(req: CompletionRequest): AsyncIterable<Chunk>;
}

export const emptyUsage = (): Usage => ({
	promptTokens: 0,
	completionTokens: 0,
	cacheReadTokens: 0,
	cacheWriteTokens: 0,
	costUsd: null
});
