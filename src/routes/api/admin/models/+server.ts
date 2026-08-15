import { error, json } from '@sveltejs/kit';
import { readJson, requireAdmin } from '$lib/server/api';
import { providerSecret } from '$lib/server/ai/admin';
import { fetchCatalogue, searchModels, setModelEnabled, syncModels } from '$lib/server/ai/models';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = ({ locals, url }) => {
	requireAdmin(locals);
	const providerId = url.searchParams.get('providerId');
	if (!providerId) error(400, 'No provider id supplied');

	return json({
		models: searchModels({
			providerId,
			query: url.searchParams.get('q') ?? undefined,
			toolsOnly: url.searchParams.get('all') !== '1',
			limit: 200
		})
	});
};

/** Pull the catalogue, or toggle one model's place in the curated list. */
export const POST: RequestHandler = async ({ locals, request }) => {
	requireAdmin(locals);
	const body = await readJson<{
		action?: 'sync' | 'toggle';
		providerId?: string;
		id?: string;
		enabled?: boolean;
	}>(request);

	if (body.action === 'toggle') {
		if (!body.id) error(400, 'No model id supplied');
		setModelEnabled(body.id, Boolean(body.enabled));
		return json({ ok: true });
	}

	if (!body.providerId) error(400, 'No provider id supplied');
	const secret = providerSecret(body.providerId);
	if (!secret) error(400, 'That provider has no API key stored');

	try {
		const catalogue = await fetchCatalogue(secret.baseUrl, secret.apiKey);
		return json({ result: syncModels(body.providerId, catalogue) });
	} catch (err) {
		// A sync failure is almost always a bad key or no egress — surface the
		// reason rather than a bare 500.
		error(502, err instanceof Error ? err.message : 'Could not reach the provider');
	}
};
