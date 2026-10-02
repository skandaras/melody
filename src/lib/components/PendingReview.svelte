<script lang="ts" module>
	/** A staged change, as `stagedRevision` reports it. */
	export interface Pending {
		revisionId: string;
		label: string;
		added: number;
		changed: number;
		removed: number;
	}
</script>

<script lang="ts">
	import type { Score } from '$lib/score/types';

	/**
	 * Accept or reject one staged change, on a stage page.
	 *
	 * The editor does this through `ScoreSession`, which also owns history and
	 * selection. A stage page owns neither, so it gets just the review: the same
	 * two calls to the revisions endpoint, and the document that comes back.
	 *
	 * While one of these is showing, the page must not start anything else that
	 * commits. Rejecting restores the revision before the staged one, so any
	 * write that landed on top of it in the meantime would go with it.
	 */

	interface Props {
		scoreId: string;
		pending: Pending;
		/** Where a stage wants accepting to go, if not the plain revisions call. */
		acceptUrl?: string;
		onresolved: (doc: Score, action: 'accept' | 'reject') => void;
	}
	let { scoreId, pending, acceptUrl, onresolved }: Props = $props();

	let busy = $state(false);
	let error = $state('');

	async function resolve(action: 'accept' | 'reject') {
		busy = true;
		error = '';
		try {
			const custom = action === 'accept' && acceptUrl;
			const res = await fetch(custom ? acceptUrl : `/api/scores/${scoreId}/revisions`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify(
					custom
						? { action: 'accept', revisionId: pending.revisionId }
						: { action, revisionId: pending.revisionId }
				)
			});
			if (!res.ok) throw new Error((await res.text()) || res.statusText);
			const body = await res.json();
			onresolved(body.doc as Score, action);
		} catch (e) {
			error = e instanceof Error ? e.message : String(e);
		} finally {
			busy = false;
		}
	}
</script>

<div class="review">
	<p>
		<strong>{pending.label}</strong>
		<span class="counts">
			{pending.added} added, {pending.changed} changed, {pending.removed} removed
		</span>
	</p>
	<div class="buttons">
		<button class="btn" onclick={() => resolve('reject')} disabled={busy}>Reject</button>
		<button class="btn primary" onclick={() => resolve('accept')} disabled={busy}>Accept</button>
	</div>
	{#if error}<p class="err">{error}</p>{/if}
</div>

<style>
	.review {
		display: flex;
		flex-direction: column;
		gap: var(--space-2);
		background: var(--bg-pane);
		border-left: 3px solid var(--accent);
		border-radius: var(--radius);
		padding: var(--space-3);
		font-size: var(--text-sm);
	}
	p {
		margin: 0;
	}
	.counts {
		display: block;
		color: var(--fg-dim);
		font-size: var(--text-xs);
	}
	.buttons {
		display: flex;
		gap: var(--space-2);
		justify-content: flex-end;
	}
	.err {
		color: var(--danger);
		font-size: var(--text-xs);
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
