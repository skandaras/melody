import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
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
	/** Fires if the job outlives JOB_TIMEOUT_MS. Cleared when it finishes. */
	timer?: ReturnType<typeof setTimeout>;
	/** Set when the abort came from the timeout rather than from a person. */
	timedOut?: boolean;
}

/** Events kept per job. Enough for a long agent turn without unbounded growth. */
const MAX_EVENTS = 2000;
/** How long a finished job stays replayable, for a client that reconnects late. */
const RETAIN_MS = 5 * 60_000;
/**
 * Wall-clock ceiling on a single job.
 *
 * Nothing else bounds a run: a provider that accepts a request and then never
 * answers would leave the job `running` forever, holding a buffer and telling
 * the browser nothing. Ten minutes is far past any legitimate agent turn —
 * the iteration and op caps stop a well-behaved one long before this — so
 * reaching it means something is wrong rather than slow.
 */
const JOB_TIMEOUT_MS = 10 * 60_000;

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
	// Aborting rather than finishing directly: the executor is the single writer
	// of a terminal status, so a timeout takes the same route a cancellation
	// does and lands as `timed_out` once the loop unwinds.
	buffer.timer = setTimeout(() => {
		if (buffer.done) return;
		buffer.timedOut = true;
		buffer.abort.abort();
	}, JOB_TIMEOUT_MS);
	buffer.timer.unref?.();

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

/**
 * End a job, exactly once.
 *
 * The guard is on the UPDATE rather than on the in-memory buffer, so it holds
 * for a job whose buffer was lost to a restart as well as for the ordinary
 * case. Only the write that actually moves the row off `running` gets to emit
 * the terminal event and log the activity; a second caller finds nothing to
 * change and returns silently.
 *
 * This matters because cancellation used to have two writers — cancelJob wrote
 * `cancelled` and the executor then wrote `done` straight over it, logging the
 * job twice. Cancellation now aborts and lets the executor be the only writer,
 * but a race is a race, so the invariant is enforced here rather than assumed.
 */
export function finishJob(jobId: string, status: JobStatus, error?: string): void {
	const res = db
		.update(jobs)
		.set({ status, error: error ?? null, finishedAt: new Date() })
		.where(and(eq(jobs.id, jobId), eq(jobs.status, 'running')))
		.run();
	if (res.changes === 0) return;

	const buffer = buffers.get(jobId);
	if (buffer) {
		if (buffer.timer) clearTimeout(buffer.timer);
		buffer.timer = undefined;
		// The event name stays `done`/`error` because that is the contract the
		// current client listens on; the real outcome rides in the payload so a
		// no_effect or a cancellation is distinguishable without a new listener.
		emit(jobId, status === 'error' ? 'error' : 'done', { status, ...(error ? { error } : {}) });
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
		// No buffer, but the row may still say what happened — a job whose
		// buffer was swept, or one lost to a restart. Closing with a bare
		// __end__ is indistinguishable from "finished long ago", which is how a
		// reconnecting browser ends up showing nothing at all.
		const row = db
			.select({ status: jobs.status, error: jobs.error })
			.from(jobs)
			.where(eq(jobs.id, jobId))
			.get();
		// A row still marked `running` has no outcome to report, so say nothing
		// rather than inventing one — failOrphanedJobs() clears these at boot,
		// and claiming a live job had finished would be worse than silence.
		if (row && row.status !== 'running') {
			const type = row.status === 'error' ? 'error' : 'done';
			fn({ seq: 0, type, data: { status: row.status, ...(row.error ? { error: row.error } : {}) } });
		}
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

/**
 * Ask a running job to stop.
 *
 * Only aborts. Writing the terminal status here as well used to mean a
 * cancelled turn was recorded twice and then overwritten by the executor's
 * `done` — and, worse, that the executor carried on and committed the very ops
 * the user had just cancelled. The abort travels through the loop's signal, the
 * loop returns `aborted`, and the executor is the single writer of `cancelled`.
 */
export function cancelJob(jobId: string): boolean {
	const buffer = buffers.get(jobId);
	if (!buffer || buffer.done) return false;
	buffer.abort.abort();
	return true;
}

/**
 * Did this job's abort come from the timeout rather than from a person?
 *
 * The executor sees only `stopReason: 'aborted'` and has to record which it
 * was. Asking here keeps the single-writer rule intact — the alternative is a
 * second writer racing the first, which is the bug this design already fixed
 * once.
 */
export function timedOut(jobId: string): boolean {
	return buffers.get(jobId)?.timedOut === true;
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
		if (buffer.done && (buffer.finishedAt ?? 0) < cutoff) {
			if (buffer.timer) clearTimeout(buffer.timer);
			buffers.delete(id);
		}
	}
}

/**
 * Fail jobs left `running` by a restart.
 *
 * Buffers live in memory, so a job in flight when the process stopped can never
 * finish or report — the row would sit `running` forever and its owner would
 * see a turn that never resolves. Safe to do unconditionally at boot because
 * the deployment is a single container: no other process owns these rows.
 */
export function failOrphanedJobs(): number {
	const res = db
		.update(jobs)
		.set({
			status: 'error',
			error: 'The server restarted while this was running.',
			finishedAt: new Date()
		})
		.where(eq(jobs.status, 'running'))
		.run();
	return res.changes;
}

/** Test seam — the buffer is process-global, so suites must be able to reset it. */
export function __resetJobs(): void {
	buffers.clear();
}
