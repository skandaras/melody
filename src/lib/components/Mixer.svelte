<script lang="ts">
	import type { MixOverrides } from '$lib/audio/mix';
	import type { PlayerStore } from '$lib/audio/player.svelte';
	import type { Op } from '$lib/score/apply';
	import { gmName } from '$lib/score/instruments';
	import { resolveSelection } from '$lib/score/query';
	import type { Part, Score } from '$lib/score/types';

	/**
	 * Per-part mixer.
	 *
	 * Level and mute live in the document (they change what a rendered WAV
	 * sounds like), so they have to be committed through the ops write path like
	 * any other edit. Solo does not — see PlayerStore.
	 *
	 * Committing per pixel of fader travel would put one revision in the undo
	 * history for every mouse move, so changes are held locally, heard
	 * immediately as CC7, and flushed as a single batched op list once the user
	 * stops moving things.
	 */

	interface Props {
		score: Score;
		player: PlayerStore;
		busy: boolean;
		oncommit: (ops: Op[], label: string) => Promise<void>;
		onremove: (partId: string) => void;
	}
	let { score, player, busy, oncommit, onremove }: Props = $props();

	const FLUSH_MS = 600;

	let pending = $state<MixOverrides>({});
	let timer: ReturnType<typeof setTimeout> | null = null;

	const level = (p: Part) => pending[p.id]?.volume ?? p.volume;
	const muted = (p: Part) => pending[p.id]?.muted ?? p.muted;

	function queue(partId: string, patch: { volume?: number; muted?: boolean }) {
		pending = { ...pending, [partId]: { ...pending[partId], ...patch } };
		player.applyMix(score, pending);
		if (timer) clearTimeout(timer);
		timer = setTimeout(() => void flush(), FLUSH_MS);
	}

	async function flush() {
		timer = null;
		const batch = pending;
		const ids = Object.keys(batch);
		if (!ids.length) return;

		await oncommit(
			ids.map((partId) => ({ op: 'set_instrument', args: { partId, ...batch[partId] } })),
			ids.length === 1 ? `Mixed ${name(ids[0])}` : 'Adjusted the mix'
		);

		// Drop only what was actually sent. A fader moved while the request was
		// in flight has a fresh object under its id and must survive.
		const next: MixOverrides = {};
		for (const [id, patch] of Object.entries(pending)) {
			if (patch !== batch[id]) next[id] = patch;
		}
		pending = next;
	}

	const name = (partId: string) => score.parts.find((p) => p.id === partId)?.name ?? 'part';

	$effect(() => {
		// A change landing from anywhere — an AI control, undo, another op —
		// still has to reach the synth.
		void score;
		player.applyMix(score, pending);
	});

	// Don't lose an adjustment made a moment before navigating away.
	$effect(() => () => {
		if (timer) clearTimeout(timer);
		void flush();
	});
</script>

{#if score.parts.length === 0}
	<p class="hint">No parts yet.</p>
{:else}
	<ul class="mixer">
		{#each score.parts as part (part.id)}
			{@const soloed = player.solo.has(part.id)}
			<li class:dimmed={muted(part) || (player.solo.size > 0 && !soloed)}>
				<div class="row">
					<span class="pname" title={gmName(part.gmProgram)}>{part.name}</span>
					<button
						class="tag"
						class:on={muted(part)}
						onclick={() => queue(part.id, { muted: !muted(part) })}
						title="Mute — also excludes this part from exported audio"
						aria-pressed={muted(part)}>M</button
					>
					<button
						class="tag solo"
						class:on={soloed}
						onclick={() => player.toggleSolo(part.id, score)}
						title="Solo — affects listening only, never the export"
						aria-pressed={soloed}>S</button
					>
					<button
						class="tag danger"
						onclick={() => onremove(part.id)}
						disabled={busy}
						title="Remove this part and its notes"
						aria-label="Remove {part.name}">×</button
					>
				</div>
				<div class="row">
					<input
						class="fader"
						type="range"
						min="0"
						max="1"
						step="0.01"
						value={level(part)}
						oninput={(e) => queue(part.id, { volume: Number(e.currentTarget.value) })}
						aria-label="{part.name} level"
					/>
					<span class="meta">{Math.round(level(part) * 100)}</span>
				</div>
				<div class="row">
					<span class="meta grow">{gmName(part.gmProgram)}</span>
					<span class="meta">
						{resolveSelection(score, { partIds: [part.id] }).length} notes
					</span>
				</div>
			</li>
		{/each}
	</ul>
	{#if player.solo.size > 0}
		<button class="clear" onclick={() => player.clearSolo(score)}>Clear solo</button>
	{/if}
{/if}

<style>
	.hint {
		color: var(--fg-dim);
		font-size: var(--text-xs);
		margin: 0 0 var(--space-2);
	}
	.mixer {
		list-style: none;
		margin: 0 0 var(--space-2);
		padding: 0;
		display: flex;
		flex-direction: column;
		gap: var(--space-2);
	}
	.mixer li {
		padding: var(--space-2);
		background: var(--bg-raise);
		border: 1px solid var(--border);
		border-radius: var(--radius);
		display: flex;
		flex-direction: column;
		gap: 2px;
	}
	.dimmed {
		opacity: 0.55;
	}
	.row {
		display: flex;
		align-items: center;
		gap: var(--space-1);
	}
	.pname {
		flex: 1;
		font-size: var(--text-sm);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.meta {
		color: var(--fg-dim);
		font-size: var(--text-xs);
		font-variant-numeric: tabular-nums;
	}
	.grow {
		flex: 1;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.fader {
		flex: 1;
		min-width: 0;
		accent-color: var(--accent);
	}
	.tag {
		background: none;
		border: 1px solid var(--border);
		color: var(--fg-dim);
		font-size: 0.62rem;
		line-height: 1;
		padding: 3px 5px;
		cursor: pointer;
		border-radius: var(--radius);
	}
	.tag.on {
		background: var(--accent);
		border-color: var(--accent);
		color: var(--bg);
	}
	.tag.solo.on {
		background: var(--diff-change);
		border-color: var(--diff-change);
	}
	.tag.danger:hover:not(:disabled) {
		color: var(--danger);
		border-color: var(--danger);
	}
	.tag:disabled {
		opacity: 0.5;
		cursor: default;
	}
	.clear {
		background: none;
		border: 1px solid var(--border);
		color: var(--fg-dim);
		font-size: var(--text-xs);
		padding: var(--space-1) var(--space-2);
		cursor: pointer;
		margin-bottom: var(--space-2);
	}
</style>
