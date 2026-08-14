import type {
	Chunk,
	Completion,
	CompletionRequest,
	ProviderAdapter,
	ToolCall,
	Usage
} from './types.js';
import { emptyUsage } from './types.js';

/**
 * A scripted adapter.
 *
 * The whole test suite has to run with no API key and no network — that is a
 * property worth protecting, since it is what lets the agent loop be tested at
 * all. This returns a pre-written sequence of turns and records the requests
 * it was given, so a test can assert both what the loop did and what it sent.
 */

export interface ScriptedTurn {
	content?: string;
	toolCalls?: { name: string; arguments: string; id?: string }[];
	finishReason?: Completion['finishReason'];
	usage?: Partial<Usage>;
	/** Throw instead of replying, to exercise transport failure. */
	error?: string;
}

export class MockAdapter implements ProviderAdapter {
	readonly name = 'mock';
	/** Every request the loop made, in order. */
	readonly requests: CompletionRequest[] = [];
	private turns: ScriptedTurn[];
	private index = 0;

	constructor(turns: ScriptedTurn[]) {
		this.turns = turns;
	}

	get callCount(): number {
		return this.index;
	}

	async complete(req: CompletionRequest): Promise<Completion> {
		// Snapshot, not the live object. The loop appends to the same messages
		// array between calls, so storing the reference would make every
		// recorded request show the final state and quietly defeat any
		// assertion about how the conversation grew.
		this.requests.push({ ...req, messages: structuredClone(req.messages) });
		// Running off the end means the loop asked for more turns than the test
		// scripted — say so plainly rather than looping forever on a default.
		const turn = this.turns[this.index++] ?? { content: 'done', finishReason: 'stop' as const };
		if (turn.error) throw new Error(turn.error);

		const toolCalls: ToolCall[] = (turn.toolCalls ?? []).map((c, i) => ({
			id: c.id ?? `call_${this.index}_${i}`,
			name: c.name,
			arguments: c.arguments
		}));

		return {
			model: 'mock/model',
			provider: 'mock',
			content: turn.content ?? '',
			toolCalls,
			finishReason: turn.finishReason ?? (toolCalls.length ? 'tool_calls' : 'stop'),
			usage: { ...emptyUsage(), promptTokens: 100, completionTokens: 20, ...turn.usage }
		};
	}

	async *stream(req: CompletionRequest): AsyncIterable<Chunk> {
		const completion = await this.complete(req);
		if (completion.content) yield { type: 'content', text: completion.content };
		yield { type: 'done', completion };
	}
}
