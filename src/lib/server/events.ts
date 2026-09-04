import { desc, eq, gte, and, type SQL } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { db } from './db/index.js';
import { events, jobs } from './db/schema.js';
import type { JobStatus } from './db/schema.js';

/**
 * A small activity log.
 *
 * The `jobs` table answers "what is running right now"; `events` answers
 * "what happened over the last month" — every AI turn, control run and
 * transcription, with how long it took and who asked. The usage tab's
 * activity feed reads it, and the retention sweep prunes it.
 *
 * Writes are deliberately fire-and-forget-safe: a logging row must never be
 * able to fail a user request, so nothing here throws.
 */

export type EventStatus = (typeof events.$inferSelect)['status'];

export function recordEvent(opts: {
	userId?: string | null;
	scoreId?: string | null;
	task?: string | null;
	type: string;
	name: string;
	status: EventStatus;
	durationMs?: number | null;
	detail?: unknown;
}): void {
	try {
		db.insert(events)
			.values({
				id: randomUUID(),
				ts: new Date(),
				userId: opts.userId ?? null,
				scoreId: opts.scoreId ?? null,
				task: opts.task ?? null,
				type: opts.type,
				name: opts.name,
				status: opts.status,
				durationMs: opts.durationMs ?? null,
				detail: (opts.detail ?? null) as typeof events.$inferInsert['detail']
			})
			.run();
	} catch {
		// Observability must not become a failure mode.
	}
}

/**
 * Record a finished job in the activity log.
 *
 * Called from finishJob only, so every AI turn and control run lands exactly
 * once, with its duration, and no call site has to remember to log. In-flight
 * jobs are deliberately not logged — the jobs table is what answers "what is
 * running", and a feed that lists things twice reads as noise.
 */
export function recordJobEvent(opts: {
	jobId: string;
	status: JobStatus;
	error?: string | null;
}): void {
	try {
		const job = db
			.select({
				userId: jobs.userId,
				scoreId: jobs.scoreId,
				task: jobs.task,
				createdAt: jobs.createdAt
			})
			.from(jobs)
			.where(eq(jobs.id, opts.jobId))
			.get();
		if (!job) return;

		// A timeout is a failure even though nothing threw; `cancelled` and
		// `no_effect` are not — the first is what the user asked for, and the
		// second is a turn that ran correctly and decided nothing needed changing.
		const ok = opts.status !== 'error' && opts.status !== 'timed_out';
		recordEvent({
			userId: job.userId,
			scoreId: job.scoreId,
			task: job.task,
			type: 'job',
			name: `${job.task} ${opts.status}`,
			status: ok ? 'ok' : 'error',
			durationMs: Date.now() - job.createdAt.getTime(),
			detail: opts.error ? { error: opts.error } : null
		});
	} catch {
		// As above: never throw from logging.
	}
}

/** Most recent activity, optionally filtered — the usage tab's feed. */
export function listEvents(limit = 50, filter?: { userId?: string; type?: string }) {
	const where: SQL[] = [];
	if (filter?.userId) where.push(eq(events.userId, filter.userId));
	if (filter?.type) where.push(eq(events.type, filter.type));
	return db
		.select()
		.from(events)
		.where(where.length ? and(...where) : undefined)
		.orderBy(desc(events.ts))
		.limit(limit)
		.all();
}

/** What the usage tab shows at a glance, without the raw rows. */
export function activitySummary(days = 30): {
	total: number;
	ok: number;
	error: number;
	avgDurationMs: number | null;
} {
	const since = new Date(Date.now() - days * 86_400_000);
	const rows = db
		.select({ status: events.status, duration: events.durationMs })
		.from(events)
		.where(and(eq(events.type, 'job'), gte(events.ts, since)))
		.all();

	const ok = rows.filter((r) => r.status === 'ok').length;
	const error = rows.filter((r) => r.status === 'error').length;
	const durations = rows.map((r) => r.duration).filter((d): d is number => d != null);

	return {
		total: rows.length,
		ok,
		error,
		avgDurationMs: durations.length
			? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length)
			: null
	};
}
