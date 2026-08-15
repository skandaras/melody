import { randomUUID } from 'node:crypto';
import { error } from '@sveltejs/kit';
import { eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { models, providers, type ProviderKind } from '../db/schema.js';
import { encryptSecret, tryDecrypt } from '../crypto.js';

/**
 * Provider administration.
 *
 * The one rule that shapes this module: an API key goes in and never comes
 * back. Not the plaintext, and not the ciphertext either — shipping the
 * encrypted blob to the browser would put the whole secret on the wire and
 * leave only the key protecting it. The UI gets a boolean and a hint.
 */

export const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';

export interface ProviderView {
	id: string;
	kind: ProviderKind;
	name: string;
	baseUrl: string;
	/** Whether a key is stored. Never the key, never the ciphertext. */
	hasKey: boolean;
	/** Last four characters, so the user can tell which key is loaded. */
	keyHint: string | null;
	enabled: boolean;
	modelCount: number;
}

export function listProviders(): ProviderView[] {
	const rows = db.select().from(providers).all();
	const all = db.select().from(models).all();

	return rows.map((row) => {
		const key = tryDecrypt(row.apiKeyEnc);
		return {
			id: row.id,
			kind: row.kind,
			name: row.name,
			baseUrl: row.baseUrl,
			hasKey: Boolean(key),
			// Four characters identifies a key among the user's own without
			// being enough to use, and without revealing its length.
			keyHint: key ? key.slice(-4) : null,
			enabled: row.enabled,
			modelCount: all.filter((m) => m.providerId === row.id).length
		};
	});
}

export interface SaveProviderInput {
	id?: string;
	name?: string;
	baseUrl?: string;
	kind?: ProviderKind;
	enabled?: boolean;
	/**
	 * Tri-state, and the distinction matters: absent leaves the stored key
	 * alone (so saving a name change does not wipe it), a string replaces it,
	 * and null clears it. Galaxy had two contradictory conventions for this;
	 * melody has one.
	 */
	apiKey?: string | null;
}

export function saveProvider(input: SaveProviderInput): ProviderView {
	if (input.id) {
		const row = db.select().from(providers).where(eq(providers.id, input.id)).get();
		if (!row) error(404, 'Provider not found');

		const patch: Record<string, unknown> = {};
		if (input.name !== undefined) patch.name = input.name.trim() || row.name;
		if (input.baseUrl !== undefined) patch.baseUrl = normaliseBaseUrl(input.baseUrl) || row.baseUrl;
		if (input.enabled !== undefined) patch.enabled = input.enabled;
		if (input.apiKey !== undefined) {
			patch.apiKeyEnc = input.apiKey === null ? null : encryptSecret(input.apiKey.trim());
		}

		if (Object.keys(patch).length) {
			db.update(providers).set(patch).where(eq(providers.id, input.id)).run();
		}
		return byId(input.id);
	}

	const id = randomUUID();
	db.insert(providers)
		.values({
			id,
			kind: input.kind ?? 'openrouter',
			name: input.name?.trim() || 'OpenRouter',
			baseUrl: normaliseBaseUrl(input.baseUrl) || OPENROUTER_BASE_URL,
			apiKeyEnc: input.apiKey ? encryptSecret(input.apiKey.trim()) : null,
			enabled: input.enabled ?? true,
			createdAt: new Date()
		})
		.run();
	return byId(id);
}

export function deleteProvider(id: string): void {
	// Models belong to their provider; leaving them would put orphans in the
	// picker that resolve to nothing.
	db.delete(models).where(eq(models.providerId, id)).run();
	db.delete(providers).where(eq(providers.id, id)).run();
}

/** The decrypted key, for server-side use only. */
export function providerSecret(id: string): { baseUrl: string; apiKey: string } | null {
	const row = db.select().from(providers).where(eq(providers.id, id)).get();
	if (!row) return null;
	const apiKey = tryDecrypt(row.apiKeyEnc);
	return apiKey ? { baseUrl: row.baseUrl, apiKey } : null;
}

function byId(id: string): ProviderView {
	const view = listProviders().find((p) => p.id === id);
	if (!view) error(404, 'Provider not found');
	return view;
}

/** Trim, drop a trailing slash, and reject anything that is not a URL. */
function normaliseBaseUrl(value: string | undefined): string | null {
	const trimmed = value?.trim();
	if (!trimmed) return null;
	try {
		new URL(trimmed);
	} catch {
		error(400, `"${trimmed}" is not a valid URL`);
	}
	return trimmed.replace(/\/$/, '');
}
