import type { DetectOptions, DetectProgress } from './basic-pitch';
import type { DetectedNote } from './transcribe';
import type { TranscribeRequest, TranscribeResponse } from './transcribe.worker';

/**
 * Talking to the pitch-detection worker.
 *
 * A worker is spawned per run rather than kept alive: inference is occasional,
 * and holding TensorFlow plus a loaded graph model in memory between takes
 * costs more than the couple of hundred milliseconds it takes to start one.
 *
 * If a worker cannot be created — an old browser, a strict CSP — detection
 * falls back to the main thread. The page janks for a few seconds, which is
 * much better than the feature simply not existing.
 */

export interface RunOptions extends Omit<DetectOptions, 'onProgress'> {
	onProgress?: (progress: DetectProgress) => void;
	signal?: AbortSignal;
}

let nextId = 1;

export function detectNotesInWorker(
	samples: Float32Array,
	opts: RunOptions = {}
): Promise<DetectedNote[]> {
	let worker: Worker;
	try {
		worker = new Worker(new URL('./transcribe.worker.ts', import.meta.url), { type: 'module' });
	} catch {
		return detectOnMainThread(samples, opts);
	}

	const id = nextId++;

	return new Promise<DetectedNote[]>((resolve, reject) => {
		const finish = (fn: () => void) => {
			opts.signal?.removeEventListener('abort', onAbort);
			worker.terminate();
			fn();
		};
		function onAbort() {
			finish(() => reject(new DOMException('Transcription cancelled', 'AbortError')));
		}

		if (opts.signal?.aborted) return onAbort();
		opts.signal?.addEventListener('abort', onAbort, { once: true });

		worker.onmessage = (event: MessageEvent<TranscribeResponse>) => {
			const msg = event.data;
			if (msg.id !== id) return;
			if (msg.type === 'progress') opts.onProgress?.(msg.progress);
			else if (msg.type === 'done') finish(() => resolve(msg.notes));
			else finish(() => reject(new Error(msg.message)));
		};
		worker.onerror = (e) => finish(() => reject(new Error(e.message || 'Transcription failed')));

		const request: TranscribeRequest = { id, samples, options: strip(opts) };
		// Transfer rather than copy: a few minutes of audio is tens of
		// megabytes, and the caller has no use for the samples afterwards.
		worker.postMessage(request, [samples.buffer as ArrayBuffer]);
	});
}

async function detectOnMainThread(
	samples: Float32Array,
	opts: RunOptions
): Promise<DetectedNote[]> {
	const { detectNotes } = await import('./basic-pitch');
	return detectNotes(samples, { ...strip(opts), onProgress: opts.onProgress });
}

function strip(opts: RunOptions): Omit<DetectOptions, 'onProgress'> {
	return {
		onsetThreshold: opts.onsetThreshold,
		frameThreshold: opts.frameThreshold,
		minNoteFrames: opts.minNoteFrames
	};
}
