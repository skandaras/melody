<script lang="ts">
	import { untrack } from 'svelte';
	import ExportMenu from '$lib/components/ExportMenu.svelte';
	import Explanation from '$lib/components/Explanation.svelte';
	import RunProgress from '$lib/components/RunProgress.svelte';
	import ScoreCanvas from '$lib/components/ScoreCanvas.svelte';
	import ScoreFacts from '$lib/components/ScoreFacts.svelte';
	import Transport from '$lib/components/Transport.svelte';
	import { PlayerStore } from '$lib/audio/player.svelte';
	import { Run } from '$lib/runs/run.svelte';
	import { secondsToTick } from '$lib/score/measures';
	import type { Score } from '$lib/score/types';
	import type { PageServerData } from './$types';

	/**
	 * Stage six: name it, understand it, take it away.
	 *
	 * Nothing here changes the music. Saving a title is the one write, and
	 * exporting is a read. There is no "finished" flag to set either: a piece
	 * can be left here and picked up again from Refinement whenever.
	 */

	let { data }: { data: PageServerData } = $props();

	// svelte-ignore state_referenced_locally
	let doc = $state<Score>(untrack(() => data.score.doc));
	// svelte-ignore state_referenced_locally
	let title = $state(untrack(() => data.score.title));
	let suggestions = $state<string[]>([]);
	let saving = $state(false);
	let saved = $state(false);
	let error = $state('');
	let selected = $state<Set<string>>(new Set());

	const run = new Run();
	$effect(() => () => run.destroy());

	// svelte-ignore state_referenced_locally
	const player = new PlayerStore(() => data.soundfontUrl, {
		masterVolume: data.audio.masterVolume,
		renderSampleRate: data.audio.renderSampleRate
	});
	$effect(() => () => player.destroy());

	$effect(() => {
		void doc;
		player.invalidate();
	});

	const playheadTick = $derived.by(() => {
		const t = player.transport;
		if (!t.playing) return null;
		return secondsToTick(doc, t.position);
	});

	const changed = $derived(title.trim() !== doc.title && title.trim().length > 0);

	async function post(body: Record<string, unknown>) {
		const res = await fetch(`/api/scores/${data.score.id}/finish`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(body)
		});
		if (!res.ok) throw new Error((await res.text()) || res.statusText);
		return res.json();
	}

	async function suggest() {
		error = '';
		try {
			const { jobId } = await post({ action: 'titles' });
			run.listen(jobId, undefined, (type, payload) => {
				if (type === 'result' && Array.isArray(payload?.titles)) {
					suggestions = payload.titles as string[];
				}
			});
		} catch (e) {
			error = e instanceof Error ? e.message : String(e);
		}
	}

	async function saveTitle() {
		saving = true;
		error = '';
		try {
			const r = await post({ action: 'title', title: title.trim() });
			doc = r.doc as Score;
			title = r.title;
			saved = true;
		} catch (e) {
			error = e instanceof Error ? e.message : String(e);
		} finally {
			saving = false;
		}
	}
</script>

<svelte:head><title>{doc.title || 'Finish'} · melody</title></svelte:head>

<div class="finish">
	<aside class="rail">
		<header>
			<p class="step">Finish</p>
			<h1>{doc.title || 'Untitled'}</h1>
		</header>

		<section>
			<label class="field">
				<span class="label">Call it</span>
				<input
					bind:value={title}
					oninput={() => (saved = false)}
					onkeydown={(e) => e.key === 'Enter' && changed && saveTitle()}
				/>
			</label>
			{#if suggestions.length}
				<div class="chips">
					{#each suggestions as s (s)}
						<button
							class="chip"
							class:on={title === s}
							onclick={() => {
								title = s;
								saved = false;
							}}>{s}</button
						>
					{/each}
				</div>
			{/if}
			<div class="row">
				{#if data.canGenerate}
					<button class="btn" onclick={suggest} disabled={run.running}>
						{suggestions.length ? 'More ideas' : 'Suggest titles'}
					</button>
				{/if}
				<button class="btn primary" onclick={saveTitle} disabled={!changed || saving}>
					{saving ? 'Saving…' : saved && !changed ? 'Saved' : 'Save title'}
				</button>
			</div>
			<!-- As in Explanation: the chips are the result, and a finished run's
			     own line is worded for edits. -->
			{#if run.running || (run.state.outcome !== 'idle' && run.state.outcome !== 'done')}
				<RunProgress
					state={run.state}
					oncancel={run.running ? () => run.cancel() : undefined}
					idleLabel="Naming it…"
				/>
			{/if}
		</section>

		<section>
			<p class="label">What it is</p>
			<ScoreFacts score={doc} />
		</section>

		<section>
			<p class="label">What it does</p>
			<Explanation scoreId={data.score.id} analysis={data.analysis} canGenerate={data.canGenerate} />
		</section>

		<section>
			<p class="label">Take it away</p>
			<ExportMenu
				score={doc}
				soundfontUrl={data.soundfontUrl}
				renderSampleRate={data.audio.renderSampleRate}
			/>
		</section>

		{#if error}
			<p class="banner">{error}</p>
		{/if}

		<footer>
			<a class="skip" href="/score/{data.score.id}/refine">Go back and change something</a>
			<a class="skip" href="/score/{data.score.id}/bench">Open in Bench</a>
		</footer>
	</aside>

	<main class="stage">
		<Transport
			score={doc}
			{player}
			soundfontUrl={data.soundfontUrl}
			renderSampleRate={data.audio.renderSampleRate}
		/>
		<div class="canvas">
			<ScoreCanvas
				score={doc}
				{selected}
				{playheadTick}
				onselect={(ids, additive) => {
					selected = additive ? new Set([...selected, ...ids]) : new Set(ids);
				}}
			/>
		</div>
	</main>
</div>

<style>
	.finish {
		display: flex;
		gap: var(--space-4);
		height: 100%;
		min-height: 0;
	}

	.rail {
		width: 20rem;
		flex: 0 0 20rem;
		display: flex;
		flex-direction: column;
		gap: var(--space-5, var(--space-4));
		overflow-y: auto;
		min-height: 0;
		padding-right: var(--space-2);
	}

	.stage {
		flex: 1;
		display: flex;
		flex-direction: column;
		gap: var(--space-2);
		min-width: 0;
		min-height: 0;
	}
	.canvas {
		flex: 1;
		overflow: auto;
		min-height: 0;
	}

	.step {
		font-size: var(--text-xs);
		text-transform: uppercase;
		letter-spacing: 0.08em;
		color: var(--accent);
	}
	h1 {
		font-size: var(--text-lg);
		margin: var(--space-1) 0;
	}

	section {
		display: flex;
		flex-direction: column;
		gap: var(--space-2);
	}
	.field {
		display: flex;
		flex-direction: column;
		gap: var(--space-1);
	}
	.label {
		font-size: var(--text-xs);
		color: var(--fg-dim);
		text-transform: uppercase;
		letter-spacing: 0.08em;
		margin: 0;
	}
	input {
		background: var(--bg-pane);
		color: var(--fg);
		border: 1px solid var(--border);
		border-radius: var(--radius);
		padding: var(--space-2);
		font: inherit;
		min-width: 0;
	}
	input:focus {
		outline: none;
		border-color: var(--accent);
	}

	.chips {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-1);
	}
	.chip {
		background: var(--bg-pane);
		color: var(--fg);
		border: 1px solid var(--border);
		border-radius: 999px;
		padding: var(--space-1) var(--space-3);
		cursor: pointer;
		font: inherit;
		font-size: var(--text-sm);
	}
	.chip.on {
		border-color: var(--accent);
		color: var(--accent);
	}

	.row {
		display: flex;
		gap: var(--space-2);
	}

	.banner {
		background: var(--bg-pane);
		border-left: 3px solid var(--danger);
		color: var(--danger);
		padding: var(--space-3);
		border-radius: var(--radius);
		font-size: var(--text-sm);
	}

	footer {
		margin-top: auto;
		display: flex;
		flex-direction: column;
		gap: var(--space-2);
		border-top: 1px solid var(--border);
		padding-top: var(--space-3);
	}
	.skip {
		color: var(--fg-dim);
		font-size: var(--text-sm);
	}
	.btn {
		background: var(--border);
		color: var(--fg);
		border: none;
		border-radius: var(--radius);
		padding: var(--space-2) var(--space-4);
		cursor: pointer;
		font: inherit;
	}
	.btn.primary {
		background: var(--accent);
		color: var(--bg);
		font-weight: 600;
	}
	.btn:disabled {
		opacity: 0.55;
		cursor: default;
	}

	@media (max-width: 60rem) {
		.finish {
			flex-direction: column;
			overflow-y: auto;
		}
		.rail {
			width: auto;
			flex: none;
			overflow: visible;
		}
	}
</style>
