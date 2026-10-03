<script lang="ts">
	import { untrack } from 'svelte';
	import RunProgress from './RunProgress.svelte';
	import { Run } from '$lib/runs/run.svelte';
	import type { AnalysisView } from '$lib/pipeline/types';

	/**
	 * What the piece does, in words — the paid half of the analysis.
	 *
	 * Asked for on purpose, never fetched on load: the free read-out from
	 * `analyse()` is always beside it, and this costs a call. Once written it is
	 * kept with the score, so coming back shows it for nothing; when the music
	 * has changed since, it says so instead of quietly describing a version that
	 * is gone.
	 */

	interface Props {
		scoreId: string;
		analysis: AnalysisView | null;
		canGenerate: boolean;
		/** The music has changed on this page since it loaded. */
		edited?: boolean;
		busy?: boolean;
	}
	let { scoreId, analysis: initial, canGenerate, edited = false, busy = false }: Props = $props();

	// svelte-ignore state_referenced_locally
	let analysis = $state<AnalysisView | null>(untrack(() => initial));
	// Written during this visit, so this page's own edits before it do not count.
	let fresh = $state(false);
	let error = $state('');

	const run = new Run();
	$effect(() => () => run.destroy());

	const stale = $derived(Boolean(analysis) && (analysis!.stale || (edited && !fresh)));

	async function explain() {
		error = '';
		try {
			const res = await fetch(`/api/scores/${scoreId}/finish`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ action: 'explain' })
			});
			if (!res.ok) throw new Error((await res.text()) || res.statusText);
			const { jobId } = await res.json();
			// The result carries no document, so it is read off the event rather
			// than through onResult, which answers "a turn staged a document".
			run.listen(jobId, undefined, (type, data) => {
				if (type === 'result' && data?.analysis) {
					analysis = data.analysis as AnalysisView;
					fresh = true;
				}
			});
		} catch (e) {
			error = e instanceof Error ? e.message : String(e);
		}
	}
</script>

<div class="explanation">
	{#if analysis}
		{#if stale}
			<p class="stale">Out of date — the music has changed since this was written.</p>
		{/if}
		<div class="text" class:dim={stale}>
			{#each analysis.text.split(/\n{2,}/) as para, i (i)}
				<p>{para}</p>
			{/each}
		</div>
	{/if}

	{#if canGenerate}
		<button class="btn" onclick={explain} disabled={busy || run.running}>
			{analysis ? (stale ? 'Explain it again' : 'Explain again') : 'Explain this piece'}
		</button>
	{/if}

	<!-- Only while it is working, or when it failed. A finished run's own line
	     is worded for edits ("Nothing was changed."), and the text above
	     already says it worked. -->
	{#if run.running || (run.state.outcome !== 'idle' && run.state.outcome !== 'done')}
		<RunProgress
			state={run.state}
			oncancel={run.running ? () => run.cancel() : undefined}
			idleLabel="Listening…"
		/>
	{/if}

	{#if error}<p class="err">{error}</p>{/if}
</div>

<style>
	.explanation {
		display: flex;
		flex-direction: column;
		gap: var(--space-2);
		font-size: var(--text-sm);
	}
	.text p {
		margin: 0 0 var(--space-2);
		line-height: 1.5;
	}
	.text.dim {
		color: var(--fg-dim);
	}
	.stale {
		margin: 0;
		font-size: var(--text-xs);
		color: var(--fg-dim);
		border-left: 2px solid var(--accent);
		padding-left: var(--space-2);
	}
	.err {
		color: var(--danger);
		font-size: var(--text-xs);
	}
	.btn {
		align-self: flex-start;
		background: var(--border);
		color: var(--fg);
		border: none;
		border-radius: var(--radius);
		padding: var(--space-2) var(--space-4);
		cursor: pointer;
		font: inherit;
	}
	.btn:disabled {
		opacity: 0.55;
		cursor: default;
	}
</style>
