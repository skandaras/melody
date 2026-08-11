import { describe, it, expect } from 'vitest';
import { gainFor, type MixOverrides } from './mix.js';
import type { Part } from '$lib/score/types';

function part(id: string, over: Partial<Part> = {}): Part {
	return {
		id,
		name: id,
		gmProgram: 0,
		channel: 0,
		isDrum: false,
		clef: 'treble',
		transpose: 0,
		volume: 0.8,
		muted: false,
		voices: [],
		...over
	};
}

const none: MixOverrides = {};
const noSolo = new Set<string>();

describe('gainFor', () => {
	it('passes the document level through when nothing is muted or soloed', () => {
		expect(gainFor(part('a', { volume: 0.5 }), none, noSolo)).toBe(0.5);
	});

	it('silences a muted part', () => {
		expect(gainFor(part('a', { muted: true }), none, noSolo)).toBe(0);
	});

	it('silences everything outside the solo set', () => {
		const solo = new Set(['a']);
		expect(gainFor(part('a', { volume: 0.7 }), none, solo)).toBe(0.7);
		expect(gainFor(part('b', { volume: 0.7 }), none, solo)).toBe(0);
	});

	it('lets mute beat solo, so soloing never silently unmutes', () => {
		expect(gainFor(part('a', { muted: true }), none, new Set(['a']))).toBe(0);
	});

	it('prefers an uncommitted fader move over the document', () => {
		expect(gainFor(part('a', { volume: 0.2 }), { a: { volume: 0.9 } }, noSolo)).toBe(0.9);
	});

	it('prefers an uncommitted mute over the document, in both directions', () => {
		expect(gainFor(part('a', { muted: false }), { a: { muted: true } }, noSolo)).toBe(0);
		expect(gainFor(part('a', { muted: true, volume: 0.6 }), { a: { muted: false } }, noSolo)).toBe(
			0.6
		);
	});

	it('ignores an override aimed at a different part', () => {
		expect(gainFor(part('a', { volume: 0.4 }), { b: { volume: 0 } }, noSolo)).toBe(0.4);
	});

	it('clamps out-of-range and non-finite levels', () => {
		expect(gainFor(part('a', { volume: 4 }), none, noSolo)).toBe(1);
		expect(gainFor(part('a', { volume: -1 }), none, noSolo)).toBe(0);
		expect(gainFor(part('a', { volume: Number.NaN }), none, noSolo)).toBe(0);
	});
});
