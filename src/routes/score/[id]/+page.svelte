<script lang="ts">
	import { untrack } from 'svelte';
	import ScoreCanvas from '$lib/components/ScoreCanvas.svelte';
	import Mixer from '$lib/components/Mixer.svelte';
	import Transport from '$lib/components/Transport.svelte';
	import { PlayerStore } from '$lib/audio/player.svelte';
	import { analyse } from '$lib/score/analyse';
	import type { Op } from '$lib/score/apply';
	import type { Score, Selection } from '$lib/score/types';
	import type { PageServerData } from './$types';

	let { data }: { data: PageServerData } = $props();

	// Seeded from the load, then owned locally — every edit round-trips through
	// /ops and comes back as a fresh document, so re-deriving from `data` would
	// fight the write path. untrack() makes the "initial value only" explicit.
	let score = $state<Score>(untrack(() => data.score.doc));
	let title = $state(untrack(() => data.score.title));
	let loadedId = untrack(() => data.score.id);
	let selected = $state<Set<string>>(new Set());
	let pendingDiff = $state<{
		added: string[];
		removed: string[];
		changed: string[];
		revisionId: string;
		label: string;
	} | null>(null);

	let busy = $state(false);
	let error = $state('');
	let scale = $state(1);

	// SvelteKit reuses this component across /score/A → /score/B, so local state
	// has to be re-seeded on navigation or the previous score's notes would be
	// rendered — and then saved — under the new score's id.
	$effect(() => {
		if (data.score.id === loadedId) return;
		loadedId = data.score.id;
		score = data.score.doc;
		title = data.score.title;
		selected = new Set();
		pendingDiff = null;
		error = '';
	});

	// One synth per editor page, shared by the transport and the mixer: the
	// AudioContext, the worklet and the soundfont are far too expensive to hold
	// per component. Constructed eagerly rather than inside an effect — nothing
	// here touches an AudioContext until the first play, so it is safe during
	// SSR, and the mixer is the parts panel, which should render server-side.
	const player = new PlayerStore(() => data.soundfontUrl);
	$effect(() => () => player.destroy());

	$effect(() => {
		// Any edit makes the loaded sequence stale.
		void score;
		player.invalidate();
	});

	const summary = $derived(analyse(score));
	const selectionCount = $derived(selected.size);

	/** What the AI and controls act on: explicit notes, else the whole score. */
	const selection = $derived<Selection>(selected.size ? { noteIds: [...selected] } : {});

	function onselect(ids: string[], additive: boolean) {
		if (!additive) {
			selected = new Set(ids);
			return;
		}
		const next = new Set(selected);
		for (const id of ids) {
			if (next.has(id)) next.delete(id);
			else next.add(id);
		}
		selected = next;
	}

	async function post(path: string, body: unknown) {
		const res = await fetch(path, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(body)
		});
		if (!res.ok) throw new Error((await res.text()) || res.statusText);
		return res.json();
	}

	/** Apply operations through the one write path, so undo and diff work. */
	async function runOps(ops: Op[], label: string, source: 'user' | 'control' = 'user') {
		busy = true;
		error = '';
		try {
			const r = await post(`/api/scores/${data.score.id}/ops`, { ops, label, source });
			score = r.doc;
			if (r.errors?.length) error = r.errors.map((e: { reason: string }) => e.reason).join('; ');
		} catch (e) {
			error = e instanceof Error ? e.message : String(e);
		} finally {
			busy = false;
		}
	}

	async function resolvePending(action: 'accept' | 'reject') {
		if (!pendingDiff) return;
		busy = true;
		try {
			const r = await post(`/api/scores/${data.score.id}/revisions`, {
				action,
				revisionId: pendingDiff.revisionId
			});
			score = r.doc;
			pendingDiff = null;
			selected = new Set();
		} catch (e) {
			error = e instanceof Error ? e.message : String(e);
		} finally {
			busy = false;
		}
	}

	async function saveTitle() {
		await fetch(`/api/scores/${data.score.id}`, {
			method: 'PATCH',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ title })
		});
	}

	async function addPart() {
		await runOps(
			[{ op: 'add_part', args: { name: 'Piano', instrument: 'Acoustic Grand Piano' } }],
			'Added a part'
		);
	}

	async function removePart(partId: string) {
		const part = score.parts.find((p) => p.id === partId);
		if (!part) return;
		if (!confirm(`Remove "${part.name}" and its notes?`)) return;
		await runOps([{ op: 'remove_part', args: { partId } }], `Removed ${part.name}`);
	}

	async function deleteSelected() {
		if (!selected.size) return;
		await runOps([{ op: 'delete_notes', args: { noteIds: [...selected] } }], 'Deleted notes');
		selected = new Set();
	}

	async function nudge(semitones: number) {
		if (!selected.size) return;
		await runOps([{ op: 'transpose', args: { selection, semitones } }], `Transposed ${semitones}`);
	}

	function onkeydown(e: KeyboardEvent) {
		const target = e.target as HTMLElement;
		if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA') return;

		if (e.key === 'Backspace' || e.key === 'Delete') {
			e.preventDefault();
			void deleteSelected();
		} else if (e.key === 'ArrowUp' && selected.size) {
			e.preventDefault();
			void nudge(e.shiftKey ? 12 : 1);
		} else if (e.key === 'ArrowDown' && selected.size) {
			e.preventDefault();
			void nudge(e.shiftKey ? -12 : -1);
		} else if (e.key === 'Escape') {
			selected = new Set();
		}
	}

	const byCategory = $derived.by(() => {
		const map = new Map<string, typeof data.controls>();
		for (const c of data.controls) {
			const list = map.get(c.category) ?? [];
			list.push(c);
			map.set(c.category, list);
		}
		return [...map.entries()];
	});
</script>

<svelte:head><title>{title} · melody</title></svelte:head>
<svelte:window {onkeydown} />

<div class="editor">
	<aside class="left">
		<input class="title" bind:value={title} onblur={saveTitle} aria-label="Score title" />

		<section>
			<h2>Parts &amp; mix</h2>
			<Mixer {score} {player} {busy} oncommit={runOps} onremove={removePart} />
			<button class="btn" onclick={addPart} disabled={busy}>Add part</button>
		</section>

		<section>
			<h2>Analysis</h2>
			<dl class="facts">
				<dt>Key</dt>
				<dd>{summary.key.name}</dd>
				<dt>Tempo</dt>
				<dd>{summary.tempoBpm} bpm</dd>
				<dt>Metre</dt>
				<dd>{summary.timeSig}</dd>
				<dt>Bars</dt>
				<dd>{summary.barCount}</dd>
				<dt>Notes</dt>
				<dd>{summary.totalNotes}</dd>
			</dl>
		</section>
	</aside>

	<main class="centre">
		<div class="toolbar">
			<span class="sel">
				{selectionCount ? `${selectionCount} selected` : 'Nothing selected — edits apply to all'}
			</span>
			<div class="spacer"></div>
			<button class="btn" onclick={() => (scale = Math.max(0.5, scale - 0.1))} aria-label="Zoom out"
				>−</button
			>
			<span class="zoom">{Math.round(scale * 100)}%</span>
			<button class="btn" onclick={() => (scale = Math.min(2, scale + 0.1))} aria-label="Zoom in"
				>+</button
			>
		</div>

		{#if error}
			<p class="banner">{error}</p>
		{/if}

		{#if pendingDiff}
			<div class="review">
				<span>
					<strong>{pendingDiff.label}</strong>
					— {pendingDiff.added.length} added, {pendingDiff.changed.length} changed,
					{pendingDiff.removed.length} removed
				</span>
				<button class="btn" onclick={() => resolvePending('reject')} disabled={busy}>Reject</button>
				<button class="btn primary" onclick={() => resolvePending('accept')} disabled={busy}>
					Accept
				</button>
			</div>
		{/if}

		<div class="scroll">
			<ScoreCanvas {score} {selected} {scale} diff={pendingDiff} {onselect} />
		</div>

		<Transport {score} {player} soundfontUrl={data.soundfontUrl} />
	</main>

	<aside class="right">
		<h2>Controls</h2>
		<p class="hint">
			Deterministic controls run instantly and free. Prompt and agent controls call the model.
		</p>

		{#each byCategory as [category, list] (category)}
			<section>
				<h3>{category}</h3>
				<ul class="controls">
					{#each list as control (control.id)}
						<li>
							<button class="control" title={control.description} disabled={busy}>
								<span class="icon" aria-hidden="true">{control.icon ?? '·'}</span>
								<span class="cname">{control.name}</span>
								<span class="kind kind-{control.kind}">
									{control.kind === 'code' ? 'free' : control.kind}
								</span>
							</button>
						</li>
					{/each}
				</ul>
			</section>
		{/each}
	</aside>
</div>

<style>
	.editor {
		display: grid;
		grid-template-columns: 220px 1fr 260px;
		height: 100vh;
		overflow: hidden;
	}

	aside {
		background: var(--bg-pane);
		border-right: 1px solid var(--border);
		padding: var(--space-4);
		overflow-y: auto;
		display: flex;
		flex-direction: column;
		gap: var(--space-6);
	}
	aside.right {
		border-right: none;
		border-left: 1px solid var(--border);
	}

	h2 {
		font-size: var(--text-xs);
		letter-spacing: 0.14em;
		text-transform: uppercase;
		color: var(--fg-dim);
		margin-bottom: var(--space-2);
	}
	h3 {
		font-size: var(--text-xs);
		color: var(--fg-dim);
		margin-bottom: var(--space-1);
	}

	.title {
		width: 100%;
		background: transparent;
		border: 1px solid transparent;
		color: var(--fg);
		font-size: var(--text-lg);
		font-weight: 600;
		padding: var(--space-1) var(--space-2);
	}
	.title:hover,
	.title:focus {
		border-color: var(--border);
		outline: none;
	}

	.hint {
		color: var(--fg-dim);
		font-size: var(--text-xs);
		margin: 0 0 var(--space-2);
		line-height: 1.45;
	}

	.facts {
		display: grid;
		grid-template-columns: auto 1fr;
		gap: var(--space-1) var(--space-3);
		margin: 0;
		font-size: var(--text-sm);
	}
	.facts dt {
		color: var(--fg-dim);
	}
	.facts dd {
		margin: 0;
	}

	.centre {
		display: flex;
		flex-direction: column;
		min-width: 0;
		background: var(--bg);
	}
	.toolbar {
		display: flex;
		align-items: center;
		gap: var(--space-2);
		padding: var(--space-2) var(--space-4);
		border-bottom: 1px solid var(--border);
		font-size: var(--text-xs);
		color: var(--fg-dim);
	}
	.spacer {
		flex: 1;
	}
	.zoom {
		min-width: 3.2em;
		text-align: center;
	}

	.scroll {
		flex: 1;
		overflow: auto;
		padding: var(--space-4);
	}

	.banner {
		margin: var(--space-3) var(--space-4) 0;
		padding: var(--space-2) var(--space-3);
		background: var(--bg-pane);
		border-left: 3px solid var(--danger);
		color: var(--danger);
		font-size: var(--text-sm);
		border-radius: var(--radius);
	}

	.review {
		display: flex;
		align-items: center;
		gap: var(--space-2);
		margin: var(--space-3) var(--space-4) 0;
		padding: var(--space-2) var(--space-3);
		background: var(--bg-pane);
		border: 1px solid var(--diff-change);
		border-radius: var(--radius);
		font-size: var(--text-sm);
	}
	.review span {
		flex: 1;
	}

	.btn {
		background: var(--border);
		color: var(--fg);
		border: none;
		padding: var(--space-1) var(--space-3);
		cursor: pointer;
		font-size: var(--text-sm);
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

	.controls {
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		flex-direction: column;
		gap: 2px;
	}
	.control {
		width: 100%;
		display: flex;
		align-items: center;
		gap: var(--space-2);
		background: none;
		border: 1px solid transparent;
		color: var(--fg);
		padding: var(--space-1) var(--space-2);
		text-align: left;
		cursor: pointer;
		font-size: var(--text-sm);
	}
	.control:hover:not(:disabled) {
		background: var(--bg-raise);
		border-color: var(--border);
	}
	.icon {
		width: 1.2em;
		color: var(--accent);
		text-align: center;
	}
	.cname {
		flex: 1;
	}
	.kind {
		font-size: 0.62rem;
		text-transform: uppercase;
		letter-spacing: 0.06em;
		color: var(--fg-dim);
	}
	/* Free controls are visually distinct because that is the single most
	   useful thing to know before clicking one. */
	.kind-code {
		color: var(--diff-add);
	}

	@media (max-width: 1000px) {
		.editor {
			grid-template-columns: 1fr;
			grid-template-rows: auto 1fr auto;
			height: auto;
			min-height: 100vh;
		}
		aside {
			border: none;
			border-bottom: 1px solid var(--border);
		}
		aside.right {
			border-left: none;
			border-top: 1px solid var(--border);
		}
	}
</style>
