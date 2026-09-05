import { describe, it, expect } from 'vitest';
import {
	emptyBrief,
	FIRST_STAGE,
	isBriefUsable,
	isStage,
	nextStage,
	pipelineOf,
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

	it('falls through for stages that have no page yet', () => {
		// Melody, arrangement, refine and finish all land in the editor until
		// each one is built. Falling through is correct; a dead link is not.
		for (const stage of ['melody', 'arrangement', 'refine', 'finish'] as const) {
			expect(stageRoute(stage)).toBeNull();
		}
	});
});
