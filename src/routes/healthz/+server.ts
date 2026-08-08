import { env } from '$env/dynamic/private';
import { json } from '@sveltejs/kit';
import { sqlite } from '$lib/server/db';

/**
 * Container health check. Deliberately outside the auth gate — Docker probes
 * this before Authelia is necessarily reachable, and a health check that can
 * fail for auth reasons tells you nothing about the app.
 *
 * It does touch the database: a process that is listening but cannot read its
 * own DB is not healthy, and reporting it as such wastes a debugging session.
 */
export const GET = () => {
	try {
		sqlite.prepare('SELECT 1').get();
	} catch (err) {
		return json(
			{ status: 'error', error: err instanceof Error ? err.message : String(err) },
			{ status: 503 }
		);
	}
	return json({
		status: 'ok',
		env: env.MELODY_ENV || 'dev',
		time: new Date().toISOString()
	});
};
