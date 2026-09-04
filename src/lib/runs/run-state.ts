/**
 * What a long-running job looks like to the person waiting for it.
 *
 * Three things in this app take enough time to need reporting: an AI turn, a
 * model-backed control, and a transcription. They arrive by different routes —
 * the first two over SSE, the third from a Web Worker callback — but a person
 * waiting on one wants the same four answers from all of them: what is it
 * doing, how far through is it, is it stuck, and how did it end.
 *
 * So the shape is shared and the transport is not. This module is the shape,
 * and it deliberately imports nothing: no runes, no DOM, no EventSource. That
 * is what lets the whole vocabulary be tested as plain functions in Node, the
 * way the rest of the interesting logic here is. `run.svelte.ts` adds the
 * reactive shell and the wire; there is nothing left in it worth testing.
 */

/**
 * How a run ended, or that it hasn't.
 *
 * Mirrors JOB_STATUSES server-side, minus the parts a client can't observe.
 * `no_effect` is the important one: a turn that ran correctly and changed
 * nothing is not a failure, but reporting it as plain success is what made the
 * panel go quiet after the model had described what it found.
 *
 * `idle` is distinct from `running` because a store that has never been used
 * must render as nothing at all. Collapsing the two makes an empty panel claim
 * work is in progress the moment the page loads.
 */
export type RunOutcome =
	| 'idle'
	| 'running'
	| 'done'
	| 'no_effect'
	| 'error'
	| 'cancelled'
	| 'timed_out';

export interface RunPhase {
	id: string;
	label: string;
}

export interface RunState {
	/** Declared up front when the run knows its shape. Empty means "unknown". */
	phases: RunPhase[];
	/** Which phase is running now, by id. */
	currentPhase: string | null;
	/**
	 * Real completion 0..1, when the producer actually knows it.
	 *
	 * Null for an agent turn, which has phases but no percentage — a bar that
	 * invents one is worse than a bar that admits it cannot say. Transcription
	 * does know, because it counts windows.
	 */
	fraction: number | null;
	/** A short line about what is happening, when it beats the phase label. */
	status: string;
	/** Prose as it streams, reset per iteration so sentences don't run together. */
	streamed: string;
	/** The model's round-trip count, for runs that iterate. */
	step: number;
	/** Recent tool calls, newest last, bounded. */
	log: string[];
	outcome: RunOutcome;
	/** Set on failure, and on a stream that died without an outcome. */
	error: string;
	/** Past the point where this should plainly have finished. */
	slow: boolean;
	opsApplied: number;
	opsRejected: number;
	/** The closing prose, if the producer sent any. */
	summary: string;
}

/** Tool lines kept. Enough to see what happened without becoming the panel. */
const MAX_LOG = 8;

export function emptyRun(): RunState {
	return {
		phases: [],
		currentPhase: null,
		fraction: null,
		status: '',
		streamed: '',
		step: 0,
		log: [],
		outcome: 'idle',
		error: '',
		slow: false,
		opsApplied: 0,
		opsRejected: 0,
		summary: ''
	};
}

/** An event off the wire, or from a local producer. `data` is untrusted JSON. */
export interface RunEvent {
	type: string;
	data?: Record<string, unknown>;
}

/** Has this run finished? Idle is not terminal — it has not started. */
export function isTerminal(state: RunState): boolean {
	return state.outcome !== 'idle' && state.outcome !== 'running';
}

/** Is there work in flight right now? */
export function isRunning(state: RunState): boolean {
	return state.outcome === 'running';
}

/** Mark a fresh run as started. Producers call this before their first event. */
export function beginRun(): RunState {
	return { ...emptyRun(), outcome: 'running' };
}

/**
 * Fold one event into the state.
 *
 * Pure, total, and never throws: every producer here is either a network
 * stream or a worker, so a malformed or unexpected payload is a thing that
 * happens rather than a thing to assert against. An event it does not
 * understand leaves the state alone.
 *
 * Once terminal, later events are ignored. The server enforces the same
 * invariant in finishJob for the same reason — a second outcome arriving after
 * the first is a bug somewhere, and the honest response is to keep the answer
 * the user has already been shown rather than flicker to another one.
 */
export function reduce(state: RunState, event: RunEvent): RunState {
	if (isTerminal(state)) return state;

	const d = event.data ?? {};

	switch (event.type) {
		case 'plan': {
			const phases = Array.isArray(d.phases) ? (d.phases as RunPhase[]) : [];
			return { ...state, phases: phases.filter((p) => p && typeof p.id === 'string') };
		}

		case 'phase': {
			if (typeof d.id !== 'string') return state;
			// A phase for an id the plan never mentioned still becomes current —
			// the run is the authority on what it is doing, and dropping it would
			// leave the panel showing the wrong step. Adopt it into the list so
			// the denominator stays honest too.
			const known = state.phases.some((p) => p.id === d.id);
			const label = typeof d.label === 'string' ? d.label : (d.id as string);
			return {
				...state,
				phases: known ? state.phases : [...state.phases, { id: d.id as string, label }],
				currentPhase: d.id as string,
				status: label,
				// A new phase means a new stretch of prose.
				streamed: ''
			};
		}

		case 'status':
			return { ...state, status: typeof d.message === 'string' ? d.message : state.status };

		case 'iteration':
			return {
				...state,
				step: typeof d.n === 'number' ? d.n : state.step + 1,
				// Each round trip starts its own prose; letting two run together
				// reads as one confused paragraph.
				streamed: ''
			};

		case 'reasoning':
			// Usually carries no text — reasoning is hidden by default — but the
			// fact that it is thinking is the point.
			return { ...state, status: state.currentPhase ? state.status : 'Thinking…' };

		case 'delta':
			return typeof d.text === 'string'
				? { ...state, streamed: state.streamed + d.text, status: '' }
				: state;

		case 'text':
			return typeof d.text === 'string' ? { ...state, streamed: d.text } : state;

		case 'tool': {
			const name = typeof d.name === 'string' ? d.name : 'tool';
			const detail = typeof d.detail === 'string' ? d.detail : name;
			const ok = d.ok !== false;
			return { ...state, log: [...state.log, `${ok ? '·' : '✕'} ${detail}`].slice(-MAX_LOG) };
		}

		case 'result':
			return {
				...state,
				summary: typeof d.summary === 'string' ? d.summary : state.summary,
				opsApplied: typeof d.opsApplied === 'number' ? d.opsApplied : state.opsApplied,
				opsRejected: typeof d.opsRejected === 'number' ? d.opsRejected : state.opsRejected,
				// Warnings are shown where an error would be: they are the reason a
				// turn stopped early, which is exactly what a waiting person needs.
				error: Array.isArray(d.warnings) && d.warnings.length ? d.warnings.join(' ') : state.error
			};

		case 'done':
			return { ...state, outcome: outcomeFrom(d.status), slow: false, streamed: state.streamed };

		case 'error':
			return {
				...state,
				outcome: 'error',
				slow: false,
				status: '',
				error: typeof d.error === 'string' && d.error ? d.error : 'The request failed.'
			};

		/** Local producers report a real fraction; SSE runs never do. */
		case 'fraction':
			return typeof d.value === 'number'
				? { ...state, fraction: Math.max(0, Math.min(1, d.value)) }
				: state;

		case 'slow':
			return { ...state, slow: true };

		/**
		 * The stream ended without saying how. The job itself is very likely
		 * still running server-side, so this is not a failure of the work — it is
		 * a failure of this page to keep hearing about it, and saying so is the
		 * difference between "reload me" and a bar that sits there forever.
		 */
		case 'disconnected':
			return {
				...state,
				outcome: 'error',
				slow: false,
				status: '',
				error:
					typeof d.error === 'string' && d.error
						? d.error
						: 'Lost the connection to this run. It may still be going — reload to pick it up.'
			};

		default:
			return state;
	}
}

/** Map the server's job status onto an outcome, defaulting to plain success. */
function outcomeFrom(status: unknown): RunOutcome {
	switch (status) {
		case 'no_effect':
		case 'cancelled':
		case 'timed_out':
		case 'error':
			return status;
		default:
			return 'done';
	}
}

/**
 * What to tell the person, once it is over.
 *
 * Returns empty when there is nothing worth saying — a successful turn that
 * produced a diff speaks through the diff, and a line saying "done" under it
 * is noise.
 */
export function outcomeMessage(state: RunState): string {
	switch (state.outcome) {
		case 'idle':
		case 'running':
			return '';

		case 'cancelled':
			return 'Cancelled — nothing was changed.';

		case 'timed_out':
			return 'This took too long and was stopped. Nothing was changed.';

		case 'error':
			return state.error || 'The request failed.';

		case 'no_effect':
			// The distinction the server draws, and the whole reason no_effect
			// exists: trying four edits that all miss is a different problem from
			// having nothing to say, and only one of them is the user's to fix.
			if (state.opsRejected > 0) {
				return (
					state.summary ||
					`Tried ${state.opsRejected} edit${state.opsRejected === 1 ? '' : 's'}, but none of them matched anything in the score.`
				);
			}
			return state.summary || 'Nothing was changed.';

		case 'done':
			return state.opsApplied > 0 ? '' : state.summary || 'Nothing was changed.';
	}
}

/** Position of the current phase, 1-based, or 0 when there is nothing to show. */
export function phaseNumber(state: RunState): number {
	if (!state.currentPhase) return 0;
	return state.phases.findIndex((p) => p.id === state.currentPhase) + 1;
}
