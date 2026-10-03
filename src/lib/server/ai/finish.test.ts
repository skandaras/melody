import { describe, it, expect } from 'vitest';
import { approved, notes } from '$lib/pipeline/testing.js';
import { buildFinishContext, parseExplanation, parseTitles } from './finish.js';

/** The parts of naming and explaining a piece that do not need a model. */

describe('parseTitles', () => {
	it('keeps up to three, best first', () => {
		expect(parseTitles({ titles: ['Slow Light', 'Rain Line', 'Low Tide', 'Fourth'] })).toEqual([
			'Slow Light',
			'Rain Line',
			'Low Tide'
		]);
	});

	it('strips quotes the prompt asked it not to add', () => {
		expect(parseTitles({ titles: ['"Slow Light"', '“November”', "'Ash'"] })).toEqual([
			'Slow Light',
			'November',
			'Ash'
		]);
	});

	it('drops blanks, Untitled, and duplicates that differ only in case', () => {
		expect(parseTitles({ titles: ['', 'Untitled', 'Rain', 'rain', '  ', 'Snow'] })).toEqual([
			'Rain',
			'Snow'
		]);
	});

	it('returns nothing for a reply of the wrong shape', () => {
		expect(parseTitles(null)).toEqual([]);
		expect(parseTitles({ titles: 'Rain' })).toEqual([]);
		expect(parseTitles({ title: ['Rain'] })).toEqual([]);
	});
});

describe('parseExplanation', () => {
	it('trims, and treats empty as nothing', () => {
		expect(parseExplanation({ explanation: '  It modulates at bar 9.  ' })).toBe(
			'It modulates at bar 9.'
		);
		expect(parseExplanation({ explanation: '   ' })).toBeNull();
		expect(parseExplanation({})).toBeNull();
	});
});

describe('buildFinishContext', () => {
	it('shows the music, its sections and what it was asked to be', () => {
		const f = approved();
		const score = notes(f.score, f.plan.ensemble[0].partId!, 'C5', 'E5', 'G5');
		const text = buildFinishContext(score, {
			stage: 'finish',
			brief: { description: 'A walk home in the rain', mood: 'wistful' },
			plan: f.plan
		});
		expect(text).toContain('Key:');
		expect(text).toContain('Verse: ticks 0 to 7680');
		expect(text).toContain('It was asked for as: A walk home in the rain');
		expect(text).toContain('Mood: wistful');
		expect(text).toContain('Working title: Rain');
	});

	it('works for a score with no brief or plan', () => {
		const f = approved();
		const text = buildFinishContext(f.score, { stage: 'finish', brief: null, plan: null });
		expect(text).not.toContain('asked for');
		expect(text).not.toContain('Working title');
	});
});
