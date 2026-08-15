<script lang="ts">
	import { extractClip } from '$lib/score/extract';
	import type { Score, Selection } from '$lib/score/types';

	/**
	 * Save a selection to the library, or drop a saved clip back in.
	 *
	 * Extraction happens here rather than on the server because the browser
	 * already holds the score — sending a selection up so the server can cut it
	 * out of a document it would have to re-read is a round trip for nothing.
	 */

	interface ClipView {
		id: string;
		name: string;
		bars: number;
		summary: string;
	}

	interface Props {
		scoreId: string;
		score: Score;
		selection: Selection;
		selectionCount: number;
		busy: boolean;
		/** Insert a clip's parts into the current score. */
		oninsert: (fragment: Score, name: string) => Promise<void>;
	}
	let { score, selection, selectionCount, busy, oninsert }: Props = $props();

	let clips = $state<ClipView[]>([]);
	let loaded = $state(false);
	let name = $state('');
	let saving = $state(false);
	let error = $state('');
	let notice = $state('');

	const preview = $derived.by(() => {
		if (!selectionCount) return null;
		const { bars, noteCount } = extractClip(score, selection);
		return noteCount ? { bars, noteCount } : null;
	});

	async function load() {
		if (loaded) return;
		try {
			const res = await fetch('/api/clips');
			if (res.ok) clips = (await res.json()).clips;
			loaded = true;
		} catch {
			// A library that fails to load should not break the editor.
		}
	}
	$effect(() => void load());

	async function save() {
		if (!preview) return;
		saving = true;
		error = '';
		notice = '';
		try {
			const { clip, bars } = extractClip(score, selection, { title: name.trim() || undefined });
			const res = await fetch('/api/clips', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({
					name: name.trim() || `${score.title} excerpt`,
					fragment: clip,
					bars
				})
			});
			if (!res.ok) throw new Error((await res.text()) || res.statusText);
			clips = [(await res.json()).clip, ...clips];
			name = '';
			notice = 'Saved to library.';
		} catch (e) {
			error = e instanceof Error ? e.message : String(e);
		} finally {
			saving = false;
		}
	}

	async function insert(clip: ClipView) {
		error = '';
		try {
			const res = await fetch(`/api/clips/${clip.id}`);
			if (!res.ok) throw new Error((await res.text()) || res.statusText);
			const { clip: full } = await res.json();
			await oninsert(full.fragment, full.name);
		} catch (e) {
			error = e instanceof Error ? e.message : String(e);
		}
	}

	async function remove(clip: ClipView) {
		if (!confirm(`Delete "${clip.name}" from the library?`)) return;
		const res = await fetch(`/api/clips/${clip.id}`, { method: 'DELETE' });
		if (res.ok) clips = clips.filter((c) => c.id !== clip.id);
	}
</script>

<div class="clips">
	{#if preview}
		<div class="save">
			<input
				bind:value={name}
				placeholder="Name this clip…"
				aria-label="Clip name"
				disabled={saving}
			/>
			<button class="btn primary" onclick={save} disabled={saving || busy}>
				{saving ? '…' : `Save ${preview.bars} bar${preview.bars === 1 ? '' : 's'}`}
			</button>
		</div>
	{:else}
		<p class="hint">Select notes to save them as a reusable clip.</p>
	{/if}

	{#if notice}<p class="hint ok">{notice}</p>{/if}
	{#if error}<p class="hint err">{error}</p>{/if}

	{#if clips.length}
		<ul>
			{#each clips as clip (clip.id)}
				<li>
					<button class="insert" onclick={() => insert(clip)} disabled={busy} title="Insert into this score">
						<span class="cname">{clip.name}</span>
						<span class="meta">{clip.summary}</span>
					</button>
					<button class="del" onclick={() => remove(clip)} aria-label="Delete {clip.name}">×</button>
				</li>
			{/each}
		</ul>
	{:else if loaded}
		<p class="hint">Nothing saved yet.</p>
	{/if}
</div>

<style>
	.clips {
		display: flex;
		flex-direction: column;
		gap: var(--space-1);
	}
	.save {
		display: flex;
		gap: var(--space-1);
	}
	input {
		flex: 1;
		min-width: 0;
		background: var(--bg);
		color: var(--fg);
		border: 1px solid var(--border);
		border-radius: var(--radius);
		padding: 2px 4px;
		font-size: var(--text-xs);
	}
	.btn {
		background: var(--border);
		color: var(--fg);
		border: none;
		padding: var(--space-1) var(--space-2);
		cursor: pointer;
		font-size: var(--text-xs);
		border-radius: var(--radius);
		white-space: nowrap;
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
	.hint {
		color: var(--fg-dim);
		font-size: var(--text-xs);
		margin: 0;
		line-height: 1.4;
	}
	.ok {
		color: var(--diff-add);
	}
	.err {
		color: var(--danger);
	}
	ul {
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		flex-direction: column;
		gap: 2px;
	}
	li {
		display: flex;
		align-items: stretch;
		gap: 2px;
	}
	.insert {
		flex: 1;
		min-width: 0;
		display: flex;
		flex-direction: column;
		align-items: flex-start;
		gap: 0;
		background: none;
		border: 1px solid transparent;
		color: var(--fg);
		padding: var(--space-1) var(--space-2);
		text-align: left;
		cursor: pointer;
	}
	.insert:hover:not(:disabled) {
		background: var(--bg-raise);
		border-color: var(--border);
	}
	.insert:disabled {
		opacity: 0.55;
		cursor: default;
	}
	.cname {
		font-size: var(--text-sm);
		max-width: 100%;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.meta {
		font-size: 0.62rem;
		color: var(--fg-dim);
	}
	.del {
		background: none;
		border: none;
		color: var(--fg-dim);
		cursor: pointer;
		padding: 0 var(--space-1);
	}
	.del:hover {
		color: var(--danger);
	}
</style>
