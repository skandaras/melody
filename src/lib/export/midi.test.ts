import { describe, it, expect } from 'vitest';
import { Midi } from '@tonejs/midi';
import { scoreToMidi, scoreToMidiBuffer, scoreDurationSeconds } from './midi.js';
import { applyOps } from '$lib/score/apply';
import { isNote } from '$lib/score/query';
import { emptyScore, type Score } from '$lib/score/types';

/**
 * The serialiser is round-tripped through an independent parser (@tonejs/midi)
 * rather than checked against bytes we produced ourselves. A hand-rolled
 * encoder validated by a hand-rolled decoder proves nothing.
 */

function fixture(): Score {
	let s = emptyScore('Round Trip');
	s = applyOps(s, [
		{ op: 'add_part', args: { name: 'Piano', instrument: 'Acoustic Grand Piano' } }
	]).score;
	const partId = s.parts[0].id;
	return applyOps(s, [
		{
			op: 'insert_notes',
			args: {
				partId,
				notes: [
					{ tick: 0, dur: 480, pitches: ['C4'], vel: 80 },
					{ tick: 480, dur: 480, pitches: ['E4'], vel: 90 },
					{ tick: 960, dur: 960, pitches: ['G4', 'C5'], vel: 100 }
				]
			}
		}
	]).score;
}

const parse = (s: Score, opts?: Parameters<typeof scoreToMidi>[1]) =>
	new Midi(scoreToMidiBuffer(s, opts));

describe('scoreToMidi', () => {
	it('produces a file an independent parser accepts', () => {
		const midi = parse(fixture());
		expect(midi.header.ppq).toBe(480);
		// Conductor track plus one part track.
		expect(midi.tracks.length).toBeGreaterThanOrEqual(1);
	});

	it('round-trips note ticks and pitches', () => {
		const midi = parse(fixture());
		const notes = midi.tracks.flatMap((t) => t.notes).sort((a, b) => a.ticks - b.ticks);
		expect(notes.map((n) => n.ticks)).toEqual([0, 480, 960, 960]);
		expect(notes.map((n) => n.midi)).toEqual([60, 64, 67, 72]);
	});

	it('round-trips velocity', () => {
		const notes = parse(fixture())
			.tracks.flatMap((t) => t.notes)
			.sort((a, b) => a.ticks - b.ticks);
		// @tonejs/midi normalises velocity to 0..1.
		expect(Math.round(notes[0].velocity * 127)).toBe(80);
		expect(Math.round(notes[1].velocity * 127)).toBe(90);
	});

	it('writes the tempo map, including changes', () => {
		let s = fixture();
		s = applyOps(s, [
			{ op: 'set_tempo', args: { bpm: 90 } },
			{ op: 'set_tempo', args: { tick: 960, bpm: 140 } }
		]).score;
		const midi = parse(s);
		const bpms = midi.header.tempos.map((t) => Math.round(t.bpm));
		expect(bpms).toContain(90);
		expect(bpms).toContain(140);
	});

	it('writes time and key signatures', () => {
		let s = fixture();
		s = applyOps(s, [
			{ op: 'set_time_sig', args: { num: 3, den: 4 } },
			{ op: 'set_key', args: { tonic: 'Eb', mode: 'major' } }
		]).score;
		const midi = parse(s);
		expect(midi.header.timeSignatures[0].timeSignature).toEqual([3, 4]);
		expect(midi.header.keySignatures.length).toBeGreaterThan(0);
	});

	it('writes the GM program for a pitched part', () => {
		let s = emptyScore('P');
		s = applyOps(s, [{ op: 'add_part', args: { name: 'Vln', instrument: 'Violin' } }]).score;
		const partId = s.parts[0].id;
		s = applyOps(s, [
			{ op: 'insert_notes', args: { partId, notes: [{ tick: 0, dur: 480, pitches: ['A4'] }] } }
		]).score;
		const track = parse(s).tracks.find((t) => t.notes.length);
		expect(track?.instrument.number).toBe(40); // GM violin
	});

	it('puts a drum part on channel 9 and writes no program change', () => {
		let s = emptyScore('D');
		s = applyOps(s, [
			{ op: 'add_part', args: { name: 'Kit', instrument: 'Drum Kit', isDrum: true } }
		]).score;
		const partId = s.parts[0].id;
		s = applyOps(s, [
			{ op: 'insert_notes', args: { partId, notes: [{ tick: 0, dur: 240, pitches: ['C2'] }] } }
		]).score;
		const track = parse(s).tracks.find((t) => t.notes.length);
		expect(track?.channel).toBe(9);
	});

	it('applies part transposition to sounding pitch', () => {
		let s = fixture();
		s = applyOps(s, [
			{ op: 'set_instrument', args: { partId: s.parts[0].id, transpose: -2 } }
		]).score;
		const notes = parse(s)
			.tracks.flatMap((t) => t.notes)
			.sort((a, b) => a.ticks - b.ticks);
		expect(notes[0].midi).toBe(58); // C4 written, Bb3 sounding
	});

	it('shortens staccato notes and leaves the start alone', () => {
		let s = fixture();
		const first = s.parts[0].voices[0].events[0].id;
		s = applyOps(s, [
			{ op: 'set_articulation', args: { selection: { noteIds: [first] }, articulations: ['staccato'] } }
		]).score;
		const notes = parse(s)
			.tracks.flatMap((t) => t.notes)
			.sort((a, b) => a.ticks - b.ticks);
		expect(notes[0].ticks).toBe(0);
		expect(notes[0].durationTicks).toBeLessThan(300); // half of 480, minus rounding
	});

	it('raises velocity for an accent', () => {
		let s = fixture();
		const first = s.parts[0].voices[0].events[0].id;
		const plain = parse(s).tracks.flatMap((t) => t.notes)[0].velocity;
		s = applyOps(s, [
			{ op: 'set_articulation', args: { selection: { noteIds: [first] }, articulations: ['accent'] } }
		]).score;
		const accented = parse(s).tracks.flatMap((t) => t.notes)[0].velocity;
		expect(accented).toBeGreaterThan(plain);
	});

	it('skips muted parts by default and keeps them when asked', () => {
		let s = fixture();
		s = applyOps(s, [{ op: 'set_instrument', args: { partId: s.parts[0].id, muted: true } }]).score;
		expect(parse(s).tracks.flatMap((t) => t.notes)).toHaveLength(0);
		expect(parse(s, { skipMuted: false }).tracks.flatMap((t) => t.notes).length).toBeGreaterThan(0);
	});

	it('does not emit a second attack for a tied continuation', () => {
		let s = emptyScore('Tie');
		s = applyOps(s, [{ op: 'add_part', args: { name: 'P', instrument: 'Piano' } }]).score;
		const partId = s.parts[0].id;
		s = applyOps(s, [
			{ op: 'insert_notes', args: { partId, notes: [{ tick: 0, dur: 480, pitches: ['C4'] }] } }
		]).score;
		// Mark the pitch as a tie continuation.
		const event = s.parts[0].voices[0].events[0];
		if (!isNote(event)) throw new Error('fixture should start with a note');
		event.pitches[0].tie = 'stop';
		expect(parse(s).tracks.flatMap((t) => t.notes)).toHaveLength(0);
	});

	it('handles an empty score without producing a corrupt file', () => {
		const midi = parse(emptyScore('Empty'));
		expect(midi.tracks.flatMap((t) => t.notes)).toHaveLength(0);
		expect(midi.header.ppq).toBe(480);
	});

	it('emits a well-formed header and MTrk chunks', () => {
		const bytes = scoreToMidi(fixture());
		expect(String.fromCharCode(...bytes.slice(0, 4))).toBe('MThd');
		// Header length is always 6.
		expect([...bytes.slice(4, 8)]).toEqual([0, 0, 0, 6]);
		// Format 1.
		expect([...bytes.slice(8, 10)]).toEqual([0, 1]);
		let mtrks = 0;
		for (let i = 0; i < bytes.length - 4; i++) {
			if (String.fromCharCode(...bytes.slice(i, i + 4)) === 'MTrk') mtrks++;
		}
		expect(mtrks).toBe(2); // conductor + one part
	});
});

describe('scoreDurationSeconds', () => {
	it('is zero for an empty score', () => {
		expect(scoreDurationSeconds(emptyScore())).toBe(0);
	});

	it('computes duration at a single tempo', () => {
		const s = fixture(); // ends at tick 1920, 120bpm default
		// 1920 ticks = 4 beats; at 120bpm that is 2 seconds.
		expect(scoreDurationSeconds(s)).toBeCloseTo(2, 2);
	});

	it('honours a tempo change partway through', () => {
		let s = fixture();
		s = applyOps(s, [{ op: 'set_tempo', args: { tick: 960, bpm: 240 } }]).score;
		// First 2 beats at 120bpm = 1s, next 2 at 240bpm = 0.5s.
		expect(scoreDurationSeconds(s)).toBeCloseTo(1.5, 2);
	});
});
