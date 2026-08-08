import { error, json } from '@sveltejs/kit';
import { readJson, requireUser } from '$lib/server/api';
import {
	acceptRevision,
	listRevisions,
	loadScore,
	rejectRevision,
	restoreRevision
} from '$lib/server/scores';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = ({ locals, params }) => {
	const user = requireUser(locals);
	return json({ revisions: listRevisions(params.id, user.id) });
};

/**
 * Accept, reject or restore.
 *
 * Reject rolls the document back to the revision before the target and marks
 * the target rejected — it never deletes history, so an accidental reject is
 * itself undoable via restore.
 */
export const POST: RequestHandler = async ({ locals, params, request }) => {
	const user = requireUser(locals);
	const body = await readJson<{ action?: string; revisionId?: string }>(request);
	if (!body.revisionId) error(400, 'revisionId is required');

	switch (body.action) {
		case 'accept':
			acceptRevision(params.id, user.id, body.revisionId);
			return json({ ok: true, doc: loadScore(params.id, user.id).doc });
		case 'reject':
			return json({ ok: true, doc: rejectRevision(params.id, user.id, body.revisionId).score });
		case 'restore':
			return json({ ok: true, doc: restoreRevision(params.id, user.id, body.revisionId).score });
		default:
			error(400, 'action must be accept, reject or restore');
	}
};
