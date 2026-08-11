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

export interface DetectOptions {
	/** 0..1. Higher means fewer, more confident note starts. */
	onsetThreshold?: number;
	/** 0..1. Higher means notes must be more strongly present to continue. */
	frameThreshold?: number;
	/** Minimum note length in model frames (~11ms each). */
	minNoteFrames?: number;
	onProgress?: (fraction: number) => void;
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
	const { BasicPitch, addPitchBendsToNoteEvents, noteFramesToTime, outputToNotesPoly } =
		await import('@spotify/basic-pitch');

	const model = new BasicPitch(MODEL_URL);

	const frames: number[][] = [];
	const onsets: number[][] = [];
	const contours: number[][] = [];

	// evaluateModel streams results in batches, appending as it goes; the model
	// is windowed, so the callback fires several times for a long recording.
	await model.evaluateModel(
		samples,
		(f, o, c) => {
			frames.push(...f);
			onsets.push(...o);
			contours.push(...c);
		},
		(percent) => opts.onProgress?.(Math.max(0, Math.min(1, percent / 100)))
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
