import { describe, it, expect } from 'vitest';
import { safeFilename } from './download.js';

describe('safeFilename', () => {
	it('keeps an ordinary title readable', () => {
		expect(safeFilename('Nocturne in E flat', 'mid')).toBe('Nocturne-in-E-flat.mid');
	});

	it('strips characters a filesystem or a Content-Disposition header would fight over', () => {
		expect(safeFilename('a/b\\c:d*e?f"g<h>i|j', 'wav')).toBe('abcdefghij.wav');
	});

	it('collapses runs of whitespace', () => {
		expect(safeFilename('  Piece   Two  ', 'mid')).toBe('Piece-Two.mid');
	});

	it('never produces a leading dot, which would hide the file', () => {
		expect(safeFilename('...hidden', 'mid')).toBe('hidden.mid');
	});

	it('falls back rather than returning a bare extension', () => {
		expect(safeFilename('', 'mid')).toBe('untitled.mid');
		expect(safeFilename('///', 'mid')).toBe('untitled.mid');
	});

	it('bounds the length', () => {
		expect(safeFilename('x'.repeat(500), 'mid')).toBe(`${'x'.repeat(80)}.mid`);
	});
});
