import { json } from '@sveltejs/kit';
import { readJson, requireAdmin } from '$lib/server/api';
import {
	DEFAULT_AUDIO,
	DEFAULT_BUDGET,
	DEFAULT_MODELS,
	DEFAULT_RETENTION,
	DEFAULT_TRANSCRIBE,
	getSetting,
	setSetting,
	type AudioSettings,
	type BudgetSettings,
	type ModelSettings,
	type RetentionSettings,
	type TranscribeSettings
} from '$lib/server/settings';
import type { RequestHandler } from './$types';

/**
 * Admin settings.
 *
 * models is legacy-shaped (the first section here); budget, transcribe,
 * retention and audio joined it under the same endpoint rather than one route
 * per section. Patches are per-section: a section absent from the body is
 * simply not written, so old callers keep working.
 */

const num = (v: unknown, fallback: number, min: number, max: number) => {
	const n = Number(v);
	return Number.isFinite(n) && n >= min && n <= max ? n : fallback;
};
const bool = (v: unknown, fallback: boolean) => (typeof v === 'boolean' ? v : fallback);
const period = (v: unknown, fallback: BudgetSettings['period']) =>
	v === 'day' || v === 'week' || v === 'month' ? v : fallback;

export const GET: RequestHandler = ({ locals }) => {
	requireAdmin(locals);
	return json({
		models: getSetting<ModelSettings>('models', DEFAULT_MODELS),
		budget: getSetting<BudgetSettings>('budget', DEFAULT_BUDGET),
		transcribe: getSetting<TranscribeSettings>('transcribe', DEFAULT_TRANSCRIBE),
		retention: getSetting<RetentionSettings>('retention', DEFAULT_RETENTION),
		audio: getSetting<AudioSettings>('audio', DEFAULT_AUDIO)
	});
};

export const POST: RequestHandler = async ({ locals, request }) => {
	requireAdmin(locals);
	const body = await readJson<{
		models?: Partial<ModelSettings>;
		budget?: Partial<BudgetSettings>;
		transcribe?: Partial<TranscribeSettings>;
		retention?: Partial<RetentionSettings>;
		audio?: Partial<AudioSettings>;
	}>(request);

	if (body.models) {
		const current = getSetting<ModelSettings>('models', DEFAULT_MODELS);
		setSetting('models', {
			primary: body.models.primary?.trim() || current.primary,
			fallbacks: Array.isArray(body.models.fallbacks)
				? body.models.fallbacks.filter((m) => typeof m === 'string' && m.trim())
				: current.fallbacks,
			maxTokens: num(body.models.maxTokens, current.maxTokens, 1, Infinity)
		});
	}

	if (body.budget) {
		const current = getSetting<BudgetSettings>('budget', DEFAULT_BUDGET);
		setSetting('budget', {
			limitUsd: Math.max(0, num(body.budget.limitUsd, current.limitUsd, 0, Infinity)),
			period: period(body.budget.period, current.period)
		});
	}

	if (body.transcribe) {
		const current = getSetting<TranscribeSettings>('transcribe', DEFAULT_TRANSCRIBE);
		setSetting('transcribe', {
			noteThreshold: num(body.transcribe.noteThreshold, current.noteThreshold, 0.05, 0.95),
			onsetThreshold: num(body.transcribe.onsetThreshold, current.onsetThreshold, 0.05, 0.95),
			minNoteMs: num(body.transcribe.minNoteMs, current.minNoteMs, 0, 5000),
			quantiseGrid: [4, 8, 16, 32].includes(Number(body.transcribe.quantiseGrid))
				? Number(body.transcribe.quantiseGrid)
				: current.quantiseGrid,
			autoCleanup: bool(body.transcribe.autoCleanup, current.autoCleanup)
		});
	}

	if (body.retention) {
		const current = getSetting<RetentionSettings>('retention', DEFAULT_RETENTION);
		setSetting('retention', {
			revisionsPerScore: num(body.retention.revisionsPerScore, current.revisionsPerScore, 0, 10_000),
			eventDays: num(body.retention.eventDays, current.eventDays, 0, 3650),
			usageDays: num(body.retention.usageDays, current.usageDays, 0, 3650),
			keepRecordings: bool(body.retention.keepRecordings, current.keepRecordings)
		});
	}

	if (body.audio) {
		const current = getSetting<AudioSettings>('audio', DEFAULT_AUDIO);
		setSetting('audio', {
			soundfontUrl: typeof body.audio.soundfontUrl === 'string' && body.audio.soundfontUrl.trim()
				? body.audio.soundfontUrl.trim()
				: current.soundfontUrl,
			countInBars: num(body.audio.countInBars, current.countInBars, 0, 4),
			masterVolume: num(body.audio.masterVolume, current.masterVolume, 0, 1),
			renderSampleRate: [22050, 44100, 48000].includes(Number(body.audio.renderSampleRate))
				? Number(body.audio.renderSampleRate)
				: current.renderSampleRate
		});
	}

	return json({
		models: getSetting<ModelSettings>('models', DEFAULT_MODELS),
		budget: getSetting<BudgetSettings>('budget', DEFAULT_BUDGET),
		transcribe: getSetting<TranscribeSettings>('transcribe', DEFAULT_TRANSCRIBE),
		retention: getSetting<RetentionSettings>('retention', DEFAULT_RETENTION),
		audio: getSetting<AudioSettings>('audio', DEFAULT_AUDIO)
	});
};
