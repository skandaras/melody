import { json } from '@sveltejs/kit';
import { readJson, requireUser } from '$lib/server/api';
import { deleteClip, loadClip, updateClip } from '$lib/server/clips';
import type { RequestHandler } from './$types';

/** The full row, fragment included — this is what insertion reads. */
export const GET: RequestHandler = ({ locals, params }) => {
	const user = requireUser(locals);
	const row = loadClip(params.id, user.id);
	return json({ clip: { id: row.id, name: row.name, bars: row.bars, fragment: row.fragment } });
};

export const PATCH: RequestHandler = async ({ locals, params, request }) => {
	const user = requireUser(locals);
	const body = await readJson<{ name?: string; folderId?: string | null; tags?: string[] }>(request);
	return json({ clip: updateClip(params.id, user.id, body) });
};

export const DELETE: RequestHandler = ({ locals, params }) => {
	const user = requireUser(locals);
	deleteClip(params.id, user.id);
	return json({ ok: true });
};
