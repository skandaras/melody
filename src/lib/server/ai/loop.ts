import { applyOps, type Op } from '$lib/score/apply.js';
import type { Score, Selection } from '$lib/score/types.js';
import { analysisReport, renderNotes } from './context.js';
import { INSTRUMENT_NAMES, READ_TOOL_NAMES, agentTools } from './tools.js';
import type { ChatMessage, Completion, ProviderAdapter, ToolCall, Usage } from './types.js';
import { emptyUsage } from './types.js';

/**
 * The agent loop.
 *
 * The model reads the score, decides on edits, and calls operations. Two rules
 * shape everything here:
 *
 *   1. Read-only tools are answered inline and the loop continues. Mutating
 *      ops are *collected*, not applied one at a time — the whole turn lands
 *      as a single revision at the end, so accepting or rejecting an AI edit
 *      is one decision rather than eight.
 *   2. Nothing the model sends can throw. Malformed JSON, an unknown tool, an
 *      op that fails validation — each becomes an error result the model can
 *      read and correct on the next iteration. A loop that crashes on bad
 *      output is a loop that fails on a bad day rather than a bad request.
 */

export interface LoopOptions {
	adapter: ProviderAdapter;
	systemPrompt: string;
	/** The opening user turn: context plus instruction. See context.ts. */
	userPrompt: string;
	/** Read against this. The loop never mutates it. */
	score: Score;
	maxIterations: number;
	maxOps: number;
	maxTokens?: number;
	effort?: 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';
	reasoning?: 'on' | 'hidden' | 'off';
	/** Progress for the SSE stream. Must not throw. */
	onEvent?: (event: LoopEvent) => void;
	signal?: AbortSignal;
}

export type LoopEvent =
	| { type: 'iteration'; n: number }
	| { type: 'text'; text: string }
	| { type: 'tool'; name: string; ok: boolean; detail?: string }
	| { type: 'usage'; usage: Usage };

export interface LoopResult {
	/** Collected in call order, ready for a single commitOps. */
	ops: Op[];
	/** The model's closing prose, if any. */
	summary: string;
	iterations: number;
	usage: Usage;
	stopReason: 'done' | 'max_iterations' | 'max_ops' | 'refused' | 'truncated' | 'aborted';
	/** Anything that went wrong but did not stop the run. */
	warnings: string[];
}

export async function runAgentLoop(opts: LoopOptions): Promise<LoopResult> {
	const tools = agentTools();
	const messages: ChatMessage[] = [
		// The system prompt is the stable prefix — mark it so families that
		// need an explicit breakpoint can cache everything up to here.
		{ role: 'system', content: opts.systemPrompt, cacheBreakpoint: true },
		{ role: 'user', content: opts.userPrompt }
	];

	const ops: Op[] = [];
	const warnings: string[] = [];
	const usage = emptyUsage();
	let summary = '';
	let iterations = 0;
	let hitOpLimit = false;
	// The score as it will be once this turn's ops are committed. Each accepted
	// op advances it, so `read_score` shows the model the consequences of its
	// own edits rather than a stale document — and validating one op against
	// it is both cheaper and more precise than re-applying the whole batch.
	let working = opts.score;

	for (let i = 0; i < opts.maxIterations; i++) {
		if (opts.signal?.aborted) return result('aborted');
		iterations = i + 1;
		opts.onEvent?.({ type: 'iteration', n: iterations });

		let completion: Completion;
		try {
			completion = await opts.adapter.complete({
				messages,
				tools,
				toolChoice: 'auto',
				maxTokens: opts.maxTokens,
				effort: opts.effort,
				reasoning: opts.reasoning,
				signal: opts.signal
			});
		} catch (err) {
			if (opts.signal?.aborted) return result('aborted');
			throw err;
		}

		addUsage(usage, completion.usage);
		opts.onEvent?.({ type: 'usage', usage: completion.usage });

		if (completion.content) {
			summary = completion.content;
			opts.onEvent?.({ type: 'text', text: completion.content });
		}

		if (completion.finishReason === 'content_filter') return result('refused');
		if (completion.finishReason === 'length') {
			warnings.push('The model ran out of output tokens mid-answer.');
			return result('truncated');
		}
		if (completion.finishReason !== 'tool_calls' || completion.toolCalls.length === 0) {
			return result('done');
		}

		messages.push({
			role: 'assistant',
			content: completion.content || null,
			toolCalls: completion.toolCalls
		});

		for (const call of completion.toolCalls) {
			const outcome = handleCall(call, working, ops, opts.maxOps);
			if (outcome.score) working = outcome.score;
			if (outcome.hitLimit) hitOpLimit = true;
			if (outcome.warning) warnings.push(outcome.warning);
			opts.onEvent?.({ type: 'tool', name: call.name, ok: outcome.ok, detail: outcome.detail });
			// One tool message per call — the id is what ties it back, and a
			// missing reply leaves the conversation structurally invalid.
			messages.push({ role: 'tool', toolCallId: call.id, content: outcome.content });
		}

		// The model was told the cap was reached and asked for more anyway.
		// Continuing would only burn iterations refusing it.
		if (hitOpLimit) return result('max_ops');
	}

	return result('max_iterations');

	function result(stopReason: LoopResult['stopReason']): LoopResult {
		if (stopReason === 'max_ops') {
			warnings.push(`Stopped after ${opts.maxOps} operations in one turn.`);
		}
		if (stopReason === 'max_iterations') {
			warnings.push(`Stopped after ${opts.maxIterations} model round-trips.`);
		}
		return { ops, summary, iterations, usage, stopReason, warnings };
	}
}

interface CallOutcome {
	content: string;
	ok: boolean;
	detail?: string;
	warning?: string;
	/** The advanced score, when the op applied. */
	score?: Score;
	/** The op was refused because the turn's budget is spent. */
	hitLimit?: boolean;
}

/**
 * Answer one tool call.
 *
 * Never throws. Every failure path returns text the model can act on, because
 * the useful response to "you sent malformed JSON" is to let it try again, not
 * to abandon a turn the user is waiting on.
 */
function handleCall(call: ToolCall, score: Score, ops: Op[], maxOps: number): CallOutcome {
	let args: Record<string, unknown>;
	try {
		args = call.arguments.trim() ? JSON.parse(call.arguments) : {};
	} catch {
		return {
			ok: false,
			content: `Error: arguments were not valid JSON. Received: ${call.arguments.slice(0, 200)}`,
			detail: 'invalid JSON',
			warning: `${call.name} was called with malformed JSON arguments.`
		};
	}
	// Strict mode makes the model send explicit nulls for arguments it is
	// leaving alone. Every op already treats absent and null alike, but
	// stripping them keeps the recorded revision clean.
	args = dropNulls(args);

	if (READ_TOOL_NAMES.has(call.name)) return readTool(call.name, args, score);

	if (ops.length >= maxOps) {
		return {
			ok: false,
			hitLimit: true,
			content: `Error: operation limit of ${maxOps} reached for this turn. Stop and summarise what you changed.`,
			detail: 'op limit'
		};
	}

	// Applied for real against the running score. Catching a bad op here —
	// while the model can still correct itself — is much better than at commit
	// time with the user looking at the diff.
	const op = { op: call.name, args } as Op;
	const trial = applyOps(score, [op]);

	if (trial.errors.length) {
		const reason = trial.errors.map((e) => e.reason).join('; ');
		return {
			ok: false,
			content: `Error: ${reason}`,
			detail: reason,
			warning: `${call.name} was rejected: ${reason}`
		};
	}

	// Two ways an op can quietly do nothing, both of which would otherwise be
	// reported to the model as success:
	//
	//   - it never ran, because the part or voice id did not resolve. Ops
	//     return an empty result rather than throwing, and an empty result
	//     writes no log line.
	//   - it ran against a selection that matched no notes. Those ops do log
	//     ("Transposed 0 note(s)"), so the empty diff is the giveaway.
	//
	// The second test keys off the arguments rather than a list of op names,
	// so an op added later is covered without anyone remembering to update
	// anything here.
	const targeted = 'selection' in args || 'noteIds' in args;
	const touchedNothing =
		trial.diff.added.length + trial.diff.removed.length + trial.diff.changed.length === 0;

	if (trial.log.length === 0 || (targeted && touchedNothing)) {
		const detail = `${call.name} matched nothing — check the ids and ranges you passed.`;
		return { ok: false, content: `Error: ${detail}`, detail, warning: detail };
	}

	ops.push(op);
	const note = trial.log.join('; ');
	return { ok: true, content: note, detail: note, score: trial.score };
}

function readTool(name: string, args: Record<string, unknown>, score: Score): CallOutcome {
	const sel = toSelection(args);
	switch (name) {
		case 'read_score':
			return { ok: true, content: renderNotes(score, sel) };
		case 'analyse_range':
			return { ok: true, content: analysisReport(score, sel) };
		case 'list_instruments':
			return { ok: true, content: INSTRUMENT_NAMES.join('\n') };
		default:
			return { ok: false, content: `Error: unknown tool "${name}".` };
	}
}

function toSelection(args: Record<string, unknown>): Selection {
	const sel: Selection = {};
	if (typeof args.startTick === 'number') sel.startTick = args.startTick;
	if (typeof args.endTick === 'number') sel.endTick = args.endTick;
	if (typeof args.partId === 'string') sel.partIds = [args.partId];
	return sel;
}

/** Recursively strip nulls, which strict mode requires the model to send. */
function dropNulls(value: unknown): never;
function dropNulls<T>(value: T): T;
function dropNulls(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(dropNulls);
	if (value === null || typeof value !== 'object') return value;
	const out: Record<string, unknown> = {};
	for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
		if (v === null) continue;
		out[k] = dropNulls(v);
	}
	return out;
}

function addUsage(total: Usage, add: Usage): void {
	total.promptTokens += add.promptTokens;
	total.completionTokens += add.completionTokens;
	total.cacheReadTokens += add.cacheReadTokens;
	total.cacheWriteTokens += add.cacheWriteTokens;
	if (add.costUsd != null) total.costUsd = (total.costUsd ?? 0) + add.costUsd;
}
