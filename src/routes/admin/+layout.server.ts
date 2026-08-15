import { requireAdmin } from '$lib/server/api';
import type { LayoutServerLoad } from './$types';

/**
 * A real guard on the route, not just on the API beneath it.
 *
 * Relying on per-endpoint checks plus a hidden nav link means a non-admin who
 * guesses the URL gets a rendered page that fails piecemeal as each fetch is
 * refused. Refusing here is both clearer and one line.
 */
export const load: LayoutServerLoad = ({ locals }) => {
	const user = requireAdmin(locals);
	return { admin: { name: user.displayName ?? user.username } };
};
