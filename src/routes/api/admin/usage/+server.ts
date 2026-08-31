import { json } from '@sveltejs/kit';
import { requireAdmin } from '$lib/server/api';
import { usageReport } from '$lib/server/usage';
import type { RequestHandler } from './$types';

/** Everything the Usage tab shows, in one fetch. */
export const GET: RequestHandler = ({ locals }) => {
	requireAdmin(locals);
	return json(usageReport());
};
