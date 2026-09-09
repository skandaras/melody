<script lang="ts">
	import { untrack } from 'svelte';
	import ExportMenu from '$lib/components/ExportMenu.svelte';
	import RunProgress from '$lib/components/RunProgress.svelte';
	import ScoreCanvas from '$lib/components/ScoreCanvas.svelte';
	import ScoreFacts from '$lib/components/ScoreFacts.svelte';
	import StageStepper from '$lib/components/StageStepper.svelte';
	import Transport from '$lib/components/Transport.svelte';
	import { PlayerStore } from '$lib/audio/player.svelte';
	import { Run } from '$lib/runs/run.svelte';
	import { secondsToTick } from '$lib/score/measures';
	import type { Score } from '$lib/score/types';
	import type { PageServerData } from './$types';

	/**
	 * Stage six: name it, understand it, take it away.
	 *
	 * The last two `CORE_TASKS` with prompts and no caller are wired here, which
	 * discharges the epic's threat about them: "if Finish does not use `analyse`
	 * and `title`, delete them rather than leaving a second generation of latent
	 * intent behind."
	 *
	 * Export is deliberately a read. Nothing on this page changes the document
	 * except naming it, and that goes through the same op path as any other edit
	 * so it lands in the history and can be undone.
	 */

	let { data }: { data: PageServerData } = $props();

	const run = new Run();
	$effect(() => () => run.destroy());

	// svelte-ignore state_referenced_locally
	let doc = $state<Score>(untrack(() => data.score.doc));
	// svelte-ignore state_referenced_locally
	let title = $state(untrack(() => data.score.title));
	let suggestions = $state<string[]>([]);
	// svelte-ignore state_referenced_locally
	let explanation = $state(untrack(() => data.analysis?.text ?? ''));
	// svelte-ignore state_referenced_locally
	let explanationStale = $state(untrack(() => data.analysis?.stale ?? false));
	let selected = $state<Set<string>>(new Set());
	let error = $state('');
	let saved = $state(false);
	let busy = $state(false);
	let scale = $state(1);

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

	const canRun = $derived(data.canGenerate && !run.running && !busy);
	const dirty = $derived(title.trim() !== doc.title && title.trim().length > 0);

	const playheadTick = $derived.by(() => {
		const t = player.transport;
		if (!t.playing) return null;
		return secondsToTick(doc, t.position);
	});

	async function post(body: Record<string, unknown>) {
		const res = await fetch(`/api/scores/${data.score.id}/finish`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(body)
		});
		if (!res.ok) throw new Error((await res.text()) || res.statusText);
		return res.json();
	}

	/**
	 * Ask for a name.
	 *
	 * One call, one suggestion, because the seeded prompt ends "Return only the
	 * title" and that prompt cannot be changed for installs that already exist —
	 * `seedTaskConfigs` is insert-if-absent. So several suggestions are several
	 * presses, which is honest and, for the cheapest task in the app, barely
	 * costs anything.
	 */
	async function suggest() {
		error = '';
		try {
			const { jobId } = await post({ action: 'suggestTitle' });
			run.listen(jobId, undefined, (type, payload) => {
				if (type !== 'result' || typeof payload?.text !== 'string') return;
				const name = payload.text.trim();
				// Models add quotation marks despite being told not to.
				const clean = name.replace(/^["'“”‘’`]+|["'“”‘’`.]+$/g, '').trim();
				if (clean && !suggestions.includes(clean)) suggestions = [clean, ...suggestions];
			});
		} catch (e) {
			error = e instanceof Error ? e.message : String(e);
		}
	}

	/** The paid `analyse` task, kept once it arrives so a return visit is free. */
	async function explain() {
		error = '';
		try {
			const { jobId } = await post({ action: 'explain' });
			run.listen(jobId, undefined, (type, payload) => {
				if (type !== 'result' || typeof payload?.text !== 'string') return;
				explanation = payload.text;
				explanationStale = false;
				// Stored with the digest it was written from, so a later visit can
				// tell whether it still describes the piece.
				void post({
					action: 'rememberAnalysis',
					analysis: payload.text,
					basis: typeof payload.basis === 'string' ? payload.basis : ''
				}).catch(() => {
					// Keeping it is a convenience; failing to keep it must not take
					// away the answer already on screen.
				});
			});
		} catch (e) {
			error = e instanceof Error ? e.message : String(e);
		}
	}

	async function saveTitle() {
		const clean = title.trim();
		if (!clean) return;
		busy = true;
		error = '';
		saved = false;
		try {
			const result = await post({ action: 'setTitle', title: clean });
			doc = result.doc as Score;
			title = result.title as string;
			saved = true;
		} catch (e) {
			error = e instanceof Error ? e.message : String(e);
		} finally {
			busy = false;
		}
	}
</script>

<svelte:head><title>{doc.title || 'Finish'} · melody</title></svelte:head>

<div class="finish">
	<aside class="rail">
		<header>
			<StageStepper scoreId={data.score.id} current="finish" reached={data.pipeline.stage} />
			<h1>{doc.title || 'Name it'}</h1>
			<p class="lead">Name it, understand it, take it away.</p>
		</header>

		<section>
			<label class="field">
				<span class="label">Title</span>
				<input
					bind:value={title}
					placeholder="Slow Light in November"
					disabled={busy}
					onkeydown={(e) => {
						if (e.key === 'Enter') saveTitle();
					}}
				/>
			</label>
			<div class="row">
				<button class="btn primary" onclick={saveTitle} disabled={busy || !dirty}>
					{busy ? 'Saving…' : 'Save the name'}
				</button>
				{#if data.canGenerate}
					<button class="btn" onclick={suggest} disabled={!canRun}>Suggest one</button>
				{/if}
			</div>
			{#if saved && !dirty}
				<p class="ok">Saved.</p>
			{/if}

			{#if suggestions.length}
				<ul class="suggestions">
					{#each suggestions as name (name)}
						<li>
							<button class="pick" onclick={() => (title = name)}>{name}</button>
						</li>
					{/each}
				</ul>
			{/if}
		</section>

		<section>
			<p class="label">What this piece is</p>
			<ScoreFacts score={doc} />
		</section>

		<section class="explain">
			{#if data.canGenerate}
				<button class="btn" onclick={explain} disabled={!canRun}>
					{explanation ? 'Read it again' : 'Explain this piece'}
				</button>
			{/if}
			{#if explanation}
				{#if explanationStale}
					<!-- The digest it was written from no longer matches, so some fact
					     it rests on has changed. Saying so beats presenting an old
					     reading as a current one. -->
					<p class="warn">Written before your last edits — read it again to be sure.</p>
				{/if}
				<p class="prose">{explanation}</p>
			{:else if data.canGenerate}
				<p class="hint">
					The facts above are free. This asks a model to read the piece back to you, and costs a
					call — the cheapest one in the app.
				</p>
			{/if}
		</section>

		<section>
			<p class="label">Take it away</p>
			<ExportMenu
				score={doc}
				soundfontUrl={data.soundfontUrl}
				renderSampleRate={data.audio.renderSampleRate}
			/>
		</section>

		{#if run.state.outcome !== 'idle'}
			<RunProgress
				state={run.state}
				oncancel={run.running ? () => run.cancel() : undefined}
				idleLabel="Thinking…"
			/>
		{/if}

		{#if error}
			<p class="banner">{error}</p>
		{/if}

		<footer>
			<!-- Refinement, because "change something" almost always means how it
			     sounds. The stepper above offers the other four at no extra cost,
			     which is what makes a single back-link enough here. -->
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
				{scale}
				{playheadTick}
				busy={run.running}
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
		gap: var(--space-4);
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

	h1 {
		font-size: var(--text-lg);
		margin: var(--space-1) 0;
	}
	.lead {
		color: var(--fg-dim);
		font-size: var(--text-sm);
	}
	.hint {
		color: var(--fg-dim);
		font-size: var(--text-xs);
		margin: 0;
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
		margin: 0;
	}
	.row {
		display: flex;
		gap: var(--space-2);
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

	.suggestions {
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		flex-direction: column;
		gap: var(--space-1);
	}
	.pick {
		width: 100%;
		text-align: left;
		background: var(--bg-pane);
		border: 1px solid var(--border);
		border-radius: var(--radius);
		color: var(--fg);
		padding: var(--space-2);
		font: inherit;
		cursor: pointer;
	}
	.pick:hover {
		border-color: var(--accent);
	}

	.prose {
		margin: 0;
		font-size: var(--text-sm);
		white-space: pre-wrap;
		background: var(--bg-pane);
		border-radius: var(--radius);
		padding: var(--space-3);
	}
	.warn {
		margin: 0;
		font-size: var(--text-xs);
		color: var(--danger);
	}
	.ok {
		margin: 0;
		font-size: var(--text-xs);
		color: var(--diff-add);
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
