<script lang="ts">
	/**
	 * The fog.
	 *
	 * Dense while a piece is vague and thinning as it takes shape — which is
	 * the point rather than the decoration. A composition tool whose atmosphere
	 * clears as the composition clears is telling you where you are without
	 * spending a progress bar on it.
	 *
	 * The whole effect is a few hundred bytes of CSS. No canvas, no WebGL, no
	 * images, no dependencies, no network requests, no per-frame JavaScript.
	 * Everything here is chosen because the compositor can do it on a thread we
	 * are not using, or because it rasterizes once and never again:
	 *
	 *  - Gradients rasterize once and then composite like any other texture.
	 *  - The grain is one inline feTurbulence tile as a data URI. Fractal noise
	 *    is expensive to generate and free to reuse, so it is generated at first
	 *    paint and never animated.
	 *  - Drift animates `transform` and `opacity` only, which the compositor
	 *    runs without touching layout, paint or the main thread.
	 *
	 * Two rules that are correctness, not taste:
	 *
	 *  - **No `backdrop-filter`.** It is the most expensive common CSS effect
	 *    and it recomposites on every scroll — and it is exactly what a
	 *    "frosted fog" instinct reaches for first.
	 *  - **Nothing here may sit over the notation.** The score is drawn on an
	 *    opaque paper surface and PDF export draws from that same SVG, so fog
	 *    across it would end up in exported files. This layer is fixed behind
	 *    everything and never rises above the chrome.
	 */

	/**
	 * One static tile of fractal noise.
	 *
	 * Inline rather than a file: it costs no request, cannot 404, and survives
	 * the asset pipeline untouched. baseFrequency is high enough that the tile
	 * reads as grain rather than as clouds, and the whole thing sits at 3%.
	 */
	const GRAIN =
		"url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='160' height='160'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.8' numOctaves='3'/%3E%3C/filter%3E%3Crect width='160' height='160' filter='url(%23n)' opacity='0.5'/%3E%3C/svg%3E\")";
</script>

<div class="atmosphere" aria-hidden="true">
	<div class="blob a"></div>
	<div class="blob b"></div>
	<div class="blob c"></div>
	<div class="grain" style:background-image={GRAIN}></div>
</div>

<style>
	.atmosphere {
		position: fixed;
		inset: 0;
		z-index: -1;
		pointer-events: none;
		overflow: hidden;
		/* Nothing inside can affect layout or paint outside this box, so the
		   browser never has to consider it while laying out the interface. */
		contain: strict;
		/* Driven by the current stage once the stages exist: 1 while a piece is
		   still an idea, 0 by the time it is finished. Until then it holds at a
		   middle value rather than pretending to a signal that is not there. */
		--fog: 0.7;
	}

	.blob {
		position: absolute;
		/* Far larger than the viewport so the edges never enter frame — a soft
		   gradient with a visible boundary reads as a shape, not as air. */
		width: 120vmax;
		height: 120vmax;
		border-radius: 50%;
		opacity: var(--fog);
		/* One compositor layer each, and only these three. */
		will-change: transform;
	}

	/* Mixed from tokens that already exist rather than stored as new theme
	   fields, so the fog follows whatever palette it finds instead of being a
	   property of one preset. */
	.a {
		top: -40vmax;
		left: -30vmax;
		background: radial-gradient(
			circle,
			color-mix(in srgb, var(--accent) 16%, transparent),
			transparent 62%
		);
		animation: drift-a 96s ease-in-out infinite alternate;
	}
	.b {
		bottom: -50vmax;
		right: -35vmax;
		background: radial-gradient(
			circle,
			color-mix(in srgb, var(--accent) 11%, transparent),
			transparent 58%
		);
		animation: drift-b 124s ease-in-out infinite alternate;
	}
	.c {
		top: 20vmax;
		right: -45vmax;
		background: radial-gradient(
			circle,
			color-mix(in srgb, var(--fg-dim) 9%, transparent),
			transparent 60%
		);
		animation: drift-c 78s ease-in-out infinite alternate;
	}

	/*
	 * Breathing, in time with the music.
	 *
	 * Paused unless something is sounding, and the duration comes from the
	 * tempo the score page publishes. Starting and stopping it is two property
	 * writes per play — the animation itself never touches JavaScript again.
	 */
	:global(html[data-playing]) .blob {
		animation-name: breathe;
		animation-duration: calc(60s / var(--bpm, 120) * 8);
		animation-timing-function: ease-in-out;
	}

	.grain {
		position: absolute;
		inset: 0;
		opacity: 0.03;
		/* Rasterized once. Never animated — moving it would repaint the whole
		   viewport every frame, which is the one genuinely expensive thing this
		   file could do. */
		background-repeat: repeat;
	}

	@keyframes drift-a {
		from {
			transform: translate3d(0, 0, 0);
		}
		to {
			transform: translate3d(6vmax, 4vmax, 0);
		}
	}
	@keyframes drift-b {
		from {
			transform: translate3d(0, 0, 0);
		}
		to {
			transform: translate3d(-7vmax, -3vmax, 0);
		}
	}
	@keyframes drift-c {
		from {
			transform: translate3d(0, 0, 0);
		}
		to {
			transform: translate3d(-4vmax, 6vmax, 0);
		}
	}
	@keyframes breathe {
		from {
			transform: scale(1);
			opacity: calc(var(--fog) * 0.8);
		}
		to {
			transform: scale(1.06);
			opacity: var(--fog);
		}
	}

	/*
	 * Reduced motion keeps the fog and drops the movement. A static gradient
	 * still reads as deliberate, which is the point of degrading rather than
	 * disappearing.
	 */
	@media (prefers-reduced-motion: reduce) {
		.blob,
		:global(html[data-playing]) .blob {
			animation: none;
		}
	}
</style>
