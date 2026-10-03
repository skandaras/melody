<script lang="ts">
	import { goto } from '$app/navigation';
	import { untrack } from 'svelte';
	import ControlRack from '$lib/components/ControlRack.svelte';
	import PendingReview, { type Pending } from '$lib/components/PendingReview.svelte';
	import RunProgress from '$lib/components/RunProgress.svelte';
	import ScoreCanvas from '$lib/components/ScoreCanvas.svelte';
	import Transport from '$lib/components/Transport.svelte';
	import { PlayerStore } from '$lib/audio/player.svelte';
	import { Run } from '$lib/runs/run.svelte';
	import { sectionStates } from '$lib/pipeline/realize';
	import { secondsToTick } from '$lib/score/measures';
	import type { Score } from '$lib/score/types';
	import type { PageServerData } from './$types';

	/**
	 * Stage three: the tune.
	 *
	 * The stage people spend the most time in, so it is shaped for iteration
	 * rather than for a single perfect run — write it, hear it, say what is
	 * wrong with one section, write that one again.
	 */

	let { data }: { data: PageServerData } = $props();

	const run = new Run();
	$effect(() => () => run.destroy());

	// Initial value only. Every run returns a fresh document, and re-deriving
	// from the load would fight that.
	// svelte-ignore state_referenced_locally
	let doc = $state<Score>(untrack(() => data.score.doc));
	let melodyPartId = $state<string | null>(untrack(() => data.melodyPartId));
	let selectedSection = $state<string | null>(null);
	let selected = $state<Set<string>>(new Set());
	let instruction = $state('');
	let error = $state('');
	let busy = $state(false);
	let scale = $state(1);
	// svelte-ignore state_referenced_locally
	let pending = $state<Pending | null>(untrack(() => data.pending));

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
	const sections = $derived(sectionStates(doc, plan, melodyPartId));
	const written = $derived(sections.filter((s) => s.state === 'written').length);
	const allWritten = $derived(sections.length > 0 && written === sections.length);
	const parts = $derived(doc.parts.map((p) => ({ id: p.id, name: p.name })));
	// A staged change blocks every other write: rejecting it would discard
	// anything that landed on top. The server refuses too; this just says so
	// before anyone presses a button.
	const canRun = $derived(data.canGenerate && !run.running && !busy && !pending);
	const selection = $derived(selected.size ? { noteIds: [...selected] } : {});

	/**
	 * The selected section, if it still exists.
	 *
	 * Editing the plan in another tab can delete the section this page is
	 * pointing at, and a stale id would otherwise render as an empty name in
	 * three separate labels.
	 */
	const current = $derived(sections.find((s) => s.sectionId === selectedSection) ?? null);

	/**
	 * Where playback has reached, in ticks.
	 *
	 * Null unless something is sounding — a line parked at the start of a
	 * stopped score reads as a stuck playhead rather than an idle one.
	 */
	const playheadTick = $derived.by(() => {
		const t = player.transport;
		if (!t.playing) return null;
		return secondsToTick(doc, t.position);
	});

	async function post(body: Record<string, unknown>) {
		const res = await fetch(`/api/scores/${data.score.id}/melody`, {
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
	 * No sections means "everything still empty", which is what makes resuming
	 * an interrupted realization the same button as starting one.
	 */
	async function realize(sectionIds?: string[], direction?: string) {
		error = '';
		try {
			const { jobId } = await post({ action: 'realize', sectionIds, instruction: direction });
			run.listen(
				jobId,
				(result) => {
					doc = result.doc as Score;
				},
				// The document after each section, so the notation fills in as it
				// is written rather than all at once at the end.
				(type, payload) => {
					if (type === 'progress' && payload?.doc) doc = payload.doc as Score;
				}
			);
			instruction = '';
		} catch (e) {
			error = e instanceof Error ? e.message : String(e);
		}
	}

	async function chooseMelodyPart(partId: string) {
		melodyPartId = partId;
		try {
			await post({ action: 'melodyPart', partId });
		} catch (e) {
			error = e instanceof Error ? e.message : String(e);
		}
	}

	async function approve() {
		busy = true;
		error = '';
		try {
			await post({ action: 'approve' });
			// Through the bare score route, so the stage table decides where that
			// lands rather than this page.
			await goto(`/score/${data.score.id}`);
		} catch (e) {
			error = e instanceof Error ? e.message : String(e);
			busy = false;
		}
	}

	const sendFeedback = () => {
		const text = instruction.trim();
		if (!text || !current) return;
		realize([current.sectionId], text);
	};
</script>

<svelte:head><title>Melody · melody</title></svelte:head>

<div class="melody">
	<aside class="rail">
		<header>
			<p class="step">Melody</p>
			<h1>{plan.title || 'The tune'}</h1>
			<p class="lead">{written} of {sections.length} sections written.</p>
		</header>

		<section>
			<label class="field">
				<span class="label">The tune goes in</span>
				<select
					value={melodyPartId ?? ''}
					onchange={(e) => chooseMelodyPart(e.currentTarget.value)}
					disabled={run.running}
				>
					{#each parts as part (part.id)}
						<option value={part.id}>{part.name}</option>
					{/each}
				</select>
			</label>
		</section>

		<section class="sections">
			{#each sections as section (section.sectionId)}
				<button
					class="section"
					class:current={selectedSection === section.sectionId}
					class:written={section.state === 'written'}
					onclick={() =>
						(selectedSection = selectedSection === section.sectionId ? null : section.sectionId)}
				>
					<span class="mark">{section.state === 'written' ? '✓' : '·'}</span>
					<span class="name">{section.name}</span>
					<span class="bars">{section.bars} bars</span>
				</button>
			{/each}
		</section>

		{#if data.canGenerate}
			<section class="actions">
				<button class="btn primary" onclick={() => realize()} disabled={!canRun || allWritten}>
					{written === 0 ? 'Write the melody' : 'Write what is left'}
				</button>
				{#if current}
					<button class="btn" onclick={() => realize([current.sectionId])} disabled={!canRun}>
						Rewrite {current.name}
					</button>
				{/if}
			</section>

			<section class="feedback">
				<label class="field">
					<span class="label">
						{current ? `Change ${current.name}` : 'Pick a section to give feedback on'}
					</span>
					<textarea
						bind:value={instruction}
						rows="3"
						placeholder="lift the chorus; make the verse less busy"
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
		{:else}
			<p class="hint">
				No model is configured, so the melody cannot be written for you. You can still write notes
				by hand in Bench.
			</p>
		{/if}

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

		{#if data.controls.length}
			<details class="rack">
				<summary>Controls</summary>
				<ControlRack
					scoreId={data.score.id}
					controls={data.controls}
					{selection}
					busy={run.running || busy || pending !== null}
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

		{#if run.state.outcome !== 'idle'}
			<RunProgress
				state={run.state}
				oncancel={run.running ? () => run.cancel() : undefined}
				idleLabel="Writing…"
				slowNote="Still writing. Each section is its own call, so finished ones are already saved."
			/>
		{/if}

		{#if error}
			<p class="banner">{error}</p>
		{/if}

		<footer>
			<a class="skip" href="/score/{data.score.id}/plan">Back to the plan</a>
			<a class="skip" href="/score/{data.score.id}/bench">Open in Bench</a>
			<button
				class="btn primary"
				onclick={approve}
				disabled={busy || run.running || written === 0 || pending !== null}
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
	.melody {
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
	select,
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
	select:focus,
	textarea:focus {
		outline: none;
		border-color: var(--accent);
	}
	textarea:disabled {
		opacity: 0.5;
	}

	.sections {
		gap: var(--space-1);
	}
	.section {
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
	.section.written {
		color: var(--fg);
	}
	.section.current {
		border-color: var(--accent);
		background: var(--bg-pane);
	}
	.section .mark {
		color: var(--accent);
		width: 1rem;
	}
	.section .name {
		flex: 1;
	}
	.section .bars {
		font-size: var(--text-xs);
	}

	.rack summary {
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
		.melody {
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
