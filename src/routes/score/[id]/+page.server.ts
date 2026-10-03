import { redirect } from '@sveltejs/kit';
import { requireUser } from '$lib/server/api';
import { entryRoute } from '$lib/pipeline/types';
import { hasNotes } from '$lib/score/query';
import { loadScore } from '$lib/server/scores';
import type { PageServerLoad } from './$types';

/**
 * Opening a score: always somewhere else.
 *
 * This route was the three-column editor. Every stage now has a page of its
 * own and Bench is the manual surface, so all that is left here is deciding
 * which of them a score opens at. The rule lives in `$lib/pipeline` so the
 * part that keeps older scores out of the brief form is tested rather than
 * merely commented.
 */
export const load: PageServerLoad = ({ locals, params }) => {
	const user = requireUser(locals);
	const row = loadScore(params.id, user.id);
	redirect(307, `/score/${params.id}/${entryRoute(row.pipeline, hasNotes(row.doc))}`);
};
