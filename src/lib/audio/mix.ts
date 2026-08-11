import type { Part } from '$lib/score/types';

/**
 * How mute, solo and the fader combine into one channel level.
 *
 * Kept apart from PlayerStore so it stays a plain function: this is the rule
 * people actually get wrong (does solo beat mute? does an uncommitted fader
 * move win over the document?), so it should be testable without a synth, an
 * AudioContext or a component harness.
 */

/** A mixer change made but not yet committed to the document, keyed by part id. */
export type MixOverrides = Record<string, { volume?: number; muted?: boolean }>;

export function gainFor(
	part: Part,
	overrides: MixOverrides,
	solo: ReadonlySet<string>
): number {
	const patch = overrides[part.id];
	// An uncommitted fader move wins, so dragging is audible before the debounce
	// flushes.
	const muted = patch?.muted ?? part.muted;
	// Mute beats solo: soloing a part you have also muted should stay silent,
	// otherwise solo becomes a way to accidentally unmute.
	if (muted) return 0;
	if (solo.size > 0 && !solo.has(part.id)) return 0;
	return clamp(patch?.volume ?? part.volume);
}

function clamp(v: number): number {
	if (!Number.isFinite(v)) return 0;
	return Math.max(0, Math.min(1, v));
}
