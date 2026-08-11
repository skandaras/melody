import { error, json } from '@sveltejs/kit';
import { readJson, requireUser } from '$lib/server/api';
import { mergeIntoScore } from '$lib/server/scores';
import type { Score } from '$lib/score/types';
import type { RequestHandler } from './$types';

/**
 * Take delivery of a transcription.
 *
 * The audio never reaches this endpoint. Recording, resampling and pitch
 * detection all happen in the browser, and what arrives here is the finished
 * score fragment — which is what keeps a 2GB droplet out of the business of
 * running neural networks.
 *
 * It lands unaccepted, so the editor's existing accept/reject review covers
 * it: a hummed melody is a draft, and rejecting the lot in one click beats
 * deleting fifty wrong notes by hand.
 */
export const POST: RequestHandler = async ({ locals, params, request }) => {
	const user = requireUser(locals);
	const body = await readJson<{
		fragment?: Score;
		label?: string;
		atTick?: number;
		adoptGlobals?: boolean;
	}>(request);

	if (!body.fragment || typeof body.fragment !== 'object') {
		error(400, 'No transcription supplied');
	}

	const result = mergeIntoScore(params.id, user.id, body.fragment, {
		label: body.label?.trim() || 'Transcription',
		atTick: body.atTick,
		adoptGlobals: body.adoptGlobals
	});

	return json({
		doc: result.score,
		revisionId: result.revisionId,
		diff: result.diff,
		log: result.log
	});
};
