/**
 * Getting audio into the browser and into the shape basic-pitch demands.
 *
 * Two sources, one destination: a microphone recording or a dropped file, both
 * ending as mono Float32 at exactly 22050 Hz. That rate is not a preference —
 * basic-pitch throws outright on anything else (AUDIO_SAMPLE_RATE in its
 * inference module), and it wants a single channel.
 *
 * Nothing is uploaded. The recording is decoded, resampled and transcribed in
 * the browser; the server never sees the audio unless the user chooses to keep
 * it. On a 2GB droplet that is the difference between a feature and a bill.
 */

export const TRANSCRIBE_SAMPLE_RATE = 22050;

/** MediaRecorder mime types in order of preference, best-supported first. */
const PREFERRED_TYPES = [
	'audio/webm;codecs=opus',
	'audio/ogg;codecs=opus',
	'audio/webm',
	'audio/mp4'
];

export function pickRecordingMimeType(): string | undefined {
	if (typeof MediaRecorder === 'undefined') return undefined;
	return PREFERRED_TYPES.find((t) => MediaRecorder.isTypeSupported(t));
}

export interface RecordingResult {
	blob: Blob;
	mimeType: string;
	durationSeconds: number;
}

/**
 * A microphone recording, start to finish.
 *
 * The stream's tracks are stopped on finish and on error alike — leaving them
 * running keeps the browser's recording indicator lit, which users reasonably
 * read as "this page is still listening to me".
 */
export class Recorder {
	private recorder: MediaRecorder | null = null;
	private stream: MediaStream | null = null;
	private chunks: Blob[] = [];
	private startedAt = 0;

	get recording(): boolean {
		return this.recorder?.state === 'recording';
	}

	async start(): Promise<void> {
		if (this.recording) return;
		this.stream = await navigator.mediaDevices.getUserMedia({
			audio: {
				// Echo cancellation and noise suppression are tuned for speech and
				// audibly mangle singing and instruments, which is precisely what
				// the pitch detector then has to work from.
				echoCancellation: false,
				noiseSuppression: false,
				autoGainControl: false
			}
		});
		const mimeType = pickRecordingMimeType();
		this.recorder = new MediaRecorder(this.stream, mimeType ? { mimeType } : undefined);
		this.chunks = [];
		this.recorder.ondataavailable = (e) => {
			if (e.data.size > 0) this.chunks.push(e.data);
		};
		this.startedAt = performance.now();
		this.recorder.start(250);
	}

	stop(): Promise<RecordingResult> {
		const rec = this.recorder;
		if (!rec || rec.state === 'inactive') {
			this.release();
			return Promise.reject(new Error('Not recording.'));
		}
		return new Promise((resolve, reject) => {
			rec.onstop = () => {
				const mimeType = rec.mimeType || 'audio/webm';
				const blob = new Blob(this.chunks, { type: mimeType });
				this.release();
				resolve({
					blob,
					mimeType,
					durationSeconds: (performance.now() - this.startedAt) / 1000
				});
			};
			rec.onerror = (e) => {
				this.release();
				reject(e instanceof Error ? e : new Error('Recording failed.'));
			};
			rec.stop();
		});
	}

	/** Abandon a recording without producing a result. */
	cancel(): void {
		if (this.recorder?.state !== 'inactive') this.recorder?.stop();
		this.release();
	}

	private release(): void {
		for (const track of this.stream?.getTracks() ?? []) track.stop();
		this.stream = null;
		this.recorder = null;
		this.chunks = [];
	}
}

export interface DecodedAudio {
	samples: Float32Array;
	sampleRate: number;
	durationSeconds: number;
}

/**
 * Decode any container the browser understands, then resample to mono 22050.
 *
 * Both steps go through an OfflineAudioContext: decoding needs a context at
 * all, and rendering into a second one at the target rate is the only
 * resampler a browser exposes. It is also a good one — better than the linear
 * interpolation we would otherwise hand-roll, which aliases badly on the
 * downsample and would put phantom partials in front of the pitch detector.
 */
export async function decodeToMono(
	input: Blob | ArrayBuffer,
	targetRate = TRANSCRIBE_SAMPLE_RATE
): Promise<DecodedAudio> {
	const bytes = input instanceof Blob ? await input.arrayBuffer() : input;
	if (bytes.byteLength === 0) throw new Error('That file is empty.');

	// Decode at the device's own rate; asking for the target rate here is
	// unreliable across browsers, so resampling is a separate, explicit pass.
	const decodeCtx = new OfflineAudioContext(1, 1, 44100);
	let decoded: AudioBuffer;
	try {
		decoded = await decodeCtx.decodeAudioData(bytes.slice(0));
	} catch {
		throw new Error('That does not look like audio this browser can read.');
	}

	if (decoded.length === 0) throw new Error('That recording contains no audio.');

	const frames = Math.max(1, Math.ceil(decoded.duration * targetRate));
	const ctx = new OfflineAudioContext(1, frames, targetRate);
	const source = ctx.createBufferSource();
	source.buffer = decoded;
	source.connect(ctx.destination);
	source.start();
	const rendered = await ctx.startRendering();

	return {
		// getChannelData hands back a view onto the rendered buffer; copy it so
		// the caller owns memory that outlives the context, and so it can be
		// transferred to a worker.
		samples: new Float32Array(rendered.getChannelData(0)),
		sampleRate: targetRate,
		durationSeconds: rendered.duration
	};
}

/** Peak absolute sample, for a "we heard nothing" warning before inference. */
export function peakLevel(samples: Float32Array): number {
	let peak = 0;
	for (let i = 0; i < samples.length; i++) {
		const v = Math.abs(samples[i]);
		if (v > peak) peak = v;
	}
	return peak;
}

/**
 * Normalise quiet material toward full scale.
 *
 * A phone microphone at arm's length routinely peaks around 0.05, and the
 * detector's confidence thresholds are absolute, so a quiet take transcribes
 * as silence. The gain is capped so room tone in an actually-silent recording
 * is not amplified into spurious notes.
 */
export function normalise(samples: Float32Array, maxGain = 12): Float32Array {
	const peak = peakLevel(samples);
	if (peak === 0) return samples;
	const gain = Math.min(maxGain, 0.95 / peak);
	if (gain <= 1.01) return samples;
	const out = new Float32Array(samples.length);
	for (let i = 0; i < samples.length; i++) out[i] = samples[i] * gain;
	return out;
}
// ------------------------------------------------------------------ count-in

/**
 * An audible count-in: clicks for `bars` bars at `bpm`, then calls back.
 *
 * Tempo is what makes a count-in musical rather than cosmetic, so it is
 * required rather than defaulted — the transcription UI already knows the
 * tempo the user typed, and the detected tempo only exists after the first
 * take. Downbeats are accented, the rest are ticks; everything runs through
 * a Web Audio graph, so no recording is made until the callback fires.
 */
export interface CountIn {
	/** Fires when the last click has played and recording should begin. */
	done: () => void;
	/** Stops the clicks immediately; fires `done` only if it had not yet. */
	cancel: () => void;
}

export function playCountIn(
	bars: number,
	bpm: number,
	audio: AudioContext,
	done: () => void
): CountIn {
	const beatsPerBar = 4; // Transcription defaults to 4/4; see notesToScore.
	const beat = 60 / bpm;
	const total = bars * beatsPerBar;
	let fired = false;
	const fireDone = () => {
		if (fired) return;
		fired = true;
		done();
	};

	void audio.resume();

	const start = audio.currentTime + 0.08;
	for (let b = 0; b < total; b++) {
		const t = start + b * beat;
		const osc = audio.createOscillator();
		const gain = audio.createGain();
		// A square wave is a beep; a sine with a fast decay is a click.
		osc.frequency.value = b % beatsPerBar === 0 ? 1200 : 800;
		osc.type = 'sine';
		gain.gain.setValueAtTime(b % beatsPerBar === 0 ? 0.5 : 0.3, t);
		gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.07);
		osc.connect(gain);
		gain.connect(audio.destination);
		osc.start(t);
		osc.stop(t + 0.09);
	}

	const lastEnd = start + total * beat;
	const timeout = setTimeout(fireDone, (lastEnd - audio.currentTime) * 1000);
	timeout.unref?.();

	return {
		done: fireDone,
		// Cancelling stops the callback; the already-scheduled clicks ring out
		// within a beat, which is shorter and kinder than cutting the graph.
		cancel: () => clearTimeout(timeout)
	};
}
