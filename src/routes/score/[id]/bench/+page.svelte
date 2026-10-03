<script lang="ts">
	import { untrack } from 'svelte';
	import ClipPanel from '$lib/components/ClipPanel.svelte';
	import Mixer from '$lib/components/Mixer.svelte';
	import NotePalette, { type NoteEntry } from '$lib/components/NotePalette.svelte';
	import ScoreCanvas from '$lib/components/ScoreCanvas.svelte';
	import Transport from '$lib/components/Transport.svelte';
	import { PlayerStore } from '$lib/audio/player.svelte';
	import { ScoreSession } from '$lib/editor/session.svelte';
	import { secondsToTick } from '$lib/score/measures';
	import type { Op } from '$lib/score/apply';
	import type { Position } from '$lib/render/locate';
	import type { Score } from '$lib/score/types';
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
	 * the two unreviewable. Clips live here too — inserting one is manual.
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
	/** One side panel at a time: the narrow canvas is the thing being edited. */
	let panel = $state<'parts' | 'clips' | null>(null);
	const toggle = (p: 'parts' | 'clips') => (panel = panel === p ? null : p);
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

	/**
	 * Put a saved clip back in, as new parts.
	 *
	 * A clip carries rests and ties, which insert_notes cannot express, so it
	 * goes through the merge path — which stages. It is accepted straight away:
	 * inserting a clip is a deliberate manual edit like any other here, and
	 * leaving it staged would put a change in the review slot that no page is
	 * showing, blocking every stage behind it.
	 */
	async function insertClip(fragment: Score, label: string) {
		const post = async (url: string, body: unknown) => {
			const res = await fetch(url, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify(body)
			});
			if (!res.ok) throw new Error((await res.text()) || res.statusText);
			return res.json();
		};
		const merged = await post(`/api/scores/${data.score.id}/transcribe`, {
			fragment,
			label: `Inserted ${label}`,
			cleanup: false
		});
		await post(`/api/scores/${data.score.id}/revisions`, {
			action: 'accept',
			revisionId: merged.revisionId
		});
		session.adopt(merged.doc as Score, null);
	}

	/**
	 * Remove a part and everything in it.
	 *
	 * Here because it is a manual edit, and the only place left to make it: the
	 * stages never delete a part on their own, so that a dropped plan row cannot
	 * take a hummed recording with it.
	 */
	async function removePart(partId: string) {
		const part = score.parts.find((p) => p.id === partId);
		if (!part || !confirm(`Remove "${part.name}" and its notes?`)) return;
		await session.runOps([{ op: 'remove_part', args: { partId } }], `Removed ${part.name}`);
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

		<button class="btn" class:on={panel === 'parts'} onclick={() => toggle('parts')}>Parts</button>
		<button class="btn" class:on={panel === 'clips'} onclick={() => toggle('clips')}>Clips</button>

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

	<div class="body">
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

	{#if panel === 'parts'}
		<aside class="side">
			<Mixer
				{score}
				{player}
				{busy}
				oncommit={(ops, label) => session.runOps(ops, label)}
				onremove={removePart}
			/>
		</aside>
	{:else if panel === 'clips'}
		<aside class="side">
			<ClipPanel
				scoreId={data.score.id}
				{score}
				selection={session.selection}
				selectionCount={session.selectionCount}
				{busy}
				oninsert={insertClip}
			/>
		</aside>
	{/if}
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

	.body {
		flex: 1;
		display: flex;
		min-height: 0;
	}
	.scroll {
		flex: 1;
		overflow: auto;
		padding: var(--space-4);
		min-width: 0;
	}
	.side {
		width: 16rem;
		flex: 0 0 16rem;
		overflow-y: auto;
		padding: var(--space-4);
		border-left: 1px solid var(--border);
		background: var(--bg-pane);
	}
	.btn.on {
		background: var(--accent);
		color: var(--bg);
	}
</style>
