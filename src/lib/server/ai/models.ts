import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { models } from '../db/schema.js';

/**
 * Syncing the model catalogue from OpenRouter.
 *
 * OpenRouter publishes what it serves, with pricing and — crucially — which
 * parameters each model supports. That last part is what stops someone
 * selecting a model that cannot call tools and then getting failures that look
 * like prompting problems.
 *
 * Synced models arrive **disabled**. The catalogue runs to hundreds of entries
 * and almost none of them are wanted; the list you actually pick from should be
 * one you curated, not one a vendor decided.
 */

export interface CatalogueModel {
	modelKey: string;
	displayName: string;
	contextWindow: number | null;
	supportsTools: boolean;
	supportsVision: boolean;
	promptCostPerMTok: number | null;
	completionCostPerMTok: number | null;
}

interface RawModel {
	id?: unknown;
	name?: unknown;
	context_length?: unknown;
	pricing?: { prompt?: unknown; completion?: unknown };
	architecture?: { input_modalities?: unknown };
	supported_parameters?: unknown;
}

/**
 * Normalise one catalogue entry.
 *
 * Pricing arrives as per-token decimal *strings* ("0.000005"), which is both
 * lossy to read and the wrong unit for a cost display — converted to price per
 * million tokens, which is how everyone actually quotes it.
 */
export function parseModel(raw: RawModel): CatalogueModel | null {
	if (typeof raw.id !== 'string' || !raw.id) return null;

	const params = Array.isArray(raw.supported_parameters)
		? raw.supported_parameters.map(String)
		: [];
	const modalities = Array.isArray(raw.architecture?.input_modalities)
		? raw.architecture.input_modalities.map(String)
		: [];

	return {
		modelKey: raw.id,
		displayName: typeof raw.name === 'string' && raw.name ? raw.name : raw.id,
		contextWindow: typeof raw.context_length === 'number' ? raw.context_length : null,
		supportsTools: params.includes('tools'),
		supportsVision: modalities.includes('image'),
		promptCostPerMTok: perMillion(raw.pricing?.prompt),
		completionCostPerMTok: perMillion(raw.pricing?.completion)
	};
}

function perMillion(value: unknown): number | null {
	const n = typeof value === 'string' ? Number(value) : typeof value === 'number' ? value : NaN;
	if (!Number.isFinite(n)) return null;
	return n * 1_000_000;
}

export async function fetchCatalogue(baseUrl: string, apiKey?: string): Promise<CatalogueModel[]> {
	const headers: Record<string, string> = {};
	// The endpoint is public, but sending the key returns the catalogue as this
	// account sees it — which can differ.
	if (apiKey) headers.authorization = `Bearer ${apiKey}`;

	const res = await fetch(`${baseUrl.replace(/\/$/, '')}/models`, { headers });
	if (!res.ok) {
		throw new Error(`Could not read the model catalogue (${res.status} ${res.statusText})`);
	}

	const json = (await res.json()) as { data?: unknown };
	const rows = Array.isArray(json.data) ? json.data : [];
	return rows.map((r) => parseModel(r as RawModel)).filter((m): m is CatalogueModel => m !== null);
}

export interface SyncResult {
	added: number;
	updated: number;
	total: number;
}

/**
 * Upsert the catalogue against a provider.
 *
 * The `enabled` flag is never written on update: it is the one column here
 * that represents a decision the user made, and a sync is not a reason to
 * revisit it.
 */
export function syncModels(providerId: string, catalogue: CatalogueModel[]): SyncResult {
	const existing = new Map(
		db
			.select()
			.from(models)
			.where(eq(models.providerId, providerId))
			.all()
			.map((m) => [m.modelKey, m])
	);

	let added = 0;
	let updated = 0;

	for (const model of catalogue) {
		const row = existing.get(model.modelKey);
		if (row) {
			db.update(models)
				.set({
					displayName: model.displayName,
					contextWindow: model.contextWindow,
					supportsTools: model.supportsTools,
					supportsVision: model.supportsVision,
					promptCostPerMTok: model.promptCostPerMTok,
					completionCostPerMTok: model.completionCostPerMTok
				})
				.where(eq(models.id, row.id))
				.run();
			updated++;
		} else {
			db.insert(models)
				.values({ id: randomUUID(), providerId, ...model, enabled: false })
				.run();
			added++;
		}
	}

	return { added, updated, total: catalogue.length };
}

/** Models the user has curated, for the picker. */
export function enabledModels() {
	return db.select().from(models).where(eq(models.enabled, true)).all();
}

export function setModelEnabled(id: string, enabled: boolean): void {
	db.update(models).set({ enabled }).where(eq(models.id, id)).run();
}

/**
 * Search the catalogue.
 *
 * Tool support is the default filter rather than an option: a model that
 * cannot call tools cannot run a control or an edit, so offering it in the
 * picker would only produce confusing failures later.
 */
export function searchModels(opts: {
	providerId: string;
	query?: string;
	toolsOnly?: boolean;
	limit?: number;
}) {
	const query = opts.query?.trim().toLowerCase();
	const rows = db
		.select()
		.from(models)
		.where(
			opts.toolsOnly === false
				? eq(models.providerId, opts.providerId)
				: and(eq(models.providerId, opts.providerId), eq(models.supportsTools, true))
		)
		.all();

	const matched = query
		? rows.filter(
				(m) =>
					m.modelKey.toLowerCase().includes(query) || m.displayName.toLowerCase().includes(query)
			)
		: rows;

	// Enabled first — those are the ones already chosen — then alphabetically.
	matched.sort((a, b) => {
		if (a.enabled !== b.enabled) return a.enabled ? -1 : 1;
		return a.modelKey.localeCompare(b.modelKey);
	});

	return matched.slice(0, opts.limit ?? 100);
}
