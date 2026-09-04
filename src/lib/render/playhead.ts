import type { NoteHit, StaveBox } from './render.js';

/**
 * Where to draw the playhead for a given tick.
 *
 * Pure, so the awkward positions — a tick before the first note of a bar, one
 * past the last bar, an empty measure — are provable rather than eyeballed
 * against a moving line.
 *
 * The naive version interpolates linearly across the measure's width, and it
 * is visibly wrong. VexFlow's formatter does not space notes evenly inside a
 * bar (a run of semiquavers after a minim is not half the width), and
 * `layoutScore` justifies every system except the last, so a bar's width is
 * decided by the line it ended up on. A line claiming to mark what is sounding
 * has to agree with the noteheads, so it is anchored to the x positions the
 * renderer actually recorded and interpolated between them.
 */

export interface Playhead {
	x: number;
	y: number;
	height: number;
}

export function playheadAt(
	staves: StaveBox[],
	hits: NoteHit[],
	tick: number | null
): Playhead | null {
	if (tick === null || !staves.length) return null;

	const box = staves.find((b) => tick >= b.startTick && tick < b.endTick);
	if (!box) return null;

	// Every system draws the same tick at the same x, so the vertical extent is
	// taken from the topmost stave and stretched to the lowest — one line
	// through all the parts rather than one per part.
	const row = staves.filter((b) => b.startTick === box.startTick && b.endTick === box.endTick);
	const top = Math.min(...row.map((b) => b.topLineY)) - box.lineSpacing * 2;
	const bottom = Math.max(...row.map((b) => b.topLineY + b.lineSpacing * 4)) + box.lineSpacing * 2;

	return { x: xForTick(box, hits, tick), y: top, height: bottom - top };
}

/**
 * Interpolate between the real note positions in this measure.
 *
 * Falls back to the measure's own bounds when there is nothing to anchor to —
 * an empty bar, or a position before its first note — which is the one place
 * even spacing is the correct answer rather than an approximation.
 */
function xForTick(box: StaveBox, hits: NoteHit[], tick: number): number {
	const inBox = hits
		.filter((h) => h.partId === box.partId && h.tick >= box.startTick && h.tick < box.endTick)
		.sort((a, b) => a.tick - b.tick);

	const span = Math.max(1, box.endTick - box.startTick);
	const even = (t: number) => box.x + ((t - box.startTick) / span) * box.width;

	if (!inBox.length) return even(tick);

	// Anchors: the start of the bar, each notehead, then the end of the bar.
	const points: { tick: number; x: number }[] = [
		{ tick: box.startTick, x: box.x },
		...inBox.map((h) => ({ tick: h.tick, x: h.x })),
		{ tick: box.endTick, x: box.x + box.width }
	];

	for (let i = 0; i < points.length - 1; i++) {
		const a = points[i];
		const b = points[i + 1];
		if (tick < a.tick || tick > b.tick) continue;
		const width = b.tick - a.tick;
		if (width <= 0) return a.x;
		return a.x + ((tick - a.tick) / width) * (b.x - a.x);
	}
	return even(tick);
}
