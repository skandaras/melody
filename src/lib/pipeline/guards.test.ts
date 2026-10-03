import { describe, it, expect } from 'vitest';
import { applyOps, type Op } from '$lib/score/apply.js';
import { allOf, formLock, guardForStage, melodyLock, onlyPart } from './guards.js';
import { approved, judge, notes } from './testing.js';

/**
 * What a run may touch.
 *
 * Each guard is tested by applying a real op and handing it what the loop
 * would — the score before, the score after, and the diff. Testing against
 * hand-built "after" scores would prove nothing about the ops a model can
 * actually send.
 */

describe('melodyLock', () => {
	it('refuses changing an approved melody note', () => {
		const { score: s0, plan } = approved();
		const melody = plan.ensemble[0].partId!;
		const score = notes(s0, melody, 'C5', 'D5');
		const guard = melodyLock(score, melody)!;

		const reason = judge(guard, score, {
			op: 'transpose',
			args: { semitones: 2, selection: { partIds: [melody] } }
		});
		expect(reason).toMatch(/approved/);
		expect(reason).toMatch(/2 of its notes/);
	});

	it('refuses removing the melody part along with its notes', () => {
		const { score: s0, plan } = approved();
		const melody = plan.ensemble[0].partId!;
		const score = notes(s0, melody, 'C5');
		expect(judge(melodyLock(score, melody)!, score, { op: 'remove_part', args: { partId: melody } }))
			.toMatch(/approved/);
	});

	it('allows new melody notes, so a new section can have a tune', () => {
		const { score: s0, plan } = approved();
		const melody = plan.ensemble[0].partId!;
		const score = notes(s0, melody, 'C5');
		const op: Op = {
			op: 'insert_notes',
			args: { partId: melody, notes: [{ tick: 3840, dur: 480, pitches: ['E5'] }] }
		};
		expect(judge(melodyLock(score, melody)!, score, op)).toBeNull();
	});

	it('allows anything in the other parts', () => {
		const { score: s0, plan } = approved();
		const [melody, strings] = plan.ensemble.map((e) => e.partId!);
		const score = notes(s0, melody, 'C5');
		expect(judge(melodyLock(score, melody)!, score, {
			op: 'insert_notes',
			args: { partId: strings, notes: [{ tick: 0, dur: 1920, pitches: ['C4', 'E4', 'G4'] }] }
		})).toBeNull();
	});

	it('has nothing to protect in an empty melody', () => {
		const { score, plan } = approved();
		expect(melodyLock(score, plan.ensemble[0].partId!)).toBeNull();
		expect(melodyLock(score, null)).toBeNull();
	});
});

describe('onlyPart', () => {
	it('allows writing the target part', () => {
		const { score, plan } = approved();
		const strings = plan.ensemble[1].partId!;
		expect(judge(onlyPart(strings), score, {
			op: 'insert_notes',
			args: { partId: strings, notes: [{ tick: 0, dur: 480, pitches: ['C4'] }] }
		})).toBeNull();
	});

	it('refuses writing any other part', () => {
		const { score, plan } = approved();
		const [, strings, bass] = plan.ensemble.map((e) => e.partId!);
		expect(judge(onlyPart(strings), score, {
			op: 'insert_notes',
			args: { partId: bass, notes: [{ tick: 0, dur: 480, pitches: ['C2'] }] }
		})).toMatch(new RegExp(`Leave part ${bass}`));
	});

	it('refuses inventing an instrument the plan did not name', () => {
		const { score, plan } = approved();
		const strings = plan.ensemble[1].partId!;
		expect(judge(onlyPart(strings), score, {
			op: 'add_part',
			args: { name: 'Oboe', instrument: 'Oboe' }
		})).toMatch(/comes from the plan/);
	});

	it('refuses changing what the plan settled', () => {
		const { score, plan } = approved();
		const strings = plan.ensemble[1].partId!;
		expect(judge(onlyPart(strings), score, { op: 'set_tempo', args: { bpm: 140 } }))
			.toMatch(/tempo, metre, key and sections/);
	});
});

describe('allOf', () => {
	it('reports the first refusal and allows what every guard allows', () => {
		const { score: s0, plan } = approved();
		const [melody, strings] = plan.ensemble.map((e) => e.partId!);
		const score = notes(s0, melody, 'C5');
		const guard = allOf(melodyLock(score, melody), null, onlyPart(strings));

		expect(judge(guard, score, {
			op: 'insert_notes',
			args: { partId: strings, notes: [{ tick: 0, dur: 480, pitches: ['C4'] }] }
		})).toBeNull();
		expect(judge(guard, score, {
			op: 'transpose',
			args: { semitones: 1, selection: { partIds: [melody] } }
		})).toMatch(/approved/);
	});
});


describe('formLock', () => {
	const allowed: [string, (s: ReturnType<typeof approved>) => Op][] = [
		['new notes', (f) => ({ op: 'insert_notes', args: { partId: f.plan.ensemble[1].partId!, notes: [{ tick: 0, dur: 480, pitches: ['C4'] }] } })],
		['a dynamic', () => ({ op: 'set_dynamic', args: { dynamic: 'pp' } })],
		['a velocity curve', () => ({ op: 'set_velocity_curve', args: { from: 40, to: 100 } })],
		['the tempo', () => ({ op: 'set_tempo', args: { bpm: 72 } })]
	];

	for (const [what, op] of allowed) {
		it(`allows ${what}`, () => {
			const f = approved();
			const score = notes(f.score, f.plan.ensemble[0].partId!, 'C5', 'D5');
			expect(judge(formLock(), score, op(f))).toBeNull();
		});
	}

	const refused: [string, (s: ReturnType<typeof approved>) => Op][] = [
		['adding a part', () => ({ op: 'add_part', args: { name: 'Oboe', instrument: 'Oboe' } })],
		['removing a part', (f) => ({ op: 'remove_part', args: { partId: f.plan.ensemble[2].partId! } })],
		['a new section', () => ({ op: 'set_section', args: { name: 'Coda', startTick: 7680, endTick: 9600 } })],
		['the metre', () => ({ op: 'set_time_sig', args: { tick: 0, num: 3, den: 4 } })],
		['the key', () => ({ op: 'set_key', args: { tick: 0, tonic: 'A', mode: 'minor' } })]
	];

	for (const [what, op] of refused) {
		it(`refuses ${what}`, () => {
			const f = approved();
			expect(judge(formLock(), f.score, op(f))).toMatch(/not its form/);
		});
	}
});

describe('guardForStage', () => {
	it('locks the melody while arranging', () => {
		const f = approved();
		const melody = f.plan.ensemble[0].partId!;
		const score = notes(f.score, melody, 'C5');
		const guard = guardForStage(score, { stage: 'arrangement', brief: null, plan: f.plan })!;
		expect(
			judge(guard, score, { op: 'transpose', args: { semitones: 1, selection: { partIds: [melody] } } })
		).toMatch(/approved/);
	});

	it('locks the form while refining, with or without a plan', () => {
		const f = approved();
		for (const plan of [f.plan, null]) {
			const guard = guardForStage(f.score, { stage: 'refine', brief: null, plan })!;
			expect(judge(guard, f.score, { op: 'add_part', args: { name: 'Oboe', instrument: 'Oboe' } }))
				.toMatch(/not its form/);
		}
	});

	it('has no rule for the other stages', () => {
		const f = approved();
		for (const stage of ['brief', 'plan', 'melody', 'finish'] as const) {
			expect(guardForStage(f.score, { stage, brief: null, plan: f.plan })).toBeNull();
		}
	});

	it('cannot lock a melody without a plan to find it in', () => {
		const f = approved();
		expect(guardForStage(f.score, { stage: 'arrangement', brief: null, plan: null })).toBeNull();
	});
});
