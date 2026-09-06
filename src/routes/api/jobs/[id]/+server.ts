import { error, json } from '@sveltejs/kit';
import { requireUser } from '$lib/server/api';
import { cancelJob, jobOwner } from '$lib/server/ai/jobs';
import type { RequestHandler } from './$types';

/**
 * Stop a running job.
 *
 * `cancelJob` has existed since the job buffer was written and had no way to be
 * reached — an AI turn could be started but never called off, so a run that had
 * gone wrong could only be waited out.
 *
 * Cancelling aborts the loop; the executor sees the abort, skips the commit and
 * records the job as `cancelled`. Nothing this route does writes to the score.
 */
export const DELETE: RequestHandler = ({ locals, params }) => {
	const user = requireUser(locals);

	// 404 rather than 403 for someone else's job, matching the events stream
	// beside this file and every score route: confirming an id exists is itself
	// a small leak.
	const owner = jobOwner(params.id);
	if (!owner || owner !== user.id) error(404, 'Job not found');

	// False means the job had already finished. That is not an error — the
	// caller wanted it stopped and it is stopped — so report which happened
	// rather than failing a request that got what it asked for.
	return json({ cancelled: cancelJob(params.id) });
};
