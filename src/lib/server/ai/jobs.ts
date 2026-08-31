import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { jobs, usageLog, type JobStatus } from '../db/schema.js';
import { recordJobEvent } from '../events.js';
import type { Usage } from './types.js';

/**
 * Jobs, and the buffer that lets a browser reconnect to one.
 *
 * An AI turn takes tens of seconds. If the SSE connection were the job, then
 * closing the laptop, a phone dropping to a different network, or a stray
 * reload would all abandon work the user has already paid for. So the job runs
 * to completion server-side regardless of who is listening, and events go into
 * a replayable buffer: a client that connects late gets everything it missed
 * and then tails the rest.
 *
 * The buffer is in memory and bounded. A restart loses in-flight jobs, which
 * is the right trade at this scale — persisting every token to SQLite would
 * cost far more than re-running the occasional interrupted request.
 */

export interface JobEvent {
	seq: number;
	type: string;
	data: unknown;
}

interface JobBuffer {
	id: string;
	events: JobEvent[];
	subscribers: Set<(event: JobEvent) => void>;
	done: boolean;
	/** Cleared when the job ends; until then, cancels the work. */
	abort: AbortController;
	finishedAt?: number;
}

/** Events kept per job. Enough for a long agent turn without unbounded growth. */
const MAX_EVENTS = 2000;
/** How long a finished job stays replayable, for a client that reconnects late. */
const RETAIN_MS = 5 * 60_000;

const buffers = new Map<string, JobBuffer>();

export function createJob(opts: {
	userId: string;
	scoreId?: string;
	task: string;
}): { id: string; abort: AbortSignal } {
	sweep();
	const id = randomUUID();
	db.insert(jobs)
		.values({
			id,
			scoreId: opts.scoreId ?? null,
			userId: opts.userId,
			task: opts.task,
			status: 'running',
			createdAt: new Date()
		})
		.run();

	const buffer: JobBuffer = {
		id,
		events: [],
		subscribers: new Set(),
		done: false,
		abort: new AbortController()
	};
	buffers.set(id, buffer);
	return { id, abort: buffer.abort.signal };
}

export function emit(jobId: string, type: string, data: unknown = {}): void {
	const buffer = buffers.get(jobId);
	if (!buffer || buffer.done) return;

	const event: JobEvent = { seq: buffer.events.length, type, data };
	buffer.events.push(event);
	// Drop the oldest rather than the newest: a late subscriber losing the
	// opening events is survivable, losing the outcome is not.
	if (buffer.events.length > MAX_EVENTS) buffer.events.shift();

	for (const fn of buffer.subscribers) {
		try {
			fn(event);
		} catch {
			// A dead connection must not take the job down with it.
		}
	}
}

export function finishJob(jobId: string, status: JobStatus, error?: string): void {
	const buffer = buffers.get(jobId);
	if (buffer) {
		emit(jobId, status === 'error' ? 'error' : 'done', error ? { error } : {});
		buffer.done = true;
		buffer.finishedAt = Date.now();
		for (const fn of buffer.subscribers) {
			try {
				fn({ seq: -1, type: '__end__', data: {} });
			} catch {
				/* ignore */
			}
		}
		buffer.subscribers.clear();
	}

	db.update(jobs)
		.set({ status, error: error ?? null, finishedAt: new Date() })
		.where(eq(jobs.id, jobId))
		.run();
	// The activity log is how the usage tab shows what ran and what failed;
	// recording it here means every entry point gets it for free.
	recordJobEvent({ jobId, status, error });
}

/**
 * Replay what has happened, then receive what happens next.
 *
 * Replaying inside subscribe rather than leaving it to the caller closes the
 * gap where an event lands between reading the history and attaching the
 * listener.
 */
export function subscribe(jobId: string, fn: (event: JobEvent) => void): () => void {
	const buffer = buffers.get(jobId);
	if (!buffer) {
		fn({ seq: -1, type: '__end__', data: {} });
		return () => {};
	}

	for (const event of buffer.events) fn(event);
	if (buffer.done) {
		fn({ seq: -1, type: '__end__', data: {} });
		return () => {};
	}

	buffer.subscribers.add(fn);
	return () => buffer.subscribers.delete(fn);
}

export function cancelJob(jobId: string): boolean {
	const buffer = buffers.get(jobId);
	if (!buffer || buffer.done) return false;
	buffer.abort.abort();
	finishJob(jobId, 'cancelled');
	return true;
}

/** Ownership check — jobs are readable only by the user who started them. */
export function jobOwner(jobId: string): string | null {
	const row = db.select({ userId: jobs.userId }).from(jobs).where(eq(jobs.id, jobId)).get();
	return row?.userId ?? null;
}

/**
 * Record what a call cost.
 *
 * OpenRouter reports the real figure per generation, so this is measured
 * rather than estimated from a price table we would otherwise have to keep in
 * step with 400 models.
 */
export function recordUsage(opts: {
	userId: string;
	scoreId?: string;
	task: string;
	modelKey: string;
	usage: Usage;
	status: 'ok' | 'error';
}): void {
	db.insert(usageLog)
		.values({
			id: randomUUID(),
			ts: new Date(),
			userId: opts.userId,
			scoreId: opts.scoreId ?? null,
			task: opts.task,
			modelKey: opts.modelKey,
			promptTokens: opts.usage.promptTokens,
			completionTokens: opts.usage.completionTokens,
			cacheReadTokens: opts.usage.cacheReadTokens,
			cacheWriteTokens: opts.usage.cacheWriteTokens,
			costUsd: opts.usage.costUsd,
			status: opts.status
		})
		.run();
}

/** Forget finished jobs once nobody could reasonably still be reconnecting. */
function sweep(): void {
	const cutoff = Date.now() - RETAIN_MS;
	for (const [id, buffer] of buffers) {
		if (buffer.done && (buffer.finishedAt ?? 0) < cutoff) buffers.delete(id);
	}
}

/** Test seam — the buffer is process-global, so suites must be able to reset it. */
export function __resetJobs(): void {
	buffers.clear();
}
