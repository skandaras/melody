import { eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { db } from './db/index.js';
import { users } from './db/schema.js';
import type { ForwardedAuth, SessionUser } from './auth.js';

/**
 * Auto-provisioning. There is no signup flow: whoever Authelia lets through
 * gets a row on their first request, which is what makes "add them to the
 * melody-users group" the entire onboarding process.
 */

/** last_seen_at is telemetry, not state. Writing it per request would mean a
 *  DB write on every page load and asset fetch for no benefit. */
const LAST_SEEN_INTERVAL_MS = 5 * 60 * 1000;
const lastSeenCache = new Map<string, number>();

export function provisionUser(auth: ForwardedAuth, isAdmin: boolean): SessionUser {
	const now = new Date();
	let row = db.select().from(users).where(eq(users.username, auth.username)).get();

	if (!row) {
		row = {
			id: randomUUID(),
			username: auth.username,
			email: auth.email,
			displayName: auth.displayName,
			isAdmin,
			createdAt: now,
			lastSeenAt: now
		};
		db.insert(users).values(row).run();
		lastSeenCache.set(row.id, now.getTime());
		return toSession(row);
	}

	const patch: Partial<typeof users.$inferInsert> = {};

	// Group membership is authoritative in Authelia, so a change there must
	// take effect on the next request — write it through immediately rather
	// than waiting for the throttled last-seen update.
	if (row.isAdmin !== isAdmin) patch.isAdmin = isAdmin;
	if (auth.email && auth.email !== row.email) patch.email = auth.email;
	if (auth.displayName && auth.displayName !== row.displayName) {
		patch.displayName = auth.displayName;
	}

	const seen = lastSeenCache.get(row.id) ?? 0;
	if (now.getTime() - seen > LAST_SEEN_INTERVAL_MS) {
		patch.lastSeenAt = now;
		lastSeenCache.set(row.id, now.getTime());
	}

	if (Object.keys(patch).length) {
		db.update(users).set(patch).where(eq(users.id, row.id)).run();
		Object.assign(row, patch);
	}
	return toSession(row);
}

function toSession(row: typeof users.$inferSelect): SessionUser {
	return {
		id: row.id,
		username: row.username,
		email: row.email,
		displayName: row.displayName,
		isAdmin: row.isAdmin
	};
}

export function listUsers(): SessionUser[] {
	return db.select().from(users).all().map(toSession);
}
