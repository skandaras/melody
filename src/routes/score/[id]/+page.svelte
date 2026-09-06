<script lang="ts">
	import { untrack } from 'svelte';
	import AiPanel from '$lib/components/AiPanel.svelte';
	import AudioInput from '$lib/components/AudioInput.svelte';
	import ClipPanel from '$lib/components/ClipPanel.svelte';
	import ControlRack from '$lib/components/ControlRack.svelte';
	import ExportMenu from '$lib/components/ExportMenu.svelte';
	import HistoryPanel from '$lib/components/HistoryPanel.svelte';
	import NotePalette, { type NoteEntry } from '$lib/components/NotePalette.svelte';
	import ScoreCanvas from '$lib/components/ScoreCanvas.svelte';
	import Mixer from '$lib/components/Mixer.svelte';
	import Transport from '$lib/components/Transport.svelte';
	import { PlayerStore } from '$lib/audio/player.svelte';
	import { ScoreSession } from '$lib/editor/session.svelte';
	import { analyse } from '$lib/score/analyse';
	import { secondsToTick, tempoAt } from '$lib/score/measures';
	import type { Op } from '$lib/score/apply';
	import type { Position } from '$lib/render/locate';
	import type { Score } from '$lib/score/types';
	import type { PageServerData } from './$types';

	let { data }: { data: PageServerData } = $props();

	// The document, the selection and the write path all live in one store now,
	// shared with Bench — two routes editing the same score must not grow two
	// copies of this state, or the single write path stops being single.
	// untrack() makes the "initial value only" explicit: every edit round-trips
	// through /ops and comes back as a fresh document, so re-deriving from
	// `data` would fight the write path.
	// svelte-ignore state_referenced_locally
	const session = new ScoreSession(untrack(() => data));

	let scale = $state(1);

	// SvelteKit reuses this component across /score/A → /score/B, so the session
	// has to be re-pointed on navigation or the previous score's notes would be
	// rendered — and then saved — under the new score's id.
	$effect(() => {
		if (session.isStale(data)) session.reseed(data);
	});

	// Read-only views, so the markup below reads the same as it did before the
	// state moved out.
	const score = $derived(session.doc);
	const selected = $derived(session.selected);
	const revisions = $derived(session.revisions);
	const pendingDiff = $derived(session.pending);
	const busy = $derived(session.busy);
	const error = $derived(session.error);

	// One synth per editor page, shared by the transport and the mixer: the
	// AudioContext, the worklet and the soundfont are far too expensive to hold
	// per component. Constructed eagerly rather than inside an effect — nothing
	// here touches an AudioContext until the first play, so it is safe during
	// SSR, and the mixer is the parts panel, which should render server-side.
	// Audio settings arrive with the page load and never change without a
	// reload, so capturing them once is deliberate.
	// svelte-ignore state_referenced_locally
	const player = new PlayerStore(() => data.soundfontUrl, {
		masterVolume: data.audio.masterVolume,
		renderSampleRate: data.audio.renderSampleRate
	});
	$effect(() => () => player.destroy());

	$effect(() => {
		// Any edit makes the loaded sequence stale.
		void score;
		player.invalidate();
	});

	const summary = $derived(analyse(score));

	/**
	 * Where playback has reached, in ticks.
	 *
	 * Null unless something is actually sounding: a line parked at the start of
	 * a stopped score reads as a stuck playhead rather than an idle one. The
	 * transport reports seconds, the notation is laid out in ticks, and
	 * secondsToTick walks the tempo map between them — so a piece that changes
	 * tempo stays in sync instead of drifting from the change onward.
	 */
	const playheadTick = $derived(
		player.transport.playing ? secondsToTick(score, player.transport.position) : null
	);

	/**
	 * Tell the atmosphere layer that something is sounding, and how fast.
	 *
	 * Deliberately derived from a boolean and a number rather than read off
	 * `player.transport` inside the effect: the store replaces that object on
	 * every animation frame, so an effect depending on it would rewrite these
	 * attributes sixty times a second. Depending on the derived values instead
	 * means it runs only when playback actually starts or stops.
	 *
	 * The breathing itself is a CSS animation the compositor owns; this only
	 * starts and stops it. Published on the document element rather than passed
	 * down, because the fog lives in the root layout, which has no view of this
	 * page's player.
	 */
	const playing = $derived(player.transport.playing);
	/** The opening tempo, not the tempo under the playhead — following a tempo
	 *  map would mean recomputing this mid-playback for a background effect. */
	const openingBpm = $derived(tempoAt(score, 0).bpm);

	$effect(() => {
		const root = document.documentElement;
		if (!playing) {
			delete root.dataset.playing;
			return;
		}
		root.style.setProperty('--bpm', String(openingBpm));
		root.dataset.playing = '';
		return () => delete root.dataset.playing;
	});
	const selectionCount = $derived(session.selectionCount);

	/** What the AI and controls act on: explicit notes, else the whole score. */
	const selection = $derived(session.selection);

	const onselect = (ids: string[], additive: boolean) => session.select(ids, additive);

	let mode = $state<'select' | 'add'>('select');
	let entry = $state<NoteEntry>({
		duration: 480,
		dotted: false,
		grid: 16,
		triplets: false,
		rest: false,
		accidental: 0
	});

	/**
	 * Place a note where the pointer landed.
	 *
	 * Goes through insert_notes like everything else, so undo, revisions and the
	 * diff review all apply without a second write path.
	 */
	async function placeNote(position: Position) {
		const dur = entry.dotted ? Math.round(entry.duration * 1.5) : entry.duration;
		// An empty pitch list is how insert_notes writes a rest.
		const pitches = entry.rest
			? []
			: [Math.max(0, Math.min(127, position.midi + entry.accidental))];

		await runOps(
			[
				{
					op: 'insert_notes',
					args: {
						partId: position.partId,
						notes: [{ tick: position.tick, dur, pitches }]
					}
				} as Op
			],
			entry.rest ? 'Added a rest' : 'Added a note'
		);
	}

	/**
	 * Commit a drag.
	 *
	 * Goes through the same write path as every other edit, so a dragged note
	 * lands in the revision history and can be undone like anything else. The
	 * operations themselves are worked out in `render/drag.ts`, which is pure
	 * and tested — the direction of "up" and the clamp that stops a selection
	 * collapsing onto tick 0 are both easy to get silently wrong.
	 */
	async function dragNotes(ops: Op[]) {
		if (!ops.length || busy) return;
		await runOps(ops, ops.length > 1 ? 'Moved notes' : 'Moved a note');
	}

	const runOps = (ops: Op[], label: string, source: 'user' | 'control' = 'user') =>
		session.runOps(ops, label, source);
	const resolvePending = (action: 'accept' | 'reject') => session.resolvePending(action);
	const restore = (revisionId: string) => session.restore(revisionId);
	const saveTitle = () => session.saveTitle();

	async function addPart() {
		await runOps(
			[{ op: 'add_part', args: { name: 'Piano', instrument: 'Acoustic Grand Piano' } }],
			'Added a part'
		);
	}

	/** Both a transcription and a clip carry rests and ties, which insert_notes
	 *  cannot express, so both go in through the merge path and land staged for
	 *  the existing accept/reject review. */
	const acceptTranscription = (fragment: Score, label: string) =>
		session.merge(fragment, `Transcribed ${label}`);
	const insertClip = (fragment: Score, label: string) =>
		session.merge(fragment, `Inserted ${label}`);

	async function removePart(partId: string) {
		const part = score.parts.find((p) => p.id === partId);
		if (!part) return;
		if (!confirm(`Remove "${part.name}" and its notes?`)) return;
		await runOps([{ op: 'remove_part', args: { partId } }], `Removed ${part.name}`);
	}

	async function deleteSelected() {
		if (!selected.size) return;
		await runOps([{ op: 'delete_notes', args: { noteIds: [...selected] } }], 'Deleted notes');
		session.clearSelection();
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
			session.clearSelection();
		} else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') {
			e.preventDefault();
			// The second-newest revision is the state one step back, whatever
			// created the newest one. Restore is append-only, so pressing it
			// again steps forward again — undo and redo in one operation.
			if (revisions.length >= 2) void restore(revisions[1].id);
		}
	}

</script>

<svelte:head><title>{session.title} · melody</title></svelte:head>
<svelte:window {onkeydown} />

<div class="editor">
	<aside class="left">
		<input class="title" bind:value={session.title} onblur={saveTitle} aria-label="Score title" />

		<section>
			<h2>Audio in</h2>
			<AudioInput
				ontranscribed={acceptTranscription}
				disabled={busy}
				settings={data.transcribe}
				countInBars={data.audio.countInBars}
				recordingUrl={data.recordingUrl}
			/>
		</section>

		<section>
			<h2>Parts &amp; mix</h2>
			<Mixer {score} {player} {busy} oncommit={runOps} onremove={removePart} />
			<button class="btn" onclick={addPart} disabled={busy}>Add part</button>
		</section>

		<section>
			<h2>Library</h2>
			<ClipPanel
				scoreId={data.score.id}
				{score}
				{selection}
				{selectionCount}
				{busy}
				oninsert={insertClip}
			/>
		</section>

		<section>
			<h2>History</h2>
			<HistoryPanel {revisions} {busy} onrestore={restore} />
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
			<NotePalette
				{mode}
				{entry}
				ppq={score.ppq}
				disabled={busy}
				onmode={(m) => (mode = m)}
				onentry={(e) => (entry = e)}
			/>
			<span class="sel">
				{#if mode === 'add'}
					Click the stave to place a note
				{:else}
					{selectionCount ? `${selectionCount} selected` : 'Nothing selected — edits apply to all'}
				{/if}
			</span>
			<div class="spacer"></div>
			<!-- The manual surface. A link rather than a mode, because Bench is a
			     different set of tools rather than a different state of these
			     ones — and once the stages exist it is reached from them. -->
			<a class="btn bench" href="/score/{data.score.id}/bench">Bench</a>
			<ExportMenu {score} soundfontUrl={data.soundfontUrl} renderSampleRate={data.audio.renderSampleRate} />
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
			<ScoreCanvas
				{score}
				{selected}
				{scale}
				{mode}
				{entry}
				{playheadTick}
				{busy}
				diff={pendingDiff}
				{onselect}
				onplace={placeNote}
				ondrag={dragNotes}
			/>
		</div>

		<Transport {score} {player} soundfontUrl={data.soundfontUrl} renderSampleRate={data.audio.renderSampleRate} />
	</main>

	<aside class="right">
		<section>
			<h2>Ask</h2>
			<AiPanel
				scoreId={data.score.id}
				{selection}
				{selectionCount}
				{busy}
				onresult={(r) =>
					session.adopt(r.doc, { ...r.diff, revisionId: r.revisionId, label: r.label })}
			/>
		</section>

		<h2>Controls</h2>
		<ControlRack
			scoreId={data.score.id}
			controls={data.controls}
			{selection}
			{busy}
			onapplied={(r) => session.adopt(r.doc, null)}
			onstaged={(r) =>
				session.adopt(r.doc, { ...r.diff, revisionId: r.revisionId, label: r.label })}
		/>
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
	.btn.bench {
		text-decoration: none;
		display: inline-flex;
		align-items: center;
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
