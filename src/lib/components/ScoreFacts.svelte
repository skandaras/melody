<script lang="ts">
	import { analyse } from '$lib/score/analyse';
	import { spellMidi } from '$lib/score/pitch';
	import type { Score } from '$lib/score/types';

	/**
	 * What the piece is, read off the notes for free.
	 *
	 * `analyse()` is pure — no model, no key, no cost — so this is shown always.
	 * The paid prose explanation is a separate thing, asked for on purpose.
	 */

	interface Props {
		score: Score;
	}
	let { score }: Props = $props();

	const facts = $derived(analyse(score));
	const range = (low: number | null, high: number | null) =>
		low === null || high === null ? '—' : `${spellMidi(low)}–${spellMidi(high)}`;
</script>

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

{#if facts.parts.length > 1}
	<ul class="parts">
		{#each facts.parts as part (part.id)}
			<li>
				<span class="name">{part.name}</span>
				<span class="dim">{range(part.lowMidi, part.highMidi)} · {part.noteCount} notes</span>
			</li>
		{/each}
	</ul>
{/if}

<style>
	.facts {
		display: grid;
		grid-template-columns: auto 1fr;
		gap: var(--space-1) var(--space-3);
		margin: 0;
		font-size: var(--text-sm);
	}
	dt {
		color: var(--fg-dim);
	}
	dd {
		margin: 0;
	}
	.parts {
		list-style: none;
		margin: var(--space-2) 0 0;
		padding: 0;
		display: flex;
		flex-direction: column;
		gap: var(--space-1);
		font-size: var(--text-xs);
	}
	li {
		display: flex;
		justify-content: space-between;
		gap: var(--space-2);
	}
	.name {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.dim {
		color: var(--fg-dim);
		white-space: nowrap;
	}
</style>
