import { requireUser } from '$lib/server/api';
import { listScores } from '$lib/server/scores';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = ({ locals }) => {
	const user = requireUser(locals);
	return {
		scores: listScores(user.id).map((s) => ({
			id: s.id,
			title: s.title,
			updatedAt: s.updatedAt.getTime()
		}))
	};
};
