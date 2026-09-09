import { describe, it, expect } from 'vitest';
import {
	emptyBrief,
	FIRST_STAGE,
	isBriefUsable,
	furthest,
	isStage,
	nextStage,
	pipelineOf,
	stagePath,
	stageRoute,
	STAGES,
	type Stage
} from './types.js';

/**
 * Every score in an existing install predates these columns, so the upgrade
 * path is the normal case rather than an edge one.
 */

describe('stages', () => {
	it('runs brief through finish in order', () => {
		expect([...STAGES]).toEqual(['brief', 'plan', 'melody', 'arrangement', 'refine', 'finish']);
		expect(FIRST_STAGE).toBe('brief');
	});

	it('walks forward and stops at the end', () => {
		let stage: Stage | null = FIRST_STAGE;
		const walked: Stage[] = [];
		while (stage) {
			walked.push(stage);
			stage = nextStage(stage);
		}
		expect(walked).toEqual([...STAGES]);
	});

	it('recognises only real stages', () => {
		expect(isStage('melody')).toBe(true);
		expect(isStage('composing')).toBe(false);
		expect(isStage(null)).toBe(false);
		expect(isStage(3)).toBe(false);
	});
});

describe('pipelineOf', () => {
	it('reads a row that predates the pipeline as being at the brief', () => {
		// Which is true rather than a placeholder: nobody has taken it anywhere.
		expect(pipelineOf({})).toEqual({ stage: 'brief', brief: null, plan: null });
	});

	it('treats nulls the same as absent', () => {
		expect(pipelineOf({ stage: null, brief: null, plan: null }).stage).toBe('brief');
	});

	it('falls back rather than trusting a stage it does not know', () => {
		// The column is plain text, so a hand-edited or downgraded row can hold
		// anything. Reading it back as a stage that does not exist would break
		// every consumer downstream instead of here.
		expect(pipelineOf({ stage: 'nonsense' }).stage).toBe('brief');
	});

	it('reads stored state back unchanged', () => {
		const brief = { description: 'A slow waltz', seedRole: 'theme' as const };
		expect(pipelineOf({ stage: 'melody', brief, plan: null })).toEqual({
			stage: 'melody',
			brief,
			plan: null
		});
	});
});

describe('isBriefUsable', () => {
	it('rejects nothing at all', () => {
		expect(isBriefUsable(null)).toBe(false);
		expect(isBriefUsable(undefined)).toBe(false);
		expect(isBriefUsable(emptyBrief())).toBe(false);
	});

	it('rejects whitespace, which looks like a description and is not one', () => {
		expect(isBriefUsable({ description: '   \n\t ' })).toBe(false);
	});

	it('accepts a description', () => {
		expect(isBriefUsable({ description: 'Something with a walking bass' })).toBe(true);
	});

	it('accepts a hummed seed with no words at all', () => {
		// Humming eight bars is a complete brief; requiring prose as well would
		// make the audio path worse than it is today.
		expect(isBriefUsable({ description: '', seedPartId: 'p1' })).toBe(true);
	});
});

describe('stageRoute', () => {
	it('never routes the brief, which is every legacy score', () => {
		// The single most important line in the routing rule. `brief` is the
		// column default, so a score that predates the pipeline reads as being
		// at it — sending those to a stage page would strand every existing
		// score behind a form asking what it should be.
		expect(stageRoute('brief')).toBeNull();
		expect(FIRST_STAGE).toBe('brief');
		expect(stageRoute(FIRST_STAGE)).toBeNull();
	});

	it('routes the plan to its own page', () => {
		expect(stageRoute('plan')).toBe('plan');
	});

	it('routes the melody to its own page', () => {
		expect(stageRoute('melody')).toBe('melody');
	});

	it('routes the arrangement to its own page', () => {
		expect(stageRoute('arrangement')).toBe('arrangement');
	});

	it('routes every stage but the brief, now all six pages exist', () => {
		for (const stage of ['plan', 'melody', 'arrangement', 'refine', 'finish'] as const) {
			expect(stageRoute(stage)).toBe(stage);
		}
	});
});

describe('stagePath', () => {
	it('gives every stage a page, including the brief', () => {
		// The distinction the stepper rests on. `stageRoute` answers "where is a
		// score sitting here sent", and excludes the brief so legacy scores are
		// never routed into the flow. This answers "where does this stage's page
		// live", and the brief has one — it is simply never a redirect target.
		expect(stagePath('abc', 'brief')).toBe('/score/abc/brief');
		expect(stageRoute('brief')).toBeNull();
	});

	it('agrees with the routing table wherever that table has an opinion', () => {
		// Two functions, one truth: a stage that redirects somewhere must redirect
		// to the page it actually has, or the stepper and the redirect disagree.
		for (const stage of STAGES) {
			const segment = stageRoute(stage);
			if (segment) expect(stagePath('abc', stage)).toBe(`/score/abc/${segment}`);
		}
	});
});

describe('furthest', () => {
	it('keeps the later of two stages', () => {
		expect(furthest('melody', 'finish')).toBe('finish');
		expect(furthest('finish', 'melody')).toBe('finish');
	});

	it('is stable for the same stage', () => {
		for (const stage of STAGES) expect(furthest(stage, stage)).toBe(stage);
	});

	it('never goes backwards, whichever way round it is asked', () => {
		// The property the approve handlers depend on. Re-entering the melody of a
		// finished piece and approving it must not rewind the score three stages,
		// which is exactly what a bare assignment would do once the stepper made
		// walking backwards possible.
		for (const a of STAGES) {
			for (const b of STAGES) {
				const later = STAGES.indexOf(a) > STAGES.indexOf(b) ? a : b;
				expect(furthest(a, b)).toBe(later);
				expect(furthest(b, a)).toBe(later);
			}
		}
	});
});
