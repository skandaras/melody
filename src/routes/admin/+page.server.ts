import { listProviders } from '$lib/server/ai/admin';
import { searchModels } from '$lib/server/ai/models';
import { DEFAULT_MODELS, getSetting, type ModelSettings } from '$lib/server/settings';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = () => {
	const providers = listProviders();
	const active = providers.find((p) => p.enabled && p.hasKey) ?? providers[0];
	return {
		providers,
		models: active ? searchModels({ providerId: active.id, toolsOnly: false, limit: 500 }) : [],
		settings: getSetting<ModelSettings>('models', DEFAULT_MODELS)
	};
};
