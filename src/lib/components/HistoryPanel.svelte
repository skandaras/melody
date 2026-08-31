<script lang="ts">
	/**
	 * Revision history and undo.
	 *
	 * Restores are append-only on the server — restoring is itself a revision —
	 * so this panel needs no undo/redo bookkeeping of its own: clicking an
	 * older entry moves to it, and Ctrl+Z (which restores the second-newest
	 * revision) steps back, and steps forward again if pressed once more.
	 */

	interface RevisionRow {
		id: string;
		seq: number;
		source: string;
		label: string;
		accepted: boolean;
		createdAt: number;
	}

	interface Props {
		revisions: RevisionRow[];
		busy: boolean;
		onrestore: (revisionId: string) => void | Promise<void>;
	}
	let { revisions, busy, onrestore }: Props = $props();

	// The second-newest snapshot is the state one step back, whatever created
	// the newest one — so undo is the same operation as restoring history[1],
	// and pressing it again is a redo, for free.
	const undoable = $derived(revisions.length >= 2);

	const fmt = (ts: number) =>
		new Date(ts).toLocaleString(undefined, {
			month: 'short',
			day: 'numeric',
			hour: '2-digit',
			minute: '2-digit'
		});
</script>

<p class="hint">
	Every edit is kept. Restore any point — a restore is itself undoable, and Ctrl+Z steps back one
	change.
</p>

<div class="row">
	<button
		class="btn"
		onclick={() => void onrestore(revisions[1].id)}
		disabled={busy || !undoable}
		title="Restore the previous state"
	>
		Undo
	</button>
	<span class="hint">{revisions.length} kept</span>
</div>

<ul class="history">
	{#each revisions as r, i (r.id)}
		<li>
			<span class="seq">#{r.seq}</span>
			<span class="what" title={r.label}>
				{r.label || 'Untitled change'}
				{#if !r.accepted}<span class="tag">pending</span>{/if}
			</span>
			<span class="meta">{r.source} · {fmt(r.createdAt)}</span>
			{#if i > 0}
				<button class="btn small" disabled={busy} onclick={() => void onrestore(r.id)}>
					Restore
				</button>
			{:else}
				<span class="now">current</span>
			{/if}
		</li>
	{/each}
</ul>

<style>
	.hint {
		margin: 0 0 var(--space-2);
		font-size: var(--text-xs);
		color: var(--fg-dim);
		line-height: 1.45;
	}
	.row {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: var(--space-2);
		margin-bottom: var(--space-2);
	}
	.history {
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		flex-direction: column;
		gap: 2px;
		max-height: 18rem;
		overflow-y: auto;
	}
	li {
		display: flex;
		align-items: center;
		gap: var(--space-1);
		font-size: var(--text-xs);
		padding: 2px var(--space-1);
		border-radius: var(--radius);
	}
	li:hover {
		background: var(--bg-raise);
	}
	.seq {
		color: var(--fg-dim);
		font-variant-numeric: tabular-nums;
		flex: none;
	}
	.what {
		flex: 1;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.tag {
		font-size: 0.6rem;
		text-transform: uppercase;
		color: var(--diff-change);
		margin-left: 4px;
	}
	.meta {
		color: var(--fg-dim);
		flex: none;
	}
	.now {
		color: var(--diff-add);
		flex: none;
		font-size: 0.6rem;
		text-transform: uppercase;
		letter-spacing: 0.06em;
	}
	.btn {
		background: var(--border);
		color: var(--fg);
		border: none;
		padding: var(--space-1) var(--space-2);
		cursor: pointer;
		font-size: var(--text-xs);
		border-radius: var(--radius);
	}
	.btn:disabled {
		opacity: 0.5;
		cursor: default;
	}
</style>
