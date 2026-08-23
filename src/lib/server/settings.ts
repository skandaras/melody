import { and, eq } from 'drizzle-orm';
import { db } from './db/index.js';
import { settings } from './db/schema.js';
import type { Theme } from '$lib/theme.js';

/**
 * Scoped key/value settings.
 *
 * No caching, deliberately: these are point lookups on a primary key in an
 * embedded SQLite file, so a read costs microseconds, and skipping the cache
 * means a config change takes effect on the very next request with no
 * invalidation logic to get wrong.
 */

export const GLOBAL_SCOPE = 'global';

export function getSetting<T>(key: string, fallback: T, scope = GLOBAL_SCOPE): T {
	const row = db
		.select()
		.from(settings)
		.where(and(eq(settings.scope, scope), eq(settings.key, key)))
		.get();
	if (!row) return fallback;
	return row.value as T;
}

export function setSetting(key: string, value: unknown, scope = GLOBAL_SCOPE): void {
	const now = new Date();
	db.insert(settings)
		.values({ scope, key, value, updatedAt: now })
		.onConflictDoUpdate({
			target: [settings.scope, settings.key],
			set: { value, updatedAt: now }
		})
		.run();
}

/** value is NOT NULL, so clearing a setting means deleting the row. */
export function deleteSetting(key: string, scope = GLOBAL_SCOPE): void {
	db.delete(settings)
		.where(and(eq(settings.scope, scope), eq(settings.key, key)))
		.run();
}

// ---------------------------------------------------------------------------
// Typed layer over the untyped table. One interface + one DEFAULT_ per key, so
// adding a knob is an interface field and a default — never a migration. The
// rationale for each cap lives beside the field, and the admin UI quotes it.
// ---------------------------------------------------------------------------

export interface AiSettings {
	/** Hard ceiling on ops one AI turn may apply. A model that has decided to
	 *  rewrite the entire piece should be stopped, not merely logged. */
	maxOpsPerTurn: number;
	/** Model round-trips per agent turn before we call it and return. */
	maxIterations: number;
	/** Bars sent per compose_realize call. Larger is more coherent and more
	 *  expensive; beyond ~16 the model starts losing the thread anyway. */
	realizeChunkBars: number;
	/** Attach style skill markdown to prompts. Off makes every call cheaper
	 *  and noticeably more generic. */
	useStyleSkills: boolean;
}
export const DEFAULT_AI: AiSettings = {
	maxOpsPerTurn: 400,
	maxIterations: 8,
	realizeChunkBars: 8,
	useStyleSkills: true
};

/**
 * Which model to use, and what to fall back to.
 *
 * Deliberately empty by default. Naming a model here would mean melody picks a
 * vendor on the operator's behalf and quietly bills them for it — and it would
 * be a model they never enabled in their own catalogue. The whole point of
 * routing through OpenRouter is that this is the operator's choice, so an
 * unconfigured install asks rather than assumes. See resolveTask, which turns
 * an empty primary into a clear error instead of a request.
 *
 * The fallback list is tried in order when the primary is unavailable or
 * rate-limited.
 */
export interface ModelSettings {
	primary: string;
	fallbacks: string[];
	/** Ceiling per call. Generous, because an agent turn interleaves reasoning,
	 *  tool calls and prose, and truncation mid-edit is worse than a big bill. */
	maxTokens: number;
}
export const DEFAULT_MODELS: ModelSettings = {
	primary: '',
	fallbacks: [],
	maxTokens: 16000
};

export interface BudgetSettings {
	/** USD ceiling per period; 0 disables the cap entirely. */
	limitUsd: number;
	period: 'day' | 'week' | 'month';
}
export const DEFAULT_BUDGET: BudgetSettings = { limitUsd: 0, period: 'month' };

export interface AudioSettings {
	/** Served to the browser; one file drives both playback and WAV export. */
	soundfontUrl: string;
	/** Metronome on by default during recording, off during playback. */
	countInBars: number;
	masterVolume: number;
	/** Sample rate for offline WAV render. 44100 is CD quality and plenty. */
	renderSampleRate: number;
}
export const DEFAULT_AUDIO: AudioSettings = {
	soundfontUrl: '/soundfonts/MuseScore_General.sf3',
	countInBars: 1,
	masterVolume: 0.85,
	renderSampleRate: 44100
};

export interface TranscribeSettings {
	/** basic-pitch note-detection threshold. Lower catches quiet notes and
	 *  more noise; higher is cleaner but drops soft passages. */
	noteThreshold: number;
	onsetThreshold: number;
	/** Shortest note to keep, in milliseconds. Filters detector chatter. */
	minNoteMs: number;
	/** Snap transcribed notes to this grid in ticks. 0 leaves them raw. */
	quantiseGrid: number;
	/** Run the AI cleanup pass automatically after transcription. */
	autoCleanup: boolean;
}
export const DEFAULT_TRANSCRIBE: TranscribeSettings = {
	noteThreshold: 0.3,
	onsetThreshold: 0.5,
	minNoteMs: 70,
	quantiseGrid: 120,
	autoCleanup: false
};

export interface RetentionSettings {
	/** Revisions kept per score. Older ones are pruned oldest-first, which
	 *  bounds the gzipped snapshots that dominate this table's size. */
	revisionsPerScore: number;
	eventDays: number;
	usageDays: number;
	/** Keep source audio after transcription? Off saves the most disk by far. */
	keepRecordings: boolean;
}
export const DEFAULT_RETENTION: RetentionSettings = {
	revisionsPerScore: 100,
	eventDays: 30,
	usageDays: 365,
	keepRecordings: true
};

/** Per-user, stored under the user's id as scope rather than 'global'. */
export function getUserTheme(userId: string, fallback: Theme): Theme {
	return getSetting<Theme>('theme', fallback, userId);
}
