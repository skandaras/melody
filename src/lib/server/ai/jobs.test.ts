import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { __resetJobs, createJob, emit, finishJob, subscribe } from './jobs.js';
import { runMigrations } from '../db/index.js';

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
