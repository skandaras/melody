import { json } from '@sveltejs/kit';
import { readJson, requireAdmin } from '$lib/server/api';
import { DEFAULT_MODELS, getSetting, setSetting, type ModelSettings } from '$lib/server/settings';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = ({ locals }) => {
	requireAdmin(locals);
	return json({ models: getSetting<ModelSettings>('models', DEFAULT_MODELS) });
};

export const POST: RequestHandler = async ({ locals, request }) => {
	requireAdmin(locals);
	const body = await readJson<{ models?: Partial<ModelSettings> }>(request);
	const current = getSetting<ModelSettings>('models', DEFAULT_MODELS);

	if (body.models) {
		setSetting('models', {
			primary: body.models.primary?.trim() || current.primary,
			fallbacks: Array.isArray(body.models.fallbacks)
				? body.models.fallbacks.filter((m) => typeof m === 'string' && m.trim())
				: current.fallbacks,
			maxTokens: Number(body.models.maxTokens) > 0 ? Number(body.models.maxTokens) : current.maxTokens
		});
	}
	return json({ models: getSetting<ModelSettings>('models', DEFAULT_MODELS) });
};
