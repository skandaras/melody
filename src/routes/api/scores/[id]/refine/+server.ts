import { error, json } from '@sveltejs/kit';
import { readJson, requireUser } from '$lib/server/api';
import { assertNothingStaged, loadScore, setPipeline } from '$lib/server/scores';
import { nextStage } from '$lib/pipeline/types';
import type { RequestHandler } from './$types';

/**
 * The refinement stage's own verb.
 *
 * Only one: everything else this stage does is an edit, and edits already have
 * endpoints — controls, the Ask path, the mixer's ops, the revisions review.
 * The form lock rides on those, read off the score's stage, so it needs
 * nothing here.
 */
export const POST: RequestHandler = async ({ locals, params, request }) => {
	const user = requireUser(locals);
	const body = await readJson<{ action?: string }>(request);
	if (body.action !== 'approve') error(400, `Unknown action: ${body.action ?? '(none)'}`);

	// Ownership first, then the staged-change check: moving on would leave a
	// change behind with nobody looking at it. No plan is required — a score
	// made before the pipeline existed has none, and refines like any other.
	loadScore(params.id, user.id);
	assertNothingStaged(params.id, user.id);

	return json({
		pipeline: setPipeline(params.id, user.id, { stage: nextStage('refine') ?? 'refine' })
	});
};
