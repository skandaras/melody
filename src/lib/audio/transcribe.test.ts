import { describe, it, expect } from 'vitest';
import {
	amplitudeToVelocity,
	estimateTempo,
	mergeAndTrim,
	notesToScore,
	quantiseNotes,
	splitAtBarlines,
	type DetectedNote
} from './transcribe.js';
import { isNote } from '$lib/score/query';
import { PPQ, type ScoreEvent } from '$lib/score/types';

/**
 * Everything here is exercised with synthetic detections rather than real
 * audio. That is deliberate: the neural network is Spotify's and is not what
 * can break here — what breaks is the tempo octave, the grid, and the bar-line
 * split, and those are all pure functions over numbers.
 */

/** A perfectly-played rhythm, so the grid answer is knowable in advance. */
function pulse(count: number, secondsPerNote: number, startAt = 0): DetectedNote[] {
	return Array.from({ length: count }, (_, i) => ({
		startTimeSeconds: startAt + i * secondsPerNote,
		durationSeconds: secondsPerNote * 0.9,
		pitchMidi: 60 + (i % 5),
		amplitude: 0.6
	}));
}

describe('estimateTempo', () => {
	it('reads a steady crotchet pulse at 120bpm', () => {
		const t = estimateTempo(pulse(16, 0.5));
		expect(t.bpm).toBeCloseTo(120, 0);
		expect(t.confidence).toBeGreaterThan(0.9);
	});

	it('reads a steady pulse at 90bpm', () => {
		expect(estimateTempo(pulse(16, 60 / 90)).bpm).toBeCloseTo(90, 0);
	});

	it('finds the pulse, not a harmonic of it', () => {
		// Quavers at 100bpm. The onsets fit a 200bpm grid just as well, so a
		// naive maximum would report 200.
		const t = estimateTempo(pulse(24, 0.3), { preferBpm: 100 });
		expect(t.bpm).toBeCloseTo(100, 0);
	});

	it('survives human timing jitter', () => {
		const jittered = pulse(20, 0.5).map((n, i) => ({
			...n,
			// Deterministic ±20ms wobble, about what a person hums to.
			startTimeSeconds: n.startTimeSeconds + Math.sin(i * 2.4) * 0.02
		}));
		const t = estimateTempo(jittered);
		expect(t.bpm).toBeGreaterThan(115);
		expect(t.bpm).toBeLessThan(125);
		expect(t.confidence).toBeGreaterThan(0.8);
	});

	it('uses preferBpm to resolve the half/double ambiguity', () => {
		const notes = pulse(16, 0.5);
		expect(estimateTempo(notes, { preferBpm: 60 }).bpm).toBeCloseTo(60, 0);
		expect(estimateTempo(notes, { preferBpm: 240, maxBpm: 260 }).bpm).toBeCloseTo(240, 0);
	});

	it('keeps the answer inside the allowed range', () => {
		const t = estimateTempo(pulse(16, 0.15), { minBpm: 50, maxBpm: 200 });
		expect(t.bpm).toBeGreaterThanOrEqual(50);
		expect(t.bpm).toBeLessThanOrEqual(200);
	});

	it('falls back rather than guessing from too little material', () => {
		const t = estimateTempo(pulse(2, 0.5));
		expect(t.bpm).toBe(120);
		expect(t.confidence).toBe(0);
	});

	it('handles no notes at all', () => {
		const t = estimateTempo([]);
		expect(t.bpm).toBe(120);
		expect(t.offsetSeconds).toBe(0);
	});

	it('reads a real melody, not just a uniform pulse', () => {
		// "Twinkle twinkle" — crotchets and a minim, with human timing.
		const beats = [0, 1, 2, 3, 4, 5, 6, 8, 9, 10, 11, 12, 13, 14];
		const lengths = [1, 1, 1, 1, 1, 1, 2, 1, 1, 1, 1, 1, 1, 2];
		const pitches = [60, 60, 67, 67, 69, 69, 67, 65, 65, 64, 64, 62, 62, 60];
		const melody = (bpm: number): DetectedNote[] =>
			beats.map((b, i) => ({
				startTimeSeconds: (b * 60) / bpm + Math.sin(i * 2.4) * 0.02,
				durationSeconds: ((lengths[i] * 60) / bpm) * 0.9,
				pitchMidi: pitches[i],
				amplitude: 0.5 + (i % 3) * 0.15
			}));
		for (const bpm of [72, 100, 132]) {
			expect(estimateTempo(melody(bpm)).bpm).toBeCloseTo(bpm, 0);
		}
		// A known limitation, pinned rather than hidden: with no hint, a fast
		// tempo is reported at half speed, because the default preference sits
		// near 100 and the rhythm alone cannot distinguish the two. Telling it
		// what to expect resolves it — which is why the UI offers a tempo field.
		expect(estimateTempo(melody(168)).bpm).toBeCloseTo(84, 0);
		expect(estimateTempo(melody(168), { preferBpm: 168 }).bpm).toBeCloseTo(168, 0);
	});

	it('reports a grid offset at or before the first note', () => {
		const t = estimateTempo(pulse(16, 0.5, 1.75));
		expect(t.offsetSeconds).toBeLessThanOrEqual(1.75 + 0.25);
	});
});

describe('quantiseNotes', () => {
	it('snaps a clean crotchet pulse onto beat boundaries', () => {
		const q = quantiseNotes(pulse(4, 0.5), { bpm: 120 });
		expect(q.map((n) => n.tick)).toEqual([0, 480, 960, 1440]);
	});

	it('pulls slightly-early and slightly-late notes onto the grid', () => {
		const q = quantiseNotes(
			[
				{ startTimeSeconds: 0.02, durationSeconds: 0.5, pitchMidi: 60, amplitude: 0.5 },
				{ startTimeSeconds: 0.48, durationSeconds: 0.5, pitchMidi: 62, amplitude: 0.5 }
			],
			{ bpm: 120 }
		);
		expect(q.map((n) => n.tick)).toEqual([0, 480]);
	});

	it('honours the grid setting', () => {
		// A note an off-beat quaver late lands on the quaver grid but is pulled
		// to the beat by a crotchet grid.
		const n = [{ startTimeSeconds: 0.25, durationSeconds: 0.25, pitchMidi: 60, amplitude: 0.5 }];
		expect(quantiseNotes(n, { bpm: 120, grid: 8 })[0].tick).toBe(240);
		expect(quantiseNotes(n, { bpm: 120, grid: 4 })[0].tick).toBe(480);
	});

	it('can snap to triplets when asked, and not when not', () => {
		// A quaver triplet at 120bpm is 1/3 of a beat: 0.1667s, 160 ticks.
		const n = [{ startTimeSeconds: 1 / 6, durationSeconds: 1 / 6, pitchMidi: 60, amplitude: 0.5 }];
		expect(quantiseNotes(n, { bpm: 120, grid: 8, triplets: true })[0].tick).toBe(160);
		expect(quantiseNotes(n, { bpm: 120, grid: 8, triplets: false })[0].tick).toBe(240);
	});

	it('applies the grid offset so an anacrusis does not shift everything', () => {
		const q = quantiseNotes(pulse(2, 0.5, 3.0), { bpm: 120, offsetSeconds: 3.0 });
		expect(q.map((n) => n.tick)).toEqual([0, 480]);
	});

	it('never emits a negative tick', () => {
		const q = quantiseNotes(
			[{ startTimeSeconds: 0, durationSeconds: 0.5, pitchMidi: 60, amplitude: 0.5 }],
			{ bpm: 120, offsetSeconds: 5 }
		);
		expect(q[0].tick).toBe(0);
	});

	it('keeps a too-short detection as one grid unit rather than dropping it', () => {
		const q = quantiseNotes(
			[{ startTimeSeconds: 0, durationSeconds: 0.001, pitchMidi: 60, amplitude: 0.5 }],
			{ bpm: 120, grid: 16 }
		);
		expect(q).toHaveLength(1);
		expect(q[0].dur).toBe(120);
	});

	it('discards pitches outside the MIDI range', () => {
		const q = quantiseNotes(
			[
				{ startTimeSeconds: 0, durationSeconds: 0.5, pitchMidi: 200, amplitude: 0.5 },
				{ startTimeSeconds: 0, durationSeconds: 0.5, pitchMidi: 60, amplitude: 0.5 }
			],
			{ bpm: 120 }
		);
		expect(q.map((n) => n.midi)).toEqual([60]);
	});
});

describe('amplitudeToVelocity', () => {
	it('maps the range onto something audible', () => {
		expect(amplitudeToVelocity(0)).toBe(45);
		expect(amplitudeToVelocity(1)).toBe(118);
		expect(amplitudeToVelocity(0.5)).toBeGreaterThan(amplitudeToVelocity(0.2));
	});

	it('does not produce a silent or out-of-range velocity from bad input', () => {
		for (const bad of [Number.NaN, -5, 99]) {
			const v = amplitudeToVelocity(bad);
			expect(v).toBeGreaterThan(0);
			expect(v).toBeLessThanOrEqual(127);
		}
	});
});

describe('mergeAndTrim', () => {
	it('merges notes on the same tick into one chord', () => {
		const chords = mergeAndTrim([
			{ tick: 0, dur: 480, midi: 64, vel: 80 },
			{ tick: 0, dur: 480, midi: 60, vel: 80 },
			{ tick: 480, dur: 480, midi: 67, vel: 80 }
		]);
		expect(chords).toHaveLength(2);
		expect(chords[0].map((n) => n.midi)).toEqual([60, 64]); // sorted low to high
	});

	it('drops a duplicate pitch on the same tick', () => {
		const chords = mergeAndTrim([
			{ tick: 0, dur: 480, midi: 60, vel: 80 },
			{ tick: 0, dur: 240, midi: 60, vel: 80 }
		]);
		expect(chords[0]).toHaveLength(1);
	});

	it('truncates a note that runs into the next one', () => {
		const chords = mergeAndTrim([
			{ tick: 0, dur: 960, midi: 60, vel: 80 },
			{ tick: 480, dur: 480, midi: 62, vel: 80 }
		]);
		expect(chords[0][0].dur).toBe(480);
		expect(chords[1][0].dur).toBe(480);
	});

	it('leaves a gap alone rather than stretching into it', () => {
		const chords = mergeAndTrim([
			{ tick: 0, dur: 240, midi: 60, vel: 80 },
			{ tick: 960, dur: 240, midi: 62, vel: 80 }
		]);
		expect(chords[0][0].dur).toBe(240);
	});
});

describe('splitAtBarlines', () => {
	const note = (tick: number, dur: number): ScoreEvent => ({
		id: 'n1',
		kind: 'note',
		tick,
		dur,
		pitches: [{ midi: 60 }],
		vel: 80
	});

	it('leaves a note inside one bar untouched', () => {
		const out = splitAtBarlines([note(0, 480)], 1920);
		expect(out).toHaveLength(1);
		expect(out[0].id).toBe('n1');
	});

	it('splits a note crossing a bar line and ties the halves', () => {
		const out = splitAtBarlines([note(1440, 960)], 1920);
		expect(out.map((e) => [e.tick, e.dur])).toEqual([
			[1440, 480],
			[1920, 480]
		]);
		expect(out.every(isNote)).toBe(true);
		if (isNote(out[0]) && isNote(out[1])) {
			expect(out[0].pitches[0].tie).toBe('start');
			expect(out[1].pitches[0].tie).toBe('stop');
		}
	});

	it('ties the middle of a note spanning three bars', () => {
		const out = splitAtBarlines([note(0, 1920 * 3)], 1920);
		expect(out).toHaveLength(3);
		if (isNote(out[1])) expect(out[1].pitches[0].tie).toBe('both');
	});

	it('gives the split halves distinct ids', () => {
		const ids = splitAtBarlines([note(1440, 1920)], 1920).map((e) => e.id);
		expect(new Set(ids).size).toBe(ids.length);
	});

	it('splits rests without inventing pitches', () => {
		const out = splitAtBarlines([{ id: 'r1', kind: 'rest', tick: 1440, dur: 960 }], 1920);
		expect(out).toHaveLength(2);
		expect(out.every((e) => e.kind === 'rest')).toBe(true);
	});

	it('preserves total duration', () => {
		const total = (es: ScoreEvent[]) => es.reduce((s, e) => s + e.dur, 0);
		expect(total(splitAtBarlines([note(700, 5000)], 1920))).toBe(5000);
	});
});

describe('notesToScore', () => {
	it('produces a playable score from a clean pulse', () => {
		const { score, noteCount } = notesToScore(pulse(8, 0.5), { bpm: 120 });
		expect(score.parts).toHaveLength(1);
		expect(noteCount).toBe(8);
		expect(score.tempoMap[0].bpm).toBe(120);
		const notes = score.parts[0].voices[0].events.filter(isNote);
		expect(notes.length).toBeGreaterThanOrEqual(8);
		expect(notes[0].tick).toBe(0);
	});

	it('fills silence with rests so the voice stays continuous', () => {
		const { score } = notesToScore(
			[
				{ startTimeSeconds: 0, durationSeconds: 0.4, pitchMidi: 60, amplitude: 0.6 },
				{ startTimeSeconds: 2, durationSeconds: 0.4, pitchMidi: 62, amplitude: 0.6 }
			],
			{ bpm: 120 }
		);
		const events = score.parts[0].voices[0].events;
		expect(events.some((e) => e.kind === 'rest')).toBe(true);
		// No holes: each event starts where the previous one ended.
		let cursor = 0;
		for (const e of events) {
			expect(e.tick).toBe(cursor);
			cursor = e.tick + e.dur;
		}
	});

	it('ends on a bar line', () => {
		const { score } = notesToScore(pulse(3, 0.5), { bpm: 120 });
		const events = score.parts[0].voices[0].events;
		const end = events.at(-1)!.tick + events.at(-1)!.dur;
		expect(end % (PPQ * 4)).toBe(0);
	});

	it('detects the key from what was sung', () => {
		// A G major scale.
		const scale = [67, 69, 71, 72, 74, 76, 78, 79].map((midi, i) => ({
			startTimeSeconds: i * 0.5,
			durationSeconds: 0.45,
			pitchMidi: midi,
			amplitude: 0.6
		}));
		const { score } = notesToScore(scale, { bpm: 120 });
		expect(score.keySigs[0].fifths).toBe(1); // one sharp
		expect(score.keySigs[0].mode).toBe('major');
	});

	it('picks bass clef for low material', () => {
		const low = pulse(8, 0.5).map((n) => ({ ...n, pitchMidi: n.pitchMidi - 24 }));
		expect(notesToScore(low, { bpm: 120 }).score.parts[0].clef).toBe('bass');
	});

	it('prefers an explicit bpm over the estimate', () => {
		const { score, tempo } = notesToScore(pulse(16, 0.5), { bpm: 76 });
		expect(score.tempoMap[0].bpm).toBe(76);
		expect(tempo.confidence).toBe(1);
	});

	it('estimates the tempo when none is given', () => {
		const { score } = notesToScore(pulse(16, 60 / 90));
		expect(score.tempoMap[0].bpm).toBeCloseTo(90, 0);
	});

	it('honours a requested time signature when padding the last bar', () => {
		const { score } = notesToScore(pulse(2, 0.5), { bpm: 120, timeSig: { num: 3, den: 4 } });
		expect(score.timeSigs[0]).toMatchObject({ num: 3, den: 4 });
		const events = score.parts[0].voices[0].events;
		const end = events.at(-1)!.tick + events.at(-1)!.dur;
		expect(end % (PPQ * 3)).toBe(0);
	});

	it('returns an empty but valid score when nothing was detected', () => {
		const { score, noteCount } = notesToScore([]);
		expect(noteCount).toBe(0);
		expect(score.parts).toHaveLength(1);
		expect(score.parts[0].voices[0].events).toHaveLength(0);
	});

	it('gives every event a unique id', () => {
		const { score } = notesToScore(pulse(24, 0.35), { bpm: 120 });
		const ids = score.parts[0].voices[0].events.map((e) => e.id);
		expect(new Set(ids).size).toBe(ids.length);
	});
});
