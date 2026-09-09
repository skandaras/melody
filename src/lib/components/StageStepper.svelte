<script lang="ts">
	import { STAGES, STAGE_LABELS, stagePath, type Stage } from '$lib/pipeline/types';

	/**
	 * Where you are in the six stages, and how to get back.
	 *
	 * `STAGE_LABELS` has carried the comment "used by the stepper" since the
	 * pipeline landed, and nothing consumed it; meanwhile the epic's own diagram
	 * promises "re-enter any earlier stage" and every page offers exactly one
	 * hand-written link to the stage before it. This is the thing both were
	 * describing.
	 *
	 * **Rendered by stage pages, never by a layout.** A `score/[id]/+layout.svelte`
	 * would also wrap the legacy editor and Bench, and a score that predates the
	 * pipeline reads as being at the brief without ever having entered it — which
	 * is the whole reason `stageRoute('brief')` returns null. Opting in per page
	 * means only pages that really are stages ever show this.
	 *
	 * The distinction that makes the Brief link safe: `STAGE_ROUTES` governs where
	 * the *bare* route redirects, not which pages exist. The brief page exists and
	 * is perfectly linkable; it is simply never a redirect target.
	 */

	interface Props {
		scoreId: string;
		/** The page drawing this, which is not necessarily where the score is. */
		current: Stage;
		/** How far the score has actually got, from `pipeline.stage`. */
		reached: Stage;
	}
	let { scoreId, current, reached }: Props = $props();

	/**
	 * Every stage, with whether it can be opened.
	 *
	 * Reachability is the furthest the score has been, not where this page is —
	 * so walking back to the Plan from Finish does not make the four stages after
	 * it unreachable and strand you there. Ahead of that point the labels still
	 * show, because seeing what is coming is most of what a stepper is for; they
	 * are simply not links yet.
	 */
	const steps = $derived.by(() => {
		const limit = STAGES.indexOf(reached);
		return STAGES.map((stage, i) => ({
			stage,
			label: STAGE_LABELS[stage],
			current: stage === current,
			open: i <= limit
		}));
	});

	const href = (stage: Stage) => stagePath(scoreId, stage);
</script>

<nav class="stepper" aria-label="Composition stages">
	<ol>
		{#each steps as step (step.stage)}
			<li class:current={step.current} class:open={step.open}>
				{#if step.open && !step.current}
					<a href={href(step.stage)}>{step.label}</a>
				{:else}
					<span aria-current={step.current ? 'step' : undefined}>{step.label}</span>
				{/if}
			</li>
		{/each}
	</ol>
</nav>

<style>
	.stepper ol {
		display: flex;
		flex-wrap: wrap;
		align-items: baseline;
		gap: var(--space-1) var(--space-2);
		list-style: none;
		margin: 0;
		padding: 0;
		font-size: var(--text-xs);
	}

	/* A separator that is decoration, so it stays out of the accessible name. */
	li + li::before {
		content: '›';
		margin-right: var(--space-2);
		color: var(--border);
	}

	li {
		color: var(--fg-dim);
		opacity: 0.5;
	}
	/* Reachable stages read as available; the ones ahead stay visible but muted,
	   because the shape of what is coming is most of the point. */
	li.open {
		opacity: 1;
	}
	li.current {
		color: var(--accent);
		font-weight: 600;
	}

	a {
		color: inherit;
		text-decoration: none;
		border-bottom: 1px solid transparent;
	}
	a:hover,
	a:focus-visible {
		border-bottom-color: currentColor;
	}
</style>
