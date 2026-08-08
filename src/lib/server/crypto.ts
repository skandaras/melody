import { env } from '$env/dynamic/private';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { dataDir } from './db/index.js';

/**
 * AES-256-GCM for secrets at rest — provider API keys today, anything else
 * that must survive a restart but never reach the browser tomorrow.
 *
 * This is not for credentials: melody has no passwords to hash. Identity comes
 * from Authelia.
 */

const KEY_FILE = join(dataDir, 'melody.key');
let cached: Buffer | null = null;

function masterKey(): Buffer {
	if (cached) return cached;

	const fromEnv = env.SECRET_KEY || process.env.SECRET_KEY;
	if (fromEnv) {
		const buf = Buffer.from(fromEnv, 'hex');
		if (buf.length !== 32) {
			throw new Error('SECRET_KEY must be 64 hex characters (32 bytes)');
		}
		cached = buf;
		return cached;
	}

	// Generating and persisting beats refusing to start: losing this key means
	// re-entering provider API keys, nothing worse, so the convenience is worth
	// more than forcing an env var on every fresh install.
	if (existsSync(KEY_FILE)) {
		cached = Buffer.from(readFileSync(KEY_FILE, 'utf8').trim(), 'hex');
		if (cached.length === 32) return cached;
	}
	const generated = randomBytes(32);
	writeFileSync(KEY_FILE, generated.toString('hex'), { mode: 0o600 });
	cached = generated;
	return cached;
}

/** Self-describing so the format can change without a migration. */
export function encryptSecret(plain: string): string {
	const iv = randomBytes(12);
	const cipher = createCipheriv('aes-256-gcm', masterKey(), iv);
	const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
	return ['v1', iv.toString('hex'), cipher.getAuthTag().toString('hex'), ct.toString('hex')].join(
		':'
	);
}

export function decryptSecret(payload: string): string {
	const [version, ivHex, tagHex, ctHex] = payload.split(':');
	if (version !== 'v1') throw new Error(`Unknown secret format: ${version}`);
	const decipher = createDecipheriv('aes-256-gcm', masterKey(), Buffer.from(ivHex, 'hex'));
	decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
	return Buffer.concat([decipher.update(Buffer.from(ctHex, 'hex')), decipher.final()]).toString(
		'utf8'
	);
}

/** Decrypt without throwing, for read paths that should degrade not explode. */
export function tryDecrypt(payload: string | null | undefined): string | undefined {
	if (!payload) return undefined;
	try {
		return decryptSecret(payload);
	} catch {
		return undefined;
	}
}
