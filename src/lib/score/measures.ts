import type { Score, TimeSig, KeySig, TempoMark } from './types.js';

/**
 * Measures are *derived*, never stored. The document holds absolute ticks and
 * a list of time signatures; barlines fall out of those two facts.
 *
 * This is the whole reason an AI edit can lengthen one bar without corrupting
 * everything after it: there is no stored bar numbering to go stale.
 */

export interface Measure {
	index: number; // 0-based
	number: number; // 1-based, what a musician calls it
	startTick: number;
	endTick: number;
	timeSig: TimeSig;
	/** Set only on the measure where it changes, for rendering. */
	keyChange?: KeySig;
	timeChange?: TimeSig;
	tempoChange?: TempoMark;
}

/** Ticks in one bar of the given signature. */
export function measureTicks(ppq: number, sig: TimeSig): number {
	return Math.round((ppq * 4 * sig.num) / sig.den);
}

/** The entry in a tick-keyed map in force at `tick`. */
function inForceAt<T extends { tick: number }>(list: T[], tick: number): T {
	let best = list[0];
	for (const item of list) {
		if (item.tick <= tick && item.tick >= best.tick) best = item;
	}
	return best;
}

export function timeSigAt(score: Score, tick: number): TimeSig {
	return inForceAt(score.timeSigs, tick);
}
export function keySigAt(score: Score, tick: number): KeySig {
	return inForceAt(score.keySigs, tick);
}
export function tempoAt(score: Score, tick: number): TempoMark {
	return inForceAt(score.tempoMap, tick);
}

/** Last tick with any content in it. Zero for an empty score. */
export function scoreEndTick(score: Score): number {
	let end = 0;
	for (const p of score.parts) {
		for (const v of p.voices) {
			for (const e of v.events) end = Math.max(end, e.tick + e.dur);
		}
	}
	for (const s of score.sections) end = Math.max(end, s.endTick);
	return end;
}

/**
 * Walk the score into measures.
 *
 * `minTick` pads the result out to at least that length, so an empty or very
 * short score still renders a sensible number of empty bars rather than
 * nothing at all.
 */
export function measuresOf(score: Score, minTick = 0): Measure[] {
	const end = Math.max(scoreEndTick(score), minTick, 1);
	const sigChanges = new Map(score.timeSigs.map((t) => [t.tick, t]));
	const keyChanges = new Map(score.keySigs.map((k) => [k.tick, k]));
	const tempoChanges = new Map(score.tempoMap.map((t) => [t.tick, t]));

	const out: Measure[] = [];
	let tick = 0;
	let index = 0;

	// Guard against a pathological signature (den 0, num 0) producing a
	// zero-length bar and spinning here forever.
	while (tick < end && index < 10_000) {
		const sig = timeSigAt(score, tick);
		const len = Math.max(1, measureTicks(score.ppq, sig));
		out.push({
			index,
			number: index + 1,
			startTick: tick,
			endTick: tick + len,
			timeSig: sig,
			keyChange: keyChanges.get(tick),
			timeChange: sigChanges.get(tick),
			tempoChange: tempoChanges.get(tick)
		});
		tick += len;
		index++;
	}

	if (out.length === 0) {
		const sig = score.timeSigs[0];
		out.push({
			index: 0,
			number: 1,
			startTick: 0,
			endTick: measureTicks(score.ppq, sig),
			timeSig: sig,
			keyChange: score.keySigs[0],
			timeChange: sig,
			tempoChange: score.tempoMap[0]
		});
	}
	return out;
}

/** Which measure contains `tick`. Returns the last one if past the end. */
export function measureAt(measures: Measure[], tick: number): Measure {
	for (const m of measures) {
		if (tick >= m.startTick && tick < m.endTick) return m;
	}
	return measures[measures.length - 1];
}

/** Convert a 1-based bar number to its start tick. */
export function barToTick(score: Score, bar: number): number {
	const measures = measuresOf(score, 0);
	const m = measures[Math.max(0, Math.min(measures.length - 1, bar - 1))];
	return m ? m.startTick : 0;
}
