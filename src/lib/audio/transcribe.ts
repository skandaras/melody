import { detectKey } from '$lib/score/analyse';
import { IdFactory } from '$lib/score/ids';
import { measureTicks } from '$lib/score/measures';
import { gmProgramFor } from '$lib/score/instruments';
import {
	PPQ,
	emptyScore,
	type Clef,
	type Note,
	type Score,
	type ScoreEvent,
	type TimeSig
} from '$lib/score/types';

/**
 * Turning detected pitches into notation.
 *
 * This module is deliberately pure — no TensorFlow, no AudioContext, no DOM.
 * The model runs in basic-pitch.ts and hands its output here as plain numbers,
 * because everything genuinely difficult about transcription happens *after*
 * pitch detection: guessing the tempo, choosing a grid, deciding what is a
 * chord and what is two notes, and splitting notes that cross a bar line.
 * Those are the parts that need tests, and they cannot be tested through a
 * neural network.
 *
 * The output is a playable, editable Score before any AI call is made. That is
 * the point: transcription has to work with no API key and no network.
 */

/** A note as basic-pitch reports it. Structurally its `NoteEventTime`, but
 *  declared here so this module imports nothing from the package. */
export interface DetectedNote {
	startTimeSeconds: number;
	durationSeconds: number;
	pitchMidi: number;
	/** 0..1. */
	amplitude: number;
	pitchBends?: number[];
}

export interface TempoGuess {
	bpm: number;
	/** Where the grid starts, in seconds. Usually a little before the first note. */
	offsetSeconds: number;
	/** 0..1: how tightly the onsets sit on the inferred grid. */
	confidence: number;
}

export const DEFAULT_BPM = 120;

/**
 * Estimate tempo from note onsets.
 *
 * The trick is that the onsets of a rhythm are a spike train, so the strength
 * of a candidate grid is the magnitude of a single DFT bin at that grid's
 * frequency — and its phase falls out of the same sum, which is what we need
 * for quantisation. That avoids searching phase separately.
 *
 * The catch is that grid alignment survives refinement: anything sitting on a
 * crotchet grid also sits on a quaver grid, so the raw maximum always runs to
 * the fastest candidate. We therefore take the *coarsest* grid that scores
 * near the maximum, which is the fundamental pulse rather than a harmonic of
 * it.
 *
 * Even then, whether a 0.25s pulse means quavers at 120 or crotchets at 240 is
 * genuinely ambiguous from timing alone. The multiplier is chosen to land the
 * answer nearest `preferBpm`, and the UI offers a manual override — a tapped
 * or typed tempo is always better than a guess, so this is a fallback rather
 * than the primary path.
 */
export function estimateTempo(
	notes: DetectedNote[],
	opts: { preferBpm?: number; minBpm?: number; maxBpm?: number } = {}
): TempoGuess {
	const prefer = opts.preferBpm ?? 100;
	const minBpm = opts.minBpm ?? 50;
	const maxBpm = opts.maxBpm ?? 200;

	const onsets = notes
		.filter((n) => Number.isFinite(n.startTimeSeconds))
		.map((n) => ({ t: n.startTimeSeconds, w: Math.max(0.05, Math.min(1, n.amplitude || 0.5)) }))
		.sort((a, b) => a.t - b.t);

	if (onsets.length < 3) {
		return {
			bpm: DEFAULT_BPM,
			offsetSeconds: onsets[0]?.t ?? 0,
			confidence: 0
		};
	}

	// Candidate pulse periods, swept geometrically so slow and fast tempi get
	// the same relative resolution.
	const RATIO = 1.002;
	const steps: number[] = [];
	for (let step = 0.1; step <= 1.3; step *= RATIO) steps.push(step);
	const strengths = steps.map((s) => gridFit(onsets, s).strength);

	const peak = Math.max(...strengths);
	if (peak <= 0) {
		return { bpm: DEFAULT_BPM, offsetSeconds: onsets[0].t, confidence: 0 };
	}

	// Choosing the fundamental and locating it are two different jobs, and one
	// threshold cannot do both: loose enough to survive human timing, it also
	// accepts the shoulder of a peak and reads consistently flat. So select
	// among *local maxima* — a grid of period T peaks at T, T/2, T/3 and never
	// at 2T, so the slowest peak is the pulse — and then interpolate to find
	// where that peak actually sits.
	let index = strengths.indexOf(peak);
	for (let i = 1; i < steps.length - 1; i++) {
		if (strengths[i] < peak * 0.9) continue;
		if (strengths[i] >= strengths[i - 1] && strengths[i] >= strengths[i + 1]) index = i;
	}

	const refined = refinePeak(steps, strengths, index, RATIO);
	const fundamental = { step: refined, ...gridFit(onsets, refined) };

	let bpm = 60 / fundamental.step;
	// Fold into range, then pick the octave nearest the preferred tempo.
	while (bpm < minBpm) bpm *= 2;
	while (bpm > maxBpm) bpm /= 2;
	for (const alt of [bpm / 2, bpm * 2]) {
		if (alt >= minBpm && alt <= maxBpm && Math.abs(alt - prefer) < Math.abs(bpm - prefer)) {
			bpm = alt;
		}
	}

	return {
		bpm: Math.round(bpm * 10) / 10,
		// Fold the phase back to the first onset so the grid starts at or before
		// the music rather than a whole pulse early.
		offsetSeconds: foldOffset(fundamental.phase, fundamental.step, onsets[0].t),
		confidence: Number(fundamental.strength.toFixed(3))
	};
}

/**
 * Sub-step peak location by fitting a parabola through the winning candidate
 * and its two neighbours.
 *
 * The sweep is geometric, so the fit is done in log space where the samples
 * are evenly spaced. Without this the answer is only as precise as the sweep —
 * around half a bpm at 120 — which is enough to make a quantised transcription
 * drift audibly over sixteen bars.
 */
function refinePeak(steps: number[], strengths: number[], index: number, ratio: number): number {
	if (index <= 0 || index >= steps.length - 1) return steps[index];
	const [a, b, c] = [strengths[index - 1], strengths[index], strengths[index + 1]];
	const denom = a - 2 * b + c;
	if (denom === 0) return steps[index];
	const delta = (0.5 * (a - c)) / denom;
	// A vertex further than one sample away means the parabola did not fit;
	// trust the sample rather than an extrapolation.
	if (!Number.isFinite(delta) || Math.abs(delta) > 1) return steps[index];
	return steps[index] * Math.pow(ratio, delta);
}

/**
 * How well weighted onsets fit a grid of the given period, plus where that
 * grid starts. Magnitude and argument of one DFT bin.
 */
function gridFit(
	onsets: { t: number; w: number }[],
	step: number
): { strength: number; phase: number } {
	let re = 0;
	let im = 0;
	let total = 0;
	for (const { t, w } of onsets) {
		const theta = (2 * Math.PI * t) / step;
		re += w * Math.cos(theta);
		im += w * Math.sin(theta);
		total += w;
	}
	if (total === 0) return { strength: 0, phase: 0 };
	const strength = Math.hypot(re, im) / total;
	// atan2 gives the angle of the weighted mean onset within the period.
	let phase = (Math.atan2(im, re) / (2 * Math.PI)) * step;
	if (phase < 0) phase += step;
	return { strength, phase };
}

/** Shift a phase back by whole periods until it is at or before the first onset. */
function foldOffset(phase: number, step: number, firstOnset: number): number {
	let offset = phase;
	while (offset > firstOnset + step / 2) offset -= step;
	return offset;
}

export interface QuantiseOptions {
	bpm?: number;
	offsetSeconds?: number;
	/** Grid denominator: 4 crotchet, 8 quaver, 16 semiquaver, 32 demisemiquaver. */
	grid?: number;
	/** Also allow triplet subdivisions of the grid. */
	triplets?: boolean;
	ppq?: number;
}

export interface QuantisedNote {
	tick: number;
	dur: number;
	midi: number;
	vel: number;
}

/**
 * Seconds → ticks, snapped to a musical grid.
 *
 * Notes shorter than one grid unit are kept at one unit rather than dropped:
 * a clipped detection is still a note the user sang, and deleting it silently
 * is worse than notating it slightly long.
 */
export function quantiseNotes(notes: DetectedNote[], opts: QuantiseOptions = {}): QuantisedNote[] {
	const ppq = opts.ppq ?? PPQ;
	const bpm = opts.bpm && opts.bpm > 0 ? opts.bpm : DEFAULT_BPM;
	const offset = opts.offsetSeconds ?? 0;
	const unit = (ppq * 4) / (opts.grid ?? 16);
	// A triplet of the grid value: three in the space of two.
	const units = opts.triplets ? [unit, (unit * 2) / 3] : [unit];
	const ticksPerSecond = (bpm / 60) * ppq;

	return notes
		.filter((n) => Number.isFinite(n.pitchMidi) && n.pitchMidi >= 0 && n.pitchMidi <= 127)
		.map((n) => {
			const startTicks = (n.startTimeSeconds - offset) * ticksPerSecond;
			const tick = Math.max(0, snap(startTicks, units));
			const dur = Math.max(unit, snap(n.durationSeconds * ticksPerSecond, units));
			return {
				tick,
				dur,
				midi: Math.round(n.pitchMidi),
				vel: amplitudeToVelocity(n.amplitude)
			};
		})
		.sort((a, b) => a.tick - b.tick || a.midi - b.midi);
}

/** Nearest multiple of any of the given units. */
function snap(value: number, units: number[]): number {
	let best = Math.round(value / units[0]) * units[0];
	let bestErr = Math.abs(value - best);
	for (const u of units.slice(1)) {
		const c = Math.round(value / u) * u;
		const err = Math.abs(value - c);
		if (err < bestErr) {
			best = c;
			bestErr = err;
		}
	}
	return Math.round(best);
}

/**
 * basic-pitch amplitudes cluster low and rarely approach 1, so mapping them
 * straight to 0-127 produces a score that plays back almost inaudibly. This
 * maps the useful part of the range onto mp-to-ff instead.
 */
export function amplitudeToVelocity(amplitude: number): number {
	const a = Number.isFinite(amplitude) ? Math.max(0, Math.min(1, amplitude)) : 0.5;
	return Math.round(45 + a * 73);
}

/**
 * Simultaneous notes become one chord.
 *
 * A Voice is a single line: two overlapping notes in it are a chord, not two
 * events. Anything landing on the same tick after quantisation was sung or
 * played together, so it is merged; a note still sounding when the next one
 * starts is truncated, because a monophonic line cannot overlap itself.
 */
export function mergeAndTrim(quantised: QuantisedNote[]): QuantisedNote[][] {
	const byTick = new Map<number, QuantisedNote[]>();
	for (const n of quantised) {
		const at = byTick.get(n.tick);
		if (at) {
			// The same pitch twice on one tick is a detection artefact.
			if (!at.some((x) => x.midi === n.midi)) at.push(n);
		} else {
			byTick.set(n.tick, [n]);
		}
	}

	const chords = [...byTick.entries()]
		.sort((a, b) => a[0] - b[0])
		.map(([, group]) => group.sort((a, b) => a.midi - b.midi));

	for (let i = 0; i < chords.length - 1; i++) {
		const nextTick = chords[i + 1][0].tick;
		for (const n of chords[i]) {
			n.dur = Math.min(n.dur, nextTick - n.tick);
		}
	}
	return chords.filter((c) => c[0].dur > 0);
}

/**
 * Split notes that cross a bar line into tied halves.
 *
 * Without this a transcription engraves as notes hanging over bar lines, which
 * is not notation anyone would accept — and the user asked for proper musical
 * notation, so it is not an optional polish step.
 */
export function splitAtBarlines(events: ScoreEvent[], barTicks: number): ScoreEvent[] {
	if (barTicks <= 0) return events;
	const out: ScoreEvent[] = [];
	for (const e of events) {
		let tick = e.tick;
		let remaining = e.dur;
		let first = true;
		while (remaining > 0) {
			const untilBar = barTicks - (tick % barTicks);
			const take = Math.min(remaining, untilBar);
			const last = take === remaining;
			if (e.kind === 'rest') {
				out.push({ ...e, id: first ? e.id : `${e.id}x${tick}`, tick, dur: take });
			} else {
				out.push({
					...e,
					id: first ? e.id : `${e.id}x${tick}`,
					tick,
					dur: take,
					pitches: e.pitches.map((p) => ({
						...p,
						tie: last ? (first ? p.tie : 'stop') : first ? 'start' : 'both'
					}))
				});
			}
			tick += take;
			remaining -= take;
			first = false;
		}
	}
	return out;
}

export interface TranscribeOptions extends QuantiseOptions {
	title?: string;
	partName?: string;
	instrument?: string;
	clef?: Clef;
	timeSig?: { num: number; den: number };
	/** Skip tempo estimation and use this. A tapped or typed tempo always wins. */
	bpm?: number;
	/** Nudge the tempo estimate toward what the user expects. */
	preferBpm?: number;
}

export interface TranscriptionResult {
	score: Score;
	tempo: TempoGuess;
	/** How many detected notes survived merging — useful for a "did that work?" hint. */
	noteCount: number;
}

/**
 * Detected pitches → a complete, playable Score.
 *
 * Everything here is reversible by hand afterwards. The whole design assumes
 * the first result is a draft: the user edits it, or asks the model to neaten
 * it, and both paths go through the same ops registry as any other edit.
 */
export function notesToScore(
	detected: DetectedNote[],
	opts: TranscribeOptions = {}
): TranscriptionResult {
	const ppq = opts.ppq ?? PPQ;
	const tempo =
		opts.bpm && opts.bpm > 0
			? { bpm: opts.bpm, offsetSeconds: opts.offsetSeconds ?? 0, confidence: 1 }
			: estimateTempo(detected, { preferBpm: opts.preferBpm });

	const score = emptyScore(opts.title ?? 'Transcription');
	score.ppq = ppq;
	score.tempoMap = [{ tick: 0, bpm: tempo.bpm }];
	const sig: TimeSig = { tick: 0, num: opts.timeSig?.num ?? 4, den: opts.timeSig?.den ?? 4 };
	score.timeSigs = [sig];

	const chords = mergeAndTrim(
		quantiseNotes(detected, {
			...opts,
			ppq,
			bpm: tempo.bpm,
			offsetSeconds: opts.offsetSeconds ?? tempo.offsetSeconds
		})
	);

	const ids = new IdFactory();
	const unit = (ppq * 4) / (opts.grid ?? 16);
	const events: ScoreEvent[] = [];
	let cursor = 0;
	for (const chord of chords) {
		const tick = chord[0].tick;
		// Silence between notes is a rest, not a gap — a voice has to be
		// continuous or the engraving is wrong.
		if (tick - cursor >= unit) {
			events.push({ id: ids.next('rest'), kind: 'rest', tick: cursor, dur: tick - cursor });
		}
		const note: Note = {
			id: ids.next('note'),
			kind: 'note',
			tick,
			dur: Math.max(...chord.map((c) => c.dur)),
			pitches: chord.map((c) => ({ midi: c.midi })),
			vel: Math.round(chord.reduce((s, c) => s + c.vel, 0) / chord.length)
		};
		events.push(note);
		cursor = note.tick + note.dur;
	}

	// Pad the last bar so the score ends on a bar line rather than mid-measure.
	const barTicks = measureTicks(ppq, sig);
	if (cursor > 0 && cursor % barTicks !== 0) {
		const pad = barTicks - (cursor % barTicks);
		events.push({ id: ids.next('rest'), kind: 'rest', tick: cursor, dur: pad });
	}

	const instrument = opts.instrument ?? 'Acoustic Grand Piano';
	score.parts = [
		{
			id: ids.next('part'),
			name: opts.partName ?? instrument,
			gmProgram: gmProgramFor(instrument),
			channel: 0,
			isDrum: false,
			clef: opts.clef ?? clefForRange(chords.flat().map((c) => c.midi)),
			transpose: 0,
			volume: 0.8,
			muted: false,
			voices: [{ id: ids.next('voice'), events: splitAtBarlines(events, barTicks) }]
		}
	];

	// Key detection needs the notes in place, so the signature is written last.
	const guess = detectKey(score);
	score.keySigs = [{ ...guess.key, tick: 0 }];

	return { score, tempo, noteCount: chords.length };
}

/** Bass clef when the material sits low enough that treble would mean ledger lines. */
function clefForRange(midis: number[]): Clef {
	if (!midis.length) return 'treble';
	const mean = midis.reduce((a, b) => a + b, 0) / midis.length;
	return mean < 57 ? 'bass' : 'treble';
}
