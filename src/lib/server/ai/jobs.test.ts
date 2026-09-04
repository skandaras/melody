import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import {
	__resetJobs,
	cancelJob,
	createJob,
	emit,
	failOrphanedJobs,
	finishJob,
	jobOwner,
	subscribe
} from './jobs.js';
import { db, runMigrations } from '../db/index.js';
import { jobs } from '../db/schema.js';
import { listEvents } from '../events.js';
import { eq } from 'drizzle-orm';

/**
 * The point of the buffer is that a browser can drop and come back without
 * losing a turn the user already paid for — so replay is what these tests are
 * really about.
 */

const user = 'u1';

function drain(jobId: string): { events: string[]; ended: boolean; off: () => void } {
	const events: string[] = [];
	let ended = false;
	const off = subscribe(jobId, (e) => {
		if (e.type === '__end__') ended = true;
		else events.push(e.type);
	});
	return {
		events,
		get ended() {
			return ended;
		},
		off
	} as { events: string[]; ended: boolean; off: () => void };
}

// Jobs are the first thing here to write real rows; test-setup gives each
// worker its own empty DATA_DIR, so the schema has to be created once.
beforeAll(() => runMigrations());
beforeEach(() => __resetJobs());

describe('job buffer', () => {
	it('delivers events to a live subscriber', () => {
		const { id } = createJob({ userId: user, task: 'edit_selection' });
		const sub = drain(id);

		emit(id, 'iteration', { n: 1 });
		emit(id, 'text', { text: 'hello' });

		expect(sub.events).toEqual(['iteration', 'text']);
	});

	it('replays everything a late subscriber missed', () => {
		const { id } = createJob({ userId: user, task: 'edit_selection' });
		emit(id, 'iteration', { n: 1 });
		emit(id, 'tool', { name: 'transpose' });

		// The browser reloaded here.
		const sub = drain(id);
		expect(sub.events).toEqual(['iteration', 'tool']);

		emit(id, 'text', { text: 'and then' });
		expect(sub.events).toEqual(['iteration', 'tool', 'text']);
	});

	it('replays a job that already finished, then ends the stream', () => {
		const { id } = createJob({ userId: user, task: 'edit_selection' });
		emit(id, 'iteration', { n: 1 });
		finishJob(id, 'done');

		const sub = drain(id);
		expect(sub.events).toEqual(['iteration', 'done']);
		expect(sub.ended).toBe(true);
	});

	it('numbers events so a client can tell what it has seen', () => {
		const { id } = createJob({ userId: user, task: 'edit_selection' });
		emit(id, 'a');
		emit(id, 'b');

		const seqs: number[] = [];
		subscribe(id, (e) => {
			if (e.type !== '__end__') seqs.push(e.seq);
		});
		expect(seqs).toEqual([0, 1]);
	});

	it('serves several subscribers at once', () => {
		const { id } = createJob({ userId: user, task: 'edit_selection' });
		const a = drain(id);
		const b = drain(id);
		emit(id, 'text');

		expect(a.events).toEqual(['text']);
		expect(b.events).toEqual(['text']);
	});

	it('stops delivering after unsubscribe', () => {
		const { id } = createJob({ userId: user, task: 'edit_selection' });
		const sub = drain(id);
		sub.off();
		emit(id, 'text');
		expect(sub.events).toEqual([]);
	});

	it('keeps running when one subscriber throws', () => {
		const { id } = createJob({ userId: user, task: 'edit_selection' });
		subscribe(id, () => {
			throw new Error('dead connection');
		});
		const healthy = drain(id);

		expect(() => emit(id, 'text')).not.toThrow();
		expect(healthy.events).toEqual(['text']);
	});

	it('ends the stream immediately for a job that never existed', () => {
		const sub = drain('no-such-job');
		expect(sub.ended).toBe(true);
		expect(sub.events).toEqual([]);
	});

	it('ignores events emitted after the job finished', () => {
		const { id } = createJob({ userId: user, task: 'edit_selection' });
		finishJob(id, 'done');
		emit(id, 'late');

		const sub = drain(id);
		expect(sub.events).toEqual(['done']);
	});

	it('reports an error as the closing event', () => {
		const { id } = createJob({ userId: user, task: 'edit_selection' });
		const sub = drain(id);
		finishJob(id, 'error', 'OpenRouter 502');

		expect(sub.events).toEqual(['error']);
		expect(sub.ended).toBe(true);
	});

	it('hands back a signal that the caller can abort the work with', () => {
		const { abort } = createJob({ userId: user, task: 'edit_selection' });
		expect(abort.aborted).toBe(false);
	});
});

describe('terminal state', () => {
	const statusOf = (id: string) =>
		db.select({ status: jobs.status }).from(jobs).where(eq(jobs.id, id)).get()?.status;

	it('records the first terminal status and ignores a second', () => {
		const { id } = createJob({ userId: user, task: 'edit_selection' });

		finishJob(id, 'cancelled');
		finishJob(id, 'done');

		// Cancellation used to be overwritten by the executor's `done` landing a
		// moment later, which lost the fact that the user had stopped the turn.
		expect(statusOf(id)).toBe('cancelled');
	});

	it('logs the job exactly once even when finishJob is called twice', () => {
		const { id } = createJob({ userId: user, task: 'edit_selection' });
		const before = listEvents(500).length;

		finishJob(id, 'done');
		finishJob(id, 'done');

		expect(listEvents(500).length - before).toBe(1);
	});

	it('emits one terminal event, carrying the real status', () => {
		const { id } = createJob({ userId: user, task: 'edit_selection' });
		const seen: { type: string; data: unknown }[] = [];
		subscribe(id, (e) => {
			if (e.type !== '__end__') seen.push({ type: e.type, data: e.data });
		});

		finishJob(id, 'no_effect');
		finishJob(id, 'done');

		expect(seen).toHaveLength(1);
		// The event name stays `done` so the existing client keeps working, but
		// the outcome has to be readable from the payload.
		expect(seen[0].type).toBe('done');
		expect((seen[0].data as { status: string }).status).toBe('no_effect');
	});

	it('cancelJob aborts without writing a terminal status', () => {
		const { id, abort } = createJob({ userId: user, task: 'edit_selection' });

		expect(cancelJob(id)).toBe(true);

		// The executor is the single writer: cancelJob only signals, so the row
		// stays running until the loop unwinds and reports what it did.
		expect(abort.aborted).toBe(true);
		expect(statusOf(id)).toBe('running');
	});

	it('will not cancel a job that has already finished', () => {
		const { id } = createJob({ userId: user, task: 'edit_selection' });
		finishJob(id, 'done');
		expect(cancelJob(id)).toBe(false);
	});
});

describe('ownership', () => {
	// The cancel and events routes both gate on this, and both answer 404 rather
	// than 403 for someone else's job — confirming an id exists is itself a leak.
	// Now that cancelling has a route, a wrong answer here would let one user
	// stop another user's turn.
	it('returns the owner of a job', () => {
		const { id } = createJob({ userId: user, task: 'edit_selection' });
		expect(jobOwner(id)).toBe(user);
	});

	it('does not report someone else as the owner', () => {
		const { id } = createJob({ userId: 'u2', task: 'edit_selection' });
		expect(jobOwner(id)).not.toBe(user);
	});

	it('returns null for a job that does not exist', () => {
		expect(jobOwner('no-such-job')).toBeNull();
	});
});

describe('a job that outlives its buffer', () => {
	const statusOf = (id: string) =>
		db.select({ status: jobs.status }).from(jobs).where(eq(jobs.id, id)).get()?.status;

	it('still reports how it ended', () => {
		const { id } = createJob({ userId: user, task: 'edit_selection' });
		finishJob(id, 'no_effect');

		// The buffer is gone — swept, or lost to a restart — but the row remains.
		__resetJobs();

		const seen: { type: string; data: unknown }[] = [];
		subscribe(id, (e) => seen.push({ type: e.type, data: e.data }));

		// Closing with a bare __end__ is indistinguishable from "finished long
		// ago", which is how a reconnecting browser ends up showing nothing.
		expect(seen.map((e) => e.type)).toEqual(['done', '__end__']);
		expect((seen[0].data as { status: string }).status).toBe('no_effect');
	});

	it('reports a failure as a failure', () => {
		const { id } = createJob({ userId: user, task: 'edit_selection' });
		finishJob(id, 'error', 'the provider refused');
		__resetJobs();

		const seen: { type: string; data: unknown }[] = [];
		subscribe(id, (e) => seen.push({ type: e.type, data: e.data }));

		expect(seen[0].type).toBe('error');
		expect((seen[0].data as { error: string }).error).toBe('the provider refused');
	});

	it('says nothing for a row that still claims to be running', () => {
		// Inventing a terminal event here would report a live job as finished.
		const { id } = createJob({ userId: user, task: 'edit_selection' });
		__resetJobs();

		const seen: string[] = [];
		subscribe(id, (e) => seen.push(e.type));
		expect(seen).toEqual(['__end__']);
	});

	it('closes immediately for a job id that never existed', () => {
		const seen: string[] = [];
		subscribe('no-such-job', (e) => seen.push(e.type));
		expect(seen).toEqual(['__end__']);
	});

	it('fails jobs a restart left running, and is idempotent', () => {
		const { id } = createJob({ userId: user, task: 'edit_selection' });
		const finished = createJob({ userId: user, task: 'title' });
		finishJob(finished.id, 'done');

		expect(failOrphanedJobs()).toBeGreaterThanOrEqual(1);
		expect(statusOf(id)).toBe('error');
		// A job that had already finished keeps the status it earned.
		expect(statusOf(finished.id)).toBe('done');

		// Nothing left running, so a second boot changes nothing.
		expect(failOrphanedJobs()).toBe(0);
	});
});
