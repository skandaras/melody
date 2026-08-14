import { error, json } from '@sveltejs/kit';
import { readJson, requireUser } from '$lib/server/api';
import { NoProviderError } from '$lib/server/ai/provider';
import { startEdit } from '$lib/server/ai/run';
import type { Selection } from '$lib/score/types';
import type { RequestHandler } from './$types';

/**
 * Ask the model to edit a score.
 *
 * Returns a job id immediately rather than the finished edit: a turn takes
 * tens of seconds, and holding the request open for it would mean losing the
 * work to any dropped connection. Subscribe to /api/jobs/<id>/events for
 * progress and the result.
 */
export const POST: RequestHandler = async ({ locals, params, request, url }) => {
	const user = requireUser(locals);
	const body = await readJson<{ instruction?: string; selection?: Selection }>(request);

	const instruction = body.instruction?.trim();
	if (!instruction) error(400, 'No instruction supplied');

	try {
		const { jobId } = startEdit({
			scoreId: params.id,
			userId: user.id,
			instruction,
			selection: body.selection ?? {},
			origin: url.origin
		});
		return json({ jobId });
	} catch (err) {
		// A missing key is a configuration problem with a clear fix, not a
		// server fault — say so rather than returning a 500.
		if (err instanceof NoProviderError) error(400, err.message);
		throw err;
	}
};
