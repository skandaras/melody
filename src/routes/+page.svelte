<script lang="ts">
	import { goto, invalidateAll } from '$app/navigation';
	import type { PageServerData } from './$types';

	let { data }: { data: PageServerData } = $props();

	let creating = $state(false);
	let error = $state('');

	async function create() {
		creating = true;
		error = '';
		try {
			const res = await fetch('/api/scores', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ title: 'Untitled' })
			});
			if (!res.ok) throw new Error(await res.text());
			const { id } = await res.json();
			await goto(`/score/${id}`);
		} catch (e) {
			error = e instanceof Error ? e.message : String(e);
			creating = false;
		}
	}

	async function remove(id: string, title: string) {
		if (!confirm(`Delete "${title}"? This cannot be undone.`)) return;
		await fetch(`/api/scores/${id}`, { method: 'DELETE' });
		await invalidateAll();
	}

	const when = (ms: number) => {
		const mins = Math.round((Date.now() - ms) / 60000);
		if (mins < 1) return 'just now';
		if (mins < 60) return `${mins}m ago`;
		if (mins < 1440) return `${Math.round(mins / 60)}h ago`;
		return new Date(ms).toLocaleDateString();
	};
</script>

<svelte:head><title>Scores · melody</title></svelte:head>

<header class="head">
	<h1>Scores</h1>
	<button class="btn primary" onclick={create} disabled={creating}>
		{creating ? 'Creating…' : 'New score'}
	</button>
</header>

{#if error}
	<p class="banner">{error}</p>
{/if}

{#if data.scores.length === 0}
	<div class="empty">
		<p class="lead">Nothing here yet.</p>
		<p>
			Start a score, then hum, play or drop in a recording — melody will transcribe it into
			notation you can edit and shape.
		</p>
	</div>
{:else}
	<ul class="list">
		{#each data.scores as score (score.id)}
			<li>
				<a class="row" href="/score/{score.id}">
					<span class="title">{score.title}</span>
					<span class="meta">{when(score.updatedAt)}</span>
				</a>
				<button
					class="del"
					onclick={() => remove(score.id, score.title)}
					aria-label="Delete {score.title}">×</button
				>
			</li>
		{/each}
	</ul>
{/if}

<style>
	.head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: var(--space-4);
		margin-bottom: var(--space-6);
	}
	h1 {
		font-size: var(--text-xl);
	}

	.btn {
		background: var(--border);
		color: var(--fg);
		border: none;
		padding: var(--space-2) var(--space-4);
		cursor: pointer;
	}
	.btn.primary {
		background: var(--accent);
		color: var(--bg);
		font-weight: 600;
	}
	.btn:disabled {
		opacity: 0.6;
		cursor: default;
	}

	.banner {
		background: var(--bg-pane);
		border-left: 3px solid var(--danger);
		color: var(--danger);
		padding: var(--space-3);
		border-radius: var(--radius);
	}

	.empty {
		max-width: 32rem;
		color: var(--fg-dim);
	}
	.lead {
		color: var(--fg);
		font-size: var(--text-lg);
		margin-bottom: var(--space-2);
	}

	.list {
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		flex-direction: column;
		gap: var(--space-1);
		max-width: 46rem;
	}
	.list li {
		display: flex;
		align-items: stretch;
		gap: var(--space-1);
	}
	.row {
		flex: 1;
		display: flex;
		align-items: baseline;
		justify-content: space-between;
		gap: var(--space-4);
		padding: var(--space-3) var(--space-4);
		background: var(--bg-pane);
		border: 1px solid var(--border);
		border-radius: var(--radius);
		color: var(--fg);
		text-decoration: none;
	}
	.row:hover {
		border-color: var(--accent);
	}
	.title {
		font-weight: 500;
	}
	.meta {
		color: var(--fg-dim);
		font-size: var(--text-xs);
		white-space: nowrap;
	}

	.del {
		background: none;
		border: 1px solid transparent;
		color: var(--fg-dim);
		cursor: pointer;
		padding: 0 var(--space-3);
		/* Dimmed rather than hidden: destructive, but it should be findable. */
		opacity: 0.45;
	}
	.del:hover,
	.del:focus-visible {
		opacity: 1;
		color: var(--danger);
		border-color: var(--danger);
	}
	/* No hover on touch, so leave it at full strength there. */
	@media (hover: none) {
		.del {
			opacity: 1;
		}
	}
</style>
