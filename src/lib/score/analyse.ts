import { measuresOf, tempoAt, timeSigAt, keySigAt } from './measures.js';
import { fifthsFor, keyName, midiToPitchClass, SHARP_NAMES, FLAT_NAMES } from './pitch.js';
import { resolveSelection } from './query.js';
import type { KeySig, Mode, Score, Selection } from './types.js';

/**
 * Musical analysis of a score or a slice of one.
 *
 * Two audiences:
 *  - the transcription pipeline, which needs a key guess before it can pick
 *    sensible spellings;
 *  - the AI layer, which gets this as a compact summary instead of the raw
 *    document. Telling a model "bars 5-8 are ii-V-I in F, alto register,
 *    sparse" is worth far more tokens than the notes themselves.
 */

/**
 * Krumhansl-Schmuckler key profiles. These are perceptual weights from
 * listening experiments, not music-theory axioms — the tonic scores highest,
 * the dominant and mediant next, and chromatic degrees lowest.
 */
const MAJOR_PROFILE = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const MINOR_PROFILE = [6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];

function correlate(hist: number[], profile: number[]): number {
	const n = 12;
	const meanH = hist.reduce((a, b) => a + b, 0) / n;
	const meanP = profile.reduce((a, b) => a + b, 0) / n;
	let num = 0;
	let dh = 0;
	let dp = 0;
	for (let i = 0; i < n; i++) {
		const a = hist[i] - meanH;
		const b = profile[i] - meanP;
		num += a * b;
		dh += a * a;
		dp += b * b;
	}
	const den = Math.sqrt(dh * dp);
	return den === 0 ? 0 : num / den;
}

export interface KeyGuess {
	key: KeySig;
	name: string;
	/** Pearson correlation with the best-fitting profile, -1..1. */
	confidence: number;
}

/**
 * Detect the most likely key by weighting each pitch class by total sounding
 * duration — a long tonic pedal should count for more than a passing
 * semiquaver, which a raw note count would miss.
 */
export function detectKey(score: Score, sel: Selection = {}): KeyGuess {
	const hist = new Array(12).fill(0);
	for (const { note } of resolveSelection(score, sel)) {
		for (const p of note.pitches) hist[midiToPitchClass(p.midi)] += note.dur;
	}

	if (hist.every((h) => h === 0)) {
		const k = score.keySigs[0];
		return { key: k, name: keyName(k), confidence: 0 };
	}

	let best: { pc: number; mode: Mode; score: number } = { pc: 0, mode: 'major', score: -Infinity };
	for (let pc = 0; pc < 12; pc++) {
		const rotated = hist.slice(pc).concat(hist.slice(0, pc));
		for (const mode of ['major', 'minor'] as const) {
			const r = correlate(rotated, mode === 'major' ? MAJOR_PROFILE : MINOR_PROFILE);
			if (r > best.score) best = { pc, mode, score: r };
		}
	}

	const key: KeySig = { tick: 0, fifths: fifthsFor(best.pc, best.mode), mode: best.mode };
	return { key, name: keyName(key), confidence: Number(best.score.toFixed(3)) };
}

const CHORD_SHAPES: { name: string; intervals: number[] }[] = [
	{ name: '', intervals: [0, 4, 7] }, // major
	{ name: 'm', intervals: [0, 3, 7] },
	{ name: 'dim', intervals: [0, 3, 6] },
	{ name: 'aug', intervals: [0, 4, 8] },
	{ name: '7', intervals: [0, 4, 7, 10] },
	{ name: 'maj7', intervals: [0, 4, 7, 11] },
	{ name: 'm7', intervals: [0, 3, 7, 10] },
	{ name: 'm7b5', intervals: [0, 3, 6, 10] },
	{ name: 'dim7', intervals: [0, 3, 6, 9] },
	{ name: 'sus4', intervals: [0, 5, 7] },
	{ name: 'sus2', intervals: [0, 2, 7] },
	{ name: '6', intervals: [0, 4, 7, 9] },
	{ name: 'm6', intervals: [0, 3, 7, 9] },
	{ name: '9', intervals: [0, 2, 4, 7, 10] }
];

/** Best-matching chord symbol for a set of pitch classes. */
export function nameChord(pitchClasses: number[], key?: KeySig): string | null {
	const set = [...new Set(pitchClasses.map(midiToPitchClass))];
	if (set.length < 2) return null;

	let best: { score: number; root: number; name: string } | null = null;
	for (let root = 0; root < 12; root++) {
		const rel = new Set(set.map((pc) => midiToPitchClass(pc - root)));
		for (const shape of CHORD_SHAPES) {
			const want = new Set(shape.intervals);
			let hit = 0;
			for (const i of want) if (rel.has(i)) hit++;
			const extra = [...rel].filter((i) => !want.has(i)).length;
			// Reward matched chord tones, penalise notes the shape can't explain.
			const score = hit / want.size - extra * 0.34;
			if (!best || score > best.score) best = { score, root, name: shape.name };
		}
	}
	if (!best || best.score < 0.6) return null;
	const names = (key?.fifths ?? 0) < 0 ? FLAT_NAMES : SHARP_NAMES;
	return `${names[best.root]}${best.name}`;
}

export interface BarAnalysis {
	bar: number;
	startTick: number;
	chord: string | null;
	noteCount: number;
	lowMidi: number | null;
	highMidi: number | null;
}

export interface ScoreAnalysis {
	key: KeyGuess;
	tempoBpm: number;
	timeSig: string;
	barCount: number;
	totalNotes: number;
	parts: {
		id: string;
		name: string;
		noteCount: number;
		lowMidi: number | null;
		highMidi: number | null;
		/** Notes per bar. A rough density signal for "thin out" / "fill out". */
		density: number;
	}[];
	bars: BarAnalysis[];
	sections: { id: string; name: string; startBar: number; endBar: number }[];
}

/**
 * A compact structural summary. This is what goes into an AI prompt in place
 * of (or alongside) the raw notes — cheap in tokens, high in signal.
 */
export function analyse(score: Score, sel: Selection = {}): ScoreAnalysis {
	const measures = measuresOf(score);
	const notes = resolveSelection(score, sel);
	const key = detectKey(score, sel);

	const byBar = new Map<number, typeof notes>();
	for (const rn of notes) {
		const m = measures.find((x) => rn.note.tick >= x.startTick && rn.note.tick < x.endTick);
		if (!m) continue;
		const list = byBar.get(m.index) ?? [];
		list.push(rn);
		byBar.set(m.index, list);
	}

	const bars: BarAnalysis[] = [];
	for (const m of measures) {
		const inBar = byBar.get(m.index) ?? [];
		const pcs: number[] = [];
		let lo: number | null = null;
		let hi: number | null = null;
		for (const { note } of inBar) {
			for (const p of note.pitches) {
				pcs.push(p.midi);
				lo = lo === null ? p.midi : Math.min(lo, p.midi);
				hi = hi === null ? p.midi : Math.max(hi, p.midi);
			}
		}
		bars.push({
			bar: m.number,
			startTick: m.startTick,
			chord: pcs.length ? nameChord(pcs, key.key) : null,
			noteCount: inBar.length,
			lowMidi: lo,
			highMidi: hi
		});
	}

	const parts = score.parts.map((p) => {
		const mine = notes.filter((n) => n.part.id === p.id);
		let lo: number | null = null;
		let hi: number | null = null;
		for (const { note } of mine) {
			for (const pit of note.pitches) {
				lo = lo === null ? pit.midi : Math.min(lo, pit.midi);
				hi = hi === null ? pit.midi : Math.max(hi, pit.midi);
			}
		}
		return {
			id: p.id,
			name: p.name,
			noteCount: mine.length,
			lowMidi: lo,
			highMidi: hi,
			density: Number((mine.length / Math.max(1, measures.length)).toFixed(2))
		};
	});

	const sig = timeSigAt(score, 0);
	return {
		key,
		tempoBpm: tempoAt(score, 0).bpm,
		timeSig: `${sig.num}/${sig.den}`,
		barCount: measures.length,
		totalNotes: notes.length,
		parts,
		bars,
		sections: score.sections.map((s) => ({
			id: s.id,
			name: s.name,
			startBar: (measures.find((m) => s.startTick < m.endTick)?.number ?? 1),
			endBar: (measures.find((m) => s.endTick <= m.endTick)?.number ?? measures.length)
		}))
	};
}

/** Human-readable one-paragraph digest, cheap enough to put in every prompt. */
export function summarise(score: Score, sel: Selection = {}): string {
	const a = analyse(score, sel);
	const chords = a.bars
		.filter((b) => b.chord)
		.map((b) => `${b.bar}:${b.chord}`)
		.join(' ');
	const parts = a.parts.map((p) => `${p.name} (${p.noteCount} notes, density ${p.density})`);
	return [
		`${a.key.name}, ${a.timeSig}, ${a.tempoBpm}bpm, ${a.barCount} bars, ${a.totalNotes} notes.`,
		parts.length ? `Parts: ${parts.join('; ')}.` : 'No parts yet.',
		chords ? `Harmony by bar: ${chords}.` : '',
		a.sections.length
			? `Sections: ${a.sections.map((s) => `${s.name} (bars ${s.startBar}-${s.endBar})`).join(', ')}.`
			: ''
	]
		.filter(Boolean)
		.join(' ');
}

export { keySigAt };
