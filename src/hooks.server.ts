import { env } from '$env/dynamic/private';
import { error, type Handle } from '@sveltejs/kit';
import {
	isAdminFromGroups,
	isTrustedProxy,
	parseAuthHeaders,
	parseTrustedProxies
} from '$lib/server/auth';
import { ensureDataDirs, runMigrations } from '$lib/server/db';
import { seedTaskConfigs, seedControls, seedStyleSkills } from '$lib/server/bootstrap';
import { provisionUser } from '$lib/server/users';

// Module scope: this runs once, before any request is served, so no handler
// ever has to wonder whether the schema is current.
runMigrations();
ensureDataDirs();
seedTaskConfigs();
seedControls();
seedStyleSkills();

/**
 * Paths served without an identity.
 *
 * /healthz is the container health check, which must answer before Authelia is
 * even reachable. Everything else — including static assets — goes through the
 * gate, because gating at the proxy means there is nothing to leak anyway and
 * one rule is easier to verify than two.
 */
const PUBLIC_PATHS = new Set(['/healthz']);

export const handle: Handle = async ({ event, resolve }) => {
	event.locals.user = null;

	if (PUBLIC_PATHS.has(event.url.pathname)) return resolve(event);

	// Default to the gated mode when unset: an accidentally-missing env var
	// should lock the door, not open it.
	const authMode = env.AUTH_MODE || 'authelia';
	const adminGroup = env.ADMIN_GROUP || 'melody-admins';

	if (authMode === 'dev') {
		const username = env.DEV_USER || 'dev';
		event.locals.user = provisionUser(
			{ username, email: null, displayName: username, groups: [adminGroup] },
			true
		);
		return resolve(event);
	}

	// The load-bearing check. Without it, anything that can reach this port can
	// set Remote-User and become an admin.
	const trusted = parseTrustedProxies(env.TRUSTED_PROXY_IPS);
	if (!isTrustedProxy(event.getClientAddress(), trusted)) {
		error(403, 'Forbidden: request did not arrive via the trusted proxy');
	}

	const auth = parseAuthHeaders((name) => event.request.headers.get(name));
	if (!auth) error(401, 'Unauthorized: no identity headers present');

	event.locals.user = provisionUser(auth, isAdminFromGroups(auth.groups, adminGroup));
	return resolve(event);
};
