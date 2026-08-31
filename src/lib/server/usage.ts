import { desc, gte, sql } from 'drizzle-orm';
import { db } from './db/index.js';
import { usageLog } from './db/schema.js';
import { budgetStatus, spendByDay } from './budget.js';
import { activitySummary, listEvents } from './events.js';

/**
 * The usage report, as the admin tab shows it.
 *
 * One call assembles the whole picture — the budget line, the daily trend,
 * where the money goes, and the recent activity feed — so the tab is a single
 * fetch rather than five, and all of its numbers are exactly the numbers
 * enforcement acts on.
 */

export function topModels(days = 30, limit = 10): {
	modelKey: string;
	costUsd: number;
	calls: number;
	tokens: number;
}[] {
	const since = new Date(Date.now() - days * 86_400_000);
	return db
		.select({
			modelKey: usageLog.modelKey,
			cost: sql<number>`COALESCE(SUM(${usageLog.costUsd}), 0)`,
			calls: sql<number>`COUNT(*)`,
			tokens: sql<number>`COALESCE(SUM(${usageLog.promptTokens} + ${usageLog.completionTokens}), 0)`
		})
		.from(usageLog)
		.where(gte(usageLog.ts, since))
		.groupBy(usageLog.modelKey)
		.orderBy(sql`COALESCE(SUM(${usageLog.costUsd}), 0) DESC`)
		.limit(limit)
		.all()
		.map((r) => ({ modelKey: r.modelKey, costUsd: Number(r.cost), calls: Number(r.calls), tokens: Number(r.tokens) }));
}

export function topTasks(days = 30, limit = 10): { task: string; costUsd: number; calls: number }[] {
	const since = new Date(Date.now() - days * 86_400_000);
	return db
		.select({
			task: usageLog.task,
			cost: sql<number>`COALESCE(SUM(${usageLog.costUsd}), 0)`,
			calls: sql<number>`COUNT(*)`
		})
		.from(usageLog)
		.where(gte(usageLog.ts, since))
		.groupBy(usageLog.task)
		.orderBy(sql`COALESCE(SUM(${usageLog.costUsd}), 0) DESC`)
		.limit(limit)
		.all()
		.map((r) => ({ task: r.task, costUsd: Number(r.cost), calls: Number(r.calls) }));
}

export function usageReport(now = new Date()) {
	return {
		budget: budgetStatus(now),
		daily: spendByDay(14),
		models: topModels(30),
		tasks: topTasks(30),
		summary: activitySummary(30),
		events: listEvents(30).map((e) => ({
			id: e.id,
			ts: e.ts.getTime(),
			task: e.task,
			type: e.type,
			name: e.name,
			status: e.status,
			durationMs: e.durationMs,
			detail: e.detail
		}))
	};
}
