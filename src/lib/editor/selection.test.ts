import { describe, it, expect } from 'vitest';
import { toggleSelection } from './selection.js';

/**
 * An additive click that replaces instead of adding still looks like a working
 * selection — it just loses the notes you had already picked. That is the
 * failure these guard against.
 */

const s = (...ids: string[]) => new Set(ids);

describe('toggleSelection', () => {
	it('replaces on a plain click', () => {
		expect(toggleSelection(s('a', 'b'), ['c'], false)).toEqual(s('c'));
	});

	it('clears when a plain click selects nothing', () => {
		// Clicking empty space.
		expect(toggleSelection(s('a', 'b'), [], false)).toEqual(s());
	});

	it('adds an unselected note on a modified click', () => {
		expect(toggleSelection(s('a'), ['b'], true)).toEqual(s('a', 'b'));
	});

	it('removes an already-selected note on a modified click', () => {
		// Shift-clicking something already picked is how you deselect it.
		expect(toggleSelection(s('a', 'b'), ['b'], true)).toEqual(s('a'));
	});

	it('toggles each id independently in one call', () => {
		// A rubber band over a mixed region: the ones already in the selection
		// come out, the ones outside it go in.
		expect(toggleSelection(s('a', 'b'), ['b', 'c'], true)).toEqual(s('a', 'c'));
	});

	it('adds to an empty selection', () => {
		expect(toggleSelection(s(), ['a', 'b'], true)).toEqual(s('a', 'b'));
	});

	it('is a no-op for an empty additive click', () => {
		expect(toggleSelection(s('a'), [], true)).toEqual(s('a'));
	});

	it('never mutates the set it was given', () => {
		// Svelte compares by reference to decide whether to re-render, so a
		// mutated-in-place set updates nothing.
		const before = s('a', 'b');
		const after = toggleSelection(before, ['c'], true);
		expect(before).toEqual(s('a', 'b'));
		expect(after).not.toBe(before);
	});

	it('deduplicates a repeated id on replace', () => {
		expect(toggleSelection(s(), ['a', 'a'], false)).toEqual(s('a'));
	});
});
