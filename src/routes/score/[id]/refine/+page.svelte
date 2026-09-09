<script lang="ts">
	import { goto } from '$app/navigation';
	import { untrack } from 'svelte';
	import AiPanel from '$lib/components/AiPanel.svelte';
	import ControlRack from '$lib/components/ControlRack.svelte';
	import PendingBar from '$lib/components/PendingBar.svelte';
	import RunProgress from '$lib/components/RunProgress.svelte';
	import ScoreCanvas from '$lib/components/ScoreCanvas.svelte';
	import ScoreFacts from '$lib/components/ScoreFacts.svelte';
	import StageStepper from '$lib/components/StageStepper.svelte';
	import Transport from '$lib/components/Transport.svelte';
	import { PlayerStore } from '$lib/audio/player.svelte';
	import { Run } from '$lib/runs/run.svelte';
	import { editScope } from '$lib/pipeline/refine';
	import { secondsToTick } from '$lib/score/measures';
	import type { Score } from '$lib/score/types';
	import type { PageServerData } from './$types';

	/**
	 * Stage five: how it sounds.
	 *
	 * Expression rather than structure — nothing here changes what the piece is.
	 * It is also the re-entry point: coming back from Bench or from Finish to
	 * change something lands here, which is why the manual editor needs no Ask
	 * box of its own.
	 *
	 * The page is shaped around one question the epic is emphatic about: what
	 * does a control act on? Every scope decision goes through `editScope`, so
	 * the words on the buttons and the notes the operation reaches cannot
	 * disagree.
	 */

	let { data }: { data: PageServerData } = $props();

	const run = new Run();
	$effect(() => () => run.destroy());

	// Initial value only. Every run returns a fresh document, and re-deriving
	// from the load would fight that.
	// svelte-ignore state_referenced_locally
	let doc = $state<Score>(untrack(() => data.score.doc));
	let selected = $state<Set<string>>(new Set());
	let selectedPart = $state<string | null>(null);
	let explanation = $state('');
	let error = $state('');
	let busy = $state(false);
	let scale = $state(1);

	/**
	 * A staged change, waiting to be kept or undone.
	 *
	 * Both the prompt-tier controls and the feedback box commit `accepted: false`
	 * — a model-driven edit is a proposal until someone has looked at it — so one
	 * slot serves both. Adopting their document without offering the decision
	 * would leave an unresolved revision behind every time.
	 */
	let pending = $state<{ revisionId: string; label: string } | null>(null);

	// svelte-ignore state_referenced_locally
	const player = new PlayerStore(() => data.soundfontUrl, {
		masterVolume: data.audio.masterVolume,
		renderSampleRate: data.audio.renderSampleRate
	});
	$effect(() => () => player.destroy());

	$effect(() => {
		// Any change makes the loaded sequence stale.
		void doc;
		player.invalidate();
	});

	const parts = $derived(doc.parts.map((p) => ({ id: p.id, name: p.name })));

	/**
	 * What every control and the feedback box acts on.
	 *
	 * One value, so the label and the operation are the same claim — see
	 * `$lib/pipeline/refine.ts` for why that has to be one function rather than
	 * two derivations that could drift apart.
	 */
	const scope = $derived(editScope(doc, { noteIds: selected, partId: selectedPart }));

	/**
	 * Whether firing something is safe.
	 *
	 * `noteCount` and not the shape of the selection: a part with nothing in it
	 * produces `{ partIds: [...] }`, which resolves to the *whole score* rather
	 * than to nothing. Refusing on the count is what stops "change the Cello"
	 * changing everything when the cello is empty.
	 */
	const hasTarget = $derived(scope.noteCount > 0);
	const canRun = $derived(data.canGenerate && !run.running && !busy && !pending);

	/** Where playback has reached. Null unless something is sounding. */
	const playheadTick = $derived.by(() => {
		const t = player.transport;
		if (!t.playing) return null;
		return secondsToTick(doc, t.position);
	});

	async function post(body: Record<string, unknown>) {
		const res = await fetch(`/api/scores/${data.score.id}/refine`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(body)
		});
		if (!res.ok) throw new Error((await res.text()) || res.statusText);
		return res.json();
	}

	/**
	 * The paid `analyse` task. Never automatic — it costs a call.
	 *
	 * Shown for the session and deliberately not kept, unlike on the Finish page.
	 * This is the stage where the piece is actively being changed, so an analysis
	 * written here is stale within a few clicks; storing prose whose whole value
	 * is being true about the current document, on the one page most likely to
	 * make it false, would be keeping a claim rather than an answer.
	 */
	async function explain() {
		error = '';
		try {
			const { jobId } = await post({ action: 'explain' });
			run.listen(jobId, undefined, (type, payload) => {
				if (type === 'result' && typeof payload?.text === 'string') {
					explanation = payload.text;
				}
			});
		} catch (e) {
			error = e instanceof Error ? e.message : String(e);
		}
	}

	/** Accept or roll back a staged change. */
	async function resolvePending(action: 'accept' | 'reject') {
		if (!pending) return;
		busy = true;
		error = '';
		try {
			const res = await fetch(`/api/scores/${data.score.id}/revisions`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ action, revisionId: pending.revisionId })
			});
			if (!res.ok) throw new Error((await res.text()) || res.statusText);
			doc = (await res.json()).doc as Score;
			pending = null;
			selected = new Set();
		} catch (e) {
			error = e instanceof Error ? e.message : String(e);
		} finally {
			busy = false;
		}
	}

	async function approve() {
		busy = true;
		error = '';
		try {
			await post({ action: 'approve' });
			// Through the bare score route, so the stage table decides where it
			// lands rather than this page hardcoding what comes next.
			await goto(`/score/${data.score.id}`);
		} catch (e) {
			error = e instanceof Error ? e.message : String(e);
			busy = false;
		}
	}

	function clearScope() {
		selected = new Set();
		selectedPart = null;
	}
</script>

<svelte:head><title>Refinement · melody</title></svelte:head>

<div class="refine">
	<aside class="rail">
		<header>
			<StageStepper scoreId={data.score.id} current="refine" reached={data.pipeline.stage} />
			<h1>{data.score.title || 'How it sounds'}</h1>
			<p class="lead">Dynamics, colour and feel. Nothing here changes what the piece is.</p>
		</header>

		<section>
			<ScoreFacts score={doc} />
		</section>

		<section class="scope">
			<p class="label">Editing</p>
			<p class="target" class:whole={scope.kind === 'whole'}>
				{scope.label}
				{#if scope.kind !== 'whole'}
					<button class="clear" onclick={clearScope}>use the whole piece</button>
				{/if}
			</p>
			{#if !hasTarget}
				<!-- The one case that must not fall through to "everything": an empty
				     part resolves to the whole score, so it is refused by name. -->
				<p class="warn">{scope.label} has no notes in it. Pick something else.</p>
			{/if}
			<label class="field">
				<span class="label">Or one part</span>
				<select
					value={selectedPart ?? ''}
					onchange={(e) => {
						selectedPart = e.currentTarget.value || null;
						if (selectedPart) selected = new Set();
					}}
					disabled={busy || run.running}
				>
					<option value="">Everything</option>
					{#each parts as part (part.id)}
						<option value={part.id}>{part.name}</option>
					{/each}
				</select>
			</label>
		</section>

		{#if pending}
			<PendingBar
				label={pending.label}
				{busy}
				onaccept={() => resolvePending('accept')}
				onreject={() => resolvePending('reject')}
			/>
		{/if}

		<ControlRack
			scoreId={data.score.id}
			controls={data.controls}
			selection={scope.selection}
			scopeLabel={scope.label}
			busy={busy || run.running || Boolean(pending) || !hasTarget}
			onapplied={(r) => (doc = r.doc)}
			onstaged={(r) => {
				doc = r.doc;
				pending = { revisionId: r.revisionId, label: r.label };
			}}
		/>

		{#if data.canGenerate}
			<section>
				<p class="label">Anything the controls do not cover</p>
				<AiPanel
					scoreId={data.score.id}
					selection={scope.selection}
					selectionCount={scope.kind === 'whole' ? 0 : scope.noteCount}
					busy={busy || run.running || Boolean(pending) || !hasTarget}
					onresult={(r) => {
						doc = r.doc;
						pending = { revisionId: r.revisionId, label: r.label };
					}}
				/>
			</section>

			<section class="explain">
				<button class="btn" onclick={explain} disabled={!canRun}>Explain this piece</button>
				<p class="hint">
					The facts above are free. This asks a model to read the piece back to you, and costs a
					call.
				</p>
				{#if explanation}
					<p class="prose">{explanation}</p>
				{/if}
			</section>
		{:else}
			<p class="hint">
				No model is configured, so the feedback box and the written explanation are unavailable.
				Every free control above still works.
			</p>
		{/if}

		{#if run.state.outcome !== 'idle'}
			<RunProgress
				state={run.state}
				oncancel={run.running ? () => run.cancel() : undefined}
				idleLabel="Reading…"
			/>
		{/if}

		{#if error}
			<p class="banner">{error}</p>
		{/if}

		<footer>
			<a class="skip" href="/score/{data.score.id}/arrangement">Back to the arrangement</a>
			<a class="skip" href="/score/{data.score.id}/bench">Open in Bench</a>
			<button
				class="btn primary"
				onclick={approve}
				disabled={busy || run.running || Boolean(pending)}
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
				busy={run.running}
				onselect={(ids, additive) => {
					selected = additive ? new Set([...selected, ...ids]) : new Set(ids);
					// A note pick is more specific than a part, so it replaces one.
					if (selected.size) selectedPart = null;
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

	h1 {
		font-size: var(--text-lg);
		margin: var(--space-1) 0;
	}
	.lead,
	.hint {
		color: var(--fg-dim);
		font-size: var(--text-sm);
	}
	.hint {
		font-size: var(--text-xs);
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
	select {
		background: var(--bg-pane);
		color: var(--fg);
		border: 1px solid var(--border);
		border-radius: var(--radius);
		padding: var(--space-2);
		font: inherit;
		min-width: 0;
	}
	select:focus {
		outline: none;
		border-color: var(--accent);
	}

	/* The scope reads as a statement, not a status line — it is the thing most
	   likely to be wrong when a control does something unexpected. */
	.scope {
		border-left: 2px solid var(--accent);
		padding-left: var(--space-3);
	}
	.target {
		margin: 0;
		font-weight: 600;
	}
	.target.whole {
		color: var(--accent);
	}
	.clear {
		background: none;
		border: none;
		padding: 0 0 0 var(--space-2);
		color: var(--fg-dim);
		font: inherit;
		font-size: var(--text-xs);
		font-weight: 400;
		cursor: pointer;
		text-decoration: underline;
	}
	.warn {
		margin: 0;
		font-size: var(--text-xs);
		color: var(--danger);
	}

	.prose {
		margin: 0;
		font-size: var(--text-sm);
		white-space: pre-wrap;
		background: var(--bg-pane);
		border-radius: var(--radius);
		padding: var(--space-3);
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
