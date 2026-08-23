<script lang="ts">
	import { hitTest, hitsInRect, renderScore, type NoteHit, type StaveBox } from '$lib/render/render';
	import { pointToPosition, type Position } from '$lib/render/locate';
	import type { Score } from '$lib/score/types';

	interface Props {
		score: Score;
		selected: Set<string>;
		diff?: { added: string[]; removed: string[]; changed: string[] } | null;
		scale?: number;
		/** In 'add', clicking the stave places a note instead of selecting one. */
		mode?: 'select' | 'add';
		/** Snapping for placement. Ignored in select mode. */
		entry?: { grid: number; triplets: boolean };
		onselect: (ids: string[], additive: boolean) => void;
		onplace?: (position: Position) => void;
	}

	let {
		score,
		selected,
		diff = null,
		scale = 1,
		mode = 'select',
		entry = { grid: 16, triplets: false },
		onselect,
		onplace
	}: Props = $props();

	let host = $state<HTMLDivElement | null>(null);
	let width = $state(900);
	let hits: NoteHit[] = [];
	let staves: StaveBox[] = [];

	/** Where a click would land right now, drawn as a ghost notehead. */
	let ghost = $state<{ x: number; y: number; midi: number } | null>(null);

	// Rubber-band state. Kept as plain locals rather than $state because they
	// change on every pointermove and only the overlay rect needs to react.
	let band = $state<{ x1: number; y1: number; x2: number; y2: number } | null>(null);
	let dragging = false;

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
	// sizes and far simpler than diffing the SVG.
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
		if (!host) return;
		const ro = new ResizeObserver(([entry]) => {
			const w = Math.max(320, Math.floor(entry.contentRect.width) - 32);
			if (Math.abs(w - width) > 2) width = w;
		});
		ro.observe(host.parentElement ?? host);
		return () => ro.disconnect();
	});

	function localPoint(e: PointerEvent) {
		const rect = host!.getBoundingClientRect();
		return { x: e.clientX - rect.left, y: e.clientY - rect.top };
	}

	/** Where a point maps to, for both the ghost and the click that follows. */
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

		const hit = hitTest(hits, x, y);

		if (hit) {
			onselect([hit.noteId], e.shiftKey || e.metaKey || e.ctrlKey);
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
			const box = position ? staves.find((b) => b.partId === position.partId && x >= b.x - b.lineSpacing && x <= b.x + b.width + b.lineSpacing) : null;
			ghost =
				position && box
					? {
							// Snap the ghost to where the note will actually go, not to
							// the pointer — otherwise it promises a precision the grid
							// will not honour.
							x: box.x + ((position.tick - box.startTick) / (box.endTick - box.startTick)) * box.width,
							y: box.topLineY + (position.step * box.lineSpacing) / 2,
							midi: position.midi
						}
					: null;
			return;
		}

		if (!dragging || !band) return;
		const { x, y } = localPoint(e);
		band = { ...band, x2: x, y2: y };
	}

	function onpointerleave() {
		ghost = null;
	}

	function onpointerup(e: PointerEvent) {
		if (mode === 'add') return;
		if (!dragging || !band) return;
		dragging = false;
		const { x1, y1, x2, y2 } = band;
		band = null;

		// A tiny drag is a click on empty space: clear the selection.
		if (Math.hypot(x2 - x1, y2 - y1) < 4) {
			if (!(e.shiftKey || e.metaKey || e.ctrlKey)) onselect([], false);
			return;
		}
		onselect(
			hitsInRect(hits, x1, y1, x2, y2).map((h) => h.noteId),
			e.shiftKey || e.metaKey || e.ctrlKey
		);
	}
</script>

<div class="paper">
	<div
		bind:this={host}
		class="canvas"
		role="application"
		aria-label="Music notation. Click a note to select it, or drag to select several."
		{onpointerdown}
		{onpointermove}
		{onpointerup}
		onpointerleave={onpointerleave}
	></div>

	{#if ghost}
		<!-- A hollow head at the exact spot the note will land. Placement is the
		     one interaction where guessing wrong is silent, so show the answer
		     before the click rather than after. -->
		<div class="ghost" style:left="{ghost.x}px" style:top="{ghost.y}px" aria-hidden="true"></div>
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

<style>
	.paper {
		position: relative;
		background: var(--notation-paper);
		border-radius: var(--radius);
		padding: var(--space-4);
		min-height: 100%;
	}
	.canvas {
		touch-action: pan-y;
		cursor: crosshair;
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
	.canvas :global(svg) {
		display: block;
		max-width: 100%;
	}
	.band {
		position: absolute;
		border: 1px solid var(--accent);
		background: color-mix(in srgb, var(--accent) 14%, transparent);
		pointer-events: none;
		border-radius: 2px;
	}
</style>
