import { gte, sql } from 'drizzle-orm';
import { db } from './db/index.js';
import { usageLog } from './db/schema.js';
import { getSetting, type BudgetSettings, DEFAULT_BUDGET } from './settings.js';

/**
 * The spend ceiling.
 *
 * Enforced where a turn begins, not where a token is billed: OpenRouter only
 * reports what a call cost after the call completes, so a check inside the
 * model loop would read a figure that lags the work by one whole turn. What
 * this can honestly promise is that a new turn is refused once the recorded
 * spend for the period has crossed the cap — one in-flight turn can overshoot,
 * and nothing can spiral.
 */

export class BudgetExceededError extends Error {
	readonly spentUsd: number;
	readonly limitUsd: number;
	readonly period: string;

	constructor(spent: number, limit: number, period: string) {
		super(
			`AI budget reached: $${spent.toFixed(2)} of the $${limit.toFixed(2)} ${period} limit has ` +
				`been spent. Raise or clear the limit in Admin → Usage.`
		);
		this.name = 'BudgetExceededError';
		this.spentUsd = spent;
		this.limitUsd = limit;
		this.period = period;
	}
}

/** When the current budget period began, truncated to a calendar boundary. */
export function periodStart(period: BudgetSettings['period'], now = new Date()): Date {
	const d = new Date(now);
	if (period === 'day') {
		d.setUTCHours(0, 0, 0, 0);
	} else if (period === 'week') {
		// Weeks run Monday 00:00 UTC; Sunday belongs to the week closing that day.
		const day = (d.getUTCDay() + 6) % 7;
		d.setUTCDate(d.getUTCDate() - day);
		d.setUTCHours(0, 0, 0, 0);
	} else {
		d.setUTCDate(1);
		d.setUTCHours(0, 0, 0, 0);
	}
	return d;
}

/** Recorded spend since a moment. Calls that errored before any tokens were
 *  billed cost null, so they are counted as zero rather than skipped silently. */
export function spentSince(since: Date): number {
	const rows = db
		.select({ cost: usageLog.costUsd })
		.from(usageLog)
		.where(gte(usageLog.ts, since))
		.all();
	return rows.reduce((sum, r) => sum + (r.cost ?? 0), 0);
}

/**
 * The current period's spend, whether the cap is armed, and how much headroom
 * is left. The usage tab reads the same numbers, so what the panel shows is
 * exactly what enforcement acts on.
 */
export function budgetStatus(now = new Date()): {
	limitUsd: number;
	period: 'day' | 'week' | 'month';
	periodStart: Date;
	spentUsd: number;
	enforced: boolean;
} {
	const budget = getSetting<BudgetSettings>('budget', DEFAULT_BUDGET);
	const start = periodStart(budget.period, now);
	return {
		limitUsd: budget.limitUsd,
		period: budget.period,
		periodStart: start,
		spentUsd: spentSince(start),
		enforced: budget.limitUsd > 0
	};
}

/** Throws `BudgetExceededError` when the cap is armed and already crossed. */
export function checkBudget(now = new Date()): void {
	const status = budgetStatus(now);
	if (!status.enforced || status.spentUsd < status.limitUsd) return;
	throw new BudgetExceededError(status.spentUsd, status.limitUsd, status.period);
}

/** Spend grouped by calendar day, for the usage tab's trend row. */
export function spendByDay(days = 14): { day: string; costUsd: number; calls: number }[] {
	const since = new Date(Date.now() - days * 86_400_000);
	const rows = db
		.select({
			day: sql<string>`date(${usageLog.ts} / 1000, 'unixepoch')`,
			cost: sql<number>`COALESCE(SUM(${usageLog.costUsd}), 0)`,
			calls: sql<number>`COUNT(*)`
		})
		.from(usageLog)
		.where(gte(usageLog.ts, since))
		.groupBy(sql`1`)
		.orderBy(sql`1`)
		.all();
	return rows.map((r) => ({ day: r.day, costUsd: Number(r.cost), calls: Number(r.calls) }));
}
