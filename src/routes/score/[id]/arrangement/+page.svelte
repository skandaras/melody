<script lang="ts">
	import { goto } from '$app/navigation';
	import { untrack } from 'svelte';
	import ControlRack from '$lib/components/ControlRack.svelte';
	import Mixer from '$lib/components/Mixer.svelte';
	import PendingBar from '$lib/components/PendingBar.svelte';
	import RunProgress from '$lib/components/RunProgress.svelte';
	import ScoreCanvas from '$lib/components/ScoreCanvas.svelte';
	import Transport from '$lib/components/Transport.svelte';
	import StageStepper from '$lib/components/StageStepper.svelte';
	import { PlayerStore } from '$lib/audio/player.svelte';
	import { Run } from '$lib/runs/run.svelte';
	import { partChunks, partStates, unwrittenParts } from '$lib/pipeline/arrange';
	import { checkPlayability, describeIssue } from '$lib/score/playability';
	import { secondsToTick } from '$lib/score/measures';
	import type { Op } from '$lib/score/apply';
	import type { Score } from '$lib/score/types';
	import type { PageServerData } from './$types';

	/**
	 * Stage four: who plays what.
	 *
	 * The melody arrived here approved, so the shape of the page is auditioning
	 * rather than writing — hear a part against the tune, keep it or throw it
	 * away, write the next one. Mute and solo are the primary verbs, which is
	 * why the mixer is in the rail rather than behind a panel.
	 */

	let { data }: { data: PageServerData } = $props();

	const run = new Run();
	$effect(() => () => run.destroy());

	// Initial value only. Every run returns a fresh document, and re-deriving
	// from the load would fight that.
	// svelte-ignore state_referenced_locally
	let doc = $state<Score>(untrack(() => data.score.doc));
	let selectedPart = $state<string | null>(null);
	let selected = $state<Set<string>>(new Set());
	let instruction = $state('');
	let error = $state('');
	let busy = $state(false);
	let scale = $state(1);

	/**
	 * A control's staged result, waiting to be accepted or rejected.
	 *
	 * The runs on this page commit accepted and are reviewed per part, but a
	 * control goes through the shared control path, which stages its result
	 * because "a model-driven change is a proposal until someone has looked at
	 * it". Adopting the document without offering that decision would leave an
	 * unresolved revision behind every time someone pressed Reharmonise, and the
	 * change would look applied while the history said otherwise.
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

	const plan = $derived(data.pipeline.plan!);
	const melodyPartId = $derived(data.melodyPartId);
	const parts = $derived(partStates(doc, plan, melodyPartId));
	/** Everything a control here may touch — the melody is not one of them. */
	const accompaniment = $derived(parts.filter((p) => p.role !== 'melody'));

	/**
	 * What this stage is responsible for writing, and what is left of it.
	 *
	 * Both from the same pure functions the run itself uses, so the button
	 * cannot disagree with the endpoint about whether there is work to do. The
	 * displayed part list is deliberately wider: it shows every part, including
	 * one an orchestration invented, because that is what is in the score.
	 */
	const targets = $derived(partChunks(doc, plan, melodyPartId));
	const remaining = $derived(unwrittenParts(doc, plan, melodyPartId));
	const written = $derived(targets.length - remaining.length);

	const canRun = $derived(data.canGenerate && !run.running && !busy && !pending);

	/**
	 * Range problems, recomputed from the document.
	 *
	 * The same pure check the run warns with and the model can now call, so the
	 * page cannot disagree with either. Shown standing rather than only at the
	 * end of a run, because a cello four notes below its bottom string is just
	 * as wrong an hour later.
	 */
	const rangeIssues = $derived(checkPlayability(doc));

	/**
	 * The selected part, if it still exists.
	 *
	 * A run can remove a part, and editing the plan in another tab can too, so a
	 * stale id would otherwise render as an empty name in three separate labels.
	 */
	const current = $derived(parts.find((p) => p.partId === selectedPart) ?? null);

	/** Where playback has reached. Null unless something is sounding. */
	const playheadTick = $derived.by(() => {
		const t = player.transport;
		if (!t.playing) return null;
		return secondsToTick(doc, t.position);
	});

	/**
	 * What a control edits when one is fired here.
	 *
	 * Never the default. `resolveSelection(score, {})` returns *everything*, so
	 * a control fired with an empty selection would rewrite the whole piece,
	 * melody included — the hazard the melody stage's notes call out, and it
	 * applies with more force here where the tune is meant to be untouchable.
	 * With no part selected the scope is every accompaniment part; with one
	 * selected it is that part alone.
	 */
	const selection = $derived(
		current && current.role !== 'melody'
			? { partIds: [current.partId] }
			: { partIds: accompaniment.map((p) => p.partId) }
	);

	/**
	 * Whether there is anything here for a control to edit.
	 *
	 * Load-bearing, not cosmetic. An empty `partIds` does not mean "no parts" —
	 * `resolveSelection` reads a missing or empty list as the whole score — so a
	 * control fired on a solo piece, where every part is the melody, would edit
	 * the tune this stage exists not to touch. There is no encoding of "select
	 * nothing" to fall back on, so the rack is withheld instead.
	 */
	const canEdit = $derived(accompaniment.length > 0);

	async function post(body: Record<string, unknown>) {
		const res = await fetch(`/api/scores/${data.score.id}/arrangement`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(body)
		});
		if (!res.ok) throw new Error((await res.text()) || res.statusText);
		return res.json();
	}

	/**
	 * Start a run.
	 *
	 * No parts means "everything still empty", which is what makes resuming an
	 * interrupted arrangement, and rewriting a rejected part, the same button as
	 * starting one.
	 */
	async function arrange(partIds?: string[], direction?: string) {
		error = '';
		try {
			const { jobId } = await post({ action: 'arrange', partIds, instruction: direction });
			run.listen(
				jobId,
				(result) => {
					doc = result.doc as Score;
				},
				// The document after each part, so the notation fills in as it is
				// written rather than all at once at the end.
				(type, payload) => {
					if (type === 'progress' && payload?.doc) doc = payload.doc as Score;
				}
			);
			instruction = '';
		} catch (e) {
			error = e instanceof Error ? e.message : String(e);
		}
	}

	/** Throw one part's notes away, keeping the part the plan created. */
	async function rejectPart(partId: string) {
		busy = true;
		error = '';
		try {
			const result = await post({ action: 'reject', partId });
			doc = result.doc as Score;
		} catch (e) {
			error = e instanceof Error ? e.message : String(e);
		} finally {
			busy = false;
		}
	}

	/** The mixer's own writes — level and mute, batched. */
	async function commitMix(ops: Op[], label: string) {
		try {
			const res = await fetch(`/api/scores/${data.score.id}/ops`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ ops, label, source: 'user' })
			});
			if (!res.ok) throw new Error((await res.text()) || res.statusText);
			const result = await res.json();
			doc = result.doc as Score;
		} catch (e) {
			error = e instanceof Error ? e.message : String(e);
		}
	}

	/** Accept or roll back a control's staged result. */
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
			// Through the bare score route, so the stage table decides where that
			// lands, rather than this page hardcoding what comes next.
			await goto(`/score/${data.score.id}`);
		} catch (e) {
			error = e instanceof Error ? e.message : String(e);
			busy = false;
		}
	}

	const sendFeedback = () => {
		const text = instruction.trim();
		if (!text || !current || current.role === 'melody') return;
		arrange([current.partId], text);
	};
</script>

<svelte:head><title>Arrangement · melody</title></svelte:head>

<div class="arrangement">
	<aside class="rail">
		<header>
			<StageStepper scoreId={data.score.id} current="arrangement" reached={data.pipeline.stage} />
			<h1>{plan.title || 'The ensemble'}</h1>
			<p class="lead">
				{#if targets.length === 0}
					A solo piece — the plan named one instrument.
				{:else}
					{written} of {targets.length} parts arranged.
				{/if}
			</p>
		</header>

		<section class="parts">
			{#each parts as part (part.partId)}
				<button
					class="part"
					class:current={selectedPart === part.partId}
					class:written={part.state === 'written'}
					class:melody={part.role === 'melody'}
					onclick={() =>
						(selectedPart = selectedPart === part.partId ? null : part.partId)}
				>
					<span class="mark">
						{#if part.role === 'melody'}♪{:else if part.state === 'written'}✓{:else}·{/if}
					</span>
					<span class="name">{part.name}</span>
					{#if part.role === 'melody'}
						<span class="tag">tune</span>
					{:else if part.role === 'extra'}
						<span class="tag warn" title="The plan did not name this instrument">added</span>
					{/if}
				</button>
			{/each}
		</section>

		{#if data.canGenerate}
			<section class="actions">
				<button
					class="btn primary"
					onclick={() => arrange()}
					disabled={!canRun || remaining.length === 0}
				>
					{written === 0 ? 'Arrange the ensemble' : 'Arrange what is left'}
				</button>
				{#if current && current.role !== 'melody'}
					<button class="btn" onclick={() => arrange([current.partId])} disabled={!canRun}>
						Rewrite {current.name}
					</button>
					{#if current.state === 'written'}
						<button
							class="btn"
							onclick={() => rejectPart(current.partId)}
							disabled={busy || run.running || Boolean(pending)}
						>
							Reject {current.name}
						</button>
					{/if}
				{/if}
			</section>

			<section class="feedback">
				<label class="field">
					<span class="label">
						{current && current.role !== 'melody'
							? `Change ${current.name}`
							: 'Pick a part to give feedback on'}
					</span>
					<textarea
						bind:value={instruction}
						rows="3"
						placeholder="give the bass more movement; let the strings rest in the verse"
						disabled={!current || current.role === 'melody' || !canRun}
					></textarea>
				</label>
				<button
					class="btn"
					onclick={sendFeedback}
					disabled={!current ||
						current.role === 'melody' ||
						!canRun ||
						!instruction.trim()}
				>
					Rewrite with this
				</button>
			</section>
		{:else}
			<p class="hint">
				No model is configured, so the ensemble cannot be arranged for you. You can still write
				parts by hand in Bench.
			</p>
		{/if}

		{#if rangeIssues.length}
			<section class="issues">
				<p class="label">Outside the instrument's range</p>
				{#each rangeIssues as issue (issue.partId)}
					<p class="issue">{describeIssue(issue)}</p>
				{/each}
			</section>
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

		<section class="mix">
			<p class="label">Audition</p>
			<!-- No remove button: the ensemble is the plan's, and throwing a part
			     away here would edit what was already approved. Rejecting one
			     part's *notes* is offered above, under that name. -->
			<Mixer
				score={doc}
				{player}
				busy={busy || run.running || Boolean(pending)}
				oncommit={commitMix}
			/>
		</section>

		{#if pending}
			<PendingBar
				label={pending.label}
				{busy}
				onaccept={() => resolvePending('accept')}
				onreject={() => resolvePending('reject')}
			/>
		{/if}

		{#if canEdit}
			<ControlRack
				scoreId={data.score.id}
				controls={data.controls}
				{selection}
				busy={busy || run.running || Boolean(pending)}
				onapplied={(r) => (doc = r.doc)}
				onstaged={(r) => {
					doc = r.doc;
					pending = { revisionId: r.revisionId, label: r.label };
				}}
			/>
		{/if}

		<footer>
			<a class="skip" href="/score/{data.score.id}/melody">Back to the melody</a>
			<a class="skip" href="/score/{data.score.id}/bench">Open in Bench</a>
			<!-- Not while a control's result is unresolved: continuing would leave a
			     staged revision behind for the next stage to trip over. -->
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
		cursor: pointer;
		font: inherit;
		color: var(--fg-dim);
		text-align: left;
	}
	.part.written {
		color: var(--fg);
	}
	/* The tune is the thing being arranged around, not one of the parts being
	   written, so it reads differently from the ones this stage is filling in. */
	.part.melody {
		color: var(--fg);
		border-left: 2px solid var(--accent);
		border-radius: 0 var(--radius) var(--radius) 0;
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
	}
	.tag {
		font-size: var(--text-xs);
		color: var(--fg-dim);
	}
	.tag.warn {
		color: var(--warn, var(--accent));
	}

	.issues {
		gap: var(--space-1);
	}
	.issue {
		font-size: var(--text-xs);
		color: var(--fg-dim);
		border-left: 2px solid var(--border);
		padding-left: var(--space-2);
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
