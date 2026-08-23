import { error, json } from '@sveltejs/kit';
import { readJson, requireUser } from '$lib/server/api';
import { NoModelError, NoProviderError, runControl } from '$lib/server/controls/run';
import type { Selection } from '$lib/score/types';
import type { RequestHandler } from './$types';

/**
 * Run one control.
 *
 * The response is discriminated by tier rather than uniform: a `code` control
 * is deterministic and instant, so it returns the finished document, while the
 * two model-backed tiers return a job id to subscribe to. Flattening that
 * distinction would mean making the free, instant tier wait on machinery it
 * does not need.
 */
export const POST: RequestHandler = async ({ locals, params, request, url }) => {
	const user = requireUser(locals);
	const body = await readJson<{ params?: Record<string, unknown>; selection?: Selection }>(request);

	try {
		const result = runControl({
			controlId: params.controlId,
			scoreId: params.id,
			userId: user.id,
			params: body.params ?? {},
			selection: body.selection ?? {},
			origin: url.origin
		});
		return json(result);
	} catch (err) {
		if (err instanceof NoProviderError || err instanceof NoModelError) error(400, err.message);
		throw err;
	}
};
