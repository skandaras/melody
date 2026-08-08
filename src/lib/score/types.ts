/**
 * The score document. This is the single source of truth for a piece of music
 * in Melody — MusicXML and MIDI are export formats produced from it, never the
 * thing we edit.
 *
 * Three properties are load-bearing and should survive any refactor:
 *
 *  1. Time is absolute ticks, never measure+beat. Measures are derived for
 *     rendering (see measures.ts). An edit that changes one bar's contents
 *     therefore cannot cascade-renumber everything after it.
 *  2. Every note carries a stable id. Patches address notes by id, the diff
 *     view highlights by id, and re-running a control doesn't reshuffle them.
 *  3. This module imports nothing — no SvelteKit, no DOM, no database. That is
 *     what makes the whole layer unit-testable.
 */

export const SCORE_VERSION = 1;

/** Ticks per quarter note. Fixed at 480: divisible by 2,3,4,5,6,8,10,12,16,
 *  which covers every tuplet anyone reasonably writes without rounding. */
export const PPQ = 480;

export const CLEFS = ['treble', 'bass', 'alto', 'tenor', 'percussion'] as const;
export type Clef = (typeof CLEFS)[number];

export const MODES = ['major', 'minor'] as const;
export type Mode = (typeof MODES)[number];

/** Standard MusicXML-ish articulation vocabulary. Renderers map these to
 *  glyphs; the synth maps them to duration/velocity adjustments. */
export const ARTICULATIONS = [
	'staccato',
	'staccatissimo',
	'accent',
	'marcato',
	'tenuto',
	'fermata',
	'trill',
	'mordent',
	'turn'
] as const;
export type Articulation = (typeof ARTICULATIONS)[number];

export const DYNAMICS = ['ppp', 'pp', 'p', 'mp', 'mf', 'f', 'ff', 'fff', 'sfz'] as const;
export type Dynamic = (typeof DYNAMICS)[number];

export interface Pitch {
	/** MIDI note number, 0-127. Middle C is 60. */
	midi: number;
	/**
	 * Preferred spelling, e.g. "Bb4" or "A#4". Optional: when absent the
	 * renderer picks from the prevailing key signature. Present when a human or
	 * the model made a deliberate enharmonic choice worth preserving.
	 */
	spell?: string;
	tie?: 'start' | 'stop' | 'both';
}

export interface Note {
	id: string;
	kind: 'note';
	/** Absolute position from the start of the piece, in ticks. */
	tick: number;
	/** Sounding length in ticks. Independent of notated length under a slur. */
	dur: number;
	/** More than one pitch is a chord. Never empty — use a Rest instead. */
	pitches: Pitch[];
	/** MIDI velocity 1-127. */
	vel: number;
	artic?: Articulation[];
	/** Dynamic marking attached at this note; applies until the next one. */
	dynamic?: Dynamic;
	slur?: 'start' | 'stop';
	lyric?: string;
	/** Tuplet grouping, e.g. {num: 3, den: 2} for a triplet. */
	tuplet?: { num: number; den: number };
}

export interface Rest {
	id: string;
	kind: 'rest';
	tick: number;
	dur: number;
}

export type ScoreEvent = Note | Rest;

export interface Voice {
	id: string;
	/** Kept sorted by tick. applyOps re-sorts after every mutation. */
	events: ScoreEvent[];
}

export interface Part {
	id: string;
	name: string;
	/** General MIDI program number, 0-127. Ignored when isDrum. */
	gmProgram: number;
	/** MIDI channel 0-15. Channel 9 is the drum channel by GM convention. */
	channel: number;
	isDrum: boolean;
	clef: Clef;
	/** Written-vs-sounding offset in semitones, e.g. -2 for a Bb trumpet. */
	transpose: number;
	/** Playback mix, 0-1. Not a musical dynamic — this is the fader. */
	volume: number;
	muted: boolean;
	voices: Voice[];
}

export interface TempoMark {
	tick: number;
	bpm: number;
}
export interface TimeSig {
	tick: number;
	num: number;
	den: number;
}
export interface KeySig {
	tick: number;
	/** Position on the circle of fifths: -7 (Cb) .. 0 (C) .. +7 (C#). */
	fifths: number;
	mode: Mode;
}

/** A named span used for selection, navigation and as an AI edit target. */
export interface Section {
	id: string;
	name: string;
	startTick: number;
	endTick: number;
	color?: string;
}

export interface Score {
	v: typeof SCORE_VERSION;
	title: string;
	composer?: string;
	ppq: number;
	/** Always at least one entry, at tick 0. */
	tempoMap: TempoMark[];
	timeSigs: TimeSig[];
	keySigs: KeySig[];
	parts: Part[];
	sections: Section[];
}

/**
 * What an operation or control applies to. An absent field widens the scope:
 * `{}` is the whole piece, `{partIds:['p1']}` is all of one part, and
 * `{noteIds:[...]}` is an explicit hand-picked set.
 *
 * When noteIds is present it wins outright — the other fields are ignored.
 */
export interface Selection {
	noteIds?: string[];
	partIds?: string[];
	sectionIds?: string[];
	startTick?: number;
	endTick?: number;
}

export function emptyScore(title = 'Untitled'): Score {
	return {
		v: SCORE_VERSION,
		title,
		ppq: PPQ,
		tempoMap: [{ tick: 0, bpm: 120 }],
		timeSigs: [{ tick: 0, num: 4, den: 4 }],
		keySigs: [{ tick: 0, fifths: 0, mode: 'major' }],
		parts: [],
		sections: []
	};
}
