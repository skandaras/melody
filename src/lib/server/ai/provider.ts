import { eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { providers, taskConfigs, type CoreTask, type TaskOptions } from '../db/schema.js';
import { tryDecrypt } from '../crypto.js';
import { DEFAULT_MODELS, getSetting, type ModelSettings } from '../settings.js';
import { OpenRouterAdapter } from './openrouter.js';
import type { ProviderAdapter } from './types.js';

/**
 * Turning stored configuration into a ready adapter.
 *
 * Everything the model layer needs — key, model, per-task effort — lives in
 * the database so it is editable from the admin panel rather than baked into a
 * deploy. This is the one place that assembles it.
 */

export class NoProviderError extends Error {
	constructor() {
		super('No AI provider is configured. Add an OpenRouter key in Admin → Providers.');
		this.name = 'NoProviderError';
	}
}

export interface ResolvedTask {
	adapter: ProviderAdapter;
	model: string;
	options: TaskOptions;
	systemPrompt: string;
}

/** The enabled OpenRouter provider row, if there is one with a usable key. */
export function activeProvider() {
	const rows = db.select().from(providers).where(eq(providers.enabled, true)).all();
	for (const row of rows) {
		if (row.kind !== 'openrouter') continue;
		const apiKey = tryDecrypt(row.apiKeyEnc);
		if (apiKey) return { row, apiKey };
	}
	return null;
}

export function hasProvider(): boolean {
	return activeProvider() !== null;
}

/**
 * Build everything needed to run one task.
 *
 * Throws `NoProviderError` rather than returning null: every caller would have
 * to handle the null case identically, and a typed error carries the message
 * the UI should show.
 */
export function resolveTask(task: CoreTask, origin?: string): ResolvedTask {
	const provider = activeProvider();
	if (!provider) throw new NoProviderError();

	const config = db.select().from(taskConfigs).where(eq(taskConfigs.task, task)).get();
	const models = getSetting<ModelSettings>('models', DEFAULT_MODELS);
	const model = config?.primaryModelId || models.primary;

	// The backup model, if the task names one, takes precedence over the
	// global list — a task configured to fall back to something specific meant
	// it.
	const fallbacks = config?.backupModelId
		? [config.backupModelId, ...models.fallbacks]
		: models.fallbacks;

	const adapter = new OpenRouterAdapter({
		apiKey: provider.apiKey,
		model,
		fallbackModels: [...new Set(fallbacks)].filter((m) => m !== model),
		baseUrl: provider.row.baseUrl || undefined,
		appUrl: origin,
		appName: 'Melody'
	});

	return {
		adapter,
		model,
		options: config?.options ?? { effort: 'medium', reasoning: 'hidden' },
		systemPrompt: config?.systemPrompt ?? ''
	};
}
