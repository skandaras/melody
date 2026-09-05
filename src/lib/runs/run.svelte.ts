import {
	beginRun,
	emptyRun,
	isRunning,
	isTerminal,
	reduce,
	type RunEvent,
	type RunState
} from './run-state.js';

/**
 * The staged document a successful turn produced.
 *
 * Handed to the caller as a one-shot callback rather than kept in RunState: the
 * score belongs to the page that owns the editor, and parking a whole document
 * in progress-reporting state would make the two impossible to reason about
 * separately.
 */
export interface RunResult {
	doc: unknown;
	revisionId: string;
	diff: { added: string[]; removed: string[]; changed: string[] };
}

/**
 * The reactive shell around a run.
 *
 * Everything interesting is in `run-state.ts`, which is pure and tested. This
 * file is the parts that cannot be: a rune holding the state, an EventSource
 * feeding it, a timer that notices a run has gone quiet, and cancellation.
 * Shaped after `PlayerStore` in `$lib/audio/player.svelte.ts`, the app's one
 * other stateful rune store, so there is one pattern here rather than two.
 *
 * Three producers share it — an AI turn, a model-backed control, and a
 * transcription. The first two are jobs and arrive over SSE; the third is a Web
 * Worker and drives the same state directly. `RunProgress` renders the result
 * without knowing which it is looking at.
 */

/**
 * How long a run may go before we admit it is taking longer than it should.
 *
 * Total duration from the start, not silence since the last event. A silence
 * timer would never fire for transcription, which reports progress constantly
 * while still potentially running for minutes on a CPU — and that is exactly
 * the case the warning exists for. 45s is the value AudioInput already used,
 * arrived at for the same reason.
 */
const SLOW_AFTER_MS = 45_000;

export class Run {
	/** The whole observable state, replaced wholesale by the reducer. */
	state = $state<RunState>(emptyRun());

	/** Set for a job-backed run, so it can be cancelled server-side. */
	jobId: string | null = null;

	/**
	 * The last `result` payload, verbatim.
	 *
	 * `onResult` below answers "a turn produced a staged document", which is the
	 * editor's question and not everyone's — a plan run produces a plan and no
	 * document at all, so it would never fire. Rather than widen a callback three
	 * callers depend on, the raw payload is offered here for whoever wants
	 * something else out of it. Progress state stays in RunState; this is not
	 * progress.
	 */
	lastResult = $state.raw<Record<string, unknown> | null>(null);

	#source: EventSource | null = null;
	#watchdog: ReturnType<typeof setTimeout> | null = null;
	/** Cancels a local (worker-backed) run. Jobs cancel over HTTP instead. */
	#abort: AbortController | null = null;

	/** In flight. False while idle, so a store nobody has used renders as nothing. */
	get running(): boolean {
		return isRunning(this.state);
	}

	/** Begin again, discarding whatever the last run left on screen. */
	reset(): void {
		this.#teardown();
		this.state = emptyRun();
		this.jobId = null;
		this.lastResult = null;
	}

	/** Fold one event in. */
	push(event: RunEvent): void {
		this.state = reduce(this.state, event);
		if (isTerminal(this.state)) this.#teardown();
	}

	/**
	 * Follow a server job.
	 *
	 * Every event type the server emits is forwarded verbatim into the reducer,
	 * so adding one to the wire needs no change here — only a case in
	 * `run-state.ts`, where it can be tested.
	 */
	listen(jobId: string, onResult?: (result: RunResult) => void): void {
		this.reset();
		this.state = beginRun();
		this.jobId = jobId;
		const source = new EventSource(`/api/jobs/${jobId}/events`);
		this.#source = source;

		const forward = (type: string) =>
			source.addEventListener(type, (e) => this.push({ type, data: parse(e) }));

		for (const type of [
			'plan',
			'phase',
			'status',
			'iteration',
			'reasoning',
			'delta',
			'text',
			'tool',
			'done'
		]) {
			forward(type);
		}

		// `result` also carries the staged document, which is not progress and
		// does not belong in RunState. Fold the reportable half in, hand the
		// document to the caller.
		source.addEventListener('result', (e) => {
			const data = parse(e);
			this.lastResult = data ?? null;
			this.push({ type: 'result', data });
			if (data?.doc && typeof data.revisionId === 'string') {
				onResult?.({
					doc: data.doc,
					revisionId: data.revisionId,
					diff: data.diff as RunResult['diff']
				});
			}
		});

		// A named `error` event with a payload is the job failing. Without a
		// payload it is the browser's own reconnect noise, which it handles.
		source.addEventListener('error', (e) => {
			const data = parse(e);
			if (!data) return;
			this.push({ type: 'error', data });
		});

		// Transport-level close. If no outcome ever arrived, the job is probably
		// still running server-side and this page has simply stopped hearing
		// about it — which is worth saying, unlike a bar that waits forever.
		source.onerror = () => {
			if (source.readyState !== EventSource.CLOSED) return;
			this.push({ type: 'disconnected' });
		};

		this.#arm();
	}

	/** Drive a local run — a worker, not a job. Owns the abort signal. */
	startLocal(): AbortSignal {
		this.reset();
		this.state = beginRun();
		this.#abort = new AbortController();
		this.#arm();
		return this.#abort.signal;
	}

	/**
	 * Stop the run.
	 *
	 * A job is cancelled server-side: aborting the EventSource alone would only
	 * stop this page watching, while the turn carried on and committed. The
	 * server aborts the loop, skips the commit and records `cancelled`, which
	 * comes back as an ordinary terminal event.
	 */
	async cancel(): Promise<void> {
		if (!this.running) return;

		if (this.#abort) {
			this.#abort.abort();
			this.push({ type: 'done', data: { status: 'cancelled' } });
			return;
		}

		if (!this.jobId) return;
		this.state = { ...this.state, status: 'Cancelling…' };
		try {
			await fetch(`/api/jobs/${this.jobId}`, { method: 'DELETE' });
			// The terminal event arrives over the stream, so nothing to do here.
		} catch {
			// The request failing does not mean the job survived, and guessing
			// either way would be worse than letting the stream have the last word.
		}
	}

	/** Release the stream and timers. Safe to call repeatedly. */
	destroy(): void {
		this.#teardown();
	}

	/** Armed once per run, at the start. Never re-armed — see SLOW_AFTER_MS. */
	#arm(): void {
		if (this.#watchdog) clearTimeout(this.#watchdog);
		this.#watchdog = setTimeout(() => this.push({ type: 'slow' }), SLOW_AFTER_MS);
	}

	#teardown(): void {
		this.#source?.close();
		this.#source = null;
		if (this.#watchdog) clearTimeout(this.#watchdog);
		this.#watchdog = null;
		this.#abort = null;
	}
}

/** SSE payloads are JSON from the server; a malformed one is not worth throwing over. */
function parse(e: Event): Record<string, unknown> | undefined {
	const data = (e as MessageEvent).data;
	if (!data) return undefined;
	try {
		return JSON.parse(data);
	} catch {
		return undefined;
	}
}
