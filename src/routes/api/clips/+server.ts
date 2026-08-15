import { error, json } from '@sveltejs/kit';
import { readJson, requireUser } from '$lib/server/api';
import { listClips, saveClip } from '$lib/server/clips';
import type { Score } from '$lib/score/types';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = ({ locals, url }) => {
	const user = requireUser(locals);
	const folder = url.searchParams.get('folderId');
	return json({
		clips: listClips(user.id, folder === null ? undefined : folder === 'root' ? null : folder)
	});
};

export const POST: RequestHandler = async ({ locals, request }) => {
	const user = requireUser(locals);
	const body = await readJson<{
		name?: string;
		fragment?: Score;
		bars?: number;
		folderId?: string | null;
		tags?: string[];
	}>(request);

	if (!body.fragment || typeof body.fragment !== 'object') error(400, 'No fragment supplied');
	return json({
		clip: saveClip(user.id, {
			name: body.name ?? 'Untitled clip',
			fragment: body.fragment,
			bars: body.bars ?? 0,
			folderId: body.folderId ?? null,
			tags: body.tags
		})
	});
};
