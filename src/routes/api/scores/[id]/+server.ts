import { json } from '@sveltejs/kit';
import { readJson, requireUser } from '$lib/server/api';
import {
	archiveScore,
	deleteScore,
	loadScore,
	renameScore,
	replaceScore
} from '$lib/server/scores';
import type { Score } from '$lib/score/types';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = ({ locals, params }) => {
	const user = requireUser(locals);
	const row = loadScore(params.id, user.id);
	return json({ id: row.id, title: row.title, doc: row.doc, updatedAt: row.updatedAt.getTime() });
};

export const PATCH: RequestHandler = async ({ locals, params, request }) => {
	const user = requireUser(locals);
	const body = await readJson<{ title?: string; archived?: boolean; doc?: Score }>(request);

	if (typeof body.title === 'string') renameScore(params.id, user.id, body.title.trim() || 'Untitled');
	if (typeof body.archived === 'boolean') archiveScore(params.id, user.id, body.archived);
	// A whole-document write is the transcription/import path. Everything else
	// should go through /ops so it lands in the revision history as operations.
	if (body.doc) replaceScore(params.id, user.id, body.doc, 'Replaced document');

	return json({ ok: true });
};

export const DELETE: RequestHandler = ({ locals, params }) => {
	const user = requireUser(locals);
	deleteScore(params.id, user.id);
	return json({ ok: true });
};
