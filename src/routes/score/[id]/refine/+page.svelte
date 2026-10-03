<script lang="ts">
	import { goto } from '$app/navigation';
	import { untrack } from 'svelte';
	import AiPanel from '$lib/components/AiPanel.svelte';
	import ControlRack from '$lib/components/ControlRack.svelte';
	import HistoryPanel from '$lib/components/HistoryPanel.svelte';
	import Mixer from '$lib/components/Mixer.svelte';
	import PendingReview, { type Pending } from '$lib/components/PendingReview.svelte';
	import ScoreCanvas from '$lib/components/ScoreCanvas.svelte';
	import ScoreFacts from '$lib/components/ScoreFacts.svelte';
	import Transport from '$lib/components/Transport.svelte';
	import { PlayerStore } from '$lib/audio/player.svelte';
	import { secondsToTick } from '$lib/score/measures';
	import type { Op } from '$lib/score/apply';
	import type { Score } from '$lib/score/types';
	import type { PageServerData } from './$types';

	/**
	 * Stage five: how it sounds.
	 *
	 * Dynamics, colour, tension, feel — expression rather than structure. The
	 * form is locked on the server, so nothing here can change what the piece
	 * is. It is also where a score comes back to be re-prompted, from Bench or
	 * from Finish, which is why the free-text box lives here and nowhere else.
	 */

	let { data }: { data: PageServerData } = $props();

	// Initial values only: every edit returns a fresh document.
	// svelte-ignore state_referenced_locally
	let doc = $state<Score>(untrack(() => data.score.doc));
	// svelte-ignore state_referenced_locally
	let pending = $state<Pending | null>(untrack(() => data.pending));
	// svelte-ignore state_referenced_locally
	let revisions = $state(untrack(() => data.revisions));
	let selected = $state<Set<string>>(new Set());
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

	const title = $derived(data.pipeline.plan?.title || data.score.title);
	const selection = $derived(selected.size ? { noteIds: [...selected] } : {});
	// A staged change blocks every other write; see PendingReview.
	const locked = $derived(busy || pending !== null);

	const playheadTick = $derived.by(() => {
		const t = player.transport;
		if (!t.playing) return null;
		return secondsToTick(doc, t.position);
	});

	function stage(r: {
		doc: Score;
		revisionId: string;
		label: string;
		diff: { added: string[]; removed: string[]; changed: string[] };
	}) {
		doc = r.doc;
		pending = {
			revisionId: r.revisionId,
			label: r.label,
			added: r.diff.added.length,
			changed: r.diff.changed.length,
			removed: r.diff.removed.length
		};
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

	async function refreshHistory() {
		const res = await fetch(`/api/scores/${data.score.id}/revisions`);
		if (!res.ok) return;
		revisions = (await res.json()).revisions.map(
			(r: { createdAt: string | number }) => ({ ...r, createdAt: new Date(r.createdAt).getTime() })
		);
	}

	/**
	 * Go back to an earlier version.
	 *
	 * A full reload through the bare score route rather than adopting the
	 * returned document here: restoring also restores the stage the score was
	 * at, and the stage table is what decides which page that is.
	 */
	async function restore(revisionId: string) {
		busy = true;
		error = '';
		try {
			const res = await fetch(`/api/scores/${data.score.id}/revisions`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ action: 'restore', revisionId })
			});
			if (!res.ok) throw new Error((await res.text()) || res.statusText);
			location.href = `/score/${data.score.id}`;
		} catch (e) {
			error = e instanceof Error ? e.message : String(e);
			busy = false;
		}
	}

	async function approve() {
		busy = true;
		error = '';
		try {
			const res = await fetch(`/api/scores/${data.score.id}/refine`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ action: 'approve' })
			});
			if (!res.ok) throw new Error((await res.text()) || res.statusText);
			await goto(`/score/${data.score.id}`);
		} catch (e) {
			error = e instanceof Error ? e.message : String(e);
			busy = false;
		}
	}
</script>

<svelte:head><title>Refinement · melody</title></svelte:head>

<div class="refine">
	<aside class="rail">
		<header>
			<p class="step">Refinement</p>
			<h1>{title || 'Untitled'}</h1>
			<p class="lead">How it sounds: dynamics, colour, tension, feel. The form stays as it is.</p>
		</header>

		<section>
			<ScoreFacts score={doc} />
		</section>

		{#if pending}
			<PendingReview
				scoreId={data.score.id}
				{pending}
				onresolved={(next) => {
					doc = next;
					pending = null;
					selected = new Set();
				}}
			/>
		{/if}

		{#if data.canGenerate}
			<section>
				<p class="label">Anything the controls do not cover</p>
				<AiPanel
					scoreId={data.score.id}
					{selection}
					selectionCount={selected.size}
					busy={locked}
					onresult={stage}
				/>
			</section>
		{:else}
			<p class="hint">
				No model is configured, so only the free controls are available. Bench is there for
				anything by hand.
			</p>
		{/if}

		{#if data.controls.length}
			<details class="fold" open>
				<summary>Controls</summary>
				<ControlRack
					scoreId={data.score.id}
					controls={data.controls}
					{selection}
					busy={locked}
					onapplied={(r) => (doc = r.doc)}
					onstaged={stage}
				/>
			</details>
		{/if}

		<details class="fold">
			<summary>Listen</summary>
			<Mixer score={doc} {player} busy={locked} oncommit={commitMix} />
		</details>

		<details class="fold" ontoggle={(e) => e.currentTarget.open && refreshHistory()}>
			<summary>History</summary>
			<HistoryPanel {revisions} busy={locked} onrestore={restore} />
		</details>

		{#if error}
			<p class="banner">{error}</p>
		{/if}

		<footer>
			{#if data.pipeline.plan}
				<a class="skip" href="/score/{data.score.id}/arrangement">Back to the arrangement</a>
			{/if}
			<a class="skip" href="/score/{data.score.id}/bench">Open in Bench</a>
			<button class="btn primary" onclick={approve} disabled={locked}>
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
				onselect={(ids, additive) => {
					selected = additive ? new Set([...selected, ...ids]) : new Set(ids);
				}}
			/>
		</div>
	</main>
</div>

<style>
	.refine {
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
	.label {
		font-size: var(--text-xs);
		color: var(--fg-dim);
		margin: 0 0 var(--space-1);
	}

	section {
		display: flex;
		flex-direction: column;
		gap: var(--space-2);
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
	.btn:disabled {
		opacity: 0.55;
		cursor: default;
	}

	@media (max-width: 60rem) {
		.refine {
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
