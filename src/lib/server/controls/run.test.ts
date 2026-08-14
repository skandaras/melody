import { describe, it, expect, beforeAll } from 'vitest';
import { interpolate } from './run.js';
import { findSkill, skillBlock } from '../ai/skills.js';
import { runMigrations } from '../db/index.js';

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
