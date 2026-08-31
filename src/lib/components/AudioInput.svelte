<script lang="ts">
	import { Recorder, decodeToMono, normalise, peakLevel } from '$lib/audio/capture';
	import { detectNotesInWorker } from '$lib/audio/transcribe-client';
	import { notesToScore } from '$lib/audio/transcribe';
	import type { Score } from '$lib/score/types';

	/**
	 * Sing, play or drop a file; get notation.
	 *
	 * The whole pipeline is local to the browser, and the draft it produces is
	 * playable and editable before any model is called — so this works with no
	 * API key, no network, and on a server that could not afford to run
	 * inference itself.
	 */

	interface Props {
		/** Receives the finished fragment. Resolves once it has been saved. */
		ontranscribed: (fragment: Score, label: string) => Promise<void>;
		disabled?: boolean;
		/** Detection thresholds and auto-cleanup, from Admin → Transcription. */
		settings?: {
			noteThreshold: number;
			onsetThreshold: number;
			minNoteMs: number;
			quantiseGrid: number;
			autoCleanup: boolean
		};
		/** Admin-configured count-in, in bars. 0 disables the metronome. */
		countInBars?: number;
	}
	let {
		ontranscribed,
		disabled = false,
		settings = {
			noteThreshold: 0.3,
			onsetThreshold: 0.5,
			minNoteMs: 70,
			quantiseGrid: 16,
			autoCleanup: false
		},
		countInBars = 0
	}: Props = $props();

	type Stage = 'idle' | 'recording' | 'decoding' | 'detecting' | 'saving';

	let stage = $state<Stage>('idle');
	let progress = $state(0);
	/** What the detector is doing, when it is more specific than the stage. */
	let detail = $state('');
	/** Set when a run passes the point where it should plainly have finished. */
	let slow = $state(false);
	let error = $state('');
	let hint = $state('');
	let elapsed = $state(0);
	let dragging = $state(false);

	// Settings the user can reach without opening a panel, because these three
	// are the ones that actually change the result.
	let bpmText = $state('');
	let grid = $state(16);
	let triplets = $state(false);

	let recorder: Recorder | null = null;
	let timer: ReturnType<typeof setInterval> | null = null;
	let watchdog: ReturnType<typeof setTimeout> | null = null;
	let controller: AbortController | null = null;
	let countIn: CountIn | null = null;
	let fileInput: HTMLInputElement | null = $state(null);

	/**
	 * How long a run may go without finishing before we admit something is off.
	 *
	 * Inference is seconds when WebGL is available and minutes when the worker
	 * silently falls back to CPU. The user cannot tell those apart from a frozen
	 * bar, so say so rather than letting them guess.
	 */
	const SLOW_AFTER_MS = 45_000;

	const busy = $derived(stage !== 'idle' && stage !== 'recording');
	const bpm = $derived.by(() => {
		const n = Number(bpmText.trim());
		return Number.isFinite(n) && n >= 20 && n <= 400 ? n : undefined;
	});

	async function startRecording() {
		error = '';
		hint = '';
		try {
			recorder = new Recorder();
			await recorder.start();
			stage = 'recording';
			elapsed = 0;
			timer = setInterval(() => (elapsed += 0.1), 100);
		} catch (e) {
			recorder = null;
			error =
				e instanceof DOMException && e.name === 'NotAllowedError'
					? 'Microphone access was refused. Allow it in your browser settings, or drop an audio file instead.'
					: e instanceof Error
						? e.message
						: 'Could not start recording.';
		}
	}

	async function stopRecording() {
		if (!recorder) return;
		clearTimer();
		try {
			const { blob } = await recorder.stop();
			recorder = null;
			await transcribe(blob, 'Recording');
		} catch (e) {
			recorder = null;
			stage = 'idle';
			error = e instanceof Error ? e.message : 'Recording failed.';
		}
	}

	function cancel() {
		clearTimer();
		if (watchdog) clearTimeout(watchdog);
		watchdog = null;
		recorder?.cancel();
		recorder = null;
		controller?.abort();
		controller = null;
		stage = 'idle';
		progress = 0;
		detail = '';
		slow = false;
	}

	function clearTimer() {
		if (timer) clearInterval(timer);
		timer = null;
	}

	async function transcribe(source: Blob | File, label: string) {
		error = '';
		hint = '';
		progress = 0;
		controller = new AbortController();
		try {
			stage = 'decoding';
			const decoded = await decodeToMono(source);
			if (decoded.durationSeconds < 0.4) {
				throw new Error('That is too short to transcribe — try at least a couple of seconds.');
			}
			// A silent take produces a confident-looking empty result, which reads
			// as a bug. Say what actually happened instead.
			if (peakLevel(decoded.samples) < 0.002) {
				throw new Error('That audio is silent. Check the right input device is selected.');
			}

			stage = 'detecting';
			watchdog = setTimeout(() => (slow = true), SLOW_AFTER_MS);
			const notes = await detectNotesInWorker(normalise(decoded.samples), {
				signal: controller.signal,
				onProgress: (p) => {
					if (p.phase === 'model') {
						detail = 'Loading the detection model…';
						return;
					}
					progress = p.fraction;
					detail = p.windows > 1 ? `${p.window} of ${p.windows}` : '';
				}
			});

			if (notes.length === 0) {
				throw new Error(
					'No notes were detected. Humming or a single instrument works best — a full mix rarely does.'
				);
			}

			const { score, tempo, noteCount } = notesToScore(notes, {
				title: label,
				partName: label,
				bpm,
				preferBpm: bpm,
				grid,
				triplets
			});

			stage = 'saving';
			await ontranscribed(score, label);

			hint = bpm
				? `${noteCount} notes at ${tempo.bpm} bpm.`
				: `${noteCount} notes, tempo detected as ${tempo.bpm} bpm` +
					`${tempo.confidence < 0.7 ? ' (unsure — try typing the tempo)' : ''}.`;
		} catch (e) {
			if (!(e instanceof DOMException && e.name === 'AbortError')) {
				error = e instanceof Error ? e.message : String(e);
			}
		} finally {
			if (watchdog) clearTimeout(watchdog);
			watchdog = null;
			controller = null;
			stage = 'idle';
			progress = 0;
			detail = '';
			slow = false;
		}
	}

	function onfiles(files: FileList | null) {
		const file = files?.[0];
		if (file) void transcribe(file, file.name.replace(/\.[^.]+$/, ''));
	}

	function ondrop(e: DragEvent) {
		e.preventDefault();
		dragging = false;
		if (!disabled && !busy) onfiles(e.dataTransfer?.files ?? null);
	}

	const fmt = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

	const stageLabel: Record<Stage, string> = {
		idle: '',
		recording: 'Recording',
		decoding: 'Reading audio…',
		detecting: 'Finding notes…',
		saving: 'Saving…'
	};
</script>

<div
	class="audio-in"
	class:dragging
	role="region"
	aria-label="Audio input"
	ondragover={(e) => {
		e.preventDefault();
		dragging = true;
	}}
	ondragleave={() => (dragging = false)}
	{ondrop}
>
	<div class="row">
		{#if stage === 'recording'}
			<button class="btn rec on" onclick={stopRecording}>■ Stop</button>
			<span class="elapsed">{fmt(elapsed)}</span>
			<button class="btn" onclick={cancel}>Discard</button>
		{:else}
			<button class="btn rec" onclick={startRecording} disabled={disabled || busy}>● Record</button>
			<button class="btn" onclick={() => fileInput?.click()} disabled={disabled || busy}>
				Add file
			</button>
			{#if busy}
				<button class="btn" onclick={cancel}>Cancel</button>
			{/if}
		{/if}
	</div>

	<input
		bind:this={fileInput}
		class="hidden-input"
		type="file"
		accept="audio/*"
		onchange={(e) => {
			onfiles(e.currentTarget.files);
			e.currentTarget.value = '';
		}}
	/>

	{#if busy}
		<div class="status">
			<span>{detail || stageLabel[stage]}</span>
			{#if stage === 'detecting'}
				<progress max="1" value={progress}></progress>
				<span class="pct">{Math.round(progress * 100)}%</span>
			{/if}
		</div>
		{#if slow}
			<p class="msg dim">
				Still going. Your browser may be running the detector without GPU
				acceleration, which is much slower — a long take can take several minutes.
			</p>
		{/if}
	{/if}

	<div class="row settings">
		<label>
			<span>Tempo</span>
			<input
				type="text"
				inputmode="numeric"
				placeholder="auto"
				bind:value={bpmText}
				disabled={busy}
				aria-label="Tempo in beats per minute, blank to detect"
			/>
		</label>
		<label>
			<span>Grid</span>
			<select bind:value={grid} disabled={busy} aria-label="Quantisation grid">
				<option value={4}>1/4</option>
				<option value={8}>1/8</option>
				<option value={16}>1/16</option>
				<option value={32}>1/32</option>
			</select>
		</label>
		<label class="check">
			<input type="checkbox" bind:checked={triplets} disabled={busy} />
			<span>Triplets</span>
		</label>
	</div>

	{#if error}
		<p class="msg err">{error}</p>
	{:else if hint}
		<p class="msg">{hint}</p>
	{:else}
		<p class="msg dim">Sing, hum or play — or drop an audio file here.</p>
	{/if}
</div>

<style>
	.audio-in {
		display: flex;
		flex-direction: column;
		gap: var(--space-2);
		padding: var(--space-2);
		border: 1px dashed var(--border);
		border-radius: var(--radius);
	}
	.dragging {
		border-color: var(--accent);
		background: var(--bg-raise);
	}
	.row {
		display: flex;
		align-items: center;
		gap: var(--space-1);
		flex-wrap: wrap;
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
	.rec.on {
		background: var(--danger);
		color: var(--bg);
		font-weight: 600;
	}
	.elapsed {
		font-variant-numeric: tabular-nums;
		font-size: var(--text-xs);
		flex: 1;
	}
	.hidden-input {
		display: none;
	}
	.status {
		display: flex;
		align-items: center;
		gap: var(--space-2);
		font-size: var(--text-xs);
		color: var(--fg-dim);
	}
	progress {
		flex: 1;
		height: 4px;
		accent-color: var(--accent);
	}
	.pct {
		font-variant-numeric: tabular-nums;
		flex: none;
	}
	.settings {
		font-size: var(--text-xs);
		color: var(--fg-dim);
	}
	.settings label {
		display: flex;
		align-items: center;
		gap: 4px;
	}
	.settings input[type='text'] {
		width: 3.6em;
	}
	.settings input[type='text'],
	.settings select {
		background: var(--bg);
		color: var(--fg);
		border: 1px solid var(--border);
		font-size: var(--text-xs);
		padding: 2px 4px;
		border-radius: var(--radius);
	}
	.check {
		cursor: pointer;
	}
	.msg {
		margin: 0;
		font-size: var(--text-xs);
		line-height: 1.4;
	}
	.dim {
		color: var(--fg-dim);
	}
	.err {
		color: var(--danger);
	}
</style>
