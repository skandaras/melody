<script lang="ts">
	import { goto } from '$app/navigation';
	import { untrack } from 'svelte';
	import ControlRack from '$lib/components/ControlRack.svelte';
	import Mixer from '$lib/components/Mixer.svelte';
	import PendingReview, { type Pending } from '$lib/components/PendingReview.svelte';
	import RunProgress from '$lib/components/RunProgress.svelte';
	import ScoreCanvas from '$lib/components/ScoreCanvas.svelte';
	import Transport from '$lib/components/Transport.svelte';
	import { PlayerStore } from '$lib/audio/player.svelte';
	import { Run } from '$lib/runs/run.svelte';
	import { accompanimentParts } from '$lib/pipeline/arrange';
	import { secondsToTick } from '$lib/score/measures';
	import type { Op } from '$lib/score/apply';
	import type { Score } from '$lib/score/types';
	import type { PageServerData } from './$types';

	/**
	 * Stage four: who has the tune, who supports, who rests.
	 *
	 * Parts are the unit, the way sections are in the melody stage. Each run
	 * writes one part at a time and may touch nothing else, so "Clear" on a part
	 * is a clean per-part reject and "Rewrite" a clean redo.
	 */

	let { data }: { data: PageServerData } = $props();

	const run = new Run();
	$effect(() => () => run.destroy());

	// Initial values only: every run and edit returns a fresh document.
	// svelte-ignore state_referenced_locally
	let doc = $state<Score>(untrack(() => data.score.doc));
	// svelte-ignore state_referenced_locally
	let pending = $state<Pending | null>(untrack(() => data.pending));
	let selectedPart = $state<string | null>(null);
	let selected = $state<Set<string>>(new Set());
	let instruction = $state('');
	let error = $state('');
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

	const plan = $derived(data.pipeline.plan!);
	const parts = $derived(accompanimentParts(doc, plan, data.pipeline.brief));
	const written = $derived(parts.filter((p) => p.state === 'written').length);
	const allWritten = $derived(parts.length > 0 && written === parts.length);
	const melody = $derived(doc.parts.find((p) => p.id === data.melodyPartId) ?? null);
	const current = $derived(parts.find((p) => p.partId === selectedPart) ?? null);
	const selection = $derived(selected.size ? { noteIds: [...selected] } : {});

	// A staged change blocks every other write; see PendingReview.
	const locked = $derived(run.running || busy || pending !== null);
	const canRun = $derived(data.canGenerate && !locked);

	const playheadTick = $derived.by(() => {
		const t = player.transport;
		if (!t.playing) return null;
		return secondsToTick(doc, t.position);
	});

	async function post(body: Record<string, unknown>) {
		const res = await fetch(`/api/scores/${data.score.id}/arrangement`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(body)
		});
		if (!res.ok) throw new Error((await res.text()) || res.statusText);
		return res.json();
	}

	/** No parts means every part still empty, so resuming is the same button. */
	async function arrange(partIds?: string[], direction?: string) {
		error = '';
		try {
			const { jobId } = await post({ action: 'arrange', partIds, instruction: direction });
			run.listen(
				jobId,
				(result) => {
					doc = result.doc as Score;
				},
				// The document after each part, so the score fills in as it is written.
				(type, payload) => {
					if (type === 'progress' && payload?.doc) doc = payload.doc as Score;
				}
			);
			instruction = '';
		} catch (e) {
			error = e instanceof Error ? e.message : String(e);
		}
	}

	async function clearPart(partId: string) {
		busy = true;
		error = '';
		try {
			const r = await post({ action: 'clear', partId });
			doc = r.doc as Score;
			selected = new Set();
		} catch (e) {
			error = e instanceof Error ? e.message : String(e);
		} finally {
			busy = false;
		}
	}

	/** The mixer's level and mute, through the one write path. */
	async function commitMix(ops: Op[], label: string) {
		const res = await fetch(`/api/scores/${data.score.id}/ops`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ ops, label })
		});
		if (!res.ok) {
			error = (await res.text()) || res.statusText;
			return;
		}
		doc = (await res.json()).doc as Score;
	}

	async function approve() {
		busy = true;
		error = '';
		try {
			await post({ action: 'approve' });
			// Through the bare score route, so the stage table decides where it lands.
			await goto(`/score/${data.score.id}`);
		} catch (e) {
			error = e instanceof Error ? e.message : String(e);
			busy = false;
		}
	}

	const sendFeedback = () => {
		const text = instruction.trim();
		if (!text || !current) return;
		arrange([current.partId], text);
	};
</script>

<svelte:head><title>Arrangement · melody</title></svelte:head>

<div class="arrangement">
	<aside class="rail">
		<header>
			<p class="step">Arrangement</p>
			<h1>{plan.title || 'The arrangement'}</h1>
			<p class="lead">
				{#if parts.length}
					{written} of {parts.length} parts written.
				{:else}
					The plan names no instruments besides the melody, so there is nothing to arrange.
				{/if}
			</p>
		</header>

		<section class="parts">
			{#if melody}
				<div class="part melody" title="Approved in the previous stage. Edit it in Bench.">
					<span class="mark">♪</span>
					<span class="name">{melody.name}</span>
					<span class="note">melody · locked</span>
				</div>
			{/if}
			{#each parts as part (part.partId)}
				<button
					class="part"
					class:current={selectedPart === part.partId}
					class:written={part.state === 'written'}
					onclick={() => (selectedPart = selectedPart === part.partId ? null : part.partId)}
				>
					<span class="mark">{part.state === 'written' ? '✓' : '·'}</span>
					<span class="name">{part.name}</span>
					<span class="note">{part.instrument}</span>
				</button>
			{/each}
		</section>

		{#if data.canGenerate && parts.length}
			<section class="actions">
				<button class="btn primary" onclick={() => arrange()} disabled={!canRun || allWritten}>
					{written === 0 ? 'Write the arrangement' : 'Write what is left'}
				</button>
				{#if current}
					<button class="btn" onclick={() => arrange([current.partId])} disabled={!canRun}>
						{current.state === 'written' ? 'Rewrite' : 'Write'}
						{current.name}
					</button>
				{/if}
			</section>

			<section class="feedback">
				<label class="field">
					<span class="label">
						{current ? `Change ${current.name}` : 'Pick a part to give feedback on'}
					</span>
					<textarea
						bind:value={instruction}
						rows="3"
						placeholder="sustain under the verse; walk in the chorus"
						disabled={!current || !canRun}
					></textarea>
				</label>
				<button
					class="btn"
					onclick={sendFeedback}
					disabled={!current || !canRun || !instruction.trim()}
				>
					Rewrite with this
				</button>
			</section>
		{:else if !data.canGenerate}
			<p class="hint">
				No model is configured, so parts cannot be written for you. You can still write them by
				hand in Bench.
			</p>
		{/if}

		{#if current && current.state === 'written'}
			<button class="btn quiet" onclick={() => clearPart(current.partId)} disabled={locked}>
				Clear {current.name}
			</button>
		{/if}

		{#if pending}
			<PendingReview
				scoreId={data.score.id}
				{pending}
				acceptUrl="/api/scores/{data.score.id}/arrangement"
				onresolved={(next) => {
					doc = next;
					pending = null;
					selected = new Set();
				}}
			/>
		{/if}

		{#if run.state.outcome !== 'idle'}
			<RunProgress
				state={run.state}
				oncancel={run.running ? () => run.cancel() : undefined}
				idleLabel="Arranging…"
				slowNote="Still arranging. Each part is its own call, so finished ones are already saved."
			/>
		{/if}

		{#if error}
			<p class="banner">{error}</p>
		{/if}

		<details class="fold">
			<summary>Listen</summary>
			<Mixer score={doc} {player} busy={locked} oncommit={commitMix} />
		</details>

		{#if data.controls.length}
			<details class="fold">
				<summary>Controls</summary>
				<ControlRack
					scoreId={data.score.id}
					controls={data.controls}
					{selection}
					busy={locked}
					onapplied={(r) => (doc = r.doc)}
					onstaged={(r) => {
						doc = r.doc;
						pending = {
							revisionId: r.revisionId,
							label: r.label,
							added: r.diff.added.length,
							changed: r.diff.changed.length,
							removed: r.diff.removed.length
						};
					}}
				/>
			</details>
		{/if}

		<footer>
			<a class="skip" href="/score/{data.score.id}/melody">Back to the melody</a>
			<a class="skip" href="/score/{data.score.id}/bench">Open in Bench</a>
			<button
				class="btn primary"
				onclick={approve}
				disabled={locked || (parts.length > 0 && written === 0)}
			>
				{busy ? 'Continuing…' : 'Approve and continue'}
			</button>
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
				quietParts={data.melodyPartId ? [data.melodyPartId] : []}
				busy={run.running}
				onselect={(ids, additive) => {
					selected = additive ? new Set([...selected, ...ids]) : new Set(ids);
				}}
			/>
		</div>
	</main>
</div>

<style>
	.arrangement {
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
	.lead,
	.hint {
		color: var(--fg-dim);
		font-size: var(--text-sm);
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
	}
	textarea {
		background: var(--bg-pane);
		color: var(--fg);
		border: 1px solid var(--border);
		border-radius: var(--radius);
		padding: var(--space-2);
		font: inherit;
		min-width: 0;
		resize: vertical;
	}
	textarea:focus {
		outline: none;
		border-color: var(--accent);
	}
	textarea:disabled {
		opacity: 0.5;
	}

	.parts {
		gap: var(--space-1);
	}
	.part {
		display: flex;
		align-items: baseline;
		gap: var(--space-2);
		background: none;
		border: 1px solid transparent;
		border-radius: var(--radius);
		padding: var(--space-2);
		font: inherit;
		color: var(--fg-dim);
		text-align: left;
	}
	button.part {
		cursor: pointer;
	}
	.part.written,
	.part.melody {
		color: var(--fg);
	}
	.part.current {
		border-color: var(--accent);
		background: var(--bg-pane);
	}
	.part .mark {
		color: var(--accent);
		width: 1rem;
	}
	.part .name {
		flex: 1;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.part .note {
		font-size: var(--text-xs);
		color: var(--fg-dim);
	}

	.fold summary {
		cursor: pointer;
		font-size: var(--text-xs);
		color: var(--fg-dim);
		text-transform: uppercase;
		letter-spacing: 0.08em;
		margin-bottom: var(--space-2);
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
	.btn.quiet {
		background: none;
		border: 1px solid var(--border);
		color: var(--fg-dim);
	}
	.btn:disabled {
		opacity: 0.55;
		cursor: default;
	}

	@media (max-width: 60rem) {
		.arrangement {
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
