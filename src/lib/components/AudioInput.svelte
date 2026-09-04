<script lang="ts">
	import RunProgress from './RunProgress.svelte';
	import { Run } from '$lib/runs/run.svelte';
	import { playCountIn, Recorder, decodeToMono, normalise, peakLevel, type CountIn } from '$lib/audio/capture';
	import { detectNotesInWorker } from '$lib/audio/transcribe-client';
	import { notesToScore } from '$lib/audio/transcribe';
	import { PPQ, type Score } from '$lib/score/types';

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
		/** Where a kept take can be uploaded to, when retention says keep. */
		recordingUrl?: string;
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
		recordingUrl = undefined,
		settings = {
			noteThreshold: 0.3,
			onsetThreshold: 0.5,
			minNoteMs: 70,
			quantiseGrid: 16,
			autoCleanup: false
		},
		countInBars = 0
	}: Props = $props();

	type Stage = 'idle' | 'counting' | 'recording' | 'decoding' | 'detecting' | 'saving';

	let stage = $state<Stage>('idle');

	/**
	 * Transcription reported as a run, the same shape an AI turn uses.
	 *
	 * Not a job — this is a Web Worker on this machine — but a person waiting on
	 * it wants the same answers, so it drives the same state and is rendered by
	 * the same component. It owns the abort signal and the slow-run watchdog
	 * that used to live here.
	 */
	const run = new Run();
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
	let countIn: CountIn | null = null;
	/** The AudioContext the count-in clicks run through, so cancel can close it. */
	let countInCtx: AudioContext | null = null;
	let fileInput: HTMLInputElement | null = $state(null);

	const busy = $derived(stage !== 'idle' && stage !== 'recording');
	const bpm = $derived.by(() => {
		const n = Number(bpmText.trim());
		return Number.isFinite(n) && n >= 20 && n <= 400 ? n : undefined;
	});

	// The admin grid is a default, not a rule: it seeds the selector and the
	// user's own choice then wins until the settings object changes (a
	// navigation), mirroring how the score page re-seeds from its load.
	$effect(() => {
		// Stored in ticks per grid unit; the selector works in denominators.
		grid = settings.quantiseGrid > 0 ? Math.round((PPQ * 4) / settings.quantiseGrid) : 16;
	});

	// Leaving the page mid-count-in must not leave clicks ringing and a
	// microphone about to open for a component that no longer exists.
	$effect(() => () => cancel());

	async function startRecording() {
		error = '';
		hint = '';
		try {
			if (countInBars > 0) {
				// Creating the AudioContext inside this click handler is what
				// unlocks it — there is no second user gesture coming.
				stage = 'counting';
				countInCtx = new AudioContext();
				countIn = playCountIn(countInBars, bpm ?? 120, countInCtx, beginCapture);
				return;
			}
			await beginCapture();
		} catch (e) {
			recorder = null;
			countInCtx?.close();
			countInCtx = null;
			stage = 'idle';
			error =
				e instanceof DOMException && e.name === 'NotAllowedError'
					? 'Microphone access was refused. Allow it in your browser settings, or drop an audio file instead.'
					: e instanceof Error
						? e.message
						: 'Could not start recording.';
		}
	}

	/** Opens the microphone once the count-in clicks have landed — or at once
	 *  when there is none. Kept separate so both paths share the error mapping. */
	async function beginCapture() {
		countIn = null;
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
		} finally {
			countInCtx?.close();
			countInCtx = null;
			if (stage !== 'recording') stage = 'idle';
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
		countIn?.cancel();
		countIn = null;
		countInCtx?.close();
		countInCtx = null;
		recorder?.cancel();
		recorder = null;
		void run.cancel();
		run.reset();
		stage = 'idle';
	}

	function clearTimer() {
		if (timer) clearInterval(timer);
		timer = null;
	}

	async function transcribe(source: Blob | File, label: string) {
		error = '';
		hint = '';
		const signal = run.startLocal();
		// Declared up front so the bar has an honest denominator rather than a
		// spinner — the same contract an AI turn now announces.
		run.push({
			type: 'plan',
			data: {
				phases: [
					{ id: 'decoding', label: 'Reading audio…' },
					{ id: 'detecting', label: 'Finding notes…' },
					{ id: 'saving', label: 'Saving…' }
				]
			}
		});
		try {
			stage = 'decoding';
			run.push({ type: 'phase', data: { id: 'decoding', label: 'Reading audio…' } });
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
			run.push({ type: 'phase', data: { id: 'detecting', label: 'Finding notes…' } });
			const notes = await detectNotesInWorker(normalise(decoded.samples), {
				signal,
				// Admin-configured detector thresholds. The model works in frames of
				// roughly 11ms, so the shortest-kept-note setting converts here
				// rather than leaking audio internals into the settings table.
				onsetThreshold: settings.onsetThreshold,
				frameThreshold: settings.noteThreshold,
				minNoteFrames: Math.max(1, Math.round(settings.minNoteMs / 11)),
				onProgress: (p) => {
					if (p.phase === 'model') {
						run.push({ type: 'status', data: { message: 'Loading the detection model…' } });
						return;
					}
					run.push({ type: 'fraction', data: { value: p.fraction } });
					run.push({
						type: 'status',
						data: {
							message: p.windows > 1 ? `Finding notes — ${p.window} of ${p.windows}` : 'Finding notes…'
						}
					});
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
			run.push({ type: 'phase', data: { id: 'saving', label: 'Saving…' } });
			await ontranscribed(score, label);
			await uploadRecording(source);

			hint = bpm
				? `${noteCount} notes at ${tempo.bpm} bpm.`
				: `${noteCount} notes, tempo detected as ${tempo.bpm} bpm` +
					`${tempo.confidence < 0.7 ? ' (unsure — try typing the tempo)' : ''}.`;
		} catch (e) {
			if (!(e instanceof DOMException && e.name === 'AbortError')) {
				error = e instanceof Error ? e.message : String(e);
			}
		} finally {
			// The outcome is carried by `hint` or `error`, which say something
			// specific about the take; the run only ever reported progress, so it
			// goes back to idle and renders nothing.
			run.reset();
			stage = 'idle';
		}
	}

	/**
	 * Keep the take, when retention says so.
	 *
	 * Uploaded after the transcription has landed, and best-effort: a failed
	 * upload must not read as a failed transcription, since the notes are
	 * already saved.
	 */
	async function uploadRecording(source: Blob | File) {
		if (!recordingUrl) return;
		try {
			const form = new FormData();
			form.append('file', source);
			const res = await fetch(recordingUrl, { method: 'POST', body: form });
			if (!res.ok) throw new Error(await res.text());
		} catch (e) {
			hint = `${hint} (take not kept: ${e instanceof Error ? e.message : 'upload failed'})`;
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
		counting: 'Count-in…',
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
		{:else if stage === 'counting'}
			<span class="elapsed">Count-in…</span>
			<button class="btn" onclick={cancel}>Cancel</button>
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

	<RunProgress
		state={run.state}
		oncancel={cancel}
		idleLabel={stageLabel[stage] || 'Working…'}
		slowNote="Still going. Your browser may be running the detector without GPU acceleration, which is much slower — a long take can take several minutes."
	/>

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
