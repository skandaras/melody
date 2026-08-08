import { PPQ } from '$lib/score/types';

/**
 * Tick durations to VexFlow duration strings.
 *
 * Our model stores sounding length in ticks; notation needs a notehead type
 * plus dots. This is the translation, and it is deliberately lossy in one
 * direction only: a duration that isn't notatable snaps to the nearest thing
 * that is, because a score that renders slightly wrong beats one that throws.
 */

/** VexFlow base durations, longest first, with their tick values at PPQ 480. */
const BASES: { code: string; ticks: number }[] = [
	{ code: 'w', ticks: PPQ * 4 },
	{ code: 'h', ticks: PPQ * 2 },
	{ code: 'q', ticks: PPQ },
	{ code: '8', ticks: PPQ / 2 },
	{ code: '16', ticks: PPQ / 4 },
	{ code: '32', ticks: PPQ / 8 },
	{ code: '64', ticks: PPQ / 16 }
];

export interface VexDuration {
	/** VexFlow duration code, e.g. "q" or "8". */
	duration: string;
	/** 0, 1 or 2 augmentation dots. */
	dots: number;
	/** Ticks this actually represents, which may differ from what was asked. */
	ticks: number;
}

/**
 * Best notatable representation of a tick length.
 *
 * Tries every base with 0-2 dots and picks whichever lands closest. Exact
 * matches win outright; otherwise the nearest is chosen, which is what makes
 * transcribed audio renderable before it has been quantised.
 */
export function ticksToDuration(ticks: number, ppq = PPQ): VexDuration {
	const scale = ppq / PPQ;
	const want = ticks / scale;

	let best: VexDuration | null = null;
	let bestError = Infinity;

	for (const base of BASES) {
		for (let dots = 0; dots <= 2; dots++) {
			// Each dot adds half of the previous value: 1, 1.5, 1.75.
			const factor = 2 - Math.pow(0.5, dots);
			const actual = base.ticks * factor;
			const error = Math.abs(actual - want);
			if (error < bestError - 1e-9) {
				bestError = error;
				best = { duration: base.code, dots, ticks: Math.round(actual * scale) };
			}
			if (error < 1e-9) return { duration: base.code, dots, ticks };
		}
	}
	return best ?? { duration: 'q', dots: 0, ticks: ppq };
}

/** Split a length that crosses a barline into notatable pieces. */
export function splitAcrossBar(tick: number, dur: number, barEnd: number): number[] {
	if (tick + dur <= barEnd) return [dur];
	const first = barEnd - tick;
	return first > 0 ? [first, dur - first] : [dur];
}
