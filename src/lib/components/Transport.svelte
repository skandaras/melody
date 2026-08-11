<script lang="ts">
	import { renderScoreToWav } from '$lib/audio/synth';
	import type { PlayerStore } from '$lib/audio/player.svelte';
	import { downloadBlob, safeFilename } from '$lib/export/download';
	import { scoreToMidiBlob } from '$lib/export/midi';
	import type { Score } from '$lib/score/types';

	interface Props {
		score: Score;
		player: PlayerStore;
		soundfontUrl: string;
	}
	let { score, player, soundfontUrl }: Props = $props();

	const t = $derived(player.transport);
	const max = $derived(Math.max(t.duration, 0.001));

	let rendering = $state(false);
	let exportError = $state('');

	const fmt = (s: number) => {
		if (!Number.isFinite(s) || s < 0) s = 0;
		const m = Math.floor(s / 60);
		return `${m}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
	};

	function exportMidi() {
		exportError = '';
		try {
			downloadBlob(scoreToMidiBlob(score), safeFilename(score.title, 'mid'));
		} catch (e) {
			exportError = e instanceof Error ? e.message : String(e);
		}
	}

	async function exportWav() {
		// Rendering runs on an OfflineAudioContext, so it is faster than real
		// time and needs no user gesture — but a long piece is still seconds of
		// work, hence the busy state.
		rendering = true;
		exportError = '';
		try {
			const blob = await renderScoreToWav(score, soundfontUrl);
			downloadBlob(blob, safeFilename(score.title, 'wav'));
		} catch (e) {
			exportError = e instanceof Error ? e.message : String(e);
		} finally {
			rendering = false;
		}
	}
</script>

<div class="transport">
	<button
		class="play"
		onclick={() => player.toggle(score)}
		disabled={t.loading}
		aria-label={t.playing ? 'Pause' : 'Play'}
	>
		{t.loading ? '…' : t.playing ? '❚❚' : '▶'}
	</button>
	<button class="btn" onclick={() => player.stop()} disabled={!t.ready} aria-label="Stop">■</button>

	<span class="time">{fmt(t.position)}</span>
	<input
		class="scrub"
		type="range"
		min="0"
		{max}
		step="0.01"
		value={Math.min(t.position, max)}
		oninput={(e) => player.seek(Number(e.currentTarget.value))}
		disabled={!t.ready}
		aria-label="Playback position"
	/>
	<span class="time dim">{fmt(t.duration)}</span>

	<button class="btn" onclick={exportMidi} title="Download a standard MIDI file">MIDI</button>
	<button class="btn" onclick={exportWav} disabled={rendering} title="Render and download audio">
		{rendering ? 'rendering…' : 'WAV'}
	</button>

	{#if exportError}
		<span class="err" title={exportError}>export failed</span>
	{:else if t.error}
		<span class="err" title={t.error}>audio unavailable</span>
	{:else if t.loading}
		<span class="hint">loading instruments…</span>
	{/if}
</div>

<style>
	.transport {
		display: flex;
		align-items: center;
		gap: var(--space-2);
		padding: var(--space-2) var(--space-4);
		border-top: 1px solid var(--border);
		background: var(--bg-pane);
		font-size: var(--text-xs);
	}
	.play,
	.btn {
		background: var(--border);
		color: var(--fg);
		border: none;
		cursor: pointer;
		padding: var(--space-1) var(--space-3);
		min-width: 2.4em;
	}
	.play {
		background: var(--accent);
		color: var(--bg);
		font-weight: 600;
	}
	.play:disabled,
	.btn:disabled {
		opacity: 0.5;
		cursor: default;
	}
	.time {
		font-variant-numeric: tabular-nums;
		min-width: 3em;
	}
	.dim {
		color: var(--fg-dim);
	}
	.scrub {
		flex: 1;
		min-width: 6rem;
		accent-color: var(--accent);
	}
	.hint {
		color: var(--fg-dim);
	}
	.err {
		color: var(--danger);
		cursor: help;
	}
</style>
