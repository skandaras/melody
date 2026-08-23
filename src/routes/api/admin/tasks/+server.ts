import { json } from '@sveltejs/kit';
import { readJson, requireAdmin } from '$lib/server/api';
import {
	listPromptVersions,
	listTasks,
	restorePromptVersion,
	saveTask,
	type SaveTaskInput
} from '$lib/server/ai/tasks';
import { CORE_TASKS, type CoreTask } from '$lib/server/db/schema';
import type { RequestHandler } from './$types';

/**
 * Per-task model and reasoning configuration.
 *
 * Admin-only, like everything under /api/admin — these settings decide what
 * gets billed to the operator's OpenRouter key.
 */

export const GET: RequestHandler = ({ locals, url }) => {
	requireAdmin(locals);

	const task = url.searchParams.get('versionsFor');
	if (task) {
		if (!CORE_TASKS.includes(task as CoreTask)) return json({ versions: [] });
		return json({ versions: listPromptVersions(task as CoreTask) });
	}
	return json({ tasks: listTasks() });
};

export const POST: RequestHandler = async ({ locals, request }) => {
	const user = requireAdmin(locals);
	const body = await readJson<
		SaveTaskInput & { action?: 'save' | 'restore'; versionId?: string }
	>(request);

	if (body.action === 'restore') {
		if (!body.versionId) return json({ error: 'versionId is required' }, { status: 400 });
		return json({ task: restorePromptVersion(body.task, body.versionId, user.username) });
	}

	return json({ task: saveTask({ ...body, author: user.username }) });
};
