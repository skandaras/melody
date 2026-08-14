import { error } from '@sveltejs/kit';
import { requireUser, sseResponse } from '$lib/server/api';
import { jobOwner, subscribe } from '$lib/server/ai/jobs';
import type { RequestHandler } from './$types';

/**
 * Progress for one AI job.
 *
 * Subscribing replays everything that has already happened before tailing the
 * live stream, so reconnecting after a reload or a network change loses
 * nothing.
 */
export const GET: RequestHandler = ({ locals, params }) => {
	const user = requireUser(locals);

	// 404 rather than 403 for someone else's job, matching how scores behave:
	// confirming an id exists is itself a small leak.
	const owner = jobOwner(params.id);
	if (!owner || owner !== user.id) error(404, 'Job not found');

	return sseResponse((ctrl) => {
		const off = subscribe(params.id, (event) => {
			if (event.type === '__end__') {
				ctrl.close();
				return;
			}
			ctrl.send(event.type, { seq: event.seq, ...(event.data as object) });
		});
		return off;
	});
};
