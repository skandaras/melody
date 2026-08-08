import { requireUser } from '$lib/server/api';
import { listRevisions, loadScore } from '$lib/server/scores';
import { listControls } from '$lib/server/controls/registry';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = ({ locals, params }) => {
	const user = requireUser(locals);
	const row = loadScore(params.id, user.id);
	return {
		score: { id: row.id, title: row.title, doc: row.doc },
		revisions: listRevisions(params.id, user.id, 40).map((r) => ({
			...r,
			createdAt: r.createdAt.getTime()
		})),
		controls: listControls()
	};
};
