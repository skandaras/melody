import { error, json } from '@sveltejs/kit';
import { readJson, requireUser } from '$lib/server/api';
import { acceptRevision, pendingRevisions, setPipeline } from '$lib/server/scores';
import { isBriefUsable, isStage, type Brief, type Stage } from '$lib/pipeline/types';
import type { RequestHandler } from './$types';

/**
 * Save a brief, and optionally move the score on from it.
 *
 * Kept apart from /ops because a stage change is not a change to the music.
 * Writing a brief adds no notes, and the operations that do add notes should
 * not have to know which stage asked for them.
 */
export const POST: RequestHandler = async ({ locals, params, request }) => {
	const user = requireUser(locals);
	const body = await readJson<{ brief?: Brief; stage?: string; advance?: boolean }>(request);

	const brief = body.brief;
	if (!brief || typeof brief.description !== 'string') error(400, 'No brief supplied');

	// Advancing on an empty brief would hand the plan stage nothing to work
	// from; saving one is fine, because a draft is allowed to be incomplete.
	if (body.advance && !isBriefUsable(brief)) {
		error(400, 'Describe the piece, or record something, before continuing');
	}

	let stage: Stage | undefined;
	if (body.stage !== undefined) {
		if (!isStage(body.stage)) error(400, `Unknown stage: ${body.stage}`);
		stage = body.stage;
	}

	// A transcribed seed lands staged, like any change that arrives as a whole
	// fragment. Continuing has to accept it: everything downstream reads the
	// committed document, and planning against one that can still be rolled
	// back would be building on sand.
	if (body.advance) {
		for (const revision of pendingRevisions(params.id, user.id)) {
			acceptRevision(params.id, user.id, revision.id);
		}
	}

	return json({ pipeline: setPipeline(params.id, user.id, { brief, stage }) });
};
