import { error, json } from '@sveltejs/kit';
import { readJson, requireAdmin } from '$lib/server/api';
import {
	SkillValidationError,
	createSkill,
	deleteSkill,
	listAdminSkills,
	readSkill,
	setSkillEnabled,
	writeSkill
} from '$lib/server/ai/skills-admin';
import type { RequestHandler } from './$types';

/**
 * Admin CRUD for style skills.
 *
 * GET returns the index; ?id= adds the body for one skill (the editor loads it
 * on open rather than shipping every body up front). POST creates, PATCH
 * writes a body or toggles enabled, DELETE removes file and row.
 */

export const GET: RequestHandler = ({ locals, url }) => {
	requireAdmin(locals);
	const id = url.searchParams.get('id');
	if (id) {
		try {
			return json({ skill: readSkill(id) });
		} catch (e) {
			if (e instanceof SkillValidationError) error(404, e.message);
			throw e;
		}
	}
	return json({ skills: listAdminSkills() });
};

export const POST: RequestHandler = async ({ locals, request }) => {
	requireAdmin(locals);
	const body = await readJson<{ name?: string; category?: string; body?: string }>(request);
	try {
		return json({ skill: createSkill(body.name ?? '', body.category ?? 'style', body.body ?? '') });
	} catch (e) {
		if (e instanceof SkillValidationError) error(400, e.message);
		throw e;
	}
};

export const PATCH: RequestHandler = async ({ locals, request }) => {
	requireAdmin(locals);
	const body = await readJson<{ id?: string; body?: string; enabled?: boolean }>(request);
	if (!body.id) error(400, 'id is required');
	try {
		const skill =
			body.body !== undefined
				? writeSkill(body.id, body.body)
				: setSkillEnabled(body.id, Boolean(body.enabled));
		return json({ skill });
	} catch (e) {
		if (e instanceof SkillValidationError) error(e.message.includes('not found') ? 404 : 400, e.message);
		throw e;
	}
};

export const DELETE: RequestHandler = async ({ locals, request }) => {
	requireAdmin(locals);
	const body = await readJson<{ id?: string }>(request);
	if (!body.id) error(400, 'id is required');
	try {
		deleteSkill(body.id);
		return json({ ok: true });
	} catch (e) {
		if (e instanceof SkillValidationError) error(404, e.message);
		throw e;
	}
};
