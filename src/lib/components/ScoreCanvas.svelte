<script lang="ts">
	import { hitTest, hitsInRect, renderScore, type NoteHit, type StaveBox } from '$lib/render/render';
	import { pointToPosition, type Position } from '$lib/render/locate';
	import { dragOps } from '$lib/render/drag';
	import { playheadAt } from '$lib/render/playhead';
	import type { Op } from '$lib/score/apply';
	import type { Score } from '$lib/score/types';

	interface Props {
		score: Score;
		selected: Set<string>;
		diff?: { added: string[]; removed: string[]; changed: string[] } | null;
		scale?: number;
		/** In 'add', clicking the stave places a note instead of selecting one. */
		mode?: 'select' | 'add';
		/** Snapping for placement and for dragging. */
		entry?: { grid: number; triplets: boolean };
		/** Where playback has reached, in ticks. Null when nothing is playing. */
		playheadTick?: number | null;
		/** An edit is in flight. A second drag would race it. */
		busy?: boolean;
		onselect: (ids: string[], additive: boolean) => void;
		onplace?: (position: Position) => void;
		/** A completed drag, as operations ready for the one write path. */
		ondrag?: (ops: Op[]) => void;
	}

	let {
		score,
		selected,
		diff = null,
		scale = 1,
		mode = 'select',
		entry = { grid: 16, triplets: false },
		playheadTick = null,
		busy = false,
		onselect,
		onplace,
		ondrag
	}: Props = $props();

	let host = $state<HTMLDivElement | null>(null);
	/** Observed for width. The stage grows with the drawing; this does not. */
	let paper = $state<HTMLDivElement | null>(null);
	let width = $state(900);
	let hits = $state.raw<NoteHit[]>([]);

	/**
	 * The stave boxes, published reactively for the playhead.
	 *
	 * `hits` stays a plain local because only event handlers read it, but the
	 * playhead is markup and has to re-derive when the layout changes. The
	 * drawing effect writes this and must never read it, or it retriggers
	 * itself forever.
	 */
	let staves = $state.raw<StaveBox[]>([]);

	/** Where a click would land right now, drawn as a ghost notehead. */
	let ghost = $state<{ x: number; y: number } | null>(null);

	// Rubber-band state. Only the overlay rect reacts to these.
	let band = $state<{ x1: number; y1: number; x2: number; y2: number } | null>(null);
	let dragging = false;

	/**
	 * An in-progress note drag.
	 *
	 * `moved` gates the whole thing: until the pointer has travelled past the
	 * threshold this is still a click, and releasing selects exactly as before.
	 * Without that, every attempt to select a note would nudge it.
	 */
	let noteDrag = $state<{
		noteIds: string[];
		/** The note under the pointer, which is what a plain click selects. */
		clickedId: string;
		from: Position;
		to: Position;
		minTick: number;
		partId: string;
		/** Where the pointer went down, in renderer units. The threshold is
		 *  measured from here, not from the note's snapped position — those
		 *  differ by however far off-centre the press landed. */
		originX: number;
		originY: number;
		moved: boolean;
	} | null>(null);

	/** Pointer travel before a press becomes a drag. Matches the rubber band. */
	const DRAG_THRESHOLD = 4;

	/** Read the resolved theme tokens so the same renderer can also draw to an
	 *  offscreen SVG for PDF export, where there is no computed style. */
	function colors() {
		const s = getComputedStyle(document.documentElement);
		const v = (n: string, fallback: string) => s.getPropertyValue(n).trim() || fallback;
		return {
			notation: v('--notation', '#1a1a1a'),
			paper: v('--notation-paper', '#ffffff'),
			accent: v('--accent', '#6ea8fe'),
			diffAdd: v('--diff-add', '#4ade80'),
			diffChange: v('--diff-change', '#fbbf24'),
			dim: v('--fg-dim', '#7d8699')
		};
	}

	function draw() {
		if (!host) return;
		const result = renderScore(host, score, {
			width,
			scale,
			selected,
			diff: diff
				? {
						added: new Set(diff.added),
						removed: new Set(diff.removed),
						changed: new Set(diff.changed)
					}
				: undefined,
			colors: colors()
		});
		hits = result.hits;
		staves = result.staves;
	}

	// Redraw whenever anything visible changes. A full redraw is cheap at these
	// sizes and far simpler than diffing the SVG — which is also why a drag
	// previews with an overlay instead of moving the note in the document.
	$effect(() => {
		// Touch the reactive inputs so the effect re-runs for each of them.
		void score;
		void selected;
		void diff;
		void scale;
		void width;
		draw();
	});

	$effect(() => {
		if (!paper) return;
		const ro = new ResizeObserver(([entry]) => {
			const w = Math.max(320, Math.floor(entry.contentRect.width) - 32);
			if (Math.abs(w - width) > 2) width = w;
		});
		// Deliberately .paper, whose width comes from the scroll container above
		// it and never from its contents. Observing .stage instead would feed
		// the drawing's own width back into the layout and run away.
		ro.observe(paper);
		return () => ro.disconnect();
	});

	/**
	 * Pointer to renderer coordinates.
	 *
	 * A plain subtraction, and it must stay one. The renderer sizes the SVG to
	 * exactly the coordinate space it drew in, and `.canvas` has no padding or
	 * border, so renderer units and CSS pixels are the same thing and an
	 * overlay can be positioned with the numbers the renderer reported.
	 *
	 * **Any CSS that resizes the SVG silently breaks this.** That is what
	 * `max-width: 100%` used to do: VexFlow writes a viewBox and no
	 * preserveAspectRatio, so a constrained width letterboxes the drawing and
	 * translates it vertically — every click landing further from its target
	 * the further down the page it was.
	 */
	function localPoint(e: PointerEvent) {
		const rect = host?.getBoundingClientRect();
		if (!rect) return { x: 0, y: 0 };
		return { x: e.clientX - rect.left, y: e.clientY - rect.top };
	}

	/** Where a point maps to, for the ghost, a placement, and a drag target. */
	function locate(x: number, y: number) {
		return pointToPosition(staves, score, x, y, {
			grid: entry.grid,
			triplets: entry.triplets
		});
	}

	function onpointerdown(e: PointerEvent) {
		if (!host || e.button !== 0) return;
		const { x, y } = localPoint(e);

		if (mode === 'add') {
			const position = locate(x, y);
			// Outside every stave: not a placement, and not a selection either.
			// Silently doing nothing is right — the ghost already showed that
			// there was nowhere to put it.
			if (position) onplace?.(position);
			return;
		}

		const hit = hitTest(hits, x, y, 14 * scale);

		if (hit) {
			// Selection still happens on release, so this press is not yet
			// committed to being either a click or a drag.
			const from = locate(x, y);
			const ids = selected.has(hit.noteId) ? [...selected] : [hit.noteId];
			const dragged = hits.filter((h) => ids.includes(h.noteId));
			if (from && ondrag && !busy) {
				noteDrag = {
					noteIds: ids,
					clickedId: hit.noteId,
					from,
					to: from,
					minTick: dragged.reduce((lo, h) => Math.min(lo, h.tick), Infinity),
					partId: hit.partId,
					originX: x,
					originY: y,
					moved: false
				};
			} else {
				// Nothing to drag with, so behave exactly as before.
				onselect([hit.noteId], e.shiftKey || e.metaKey || e.ctrlKey);
			}
			(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
			return;
		}

		// Empty space starts a rubber band. Pointer capture keeps the drag alive
		// when it leaves the SVG, which it will at the edges.
		dragging = true;
		band = { x1: x, y1: y, x2: x, y2: y };
		(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
	}

	function onpointermove(e: PointerEvent) {
		if (mode === 'add') {
			const { x, y } = localPoint(e);
			const position = locate(x, y);
			const box = position ? boxFor(position) : null;
			ghost = position && box ? xy(ghostXY(position, box)) : null;
			return;
		}

		if (noteDrag) {
			const { x, y } = localPoint(e);
			const moved =
				noteDrag.moved ||
				Math.hypot(x - noteDrag.originX, y - noteDrag.originY) > DRAG_THRESHOLD;
			const to = locate(x, y);
			// A drag that wanders onto another instrument stays on its own: no
			// operation moves a note between parts, and silently doing nothing
			// is better than silently doing the wrong thing.
			noteDrag = {
				...noteDrag,
				moved,
				to: to && to.partId === noteDrag.partId ? to : noteDrag.to
			};
			return;
		}

		if (!dragging || !band) return;
		const { x, y } = localPoint(e);
		band = { ...band, x2: x, y2: y };
	}

	function onpointerleave() {
		ghost = null;
	}

	/**
	 * The browser took the gesture away — a touch it decided was a scroll, or
	 * capture lost some other way. Both state machines have to be torn down or
	 * the rubber band stays on screen for good and the next press behaves as a
	 * continuation of a drag that is no longer happening.
	 */
	function cancelGestures() {
		noteDrag = null;
		dragging = false;
		band = null;
		ghost = null;
	}

	function onpointerup(e: PointerEvent) {
		if (mode === 'add') return;

		if (noteDrag) {
			const drag = noteDrag;
			noteDrag = null;

			if (!drag.moved) {
				// Never crossed the threshold, so this was a click after all —
				// and a click selects the note under the pointer, not whatever
				// happened to be selected when the press started.
				onselect([drag.clickedId], e.shiftKey || e.metaKey || e.ctrlKey);
				return;
			}

			const ops = dragOps({
				noteIds: drag.noteIds,
				from: drag.from,
				to: drag.to,
				minTick: drag.minTick
			});
			if (ops.length) ondrag?.(ops);
			return;
		}

		if (!dragging || !band) return;
		dragging = false;
		const { x1, y1, x2, y2 } = band;
		band = null;

		// A tiny drag is a click on empty space: clear the selection.
		if (Math.hypot(x2 - x1, y2 - y1) < DRAG_THRESHOLD) {
			if (!(e.shiftKey || e.metaKey || e.ctrlKey)) onselect([], false);
			return;
		}
		onselect(
			hitsInRect(hits, x1, y1, x2, y2).map((h) => h.noteId),
			e.shiftKey || e.metaKey || e.ctrlKey
		);
	}

	const xy = ([x, y]: [number, number]) => ({ x, y });

	/** The stave box a position falls in. */
	function boxFor(position: Position): StaveBox | undefined {
		return staves.find(
			(b) =>
				b.partId === position.partId &&
				position.tick >= b.startTick &&
				position.tick < b.endTick
		);
	}

	/** Where a notehead sits inside its box, in renderer coordinates. */
	function ghostXY(position: Position, box: StaveBox): [number, number] {
		const span = Math.max(1, box.endTick - box.startTick);
		return [
			box.x + ((position.tick - box.startTick) / span) * box.width,
			box.topLineY + (position.step * box.lineSpacing) / 2
		];
	}

	/** Where the dragged note would land, in CSS pixels. */
	const dragGhost = $derived.by(() => {
		if (!noteDrag?.moved) return null;
		const box = boxFor(noteDrag.to);
		if (!box) return null;
		return xy(ghostXY(noteDrag.to, box));
	});

	/**
	 * The playhead's x and y span, in CSS pixels.
	 *
	 * Anchored to the note positions the renderer recorded — see playhead.ts for
	 * why an even division of the bar is visibly wrong.
	 */
	const playhead = $derived(playheadAt(staves, hits, playheadTick));
</script>

<div class="paper" bind:this={paper}>
	<!-- The overlays are siblings of the render host, never children of it:
	     renderScore opens with container.replaceChildren(), which would delete
	     them — and Svelte's anchor comments with them — on every redraw. -->
	<div
		class="stage"
		class:pressing-note={noteDrag !== null}
		class:dragging-note={noteDrag?.moved}
		role="application"
		aria-label="Music notation. Click a note to select it, drag it to move it, or drag the page to select several."
		{onpointerdown}
		{onpointermove}
		{onpointerup}
		onpointerleave={onpointerleave}
		onpointercancel={cancelGestures}
		onlostpointercapture={cancelGestures}
	>
		<div bind:this={host} class="canvas"></div>
		{#if playhead}
			<div
				class="playhead"
				style:left="{playhead.x}px"
				style:top="{playhead.y}px"
				style:height="{playhead.height}px"
				aria-hidden="true"
			></div>
		{/if}

		{#if ghost}
			<!-- A hollow head at the exact spot the note will land. Placement is the
			     one interaction where guessing wrong is silent, so show the answer
			     before the click rather than after. -->
			<div class="ghost" style:left="{ghost.x}px" style:top="{ghost.y}px" aria-hidden="true"></div>
		{/if}

		{#if dragGhost}
			<div
				class="ghost dragged"
				style:left="{dragGhost.x}px"
				style:top="{dragGhost.y}px"
				aria-hidden="true"
			></div>
		{/if}

		{#if band}
			<div
				class="band"
				style:left="{Math.min(band.x1, band.x2)}px"
				style:top="{Math.min(band.y1, band.y2)}px"
				style:width="{Math.abs(band.x2 - band.x1)}px"
				style:height="{Math.abs(band.y2 - band.y1)}px"
			></div>
		{/if}
	</div>
</div>

<style>
	.paper {
		/* Not position:relative and not sized to its content. Overlays anchor to
		   .canvas instead, and the ResizeObserver measures this element — if it
		   grew with the drawing it would feed its own width back into the
		   layout. */
		border-radius: var(--radius);
		padding: var(--space-4);
		min-height: 100%;
	}
	.stage {
		/* The overlay origin. Anchoring them to the padded .paper instead is
		   what put the ghost and the rubber band a padding step away from the
		   pointer — and the padding is theme-dependent, so no fixed offset
		   could have corrected it. */
		position: relative;
		/* Wraps the drawing exactly, so the paper still sits under a score
		   zoomed wider than the viewport. .paper stays a plain block, because
		   it is what the ResizeObserver measures. */
		width: max-content;
		min-width: 100%;
		background: var(--notation-paper);
		touch-action: pan-y;
		cursor: crosshair;
	}
	/* No padding, no border: .stage's padding box and .canvas's border box have
	   to coincide, because that is the frame both the pointer and the overlays
	   are measured in. */
	.canvas {
		padding: 0;
		border: 0;
	}
	/* Relaxed on press rather than on movement: by the time the drag threshold
	   is crossed the browser has already decided the gesture is a scroll, and a
	   vertical drag would pan the page instead of changing the pitch. */
	.stage.pressing-note {
		touch-action: none;
	}
	.stage.dragging-note {
		cursor: grabbing;
	}
	.ghost {
		position: absolute;
		width: 11px;
		height: 8px;
		margin: -4px 0 0 -5px;
		border: 1.5px solid var(--accent);
		border-radius: 50%;
		transform: rotate(-20deg);
		pointer-events: none;
		opacity: 0.85;
	}
	.ghost.dragged {
		background: color-mix(in srgb, var(--accent) 35%, transparent);
	}
	.playhead {
		position: absolute;
		width: 2px;
		margin-left: -1px;
		background: var(--accent);
		opacity: 0.7;
		pointer-events: none;
		border-radius: 1px;
	}
	.canvas :global(svg) {
		display: block;
		/* Deliberately no max-width. The renderer already sizes the drawing to
		   the zoom level; shrinking it back to fit meant zooming in did not
		   zoom, and put every click progressively further from its target. The
		   scroll container above handles the overflow. */
	}
	.band {
		position: absolute;
		border: 1px solid var(--accent);
		background: color-mix(in srgb, var(--accent) 14%, transparent);
		pointer-events: none;
		border-radius: 2px;
	}
</style>
