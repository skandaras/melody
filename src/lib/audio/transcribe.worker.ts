import { detectNotes, type DetectOptions, type DetectProgress } from './basic-pitch';
import type { DetectedNote } from './transcribe';

/**
 * Pitch detection, off the main thread.
 *
 * Inference on a minute of audio is seconds of solid arithmetic. On the main
 * thread that freezes the page — no scrolling, no cancel button, and on a
 * phone the browser may decide the tab has hung. The worker also keeps
 * TensorFlow out of the main bundle entirely: it is only fetched when someone
 * actually records something.
 *
 * The protocol is deliberately tiny: one request in, progress out, one result
 * or one error. Musical decisions stay on the main thread in transcribe.ts,
 * because they are cheap and much easier to debug there.
 */

export interface TranscribeRequest {
	id: number;
	samples: Float32Array;
	options?: Omit<DetectOptions, 'onProgress'>;
}

export type TranscribeResponse =
	| { id: number; type: 'progress'; progress: DetectProgress }
	| { id: number; type: 'done'; notes: DetectedNote[] }
	| { id: number; type: 'error'; message: string };

const post = (msg: TranscribeResponse) => self.postMessage(msg);

self.onmessage = async (event: MessageEvent<TranscribeRequest>) => {
	const { id, samples, options } = event.data;
	try {
		const notes = await detectNotes(samples, {
			...options,
			onProgress: (progress) => post({ id, type: 'progress', progress })
		});
		post({ id, type: 'done', notes });
	} catch (err) {
		post({ id, type: 'error', message: err instanceof Error ? err.message : String(err) });
	}
};
