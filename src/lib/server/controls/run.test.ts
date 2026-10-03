import { describe, it, expect, beforeAll } from 'vitest';
import { eq } from 'drizzle-orm';
import { planToOps, withCreatedPartIds } from '$lib/pipeline/plan.js';
import { emptyPlan, type Plan } from '$lib/pipeline/types.js';
import { interpolate, runControl } from './run.js';
import { findSkill, skillBlock } from '../ai/skills.js';
import { seedControls } from '../bootstrap.js';
import { db, runMigrations } from '../db/index.js';
import { controls } from '../db/schema.js';
import { commitOps, createScore, loadScore, setPipeline } from '../scores.js';

/**
 * The pure halves of the control runtime. Dispatch itself needs a database and
 * a provider, and is covered by the end-to-end pass against the built server;
 * these are the parts where a quiet bug would be invisible there.
 */

describe('interpolate', () => {
	it('fills placeholders from params', () => {
		expect(interpolate('Darken by {{amount}}%.', { amount: 40 })).toBe('Darken by 40%.');
	});

	it('fills several, including repeats', () => {
		expect(
			interpolate('{{style}} at {{amount}}% — really {{style}}.', { style: 'Bossa nova', amount: 60 })
		).toBe('Bossa nova at 60% — really Bossa nova.');
	});

	it('tolerates whitespace inside the braces', () => {
		expect(interpolate('{{ amount }}%', { amount: 10 })).toBe('10%');
	});

	it('leaves a missing parameter visible rather than writing "undefined"', () => {
		// A stray {{amount}} in a bad output points at the misconfigured
		// control; the word "undefined" points nowhere.
		expect(interpolate('Darken by {{amount}}%.', {})).toBe('Darken by {{amount}}%.');
	});

	it('treats null as missing', () => {
		expect(interpolate('{{style}}', { style: null })).toBe('{{style}}');
	});

	it('renders zero and false, which are values rather than absences', () => {
		expect(interpolate('{{amount}}', { amount: 0 })).toBe('0');
		expect(interpolate('{{flag}}', { flag: false })).toBe('false');
	});

	it('leaves a template with no placeholders alone', () => {
		expect(interpolate('Reverse the melody.', { amount: 5 })).toBe('Reverse the melody.');
	});

	it('ignores params that match no placeholder', () => {
		expect(interpolate('{{a}}', { a: 1, unused: 2 })).toBe('1');
	});
});

describe('skillBlock', () => {
	it('fences the reference so it cannot be mistaken for the request', () => {
		const out = skillBlock({ name: 'bossa-nova', body: '  Syncopated 2-3 clave.  ' });
		expect(out).toBe('<style_reference name="bossa-nova">\nSyncopated 2-3 clave.\n</style_reference>');
	});
});

describe('findSkill', () => {
	beforeAll(() => runMigrations());

	// The index is empty in a bare test database; what matters here is that
	// lookup degrades to null rather than throwing, since a free-text style
	// that matches nothing is the normal case.
	it('returns null for an unknown style', () => {
		expect(findSkill('nonexistent-genre-xyz')).toBeNull();
	});

	it('returns null for empty input', () => {
		expect(findSkill('')).toBeNull();
		expect(findSkill('   ')).toBeNull();
	});
});

describe('the melody lock while arranging', () => {
	const user = 'lock-user';

	function arranging() {
		runMigrations();
		seedControls();
		const row = createScore(user, 'Locked');
		const plan: Plan = {
			...emptyPlan(),
			ensemble: [
				{ name: 'Flute', instrument: 'Flute' },
				{ name: 'Strings', instrument: 'String Ensemble 1' }
			],
			sections: [{ name: 'A', bars: 2, harmony: 'I', role: 'statement' }]
		};
		const before = loadScore(row.id, user).doc;
		const commit = commitOps(row.id, user, planToOps(before, plan), { source: 'user', label: 'Plan' });
		const approved = withCreatedPartIds(plan, before, commit.created);
		const [flute, strings] = approved.ensemble.map((e) => e.partId!);
		commitOps(
			row.id,
			user,
			[{ op: 'insert_notes', args: { partId: flute, notes: [{ tick: 0, dur: 480, pitches: ['C5'] }] } }],
			{ source: 'ai', label: 'Melody' }
		);
		setPipeline(row.id, user, { stage: 'arrangement', plan: { ...approved, approved: true } });
		return { scoreId: row.id, flute, strings };
	}

	function thrown(fn: () => unknown): { status?: number; body?: { message?: string } } | null {
		try {
			fn();
			return null;
		} catch (e) {
			return e as { status?: number; body?: { message?: string } };
		}
	}

	const transpose = () => db.select().from(controls).where(eq(controls.name, 'Transpose')).get()!;

	it('refuses a free control that would move the approved tune', () => {
		const { scoreId } = arranging();
		const refused = thrown(() =>
			runControl({
				controlId: transpose().id,
				scoreId,
				userId: user,
				params: { semitones: 2 },
				selection: {}
			})
		);
		// SvelteKit's error() carries the text on body, not on message.
		expect(refused?.status).toBe(400);
		expect(refused?.body?.message).toMatch(/approved in the previous stage/);
		expect(loadScore(scoreId, user).doc.parts[0].voices[0].events[0]).toMatchObject({
			pitches: [expect.objectContaining({ midi: 72 })]
		});
	});

	it('lifts the melody lock once the score moves on to refinement', () => {
		const { scoreId } = arranging();
		setPipeline(scoreId, user, { stage: 'refine' });
		const result = runControl({
			controlId: transpose().id,
			scoreId,
			userId: user,
			params: { semitones: 2 },
			selection: {}
		});
		// Refinement locks the form, not the tune: transposing is expression.
		expect(result.kind).toBe('applied');
	});

	it('allows one aimed at the accompaniment', () => {
		const { scoreId, strings } = arranging();
		commitOps(
			scoreId,
			user,
			[{ op: 'insert_notes', args: { partId: strings, notes: [{ tick: 0, dur: 480, pitches: ['C4'] }] } }],
			{ source: 'ai', label: 'Strings' }
		);
		const result = runControl({
			controlId: transpose().id,
			scoreId,
			userId: user,
			params: { semitones: 2 },
			selection: { partIds: [strings] }
		});
		expect(result.kind).toBe('applied');
	});
});
