import { describe, it, expect } from 'vitest';
import { normalise, peakLevel } from './capture.js';

/**
 * Only the sample-level maths is covered here. getUserMedia, MediaRecorder and
 * OfflineAudioContext are browser plumbing with no logic of ours in them —
 * mocking them would test the mocks.
 */

const buf = (...values: number[]) => Float32Array.from(values);

describe('peakLevel', () => {
	it('finds the largest magnitude, sign-independent', () => {
		expect(peakLevel(buf(0.1, -0.8, 0.3))).toBeCloseTo(0.8);
	});

	it('is zero for silence and for nothing', () => {
		expect(peakLevel(buf(0, 0, 0))).toBe(0);
		expect(peakLevel(buf())).toBe(0);
	});
});

describe('normalise', () => {
	it('lifts a quiet take toward full scale', () => {
		// 0.1 needs 9.5x, comfortably inside the gain cap.
		expect(peakLevel(normalise(buf(0.1, -0.1, 0.05)))).toBeCloseTo(0.95, 2);
	});

	it('caps the gain so room tone is not amplified into notes', () => {
		// A peak of 0.001 would need 950x to reach full scale; it gets 12x.
		expect(peakLevel(normalise(buf(0.001, -0.001), 12))).toBeCloseTo(0.012, 3);
		// 0.05 needs 19x, so it too is capped rather than reaching 0.95.
		expect(peakLevel(normalise(buf(0.05, -0.05), 12))).toBeCloseTo(0.6, 2);
	});

	it('barely touches an already-loud take', () => {
		expect(peakLevel(normalise(buf(0.9, -0.94)))).toBeCloseTo(0.95, 2);
	});

	it('skips the work entirely when the gain would be negligible', () => {
		// Inside the deadband, the input is handed straight back rather than
		// copied — a few minutes of audio is tens of megabytes.
		const input = buf(0.5, -0.95);
		expect(normalise(input)).toBe(input);
	});

	it('does not divide by zero on silence', () => {
		const input = buf(0, 0);
		expect(normalise(input)).toBe(input);
	});

	it('preserves relative levels and shape', () => {
		const out = normalise(buf(0.1, 0.05, -0.1));
		expect(out[1] / out[0]).toBeCloseTo(0.5, 5);
		expect(out[2]).toBeLessThan(0);
		expect(out).toHaveLength(3);
	});
});
