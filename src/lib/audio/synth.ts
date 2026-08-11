import { scoreToMidiBuffer, scoreDurationSeconds, type MidiOptions } from '$lib/export/midi';
import type { Score } from '$lib/score/types';

/**
 * Playback and audio export.
 *
 * Both go through the same Score → MIDI serialiser, because SpessaSynth's
 * sequencer and its offline renderer both consume a parsed MIDI sequence
 * rather than live note calls. That is a happy constraint: what you hear and
 * what you export are the same bytes, so they cannot disagree.
 *
 * Everything here is browser-only and dynamically imported. The modules touch
 * AudioContext at import time, so a static import would break SSR.
 */

export interface TransportState {
	ready: boolean;
	loading: boolean;
	playing: boolean;
	/** Seconds. */
	position: number;
	duration: number;
	error: string | null;
}

type Listener = (state: TransportState) => void;

/**
 * One synth per page, created lazily.
 *
 * Browsers refuse to start an AudioContext before a user gesture, so
 * construction is deferred until the first play() rather than done on mount —
 * otherwise every page load logs a console warning and the context sits
 * suspended.
 */
export class Player {
	private ctx: AudioContext | null = null;
	private synth: unknown = null;
	private sequencer: unknown = null;
	private soundfont: ArrayBuffer | null = null;
	private listeners = new Set<Listener>();
	private raf: number | null = null;
	/** A thunk, not a string: the soundfont is an admin setting, so it must be
	 *  read when it is fetched rather than captured when the player is built. */
	private soundfontUrl: () => string;

	state: TransportState = {
		ready: false,
		loading: false,
		playing: false,
		position: 0,
		duration: 0,
		error: null
	};

	constructor(soundfontUrl: () => string) {
		this.soundfontUrl = soundfontUrl;
	}

	subscribe(fn: Listener): () => void {
		this.listeners.add(fn);
		fn(this.state);
		return () => this.listeners.delete(fn);
	}

	private emit(patch: Partial<TransportState>) {
		this.state = { ...this.state, ...patch };
		for (const fn of this.listeners) fn(this.state);
	}

	/**
	 * Boot the audio graph. Safe to call repeatedly; only the first does work.
	 * Must be called from a user gesture.
	 */
	async init(): Promise<void> {
		if (this.synth || this.state.loading) return;
		this.emit({ loading: true, error: null });

		try {
			const [{ WorkletSynthesizer, Sequencer }] = await Promise.all([
				import('spessasynth_lib')
			]);

			const ctx = new AudioContext();
			// The worklet is fetched by URL, so it has to be a real static file
			// rather than a bundled module — see scripts/setup-assets.mjs.
			await ctx.audioWorklet.addModule('/spessasynth_processor.min.js');

			const synth = new WorkletSynthesizer(ctx);
			await synth.isReady;

			const sf = await this.loadSoundfont();
			await synth.soundBankManager.addSoundBank(sf, 'main');
			synth.connect(ctx.destination);

			this.ctx = ctx;
			this.synth = synth;
			this.sequencer = new Sequencer(synth);
			this.emit({ ready: true, loading: false });
		} catch (err) {
			this.emit({
				loading: false,
				ready: false,
				error: err instanceof Error ? err.message : String(err)
			});
			throw err;
		}
	}

	private async loadSoundfont(): Promise<ArrayBuffer> {
		if (this.soundfont) return this.soundfont;
		const url = this.soundfontUrl();
		const res = await fetch(url);
		if (!res.ok) {
			throw new Error(
				`Could not load the soundfont from ${url} (${res.status}). ` +
					`Run "npm run assets" to install it.`
			);
		}
		this.soundfont = await res.arrayBuffer();
		return this.soundfont;
	}

	/** Load a score for playback. Replaces whatever was loaded before. */
	async load(score: Score, opts?: MidiOptions): Promise<void> {
		await this.init();
		const seq = this.sequencer as {
			loadNewSongList: (m: ArrayBuffer[]) => void;
			pause: () => void;
		};
		seq.loadNewSongList([scoreToMidiBuffer(score, opts)]);
		seq.pause();
		this.emit({ playing: false, position: 0, duration: scoreDurationSeconds(score) });
	}

	async play(): Promise<void> {
		await this.init();
		await this.ctx?.resume();
		(this.sequencer as { play: () => void }).play();
		this.emit({ playing: true });
		this.track();
	}

	pause(): void {
		(this.sequencer as { pause?: () => void } | null)?.pause?.();
		this.emit({ playing: false });
		this.stopTracking();
	}

	stop(): void {
		this.pause();
		this.seek(0);
		this.emit({ position: 0 });
	}

	seek(seconds: number): void {
		const seq = this.sequencer as { currentTime: number } | null;
		if (seq) seq.currentTime = Math.max(0, seconds);
		this.emit({ position: Math.max(0, seconds) });
	}

	/** Live mixer: 0..1 per MIDI channel, applied as CC7. */
	setChannelVolume(channel: number, volume: number): void {
		const synth = this.synth as {
			controllerChange?: (ch: number, cc: number, v: number) => void;
		} | null;
		synth?.controllerChange?.(channel, 7, Math.round(Math.max(0, Math.min(1, volume)) * 127));
	}

	private track() {
		this.stopTracking();
		const tick = () => {
			const seq = this.sequencer as { currentTime: number; paused: boolean } | null;
			if (!seq) return;
			// The sequencer stops on its own at the end of the song; reflect
			// that rather than leaving the UI showing "playing" forever.
			if (seq.paused) {
				this.emit({ playing: false, position: seq.currentTime });
				this.raf = null;
				return;
			}
			this.emit({ position: seq.currentTime });
			this.raf = requestAnimationFrame(tick);
		};
		this.raf = requestAnimationFrame(tick);
	}

	private stopTracking() {
		if (this.raf !== null) cancelAnimationFrame(this.raf);
		this.raf = null;
	}

	destroy(): void {
		this.stopTracking();
		(this.synth as { destroy?: () => void } | null)?.destroy?.();
		void this.ctx?.close();
		this.ctx = null;
		this.synth = null;
		this.sequencer = null;
		this.listeners.clear();
	}
}

/**
 * Render a score to a WAV blob without playing it.
 *
 * Uses an OfflineAudioContext, so it runs faster than real time and needs no
 * user gesture. A fresh synth is built for the render rather than reusing the
 * live one — SpessaSynth's offline mode wants to be configured immediately
 * after construction and before anything else touches it.
 */
export async function renderScoreToWav(
	score: Score,
	soundfontUrl: string,
	opts: { sampleRate?: number; onProgress?: (fraction: number) => void } = {}
): Promise<Blob> {
	const { WorkletSynthesizer, audioBufferToWav } = await import('spessasynth_lib');
	const { BasicMIDI } = await import('spessasynth_core');

	const sampleRate = opts.sampleRate ?? 44100;
	const duration = scoreDurationSeconds(score);
	if (duration <= 0) throw new Error('Nothing to render — the score is empty.');

	// A tail so the last note's release isn't clipped.
	const seconds = duration + 2;
	const ctx = new OfflineAudioContext(2, Math.ceil(seconds * sampleRate), sampleRate);
	await ctx.audioWorklet.addModule('/spessasynth_processor.min.js');

	const synth = new WorkletSynthesizer(ctx);
	synth.connect(ctx.destination);

	const res = await fetch(soundfontUrl);
	if (!res.ok) throw new Error(`Could not load the soundfont (${res.status})`);
	const soundBankBuffer = await res.arrayBuffer();

	await synth.startOfflineRender({
		midiSequence: BasicMIDI.fromArrayBuffer(scoreToMidiBuffer(score)),
		loopCount: 0,
		soundBankList: [{ bankOffset: 0, soundBankBuffer }]
	});

	opts.onProgress?.(0.1);
	const rendered = await ctx.startRendering();
	opts.onProgress?.(1);

	return audioBufferToWav(rendered);
}
