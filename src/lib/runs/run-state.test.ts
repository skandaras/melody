import { describe, it, expect } from 'vitest';
import {
	beginRun,
	emptyRun,
	isRunning,
	isTerminal,
	outcomeMessage,
	phaseNumber,
	reduce,
	type RunEvent,
	type RunState
} from './run-state.js';

/**
 * The reducer is where every run — an AI turn, a control, a transcription —
 * turns into something a person can read. It is pure so that the awkward
 * cases (a stream that dies, a turn that changes nothing, an outcome arriving
 * twice) can be provoked here rather than only in front of a real model.
 */

const play = (events: RunEvent[], from: RunState = beginRun()): RunState =>
	events.reduce(reduce, from);

describe('idle', () => {
	// A store nobody has used must render as nothing at all. Collapsing idle into
	// running makes an empty panel claim work is in progress on page load, and
	// again after every free control that never starts a run.
	it('starts idle, not running', () => {
		const s = emptyRun();
		expect(s.outcome).toBe('idle');
		expect(isRunning(s)).toBe(false);
		expect(isTerminal(s)).toBe(false);
		expect(outcomeMessage(s)).toBe('');
	});

	it('is running once begun, and still not terminal', () => {
		const s = beginRun();
		expect(isRunning(s)).toBe(true);
		expect(isTerminal(s)).toBe(false);
	});
});

describe('phases', () => {
	it('takes the declared plan and marks the current phase', () => {
		const s = play([
			{ type: 'plan', data: { phases: [{ id: 'a', label: 'Verse' }, { id: 'b', label: 'Chorus' }] } },
			{ type: 'phase', data: { id: 'b', label: 'Chorus' } }
		]);

		expect(s.phases.map((p) => p.id)).toEqual(['a', 'b']);
		expect(s.currentPhase).toBe('b');
		expect(phaseNumber(s)).toBe(2);
	});

	it('adopts a phase the plan never mentioned rather than dropping it', () => {
		// The run is the authority on what it is doing. Ignoring an unplanned
		// phase would leave the panel showing the wrong step and a denominator
		// that no longer counts everything.
		const s = play([
			{ type: 'plan', data: { phases: [{ id: 'a', label: 'Verse' }] } },
			{ type: 'phase', data: { id: 'surprise', label: 'Coda' } }
		]);

		expect(s.phases.map((p) => p.id)).toEqual(['a', 'surprise']);
		expect(s.currentPhase).toBe('surprise');
		expect(phaseNumber(s)).toBe(2);
	});

	it('survives a malformed plan', () => {
		const s = play([{ type: 'plan', data: { phases: 'not an array' } }]);
		expect(s.phases).toEqual([]);
	});

	it('reports no phase number before anything has started', () => {
		expect(phaseNumber(emptyRun())).toBe(0);
	});
});

describe('prose', () => {
	it('accumulates deltas', () => {
		const s = play([
			{ type: 'delta', data: { text: 'Raising ' } },
			{ type: 'delta', data: { text: 'the chorus.' } }
		]);
		expect(s.streamed).toBe('Raising the chorus.');
	});

	it('starts fresh prose on each iteration', () => {
		// Two round trips' sentences running together read as one confused
		// paragraph, which is why the old panel cleared between iterations.
		const s = play([
			{ type: 'iteration', data: { n: 1 } },
			{ type: 'delta', data: { text: 'First thought.' } },
			{ type: 'iteration', data: { n: 2 } },
			{ type: 'delta', data: { text: 'Second thought.' } }
		]);
		expect(s.streamed).toBe('Second thought.');
		expect(s.step).toBe(2);
	});

	it('starts fresh prose on each phase', () => {
		const s = play([
			{ type: 'delta', data: { text: 'Verse prose.' } },
			{ type: 'phase', data: { id: 'b', label: 'Chorus' } }
		]);
		expect(s.streamed).toBe('');
	});

	it('bounds the tool log', () => {
		const s = play(
			Array.from({ length: 20 }, (_, i) => ({ type: 'tool', data: { name: `op${i}`, ok: true } }))
		);
		expect(s.log).toHaveLength(8);
		expect(s.log.at(-1)).toContain('op19');
	});

	it('marks a failed tool call differently from a successful one', () => {
		const s = play([
			{ type: 'tool', data: { detail: 'transpose applied', ok: true } },
			{ type: 'tool', data: { detail: 'transpose matched nothing', ok: false } }
		]);
		expect(s.log[0].startsWith('·')).toBe(true);
		expect(s.log[1].startsWith('✕')).toBe(true);
	});
});

describe('outcomes', () => {
	it('treats a plain done as success', () => {
		const s = play([{ type: 'done', data: { status: 'done' } }]);
		expect(s.outcome).toBe('done');
		expect(isTerminal(s)).toBe(true);
	});

	it('reads the real status out of the done payload', () => {
		// The event name stays `done` so the wire contract did not change; the
		// outcome rides in the payload.
		for (const status of ['no_effect', 'cancelled', 'timed_out', 'error'] as const) {
			expect(play([{ type: 'done', data: { status } }]).outcome).toBe(status);
		}
	});

	it('ignores everything after a terminal event', () => {
		// A second outcome arriving is a bug somewhere upstream. Keeping the
		// answer already shown beats flickering to a different one.
		const s = play([
			{ type: 'done', data: { status: 'cancelled' } },
			{ type: 'delta', data: { text: 'late' } },
			{ type: 'done', data: { status: 'done' } }
		]);
		expect(s.outcome).toBe('cancelled');
		expect(s.streamed).toBe('');
	});

	it('carries a warning through as the thing to show', () => {
		const s = play([{ type: 'result', data: { warnings: ['Stopped after 8 round-trips.'] } }]);
		expect(s.error).toContain('8 round-trips');
	});

	it('clears the slow flag once it is over', () => {
		const s = play([{ type: 'slow' }, { type: 'done', data: { status: 'done' } }]);
		expect(s.slow).toBe(false);
	});
});

describe('a stream that dies', () => {
	it('is not reported as finished', () => {
		const s = play([
			{ type: 'iteration', data: { n: 3 } },
			{ type: 'disconnected' }
		]);

		// The job is very likely still running server-side. The failure is this
		// page's, not the work's, and a bar that sits there forever is the bug.
		expect(s.outcome).toBe('error');
		expect(s.error).toContain('reload');
		expect(s.status).toBe('');
	});

	it('does not overwrite an outcome that already arrived', () => {
		const s = play([{ type: 'done', data: { status: 'done' } }, { type: 'disconnected' }]);
		expect(s.outcome).toBe('done');
		expect(s.error).toBe('');
	});
});

describe('outcomeMessage', () => {
	it('says nothing while running', () => {
		expect(outcomeMessage(beginRun())).toBe('');
	});

	it('stays quiet when a successful turn produced a diff', () => {
		// The diff is the message. A line saying "done" underneath it is noise.
		const s = play([
			{ type: 'result', data: { opsApplied: 4 } },
			{ type: 'done', data: { status: 'done' } }
		]);
		expect(outcomeMessage(s)).toBe('');
	});

	it('distinguishes "nothing to say" from "tried and missed"', () => {
		const quiet = play([
			{ type: 'result', data: { opsApplied: 0, opsRejected: 0 } },
			{ type: 'done', data: { status: 'no_effect' } }
		]);
		expect(outcomeMessage(quiet)).toBe('Nothing was changed.');

		// This is the reported bug's exact shape: the model read the score,
		// described the range, tried edits that all missed, and the panel went
		// blank. Naming the difference is the whole point of no_effect.
		const missed = play([
			{ type: 'result', data: { opsApplied: 0, opsRejected: 3 } },
			{ type: 'done', data: { status: 'no_effect' } }
		]);
		expect(outcomeMessage(missed)).toContain('3 edits');
		expect(outcomeMessage(missed)).toContain('matched anything');
	});

	it('counts one rejected edit in the singular', () => {
		const s = play([
			{ type: 'result', data: { opsRejected: 1 } },
			{ type: 'done', data: { status: 'no_effect' } }
		]);
		expect(outcomeMessage(s)).toContain('1 edit,');
	});

	it("prefers the model's own summary when it gave one", () => {
		const s = play([
			{ type: 'result', data: { summary: 'The dynamics are already where you want them.' } },
			{ type: 'done', data: { status: 'no_effect' } }
		]);
		expect(outcomeMessage(s)).toBe('The dynamics are already where you want them.');
	});

	it('has a sentence for every terminal outcome', () => {
		for (const status of ['cancelled', 'timed_out', 'error'] as const) {
			const s = play([{ type: 'done', data: { status } }]);
			expect(outcomeMessage(s).length).toBeGreaterThan(0);
		}
	});
});

describe('robustness', () => {
	it('ignores an event type it does not know', () => {
		const before = beginRun();
		expect(reduce(before, { type: 'nonsense', data: { x: 1 } })).toEqual(before);
	});

	it('ignores events with no payload at all', () => {
		const before = beginRun();
		expect(reduce(before, { type: 'delta' })).toEqual(before);
	});

	it('clamps a fraction to 0..1', () => {
		expect(play([{ type: 'fraction', data: { value: 1.4 } }]).fraction).toBe(1);
		expect(play([{ type: 'fraction', data: { value: -3 } }]).fraction).toBe(0);
	});

	it('leaves fraction null for a run that never reports one', () => {
		// An agent turn has phases, not a percentage. A bar that invents one is
		// worse than a bar that admits it cannot say.
		expect(play([{ type: 'iteration', data: { n: 1 } }]).fraction).toBeNull();
	});
});
