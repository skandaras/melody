import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { db, dataDir, runMigrations } from './db/index.js';
import { usageLog, events, recordings } from './db/schema.js';
import {
	BudgetExceededError,
	budgetStatus,
	checkBudget,
	periodStart,
	spentSince
} from './budget.js';
import { setSetting, getSetting, DEFAULT_BUDGET, DEFAULT_RETENTION } from './settings.js';
import { createJob, finishJob, __resetJobs } from './ai/jobs.js';
import { listEvents, activitySummary } from './events.js';
import { sweepRetention } from './retention.js';
import { saveRecording, loadRecording, deleteRecording, sweepRecordings } from './recordings.js';

/**
 * Budget enforcement, the events log, the retention sweeps and the recording
 * store, against the real migrated schema. Each vitest worker gets its own
 * DATA_DIR, so runMigrations() is what puts the tables there — the same setup
 * jobs.test.ts uses. These live together because they are the integration
 * seam: a finished job must land in events, and a budget check must see
 * exactly what the usage log holds, with no per-module view drifting apart.
 */

const user = 'u-budget-test';

beforeAll(() => runMigrations());
beforeEach(() => __resetJobs());

function insertUsage(ts: Date, cost: number | null) {
	db.insert(usageLog)
		.values({
			id: randomUUID(),
			ts,
			userId: user,
			scoreId: null,
			task: 'edit_selection',
			modelKey: 'test/model',
			promptTokens: 10,
			completionTokens: 5,
			cacheReadTokens: 0,
			cacheWriteTokens: 0,
			costUsd: cost,
			status: cost === null ? 'error' : 'ok'
		})
		.run();
}

function insertEvent(ts: Date, status: 'ok' | 'error') {
	db.insert(events)
		.values({
			id: randomUUID(),
			ts,
			userId: user,
			scoreId: null,
			task: 'edit_selection',
			type: 'job',
			name: 'edit_selection done',
			status,
			durationMs: 5,
			detail: null
		})
		.run();
}

describe('budget enforcement', () => {
	it('counts null-cost rows as zero rather than skipping them', () => {
		insertUsage(new Date(), 0.1);
		insertUsage(new Date(), null);
		// A null cost is an errored call billed nothing. Sum, don't skip.
		expect(spentSince(new Date(Date.now() - 60_000))).toBeCloseTo(0.1, 6);
	});

	it('refuses a new turn once the cap is crossed, and says where to raise it', () => {
		setSetting('budget', { limitUsd: 5, period: 'day' });
		expect(() => checkBudget()).not.toThrow();

		// Lower the cap under the recorded spend rather than chasing exact
		// sums — other rows share the table, and enforcement must not care.
		setSetting('budget', { limitUsd: 0.01, period: 'day' });
		try {
			checkBudget();
			expect.unreachable('checkBudget should have thrown');
		} catch (e) {
			expect(e).toBeInstanceOf(BudgetExceededError);
			const err = e as BudgetExceededError;
			expect(err.period).toBe('day');
			expect(err.message).toContain('Admin → Usage');
		} finally {
			setSetting('budget', DEFAULT_BUDGET);
		}
	});

	it('leaves the door open while the cap is disarmed (limit 0)', () => {
		setSetting('budget', { limitUsd: 0, period: 'day' });
		try {
			expect(() => checkBudget()).not.toThrow();
			expect(budgetStatus().enforced).toBe(false);
		} finally {
			setSetting('budget', DEFAULT_BUDGET);
		}
	});

	it('scopes the sum to the current period, not all history', () => {
		insertUsage(new Date(Date.now() - 3 * 86_400_000), 5);
		// Today's spend only — if the old row leaked in, this would exceed 5.
		expect(spentSince(periodStart('day'))).toBeLessThan(5);
	});

	it('aligns weeks on Monday 00:00 UTC', () => {
		const sunday = new Date('2024-01-07T15:00:00Z');
		expect(sunday.getUTCDay()).toBe(0);
		const start = periodStart('week', sunday);
		expect(start.getUTCDay()).toBe(1);
		expect(start.toISOString()).toBe('2024-01-01T00:00:00.000Z');
	});

	it('aligns months on the 1st, 00:00 UTC', () => {
		const start = periodStart('month', new Date('2024-03-15T10:00:00Z'));
		expect(start.toISOString()).toBe('2024-03-01T00:00:00.000Z');
	});
});

describe('events log', () => {
	it('records a finished job with its duration', () => {
		const { id } = createJob({ userId: user, task: 'edit_selection' });
		finishJob(id, 'done');
		const mine = listEvents(10, { type: 'job' })[0];
		expect(mine).toBeTruthy();
		expect(mine.task).toBe('edit_selection');
		expect(mine.status).toBe('ok');
		expect(mine.durationMs).toBeGreaterThanOrEqual(0);
	});

	it('records the error detail on a failed job', () => {
		const { id } = createJob({ userId: user, task: 'edit_selection' });
		finishJob(id, 'error', 'model unavailable');
		const mine = listEvents(10, { type: 'job' })[0];
		expect(mine.status).toBe('error');
		expect((mine.detail as { error?: string } | null)?.error).toBe('model unavailable');
	});

	it('summarises recent jobs for the usage tab', () => {
		insertEvent(new Date(), 'ok');
		insertEvent(new Date(), 'error');
		const summary = activitySummary(30);
		expect(summary.total).toBeGreaterThanOrEqual(2);
		expect(summary.ok).toBeGreaterThanOrEqual(1);
		expect(summary.error).toBeGreaterThanOrEqual(1);
	});
});

describe('retention sweeps', () => {
	it('prunes events and usage past their day limits', () => {
		insertEvent(new Date(Date.now() - 40 * 86_400_000), 'ok');
		insertUsage(new Date(Date.now() - 400 * 86_400_000), 0.5);
		const r = sweepRetention({
			eventDays: 30,
			usageDays: 365,
			revisionsPerScore: 100,
			keepRecordings: true
		});
		expect(r.eventsDeleted).toBeGreaterThanOrEqual(1);
		expect(r.usageDeleted).toBeGreaterThanOrEqual(1);
	});

	it('0 days keeps everything, matching revisionsPerScore=0', () => {
		insertEvent(new Date('2001-01-01T00:00:00Z'), 'ok');
		const r = sweepRetention({
			eventDays: 0,
			usageDays: 0,
			revisionsPerScore: 0,
			keepRecordings: true
		});
		expect(r.eventsDeleted).toBe(0);
	});
});

describe('recordings', () => {
	const dir = join(dataDir, 'recordings');

	function makeFile(name: string, bytes: string): File {
		return new File([bytes], name, { type: 'audio/webm' });
	}

	it('stores a recording on disk and in the table, and reads it back', async () => {
		mkdirSync(dir, { recursive: true });
		const saved = await saveRecording({
			userId: user,
			scoreId: 'score-1',
			file: makeFile('take.webm', 'fake audio bytes'),
			durationMs: 4200
		});
		expect(saved.kept).toBe(true); // default retention keeps recordings

		const found = await loadRecording(saved.id, user);
		expect(found).not.toBeNull();
		expect(found!.row.durationMs).toBe(4200);
		expect(found!.bytes.toString()).toBe('fake audio bytes');
		expect(existsSync(found!.row.path)).toBe(true);

		// Another user cannot see it — same ownership rule as scores.
		expect(await loadRecording(saved.id, 'someone-else')).toBeNull();

		await deleteRecording(saved.id, user);
		expect(await loadRecording(saved.id, user)).toBeNull();
	});

	it('rejects non-audio and oversized uploads', async () => {
		mkdirSync(dir, { recursive: true });
		const notAudio = new File(['plain text'], 'x.txt', { type: 'text/plain' });
		await expect(
			saveRecording({ userId: user, scoreId: 's', file: notAudio, durationMs: null })
		).rejects.toThrow(/audio/i);
		const big = new File([new Uint8Array(61 * 1024 * 1024)], 'big.webm', { type: 'audio/webm' });
		await expect(
			saveRecording({ userId: user, scoreId: 's', file: big, durationMs: null })
		).rejects.toThrow(/MB/);
	});

	it('sweeps orphaned recordings only when keepRecordings is off', async () => {
		mkdirSync(dir, { recursive: true });
		const file = join(dir, 'orphan.webm');
		writeFileSync(file, 'audio');
		const id = randomUUID();
		db.insert(recordings)
			.values({
				id,
				ownerId: user,
				scoreId: null,
				name: 'orphan',
				mime: 'audio/webm',
				size: 5,
				path: file,
				createdAt: new Date(Date.now() - 3 * 86_400_000)
			})
			.run();

		// Keeping is the operator's choice: nothing is deleted while it holds.
		expect(
			await sweepRecordings({ ...DEFAULT_RETENTION, keepRecordings: true })
		).toBe(0);

		expect(
			await sweepRecordings({ ...DEFAULT_RETENTION, keepRecordings: false })
		).toBe(1);
		expect(existsSync(file)).toBe(false);
		expect(getSetting('retention', DEFAULT_RETENTION).keepRecordings).toBe(true);
	});
});
