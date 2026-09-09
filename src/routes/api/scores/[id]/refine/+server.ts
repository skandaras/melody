import { error, json } from '@sveltejs/kit';
import { readJson, requireUser } from '$lib/server/api';
import { BudgetExceededError } from '$lib/server/budget';
import { NoModelError, NoProviderError } from '$lib/server/ai/provider';
import { startExplain } from '$lib/server/ai/describe';
import { loadScore, setPipeline } from '$lib/server/scores';
import { furthest, nextStage } from '$lib/pipeline/types';
import type { RequestHandler } from './$types';

/**
 * The refinement stage's verbs, and there are only two.
 *
 * Everything else this stage does already has a home: the controls run through
 * `/controls/[controlId]`, the feedback box through `/ai` — it is the Ask box,
 * unchanged, which is what `edit_selection` was always for — and accepting or
 * rejecting what either produced through `/revisions`. A stage endpoint exists
 * for what is specific to the stage, not to re-front what is not.
 */
export const POST: RequestHandler = async ({ locals, params, request, url }) => {
	const user = requireUser(locals);
	const body = await readJson<{ action?: string }>(request);

	switch (body.action) {
		case 'explain':
			return explain(params.id, user.id, url.origin);
		case 'approve':
			return approve(params.id, user.id);
		default:
			error(400, `Unknown action: ${body.action ?? '(none)'}`);
	}
};

/**
 * The paid `analyse` task, on request only.
 *
 * Deliberately a button rather than something the page does on arrival. The
 * free `analyse()` read-out is already on screen and costs nothing; this is the
 * prose layered on top, and it costs a call. The epic asks for exactly that
 * split — "show the free one always; offer the paid one on request" — which
 * only reads as a choice if the free one is visibly already there.
 */
function explain(scoreId: string, userId: string, origin: string) {
	try {
		return json(startExplain({ scoreId, userId, origin }));
	} catch (err) {
		if (
			err instanceof NoProviderError ||
			err instanceof NoModelError ||
			err instanceof BudgetExceededError
		) {
			error(400, err.message);
		}
		throw err;
	}
}

/**
 * Move on to the finish.
 *
 * Gates on nothing, unlike the arrangement's "arrange at least one part". A
 * stage that wrote no notes has failed at its job; a piece that needed no
 * expressive edits has not. Refusing to continue would strand a finished piece
 * behind a demand to change something about it.
 */
function approve(scoreId: string, userId: string) {
	const row = loadScore(scoreId, userId);

	return json({
		pipeline: setPipeline(scoreId, userId, {
			// See the arrangement route: the stepper makes it possible to walk back
			// into this stage, and approving it again must not rewind the score.
			stage: furthest(row.pipeline.stage, nextStage('refine') ?? 'refine')
		})
	});
}
