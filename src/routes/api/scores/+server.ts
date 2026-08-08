import { json } from '@sveltejs/kit';
import { readJson, requireUser } from '$lib/server/api';
import { createScore, listScores } from '$lib/server/scores';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = ({ locals, url }) => {
	const user = requireUser(locals);
	return json({ scores: listScores(user.id, url.searchParams.get('archived') === '1') });
};

export const POST: RequestHandler = async ({ locals, request }) => {
	const user = requireUser(locals);
	const body = await readJson<{ title?: string }>(request);
	const score = createScore(user.id, body.title?.trim() || 'Untitled');
	return json({ id: score.id, title: score.title }, { status: 201 });
};
