<script lang="ts">
	import { untrack } from 'svelte';
	import NotePalette, { type NoteEntry } from '$lib/components/NotePalette.svelte';
	import ScoreCanvas from '$lib/components/ScoreCanvas.svelte';
	import Transport from '$lib/components/Transport.svelte';
	import { PlayerStore } from '$lib/audio/player.svelte';
	import { ScoreSession } from '$lib/editor/session.svelte';
	import { secondsToTick } from '$lib/score/measures';
	import type { Op } from '$lib/score/apply';
	import type { Position } from '$lib/render/locate';
	import type { PageServerData } from './$types';

	/**
	 * Bench — fix one note by hand.
	 *
	 * Everything the editor can do *except* ask the model anything. No Ask box,
	 * no control rack, no diff to review. That is the point rather than an
	 * omission: the editor fails not because any one tool is bad but because
	 * thirty are present at once, and a manual surface with five tools that work
	 * perfectly is worth more than one with thirty that mostly do.
	 *
	 * It shares `ScoreSession` with the editor, so an edit made here goes
	 * through the same single write path and lands in the same revision history.
	 * It deliberately never touches `session.pending`: that slot belongs to
	 * staged AI changes, and a manual edit competing for it would leave one of
	 * the two unreviewable.
	 */

	let { data }: { data: PageServerData } = $props();

	// svelte-ignore state_referenced_locally
	const session = new ScoreSession(untrack(() => data));

	$effect(() => {
		if (session.isStale(data)) session.reseed(data);
	});

	// svelte-ignore state_referenced_locally
	const player = new PlayerStore(() => data.soundfontUrl, {
		masterVolume: data.audio.masterVolume,
		renderSampleRate: data.audio.renderSampleRate
	});
	$effect(() => () => player.destroy());

	$effect(() => {
		// Any edit makes the loaded sequence stale.
		void session.doc;
		player.invalidate();
	});

	let scale = $state(1);
	let mode = $state<'select' | 'add'>('select');
	let entry = $state<NoteEntry>({
		duration: 480,
		dotted: false,
		grid: 16,
		triplets: false,
		rest: false,
		accidental: 0
	});

	const score = $derived(session.doc);
	const selected = $derived(session.selected);
	const busy = $derived(session.busy);
	const error = $derived(session.error);

	const playing = $derived(player.transport.playing);
	const playheadTick = $derived(
		playing ? secondsToTick(session.doc, player.transport.position) : null
	);

	async function placeNote(position: Position) {
		const dur = entry.dotted ? Math.round(entry.duration * 1.5) : entry.duration;
		// An empty pitch list is how insert_notes writes a rest.
		const pitches = entry.rest
			? []
			: [Math.max(0, Math.min(127, position.midi + entry.accidental))];

		await session.runOps(
			[
				{
					op: 'insert_notes',
					args: { partId: position.partId, notes: [{ tick: position.tick, dur, pitches }] }
				} as Op
			],
			entry.rest ? 'Added a rest' : 'Added a note'
		);
	}

	async function dragNotes(ops: Op[]) {
		if (!ops.length || session.busy) return;
		await session.runOps(ops, ops.length > 1 ? 'Moved notes' : 'Moved a note');
	}

	async function deleteSelected() {
		if (!selected.size) return;
		await session.runOps(
			[{ op: 'delete_notes', args: { noteIds: [...selected] } }],
			'Deleted notes'
		);
		session.clearSelection();
	}

	async function nudge(semitones: number) {
		if (!selected.size) return;
		await session.runOps(
			[{ op: 'transpose', args: { selection: session.selection, semitones } }],
			`Transposed ${semitones}`
		);
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
			session.clearSelection();
		} else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') {
			e.preventDefault();
			// The second-newest revision is the state one step back, whatever
			// created the newest one. Restore is append-only, so pressing it
			// again steps forward again — undo and redo in one operation.
			if (session.revisions.length >= 2) void session.restore(session.revisions[1].id);
		}
	}
</script>

<svelte:head><title>{session.title} · bench</title></svelte:head>
<svelte:window {onkeydown} />

<div class="bench">
	<div class="toolbar">
		<a class="back" href="/score/{data.score.id}">← {session.title}</a>

		<NotePalette
			{mode}
			{entry}
			ppq={score.ppq}
			disabled={busy}
			onmode={(m) => (mode = m)}
			onentry={(en) => (entry = en)}
		/>

		<span class="sel">
			{#if mode === 'add'}
				Click the stave to place a note
			{:else if selected.size}
				{selected.size} selected — drag to move, arrows to transpose
			{:else}
				Click a note to select it
			{/if}
		</span>

		<div class="spacer"></div>

		<button class="btn" onclick={() => (scale = Math.max(0.5, scale - 0.1))} aria-label="Zoom out">
			−
		</button>
		<span class="zoom">{Math.round(scale * 100)}%</span>
		<button class="btn" onclick={() => (scale = Math.min(2, scale + 0.1))} aria-label="Zoom in">
			+
		</button>
	</div>

	{#if error}
		<p class="banner">{error}</p>
	{/if}

	<div class="scroll">
		<ScoreCanvas
			{score}
			{selected}
			{scale}
			{mode}
			{entry}
			{playheadTick}
			{busy}
			onselect={(ids, additive) => session.select(ids, additive)}
			onplace={placeNote}
			ondrag={dragNotes}
		/>
	</div>

	<Transport
		{score}
		{player}
		soundfontUrl={data.soundfontUrl}
		renderSampleRate={data.audio.renderSampleRate}
	/>
</div>

<style>
	.bench {
		display: flex;
		flex-direction: column;
		height: 100vh;
		overflow: hidden;
	}

	.toolbar {
		display: flex;
		align-items: center;
		gap: var(--space-3);
		padding: var(--space-2) var(--space-4);
		border-bottom: 1px solid var(--border);
		flex-wrap: wrap;
	}
	.back {
		color: var(--fg-dim);
		text-decoration: none;
		font-size: var(--text-sm);
		white-space: nowrap;
		max-width: 16rem;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.back:hover {
		color: var(--accent);
	}
	.sel {
		font-size: var(--text-xs);
		color: var(--fg-dim);
	}
	.spacer {
		flex: 1;
	}
	.zoom {
		font-size: var(--text-xs);
		color: var(--fg-dim);
		font-variant-numeric: tabular-nums;
	}
	.btn {
		background: var(--border);
		color: var(--fg);
		border: none;
		border-radius: var(--radius);
		padding: var(--space-1) var(--space-3);
		cursor: pointer;
	}

	.banner {
		margin: var(--space-3) var(--space-4) 0;
		padding: var(--space-2) var(--space-3);
		background: var(--bg-pane);
		border-left: 3px solid var(--danger);
		color: var(--danger);
		border-radius: var(--radius);
		font-size: var(--text-sm);
	}

	.scroll {
		flex: 1;
		overflow: auto;
		padding: var(--space-4);
	}
</style>
