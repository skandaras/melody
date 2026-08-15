import { detectKey } from './analyse.js';
import { IdFactory } from './ids.js';
import { keySigAt, measureTicks, tempoAt, timeSigAt } from './measures.js';
import { isNote, resolveSelection } from './query.js';
import { emptyScore, type Score, type Selection } from './types.js';

/**
 * Pulling a fragment out of a score.
 *
 * A clip is a complete little Score rather than a bag of notes, because a riff
 * without its tempo, key and instrument is not reusable — dropped into a
 * different piece it would play at the wrong speed on the wrong instrument.
 * Carrying that context is what makes the library worth having.
 *
 * The inverse — putting a clip back — is `mergeParts` in merge.ts, which
 * already re-mints ids and offsets ticks.
 */

export interface ExtractOptions {
	title?: string;
	/**
	 * Snap the start back to the beginning of its bar. On by default: a riff
	 * that starts on beat 3 should keep that placement relative to the bar, or
	 * it will be re-inserted sounding like an anacrusis.
	 */
	alignToBar?: boolean;
}

export interface ExtractResult {
	clip: Score;
	/** Bars the fragment spans, for the library listing. */
	bars: number;
	noteCount: number;
	/** Where it came from, so the UI can say so. */
	sourceStartTick: number;
}

export function extractClip(
	score: Score,
	sel: Selection,
	opts: ExtractOptions = {}
): ExtractResult {
	const resolved = resolveSelection(score, sel).filter((r) => isNote(r.note));
	if (resolved.length === 0) {
		return {
			clip: emptyScore(opts.title ?? 'Empty clip'),
			bars: 0,
			noteCount: 0,
			sourceStartTick: 0
		};
	}

	const firstTick = Math.min(...resolved.map((r) => r.note.tick));
	const lastTick = Math.max(...resolved.map((r) => r.note.tick + r.note.dur));

	const sig = timeSigAt(score, firstTick);
	const barTicks = measureTicks(score.ppq, sig);
	// Rebasing to the bar rather than to the first note keeps the fragment's
	// rhythmic position: a phrase starting on the second beat still starts on
	// the second beat when it is dropped somewhere else.
	const origin =
		opts.alignToBar === false ? firstTick : Math.floor(firstTick / barTicks) * barTicks;

	const clip = emptyScore(opts.title ?? `${score.title} excerpt`);
	clip.ppq = score.ppq;
	clip.tempoMap = [{ tick: 0, bpm: tempoAt(score, firstTick).bpm }];
	clip.timeSigs = [{ tick: 0, num: sig.num, den: sig.den }];
	clip.keySigs = [{ ...keySigAt(score, firstTick), tick: 0 }];

	// Grouped by source part so a two-handed piano excerpt stays two parts
	// rather than collapsing into one unplayable stave.
	const ids = new IdFactory();
	const byPart = new Map<string, typeof resolved>();
	for (const r of resolved) {
		const list = byPart.get(r.part.id) ?? [];
		list.push(r);
		byPart.set(r.part.id, list);
	}

	for (const [, group] of byPart) {
		const source = group[0].part;
		clip.parts.push({
			...structuredClone(source),
			id: ids.next('part'),
			voices: [
				{
					id: ids.next('voice'),
					events: group
						.map((r) => ({
							...structuredClone(r.note),
							id: ids.next('note'),
							tick: r.note.tick - origin
						}))
						.sort((a, b) => a.tick - b.tick)
				}
			]
		});
	}

	// Key detection on the fragment itself, since an excerpt often sits in a
	// different key area than the piece it came from.
	const guess = detectKey(clip);
	if (guess.confidence > 0.6) clip.keySigs = [{ ...guess.key, tick: 0 }];

	return {
		clip,
		bars: Math.max(1, Math.ceil((lastTick - origin) / barTicks)),
		noteCount: resolved.length,
		sourceStartTick: origin
	};
}

/** A one-line description for the library listing. */
export function describeClip(clip: Score, bars: number): string {
	const instruments = [...new Set(clip.parts.map((p) => p.name))].slice(0, 3).join(', ');
	const bpm = clip.tempoMap[0]?.bpm ?? 120;
	const sig = clip.timeSigs[0];
	return [
		`${bars} bar${bars === 1 ? '' : 's'}`,
		sig ? `${sig.num}/${sig.den}` : null,
		`${Math.round(bpm)}bpm`,
		instruments || null
	]
		.filter(Boolean)
		.join(' · ');
}
