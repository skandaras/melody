import { error, json } from '@sveltejs/kit';
import { readJson, requireUser } from '$lib/server/api';
import { createFolder, deleteFolder, listFolders } from '$lib/server/clips';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = ({ locals }) => {
	const user = requireUser(locals);
	return json({ folders: listFolders(user.id) });
};

export const POST: RequestHandler = async ({ locals, request }) => {
	const user = requireUser(locals);
	const body = await readJson<{ name?: string; parentId?: string | null }>(request);
	if (!body.name?.trim()) error(400, 'A folder needs a name');
	return json({ folder: createFolder(user.id, body.name, body.parentId ?? null) });
};

export const DELETE: RequestHandler = async ({ locals, request }) => {
	const user = requireUser(locals);
	const { id } = await readJson<{ id?: string }>(request);
	if (!id) error(400, 'No folder id supplied');
	deleteFolder(id, user.id);
	return json({ folders: listFolders(user.id) });
};
