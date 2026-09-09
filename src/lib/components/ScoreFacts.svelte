<script lang="ts">
	import { analyse } from '$lib/score/analyse';
	import type { Score } from '$lib/score/types';

	/**
	 * What the score is, for free.
	 *
	 * `analyse()` is pure: key, tempo, metre, bars and note count computed from
	 * the document with no model call, no API key and no cost. Worth keeping
	 * distinct from the `analyse` **task**, which is prose explanation layered on
	 * top and costs money — the two share a name and are not the same thing. The
	 * epic asks that the free one be shown always and the paid one offered on
	 * request, which only reads as a real choice if the free one is visibly
	 * already there.
	 *
	 * Extracted from the editor's left rail, which is where these five rows have
	 * lived since before the pipeline; Refinement and Finish both want the same
	 * five and copying them a third time is how they start disagreeing.
	 */

	interface Props {
		score: Score;
		/** Heading text, or omitted for a bare list inside a section of its own. */
		heading?: string;
	}
	let { score, heading }: Props = $props();

	const facts = $derived(analyse(score));
</script>

{#if heading}
	<h2>{heading}</h2>
{/if}
<dl class="facts">
	<dt>Key</dt>
	<dd>{facts.key.name}</dd>
	<dt>Tempo</dt>
	<dd>{facts.tempoBpm} bpm</dd>
	<dt>Metre</dt>
	<dd>{facts.timeSig}</dd>
	<dt>Bars</dt>
	<dd>{facts.barCount}</dd>
	<dt>Notes</dt>
	<dd>{facts.totalNotes}</dd>
</dl>

<style>
	.facts {
		display: grid;
		grid-template-columns: auto 1fr;
		gap: var(--space-1) var(--space-3);
		margin: 0;
		font-size: var(--text-sm);
	}
	.facts dt {
		color: var(--fg-dim);
	}
	.facts dd {
		margin: 0;
	}
</style>
