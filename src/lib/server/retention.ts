import { lt } from 'drizzle-orm';
import { db } from './db/index.js';
import { events, usageLog } from './db/schema.js';
import { getSetting, DEFAULT_RETENTION, type RetentionSettings } from './settings.js';

/**
 * The other half of retention.
 *
 * Revision pruning happens per commit, because that is the only moment anyone
 * can say which score just grew. These two tables have no such moment — rows
 * land from AI activity whenever a job finishes — so their cleanup is a sweep
 * instead: cheap, idempotent, run once at boot and then daily. Deleting from
 * an indexed ts column on tables this size is well under a millisecond, so
 * there is nothing to schedule carefully.
 */

export interface SweepResult {
	eventsDeleted: number;
	usageDeleted: number;
}

function prune(table: typeof events | typeof usageLog, days: number): number {
	if (days <= 0) return 0; // 0 keeps everything, matching revisionsPerScore.
	const cutoff = new Date(Date.now() - days * 86_400_000);
	return db.delete(table).where(lt(table.ts, cutoff)).run().changes;
}

export function sweepRetention(retention: RetentionSettings = getSetting('retention', DEFAULT_RETENTION)): SweepResult {
	return {
		eventsDeleted: prune(events, retention.eventDays),
		usageDeleted: prune(usageLog, retention.usageDays)
	};
}
