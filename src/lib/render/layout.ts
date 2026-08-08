import { measuresOf, type Measure } from '$lib/score/measures';
import type { Score } from '$lib/score/types';

/**
 * System and page layout.
 *
 * VexFlow draws staves where you tell it to and nothing more — line breaking
 * and pagination are ours. This module is pure: it decides geometry from the
 * score and the page size, and the renderer just obeys. Keeping it separate
 * means layout is testable without a DOM.
 */

export interface LayoutOptions {
	/** Usable width in px, excluding margins. */
	width: number;
	/** Page height in px. 0 means one continuous scroll with no page breaks. */
	pageHeight: number;
	/** Vertical space for one part's stave, including its padding. */
	staveHeight: number;
	/** Gap between systems. */
	systemGap: number;
	/** Extra width allowed for clef, key and time signature on a system's
	 *  first measure — that furniture is drawn once per line, not per bar. */
	firstMeasureExtra: number;
	/** Minimum width for a measure regardless of how empty it is. */
	minMeasureWidth: number;
	/** Width contributed per note, before justification. */
	widthPerNote: number;
}

export const DEFAULT_LAYOUT: LayoutOptions = {
	width: 900,
	pageHeight: 0,
	staveHeight: 110,
	systemGap: 26,
	firstMeasureExtra: 90,
	minMeasureWidth: 120,
	widthPerNote: 42
};

export interface LaidOutMeasure {
	measure: Measure;
	x: number;
	width: number;
	/** True for the first measure of a system, which draws clef/key/time. */
	leading: boolean;
}

export interface System {
	index: number;
	/** Y of the first stave in this system. */
	y: number;
	measures: LaidOutMeasure[];
	page: number;
}

export interface ScoreLayout {
	systems: System[];
	width: number;
	height: number;
	pages: number;
	staveHeight: number;
	partCount: number;
}

/** How many notes sit in a measure across all parts — drives its width. */
function densityOf(score: Score, m: Measure): number {
	let n = 0;
	for (const part of score.parts) {
		for (const voice of part.voices) {
			for (const e of voice.events) {
				if (e.tick >= m.startTick && e.tick < m.endTick) n++;
			}
		}
	}
	return n;
}

/**
 * Greedy line breaking.
 *
 * Measures accumulate onto a system until the next one would overflow, then
 * the line is justified to the full width. Greedy rather than
 * Knuth-Plass-style optimal: on a screen where the user can resize freely, the
 * difference is invisible, and greedy is far easier to keep correct.
 */
export function layoutScore(score: Score, opts: Partial<LayoutOptions> = {}): ScoreLayout {
	const o = { ...DEFAULT_LAYOUT, ...opts };
	const partCount = Math.max(1, score.parts.length);
	const measures = measuresOf(score);

	const naturalWidth = (m: Measure, leading: boolean) =>
		Math.max(o.minMeasureWidth, densityOf(score, m) * o.widthPerNote) +
		(leading ? o.firstMeasureExtra : 0);

	const systems: System[] = [];
	let current: LaidOutMeasure[] = [];
	let used = 0;

	const flush = (justify: boolean) => {
		if (!current.length) return;
		// Justify by scaling every measure to fill the line. The last system of
		// the piece is left ragged, as engravers do — a two-bar final line
		// stretched across the page looks broken.
		const scale = justify && used > 0 ? o.width / used : 1;
		let x = 0;
		for (const lm of current) {
			lm.x = x;
			lm.width = lm.width * scale;
			x += lm.width;
		}
		systems.push({ index: systems.length, y: 0, measures: current, page: 0 });
		current = [];
		used = 0;
	};

	for (const m of measures) {
		const leading = current.length === 0;
		const w = naturalWidth(m, leading);
		if (!leading && used + w > o.width) {
			flush(true);
			const lw = naturalWidth(m, true);
			current.push({ measure: m, x: 0, width: lw, leading: true });
			used = lw;
		} else {
			current.push({ measure: m, x: used, width: w, leading });
			used += w;
		}
	}
	flush(false);

	// Assign vertical positions, breaking pages when one is configured.
	const systemHeight = partCount * o.staveHeight + o.systemGap;
	let page = 0;
	let y = 0;

	for (const system of systems) {
		if (o.pageHeight > 0 && y + systemHeight > o.pageHeight && y > 0) {
			page++;
			y = 0;
		}
		system.page = page;
		system.y = y;
		y += systemHeight;
	}

	const height =
		o.pageHeight > 0 ? (page + 1) * o.pageHeight : Math.max(systemHeight, y) + o.systemGap;

	return {
		systems,
		width: o.width,
		height,
		pages: page + 1,
		staveHeight: o.staveHeight,
		partCount
	};
}
