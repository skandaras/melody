import type { DetectedNote } from './transcribe';

/**
 * Running the pitch-detection model.
 *
 * This is the only module that touches TensorFlow, and it does nothing but
 * turn samples into note events — every musical decision lives in
 * transcribe.ts, where it can be tested. Keeping the boundary here is what
 * lets the interesting logic be unit-tested without loading a 900KB model.
 *
 * The model is served from static/basic-pitch-model, copied out of the npm
 * package by scripts/setup-assets.mjs. It is deliberately not a CDN URL: this
 * app sits behind Authelia on a private host, and a feature that silently
 * needs the public internet is a feature that breaks.
 */

export const MODEL_URL = '/basic-pitch-model/model.json';

/**
 * What the detector is doing right now.
 *
 * The first run fetches TensorFlow (~1.8MB) and the model (~900KB), which on a
 * slow connection takes longer than the inference that follows. Reporting it as
 * a distinct phase is the difference between "loading" and "hung" — without it
 * the UI sits on an unmoving bar with nothing to say for itself.
 */
export type DetectProgress =
	| { phase: 'model' }
	| { phase: 'analysing'; fraction: number; window: number; windows: number };

export interface DetectOptions {
	/** 0..1. Higher means fewer, more confident note starts. */
	onsetThreshold?: number;
	/** 0..1. Higher means notes must be more strongly present to continue. */
	frameThreshold?: number;
	/** Minimum note length in model frames (~11ms each). */
	minNoteFrames?: number;
	onProgress?: (progress: DetectProgress) => void;
}

/**
 * Samples (mono, exactly 22050 Hz) → detected notes.
 *
 * Defaults follow basic-pitch's own, except for minNoteFrames: its default of
 * 5 frames (~58ms) admits a lot of vibrato flicker as separate notes, and
 * anything under about a 32nd note at a fast tempo is noise for our purposes.
 */
export async function detectNotes(
	samples: Float32Array,
	opts: DetectOptions = {}
): Promise<DetectedNote[]> {
	opts.onProgress?.({ phase: 'model' });

	const [{ BasicPitch, addPitchBendsToNoteEvents, noteFramesToTime, outputToNotesPoly }, tf] =
		await Promise.all([import('@spotify/basic-pitch'), import('@tensorflow/tfjs')]);

	// Same specifier basic-pitch itself imports, so this is the very backend it
	// will use — not a second copy. Worth one line in the console: WebGL is
	// seconds and CPU is minutes, and from the outside those look identical
	// apart from the wait.
	await tf.ready();
	console.info(`[melody] pitch detection backend: ${tf.getBackend()}`);

	const model = new BasicPitch(MODEL_URL);

	const frames: number[][] = [];
	const onsets: number[][] = [];
	const contours: number[][] = [];

	// The window count is not exposed, but the callback reports i/total — so the
	// first non-zero value is exactly 1/total and gives it up. Derived rather
	// than recomputed from basic-pitch's framing constants, which are private
	// and would silently drift out of step with the package.
	let windows = 0;

	// evaluateModel streams results in batches, appending as it goes; the model
	// is windowed, so the callback fires several times for a long recording.
	await model.evaluateModel(
		samples,
		(f, o, c) => {
			frames.push(...f);
			onsets.push(...o);
			contours.push(...c);
		},
		// Despite the parameter name upstream, this is a fraction in 0..1
		// (`i / shape[0]`, then a final 1.0) — not a percentage. Dividing it by
		// 100 pins the progress bar at 1% and makes a working run look hung.
		(fraction) => {
			const f = Math.max(0, Math.min(1, fraction));
			if (!windows && f > 0) windows = Math.round(1 / f);
			opts.onProgress?.({
				phase: 'analysing',
				fraction: f,
				window: windows ? Math.min(windows, Math.round(f * windows) + 1) : 1,
				windows
			});
		}
	);

	const notes = noteFramesToTime(
		addPitchBendsToNoteEvents(
			contours,
			outputToNotesPoly(
				frames,
				onsets,
				opts.onsetThreshold ?? 0.5,
				opts.frameThreshold ?? 0.3,
				opts.minNoteFrames ?? 11
			)
		)
	);

	return notes.map((n) => ({
		startTimeSeconds: n.startTimeSeconds,
		durationSeconds: n.durationSeconds,
		pitchMidi: n.pitchMidi,
		amplitude: n.amplitude,
		pitchBends: n.pitchBends
	}));
}
