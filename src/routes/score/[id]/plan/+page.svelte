<script lang="ts">
	import { goto } from '$app/navigation';
	import { untrack } from 'svelte';
	import RunProgress from '$lib/components/RunProgress.svelte';
	import { Run } from '$lib/runs/run.svelte';
	import { estimateSeconds, formatDuration, MAX_ENSEMBLE } from '$lib/pipeline/plan';
	import { emptyPlan, isPlanUsable, type Plan, type PlanSection } from '$lib/pipeline/types';
	import type { PageServerData } from './$types';

	/**
	 * Stage two: the blueprint, before a single note.
	 *
	 * Cards rather than prose, because the point of the stage is that this is
	 * *editable*. Everything the model proposes is a starting value in a field
	 * the user can overwrite, and approving is the only thing on the page that
	 * touches the score.
	 */

	let { data }: { data: PageServerData } = $props();

	const run = new Run();
	// Navigating away otherwise leaves the stream open, as every other page
	// holding a Run already knows.
	$effect(() => () => run.destroy());

	// Seeded once. Re-deriving from the load would discard an in-progress edit
	// every time anything else invalidated the page.
	let plan = $state<Plan>(untrack(() => data.pipeline.plan ?? emptyPlan()));
	let busy = $state(false);
	let error = $state('');
	let saved = $state(false);

	const brief = $derived(data.pipeline.brief);
	const duration = $derived(formatDuration(estimateSeconds(plan)));
	const totalBars = $derived(plan.sections.reduce((n, s) => n + Math.max(1, s.bars), 0));
	const canApprove = $derived(isPlanUsable(plan) && !busy && !run.running);
	const hasPlan = $derived(plan.sections.length > 0);

	/** The seeded part the plan may claim, so a row can say what it stands for. */
	const partName = (id: string | undefined) =>
		id ? (data.parts.find((p) => p.id === id)?.name ?? null) : null;

	async function generate() {
		error = '';
		try {
			const res = await fetch(`/api/scores/${data.score.id}/plan`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ action: 'generate' })
			});
			if (!res.ok) throw new Error((await res.text()) || res.statusText);
			const { jobId } = await res.json();

			run.listen(jobId);
		} catch (e) {
			error = e instanceof Error ? e.message : String(e);
		}
	}

	/**
	 * Adopt a generated plan when the run reports one.
	 *
	 * Reads `run.lastResult` rather than a callback, because the run's own
	 * `onResult` answers "did a turn stage a document", and a plan is not one.
	 */
	$effect(() => {
		const generated = run.lastResult?.plan;
		// Already through `coercePlan` on the way in, and saved to the column
		// before it was emitted — so this is the stored plan, not raw model
		// output. Re-coercing here would need a Score the page does not have.
		if (generated) untrack(() => (plan = generated as Plan));
	});

	async function post(action: 'save' | 'approve') {
		busy = true;
		error = '';
		saved = false;
		try {
			const res = await fetch(`/api/scores/${data.score.id}/plan`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ action, plan })
			});
			if (!res.ok) throw new Error((await res.text()) || res.statusText);
			const body = await res.json();

			if (action === 'approve') {
				// Straight to the bare score route, and the stage table there decides
				// where that lands. Melody has no page yet, so today it falls through
				// to the editor with the blueprint visible as real sections — and when
				// Melody lands, this line needs no change.
				await goto(`/score/${data.score.id}`);
				return;
			}
			plan = body.pipeline.plan ?? plan;
			saved = true;
		} catch (e) {
			error = e instanceof Error ? e.message : String(e);
		} finally {
			busy = false;
		}
	}

	/**
	 * Begin a plan by hand.
	 *
	 * Without this the page tells someone with no model configured that they can
	 * write a plan themselves, and then shows them nothing to write it in — the
	 * editor is all behind `hasPlan`, which only a generated plan could satisfy.
	 */
	function startBlank() {
		plan = {
			...emptyPlan(),
			ensemble: [{ name: 'Piano', instrument: 'Acoustic Grand Piano' }],
			sections: [{ name: 'Verse', bars: 8, harmony: '', role: 'statement' }]
		};
	}

	function addSection() {
		const section: PlanSection = { name: 'New section', bars: 8, harmony: '', role: '' };
		plan = { ...plan, sections: [...plan.sections, section] };
	}

	function updateSection(i: number, patch: Partial<PlanSection>) {
		plan = {
			...plan,
			sections: plan.sections.map((s, n) => (n === i ? { ...s, ...patch } : s))
		};
	}

	function removeSection(i: number) {
		plan = { ...plan, sections: plan.sections.filter((_, n) => n !== i) };
	}

	function moveSection(i: number, by: -1 | 1) {
		const to = i + by;
		if (to < 0 || to >= plan.sections.length) return;
		const sections = [...plan.sections];
		[sections[i], sections[to]] = [sections[to], sections[i]];
		plan = { ...plan, sections };
	}

	function addPart() {
		if (plan.ensemble.length >= MAX_ENSEMBLE) return;
		plan = {
			...plan,
			ensemble: [...plan.ensemble, { name: 'New part', instrument: 'Acoustic Grand Piano' }]
		};
	}

	function updatePart(i: number, patch: { name?: string; instrument?: string }) {
		plan = {
			...plan,
			ensemble: plan.ensemble.map((p, n) => (n === i ? { ...p, ...patch } : p))
		};
	}

	function removePart(i: number) {
		plan = { ...plan, ensemble: plan.ensemble.filter((_, n) => n !== i) };
	}
</script>

<svelte:head><title>Plan · melody</title></svelte:head>

<div class="plan">
	<header>
		<p class="step">Plan</p>
		<h1>The shape of it</h1>
		<p class="lead">
			Key, tempo, instruments and the sections in order. Change anything — nothing is written
			until you approve it.
		</p>
	</header>

	{#if brief?.description}
		<blockquote class="brief">
			{brief.description}
			<a href="/score/{data.score.id}/brief">Edit the brief</a>
		</blockquote>
	{/if}

	<section class="generate">
		<div class="actions">
			{#if data.canGenerate}
				<button class="btn" onclick={generate} disabled={run.running || busy}>
					{hasPlan ? 'Start again from the brief' : 'Draft a plan'}
				</button>
			{/if}
			{#if !hasPlan}
				<button class="btn" onclick={startBlank} disabled={run.running || busy}>
					Write one myself
				</button>
			{/if}
		</div>
		{#if !hasPlan && !data.canGenerate}
			<p class="hint">No model is configured, so a plan cannot be drafted for you.</p>
		{/if}

		{#if run.state.outcome !== 'idle'}
			<RunProgress
				state={run.state}
				oncancel={run.running ? () => run.cancel() : undefined}
				idleLabel="Planning…"
				slowNote="Still planning. This is one call, so it should not take long."
			/>
		{/if}
	</section>

	{#if hasPlan}
		<section class="facts">
			<label class="field wide">
				<span class="label">Title</span>
				<input type="text" value={plan.title} oninput={(e) => (plan = { ...plan, title: e.currentTarget.value })} placeholder="Untitled" />
			</label>

			<label class="field">
				<span class="label">Key</span>
				<div class="pair">
					<input type="text" value={plan.key.tonic} oninput={(e) => (plan = { ...plan, key: { ...plan.key, tonic: e.currentTarget.value } })} placeholder="C" />
					<select value={plan.key.mode} onchange={(e) => (plan = { ...plan, key: { ...plan.key, mode: e.currentTarget.value === 'minor' ? 'minor' : 'major' } })}>
						<option value="major">major</option>
						<option value="minor">minor</option>
					</select>
				</div>
			</label>

			<label class="field">
				<span class="label">Tempo</span>
				<input type="number" min="20" max="300" value={plan.tempoBpm} oninput={(e) => (plan = { ...plan, tempoBpm: Number(e.currentTarget.value) || plan.tempoBpm })} />
			</label>

			<label class="field">
				<span class="label">Metre</span>
				<div class="pair">
					<input type="number" min="1" max="32" value={plan.timeSig.num} oninput={(e) => (plan = { ...plan, timeSig: { ...plan.timeSig, num: Number(e.currentTarget.value) || plan.timeSig.num } })} />
					<select value={String(plan.timeSig.den)} onchange={(e) => (plan = { ...plan, timeSig: { ...plan.timeSig, den: Number(e.currentTarget.value) } })}>
						{#each [2, 4, 8, 16] as den (den)}
							<option value={String(den)}>/{den}</option>
						{/each}
					</select>
				</div>
			</label>
		</section>

		<section>
			<div class="head">
				<h2>Instruments</h2>
				<button class="link" onclick={addPart} disabled={plan.ensemble.length >= MAX_ENSEMBLE}>
					Add
				</button>
			</div>
			{#if !plan.ensemble.length}
				<p class="hint">No instruments yet. Approving with none leaves the score empty.</p>
			{/if}
			{#each plan.ensemble as part, i (i)}
				<div class="row">
					<input class="grow" type="text" value={part.name} oninput={(e) => updatePart(i, { name: e.currentTarget.value })} placeholder="Staff name" />
					<input class="grow" type="text" value={part.instrument} oninput={(e) => updatePart(i, { instrument: e.currentTarget.value })} placeholder="General MIDI instrument" />
					{#if partName(part.partId)}
						<span class="tag" title="Already in the score — approving will not add it again">
							{partName(part.partId)}
						</span>
					{/if}
					<button class="link danger" onclick={() => removePart(i)} title="Remove this row">×</button>
				</div>
			{/each}
			{#if plan.ensemble.some((p) => p.partId)}
				<p class="hint">
					A tagged row is a part that already exists — the recording you made. Removing the row
					leaves the part in the score; delete it in the editor if you want it gone.
				</p>
			{/if}
		</section>

		<section>
			<div class="head">
				<h2>Sections</h2>
				<span class="hint">{totalBars} bars · about {duration}</span>
				<button class="link" onclick={addSection}>Add</button>
			</div>

			{#each plan.sections as section, i (i)}
				<article class="card">
					<div class="row">
						<input class="grow name" type="text" value={section.name} oninput={(e) => updateSection(i, { name: e.currentTarget.value })} placeholder="Section name" />
						<label class="bars">
							<input type="number" min="1" max="64" value={section.bars} oninput={(e) => updateSection(i, { bars: Number(e.currentTarget.value) || 1 })} />
							<span>bars</span>
						</label>
						<button class="link" onclick={() => moveSection(i, -1)} disabled={i === 0} title="Move up">↑</button>
						<button class="link" onclick={() => moveSection(i, 1)} disabled={i === plan.sections.length - 1} title="Move down">↓</button>
						<button class="link danger" onclick={() => removeSection(i)} title="Remove this section">×</button>
					</div>
					<div class="row">
						<input class="grow" type="text" value={section.harmony} oninput={(e) => updateSection(i, { harmony: e.currentTarget.value })} placeholder="i-VI-III-VII in A minor" />
						<input class="grow" type="text" value={section.role} oninput={(e) => updateSection(i, { role: e.currentTarget.value })} placeholder="statement, contrast, release" />
					</div>
				</article>
			{/each}
		</section>
	{/if}

	{#if error}
		<p class="banner">{error}</p>
	{:else if saved}
		<p class="note">Draft saved.</p>
	{/if}

	<footer>
		<a class="skip" href="/score/{data.score.id}/brief">Back to the brief</a>
		<div class="spacer"></div>
		<button class="btn" onclick={() => post('save')} disabled={!hasPlan || busy}>Save draft</button>
		<button class="btn primary" onclick={() => post('approve')} disabled={!canApprove}>
			{busy ? 'Approving…' : plan.approved ? 'Update and continue' : 'Approve and continue'}
		</button>
	</footer>
</div>

<style>
	.plan {
		max-width: 48rem;
		margin: 0 auto;
		display: flex;
		flex-direction: column;
		gap: var(--space-6);
		padding-bottom: var(--space-8);
	}

	.step {
		font-size: var(--text-xs);
		text-transform: uppercase;
		letter-spacing: 0.08em;
		color: var(--accent);
		margin-bottom: var(--space-2);
	}
	h1 {
		font-size: var(--text-xl);
		margin-bottom: var(--space-2);
	}
	.lead {
		color: var(--fg-dim);
		max-width: 34rem;
	}

	.brief {
		border-left: 2px solid var(--border);
		padding-left: var(--space-3);
		color: var(--fg-dim);
		font-size: var(--text-sm);
		display: flex;
		flex-direction: column;
		gap: var(--space-1);
		align-items: flex-start;
	}
	.brief a {
		color: var(--accent);
		font-size: var(--text-xs);
	}

	section {
		display: flex;
		flex-direction: column;
		gap: var(--space-2);
	}
	.generate {
		align-items: flex-start;
		gap: var(--space-3);
	}
	.actions {
		display: flex;
		gap: var(--space-2);
		flex-wrap: wrap;
	}
	.head {
		display: flex;
		align-items: baseline;
		gap: var(--space-3);
	}
	h2 {
		font-size: var(--text-lg);
	}
	.head .hint {
		flex: 1;
	}
	.hint {
		color: var(--fg-dim);
		font-size: var(--text-sm);
	}

	.facts {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-3);
	}
	.field {
		display: flex;
		flex-direction: column;
		gap: var(--space-1);
		min-width: 0;
	}
	.field.wide {
		flex: 1 1 16rem;
	}
	.label {
		font-size: var(--text-xs);
		color: var(--fg-dim);
	}
	.pair {
		display: flex;
		gap: var(--space-1);
	}
	.pair input {
		width: 4rem;
	}

	input,
	select {
		background: var(--bg-pane);
		color: var(--fg);
		border: 1px solid var(--border);
		border-radius: var(--radius);
		padding: var(--space-2);
		font: inherit;
		min-width: 0;
	}
	input:focus,
	select:focus {
		outline: none;
		border-color: var(--accent);
	}

	.card {
		border: 1px solid var(--border);
		border-radius: var(--radius);
		padding: var(--space-3);
		display: flex;
		flex-direction: column;
		gap: var(--space-2);
		background: var(--bg-pane);
	}
	.row {
		display: flex;
		align-items: center;
		gap: var(--space-2);
		flex-wrap: wrap;
	}
	.grow {
		flex: 1 1 10rem;
	}
	.name {
		font-weight: 600;
	}
	.bars {
		display: flex;
		align-items: center;
		gap: var(--space-1);
		font-size: var(--text-sm);
		color: var(--fg-dim);
	}
	.bars input {
		width: 4.5rem;
	}
	.tag {
		font-size: var(--text-xs);
		color: var(--fg-dim);
		border: 1px solid var(--border);
		border-radius: 999px;
		padding: 0 var(--space-2);
	}

	.link {
		background: none;
		border: none;
		color: var(--accent);
		cursor: pointer;
		font: inherit;
		padding: var(--space-1);
	}
	.link:disabled {
		opacity: 0.4;
		cursor: default;
	}
	.link.danger {
		color: var(--danger);
	}

	.banner {
		background: var(--bg-pane);
		border-left: 3px solid var(--danger);
		color: var(--danger);
		padding: var(--space-3);
		border-radius: var(--radius);
	}
	.note {
		color: var(--fg-dim);
		font-size: var(--text-sm);
	}

	footer {
		display: flex;
		align-items: center;
		gap: var(--space-3);
		border-top: 1px solid var(--border);
		padding-top: var(--space-4);
		flex-wrap: wrap;
	}
	.spacer {
		flex: 1;
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
</style>
