<script lang="ts">
	import { isRunning, outcomeMessage, phaseNumber, type RunState } from '$lib/runs/run-state';

	/**
	 * One run, rendered.
	 *
	 * Knows nothing about where the state came from — an AI turn over SSE, a
	 * control, or a transcription reporting from a Web Worker all arrive as the
	 * same shape. Adding a fourth producer means producing a RunState, not
	 * writing a fourth progress bar.
	 */

	interface Props {
		state: RunState;
		/** Omitted when there is nothing to cancel, e.g. a run already finished. */
		oncancel?: () => void;
		/** Shown while the run has produced no other line to read. */
		idleLabel?: string;
		/** Overrides the generic "still going" note when a producer can say more. */
		slowNote?: string;
	}
	let {
		state,
		oncancel,
		idleLabel = 'Working…',
		slowNote = 'Still going. Long turns are normal for bigger edits — you can cancel and try a smaller selection.'
	}: Props = $props();

	const running = $derived(isRunning(state));
	const message = $derived(outcomeMessage(state));
	const position = $derived(phaseNumber(state));
	const total = $derived(state.phases.length);

	/** The single line describing what is happening now. */
	const headline = $derived.by(() => {
		if (!running) return message;
		if (state.status) return state.status;
		if (state.currentPhase) {
			const phase = state.phases.find((p) => p.id === state.currentPhase);
			return phase?.label ?? idleLabel;
		}
		return idleLabel;
	});

	// A percentage only when the producer actually knows one. An agent turn has
	// phases and no percentage, so it gets a phase count instead of an invented
	// bar — the old one filled to 100% and sat there, which is worse than none.
	const percent = $derived(state.fraction === null ? null : Math.round(state.fraction * 100));
</script>

{#if running || message || state.streamed}
	<div class="run" class:failed={state.outcome === 'error' || state.outcome === 'timed_out'}>
		<div class="head">
			<span class="headline">{headline}</span>

			{#if running && total > 1}
				<span class="count">{position} of {total}</span>
			{:else if running && state.step > 1}
				<span class="count">step {state.step}</span>
			{/if}

			{#if running && oncancel}
				<button class="cancel" onclick={oncancel}>Cancel</button>
			{/if}
		</div>

		{#if running}
			{#if percent === null}
				<div class="bar indeterminate" role="presentation"></div>
			{:else}
				<progress max="100" value={percent}></progress>
				<span class="pct">{percent}%</span>
			{/if}
		{/if}

		{#if state.slow && running}
			<!-- Spelled out rather than left to a spinner: this is the one message
			     that explains why nothing appears to be happening. -->
			<p class="note">{slowNote}</p>
		{/if}

		{#if state.streamed}
			<p class="prose">{state.streamed}</p>
		{/if}

		{#if state.log.length}
			<ul class="log">
				{#each state.log as line, i (i)}
					<li>{line}</li>
				{/each}
			</ul>
		{/if}
	</div>
{/if}

<style>
	.run {
		display: flex;
		flex-direction: column;
		gap: var(--space-2);
		font-size: var(--text-xs);
		color: var(--fg-dim);
		/* A flex child with default min-width:auto refuses to shrink below its
		   content, which is how the old bar pushed out of a 220px rail. */
		min-width: 0;
	}
	.failed .headline {
		color: var(--danger);
	}

	.head {
		display: flex;
		align-items: baseline;
		gap: var(--space-2);
		min-width: 0;
	}
	.headline {
		flex: 1;
		min-width: 0;
		color: var(--fg);
		overflow-wrap: anywhere;
	}
	.count {
		flex: none;
		font-variant-numeric: tabular-nums;
	}

	.cancel {
		flex: none;
		background: none;
		border: 1px solid var(--border);
		border-radius: var(--radius);
		color: var(--fg-dim);
		font: inherit;
		padding: 0 var(--space-2);
		cursor: pointer;
	}
	.cancel:hover,
	.cancel:focus-visible {
		color: var(--danger);
		border-color: var(--danger);
	}

	progress {
		flex: 1;
		/* Without this a <progress> keeps its ~160px intrinsic width and overflows
		   a narrow rail rather than shrinking. */
		min-width: 0;
		width: 100%;
		height: 4px;
		accent-color: var(--accent);
	}
	.pct {
		font-variant-numeric: tabular-nums;
	}

	/* No percentage to show, so show motion instead of a lie. Transform only —
	   it runs on the compositor and costs nothing measurable. */
	.bar {
		height: 4px;
		border-radius: 2px;
		background: var(--border);
		overflow: hidden;
		position: relative;
	}
	.bar.indeterminate::after {
		content: '';
		position: absolute;
		inset: 0;
		width: 40%;
		border-radius: 2px;
		background: var(--accent);
		animation: slide 1.4s ease-in-out infinite;
	}
	@keyframes slide {
		0% {
			transform: translateX(-100%);
		}
		100% {
			transform: translateX(250%);
		}
	}
	@media (prefers-reduced-motion: reduce) {
		.bar.indeterminate::after {
			animation: none;
			width: 100%;
			opacity: 0.4;
		}
	}

	.note {
		margin: 0;
	}
	.prose {
		margin: 0;
		color: var(--fg);
		white-space: pre-wrap;
	}
	.log {
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		flex-direction: column;
		gap: 1px;
		font-variant-numeric: tabular-nums;
	}
	.log li {
		overflow-wrap: anywhere;
	}
</style>
