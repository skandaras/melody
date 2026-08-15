import { error, json } from '@sveltejs/kit';
import { readJson, requireAdmin } from '$lib/server/api';
import { deleteProvider, listProviders, saveProvider } from '$lib/server/ai/admin';
import type { RequestHandler } from './$types';

/**
 * Provider configuration.
 *
 * Every response goes through listProviders/saveProvider, which return a view
 * with `hasKey` and a four-character hint in place of the secret. There is no
 * path here that puts a key — plaintext or ciphertext — on the wire.
 */

export const GET: RequestHandler = ({ locals }) => {
	requireAdmin(locals);
	return json({ providers: listProviders() });
};

export const POST: RequestHandler = async ({ locals, request }) => {
	requireAdmin(locals);
	const body = await readJson<Parameters<typeof saveProvider>[0]>(request);
	return json({ provider: saveProvider(body) });
};

export const DELETE: RequestHandler = async ({ locals, request }) => {
	requireAdmin(locals);
	const { id } = await readJson<{ id?: string }>(request);
	if (!id) error(400, 'No provider id supplied');
	deleteProvider(id);
	return json({ providers: listProviders() });
};
