<script lang="ts">
	import { hitTest, hitsInRect, renderScore, type NoteHit } from '$lib/render/render';
	import type { Score } from '$lib/score/types';

	interface Props {
		score: Score;
		selected: Set<string>;
		diff?: { added: string[]; removed: string[]; changed: string[] } | null;
		scale?: number;
		onselect: (ids: string[], additive: boolean) => void;
	}

	let { score, selected, diff = null, scale = 1, onselect }: Props = $props();

	let host = $state<HTMLDivElement | null>(null);
	let width = $state(900);
	let hits: NoteHit[] = [];

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

	function onpointerdown(e: PointerEvent) {
		if (!host || e.button !== 0) return;
		const { x, y } = localPoint(e);
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
		if (!dragging || !band) return;
		const { x, y } = localPoint(e);
		band = { ...band, x2: x, y2: y };
	}

	function onpointerup(e: PointerEvent) {
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
	></div>

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
