import { error, json } from '@sveltejs/kit';
import { readJson, requireAdmin } from '$lib/server/api';
import {
	ControlValidationError,
	createControl,
	deleteControl,
	listAdminControls,
	updateControl
} from '$lib/server/controls/admin';
import type { ControlKind } from '$lib/server/db/schema';
import type { RequestHandler } from './$types';

/**
 * Admin CRUD for the control rack.
 *
 * GET is the whole list, including disabled rows — the rack itself only shows
 * enabled ones. POST creates (prompt/agent only); PATCH edits one; DELETE
 * removes a user-created row. Built-ins are never deleted, only disabled,
 * because an upgrade reseeds anything missing.
 */

export const GET: RequestHandler = ({ locals }) => {
	requireAdmin(locals);
	return json({ controls: listAdminControls() });
};

export const POST: RequestHandler = async ({ locals, request }) => {
	requireAdmin(locals);
	const body = await readJson<{
		name?: string;
		category?: string;
		kind?: ControlKind;
		icon?: string;
		description?: string;
		promptTemplate?: string;
		systemPrompt?: string;
		paramsSchema?: Record<string, unknown>;
		defaultParams?: Record<string, unknown>;
	}>(request);

	try {
		const control = createControl({
			name: body.name ?? '',
			category: body.category ?? 'Custom',
			kind: body.kind ?? 'prompt',
			icon: body.icon ?? null,
			description: body.description ?? '',
			promptTemplate: body.promptTemplate ?? '',
			systemPrompt: body.systemPrompt ?? null,
			paramsSchema: body.paramsSchema ?? null,
			defaultParams: body.defaultParams ?? null
		});
		return json({ control });
	} catch (e) {
		if (e instanceof ControlValidationError) error(400, e.message);
		throw e;
	}
};

export const PATCH: RequestHandler = async ({ locals, request }) => {
	requireAdmin(locals);
	const body = await readJson<{ id?: string; patch?: Record<string, unknown> }>(request);
	if (!body.id) error(400, 'id is required');

	try {
		const control = updateControl(body.id, (body.patch ?? {}) as never);
		return json({ control });
	} catch (e) {
		if (e instanceof ControlValidationError) error(400, e.message);
		throw e;
	}
};

export const DELETE: RequestHandler = async ({ locals, request }) => {
	requireAdmin(locals);
	const body = await readJson<{ id?: string }>(request);
	if (!body.id) error(400, 'id is required');

	try {
		deleteControl(body.id);
		return json({ ok: true });
	} catch (e) {
		if (e instanceof ControlValidationError) error(400, e.message);
		throw e;
	}
};
