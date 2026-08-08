import { describe, it, expect } from 'vitest';
import { emptyScore, PPQ, type Score } from './types.js';
import { applyOps } from './apply.js';
import { validateScore } from './validate.js';
import { measuresOf, measureTicks, timeSigAt, scoreEndTick } from './measures.js';
import { detectKey, nameChord, analyse, summarise } from './analyse.js';
import { resolveSelection, findNote } from './query.js';
import {
	parseSpelling,
	spellMidi,
	diatonicTranspose,
	snapToKey,
	keyName,
	fifthsFor
} from './pitch.js';
import { gmProgramFor, gmName } from './instruments.js';
import { OP_NAMES, OPS } from './ops/index.js';

/** A two-bar C major score with a piano part, used by most tests below. */
function fixture(): Score {
	const s = emptyScore('Test');
	const r = applyOps(s, [
		{ op: 'add_part', args: { name: 'Piano', instrument: 'Acoustic Grand Piano' } }
	]);
	const partId = r.score.parts[0].id;
	return applyOps(r.score, [
		{
			op: 'insert_notes',
			args: {
				partId,
				notes: [
					{ tick: 0, dur: 480, pitches: ['C4'] },
					{ tick: 480, dur: 480, pitches: ['E4'] },
					{ tick: 960, dur: 480, pitches: ['G4'] },
					{ tick: 1440, dur: 480, pitches: ['C5'] }
				]
			}
		}
	]).score;
}

describe('pitch', () => {
	it('round-trips spellings through MIDI', () => {
		for (const s of ['C4', 'Bb3', 'F#5', 'A0', 'C-1', 'G9']) {
			const midi = parseSpelling(s);
			expect(midi, s).not.toBeNull();
		}
		expect(parseSpelling('C4')).toBe(60);
		expect(parseSpelling('A4')).toBe(69);
		expect(parseSpelling('Bb3')).toBe(58);
		expect(parseSpelling('nonsense')).toBeNull();
	});

	it('spells flat keys with flats and sharp keys with sharps', () => {
		const fMajor = { tick: 0, fifths: -1, mode: 'major' as const };
		const dMajor = { tick: 0, fifths: 2, mode: 'major' as const };
		expect(spellMidi(58, fMajor)).toBe('Bb3');
		expect(spellMidi(61, dMajor)).toBe('C#4');
	});

	it('transposes diatonically, staying in key', () => {
		const cMajor = { tick: 0, fifths: 0, mode: 'major' as const };
		// B4 (71) up one scale step is C5 (72) — a semitone, not a tone.
		expect(diatonicTranspose(71, 1, cMajor)).toBe(72);
		// C4 up one step is D4 — a tone.
		expect(diatonicTranspose(60, 1, cMajor)).toBe(62);
	});

	it('snaps chromatic notes into the key', () => {
		const cMajor = { tick: 0, fifths: 0, mode: 'major' as const };
		expect(snapToKey(61, cMajor)).toBe(60); // C# -> C
		expect(snapToKey(60, cMajor)).toBe(60); // already diatonic
	});

	it('names keys from their circle-of-fifths position', () => {
		expect(keyName({ tick: 0, fifths: 0, mode: 'major' })).toBe('C major');
		expect(keyName({ tick: 0, fifths: -1, mode: 'major' })).toBe('F major');
		expect(keyName({ tick: 0, fifths: 0, mode: 'minor' })).toBe('A minor');
		expect(fifthsFor(9, 'minor')).toBe(0); // A minor has no accidentals
	});
});

describe('measures', () => {
	it('derives bar lengths from the time signature', () => {
		expect(measureTicks(PPQ, { tick: 0, num: 4, den: 4 })).toBe(1920);
		expect(measureTicks(PPQ, { tick: 0, num: 3, den: 4 })).toBe(1440);
		expect(measureTicks(PPQ, { tick: 0, num: 6, den: 8 })).toBe(1440);
	});

	it('re-bars everything after a time signature change', () => {
		let s = fixture();
		s = applyOps(s, [{ op: 'set_time_sig', args: { tick: 1920, num: 3, den: 4 } }]).score;
		const bars = measuresOf(s, 1920 * 3);
		expect(bars[0].endTick).toBe(1920); // 4/4
		expect(bars[1].startTick).toBe(1920);
		expect(bars[1].endTick).toBe(1920 + 1440); // now 3/4
		expect(timeSigAt(s, 2000).num).toBe(3);
	});

	it('always produces at least one measure, even for an empty score', () => {
		expect(measuresOf(emptyScore()).length).toBeGreaterThanOrEqual(1);
	});
});

describe('ops registry', () => {
	it('has unique names and well-formed schemas', () => {
		expect(new Set(OP_NAMES).size).toBe(OP_NAMES.length);
		for (const op of OPS) {
			expect(op.summary.length, `${op.name} needs a real description`).toBeGreaterThan(20);
			expect(op.schema.type).toBe('object');
			// Anthropic strict tool use rejects a schema without this.
			expect(op.schema.additionalProperties, op.name).toBe(false);
			for (const req of op.schema.required) {
				expect(Object.keys(op.schema.properties), `${op.name}.${req}`).toContain(req);
			}
		}
	});

	it('reports unknown operations instead of throwing', () => {
		const r = applyOps(fixture(), [{ op: 'make_it_funky', args: {} }]);
		expect(r.errors).toHaveLength(1);
		expect(r.errors[0].reason).toContain('Unknown operation');
	});

	it('keeps good ops in a batch when one is bad', () => {
		const s = fixture();
		const r = applyOps(s, [
			{ op: 'set_tempo', args: { bpm: 90 } },
			{ op: 'nope', args: {} },
			{ op: 'set_title', args: { title: 'Renamed' } }
		]);
		expect(r.errors).toHaveLength(1);
		expect(r.score.tempoMap[0].bpm).toBe(90);
		expect(r.score.title).toBe('Renamed');
	});

	it('never mutates the input score', () => {
		const s = fixture();
		const before = JSON.stringify(s);
		applyOps(s, [{ op: 'transpose', args: { semitones: 12 } }]);
		expect(JSON.stringify(s)).toBe(before);
	});
});

describe('operations', () => {
	it('inserts and deletes notes, reporting both in the diff', () => {
		const s = fixture();
		const partId = s.parts[0].id;
		const ins = applyOps(s, [
			{ op: 'insert_notes', args: { partId, notes: [{ tick: 1920, dur: 480, pitches: ['D4'] }] } }
		]);
		expect(ins.diff.added).toHaveLength(1);

		const del = applyOps(ins.score, [{ op: 'delete_notes', args: { noteIds: ins.diff.added } }]);
		expect(del.diff.removed).toEqual(ins.diff.added);
		expect(resolveSelection(del.score, {})).toHaveLength(4);
	});

	it('collapses a note added and removed within one batch', () => {
		const s = fixture();
		const partId = s.parts[0].id;
		// replace_range removes the four notes then writes one back.
		const r = applyOps(s, [
			{
				op: 'replace_range',
				args: { partId, startTick: 0, endTick: 1920, notes: [{ tick: 0, dur: 1920, pitches: ['C4'] }] }
			}
		]);
		expect(r.diff.removed).toHaveLength(4);
		expect(r.diff.added).toHaveLength(1);
		// Nothing appears in two buckets at once.
		for (const id of r.diff.added) expect(r.diff.removed).not.toContain(id);
	});

	it('transposes by semitones and reverses exactly', () => {
		const s = fixture();
		const up = applyOps(s, [{ op: 'transpose', args: { semitones: 5 } }]).score;
		const back = applyOps(up, [{ op: 'transpose', args: { semitones: -5 } }]).score;
		const orig = resolveSelection(s, {}).map((n) => n.note.pitches[0].midi);
		const round = resolveSelection(back, {}).map((n) => n.note.pitches[0].midi);
		expect(round).toEqual(orig);
	});

	it('retrograde is its own inverse', () => {
		const s = fixture();
		const once = applyOps(s, [{ op: 'retrograde', args: {} }]).score;
		const twice = applyOps(once, [{ op: 'retrograde', args: {} }]).score;
		const before = resolveSelection(s, {}).map((n) => [n.note.tick, n.note.pitches[0].midi]);
		const after = resolveSelection(twice, {}).map((n) => [n.note.tick, n.note.pitches[0].midi]);
		expect(after).toEqual(before);
	});

	it('scale_time doubles then halves back to the original', () => {
		const s = fixture();
		const slow = applyOps(s, [{ op: 'scale_time', args: { factor: 2 } }]).score;
		const back = applyOps(slow, [{ op: 'scale_time', args: { factor: 0.5 } }]).score;
		expect(resolveSelection(back, {}).map((n) => n.note.tick)).toEqual([0, 480, 960, 1440]);
	});

	it('humanise is deterministic for a given seed', () => {
		const s = fixture();
		const a = applyOps(s, [{ op: 'humanise', args: { seed: 7 } }]).score;
		const b = applyOps(s, [{ op: 'humanise', args: { seed: 7 } }]).score;
		const c = applyOps(s, [{ op: 'humanise', args: { seed: 8 } }]).score;
		expect(JSON.stringify(a)).toBe(JSON.stringify(b));
		expect(JSON.stringify(a)).not.toBe(JSON.stringify(c));
	});

	it('quantise pulls off-grid notes onto the grid', () => {
		let s = fixture();
		s = applyOps(s, [{ op: 'shift_time', args: { selection: {}, deltaTicks: 17 } }]).score;
		const q = applyOps(s, [{ op: 'quantise', args: { grid: 480 } }]).score;
		for (const { note } of resolveSelection(q, {})) {
			expect(note.tick % 480).toBe(0);
		}
	});

	it('swing delays off-beat quavers and leaves downbeats alone', () => {
		let s = emptyScore();
		s = applyOps(s, [{ op: 'add_part', args: { name: 'P', instrument: 'Piano' } }]).score;
		const partId = s.parts[0].id;
		// A straight run of quavers — the only thing swing is defined against.
		s = applyOps(s, [
			{
				op: 'insert_notes',
				args: {
					partId,
					notes: [0, 240, 480, 720].map((tick) => ({ tick, dur: 240, pitches: ['C4'] }))
				}
			}
		]).score;

		const sw = applyOps(s, [{ op: 'swing', args: { ratio: 0.667 } }]).score;
		const after = resolveSelection(sw, {})
			.map((n) => n.note.tick)
			.sort((a, b) => a - b);
		// On-beat quavers stay put; off-beats are pushed late by the ratio.
		expect(after).toEqual([0, 320, 480, 800]);
	});

	it('swing at ratio 0.5 is a no-op (straight eighths)', () => {
		let s = emptyScore();
		s = applyOps(s, [{ op: 'add_part', args: { name: 'P', instrument: 'Piano' } }]).score;
		const partId = s.parts[0].id;
		s = applyOps(s, [
			{
				op: 'insert_notes',
				args: { partId, notes: [0, 240, 480].map((tick) => ({ tick, dur: 240, pitches: ['C4'] })) }
			}
		]).score;
		const sw = applyOps(s, [{ op: 'swing', args: { ratio: 0.5 } }]).score;
		expect(resolveSelection(sw, {}).map((n) => n.note.tick).sort((a, b) => a - b)).toEqual([
			0, 240, 480
		]);
	});

	it('set_dynamic marks only the first note but sets every velocity', () => {
		const s = fixture();
		const r = applyOps(s, [{ op: 'set_dynamic', args: { dynamic: 'pp' } }]).score;
		const notes = resolveSelection(r, {}).sort((a, b) => a.note.tick - b.note.tick);
		expect(notes[0].note.dynamic).toBe('pp');
		expect(notes[1].note.dynamic).toBeUndefined();
		for (const n of notes) expect(n.note.vel).toBe(32);
	});

	it('velocity curve ramps across the selection in time order', () => {
		const s = fixture();
		const r = applyOps(s, [{ op: 'set_velocity_curve', args: { from: 40, to: 100 } }]).score;
		const vels = resolveSelection(r, {})
			.sort((a, b) => a.note.tick - b.note.tick)
			.map((n) => n.note.vel);
		expect(vels[0]).toBe(40);
		expect(vels.at(-1)).toBe(100);
		for (let i = 1; i < vels.length; i++) expect(vels[i]).toBeGreaterThanOrEqual(vels[i - 1]);
	});

	it('add_part puts drums on channel 9 and picks a sensible clef', () => {
		let s = emptyScore();
		s = applyOps(s, [
			{ op: 'add_part', args: { name: 'Cello', instrument: 'Cello' } },
			{ op: 'add_part', args: { name: 'Kit', instrument: 'Drum Kit', isDrum: true } }
		]).score;
		expect(s.parts[0].clef).toBe('bass');
		expect(s.parts[1].isDrum).toBe(true);
		expect(s.parts[1].channel).toBe(9);
		expect(s.parts[0].channel).not.toBe(9);
	});

	it('fit_to_key snaps out-of-key notes', () => {
		let s = fixture();
		const partId = s.parts[0].id;
		s = applyOps(s, [
			{ op: 'insert_notes', args: { partId, notes: [{ tick: 1920, dur: 480, pitches: ['F#4'] }] } }
		]).score;
		const fitted = applyOps(s, [{ op: 'fit_to_key', args: {} }]).score;
		const fs = resolveSelection(fitted, {}).find((n) => n.note.tick === 1920);
		expect(fs!.note.pitches[0].midi).toBe(65); // F#4 -> F4 in C major
	});
});

describe('selection', () => {
	it('treats explicit noteIds as final', () => {
		const s = fixture();
		const id = s.parts[0].voices[0].events[1].id;
		const got = resolveSelection(s, { noteIds: [id], startTick: 99999 });
		expect(got).toHaveLength(1);
		expect(got[0].note.id).toBe(id);
	});

	it('filters by tick window on note start, not overlap', () => {
		const s = fixture();
		expect(resolveSelection(s, { startTick: 0, endTick: 960 })).toHaveLength(2);
	});

	it('finds a note by id anywhere in the score', () => {
		const s = fixture();
		const id = s.parts[0].voices[0].events[2].id;
		expect(findNote(s, id)?.note.id).toBe(id);
		expect(findNote(s, 'nope')).toBeUndefined();
	});
});

describe('analysis', () => {
	it('detects C major from a C major triad arpeggio', () => {
		const guess = detectKey(fixture());
		expect(guess.name).toBe('C major');
		expect(guess.confidence).toBeGreaterThan(0.5);
	});

	it('detects a minor key', () => {
		let s = emptyScore();
		s = applyOps(s, [{ op: 'add_part', args: { name: 'P', instrument: 'Piano' } }]).score;
		const partId = s.parts[0].id;
		// A natural minor scale, weighted toward the tonic.
		s = applyOps(s, [
			{
				op: 'insert_notes',
				args: {
					partId,
					notes: [
						{ tick: 0, dur: 960, pitches: ['A3'] },
						{ tick: 960, dur: 480, pitches: ['B3'] },
						{ tick: 1440, dur: 480, pitches: ['C4'] },
						{ tick: 1920, dur: 480, pitches: ['D4'] },
						{ tick: 2400, dur: 960, pitches: ['E4'] },
						{ tick: 3360, dur: 480, pitches: ['F4'] },
						{ tick: 3840, dur: 480, pitches: ['G4'] },
						{ tick: 4320, dur: 960, pitches: ['A4'] }
					]
				}
			}
		]).score;
		expect(detectKey(s).name).toBe('A minor');
	});

	it('names triads and sevenths', () => {
		expect(nameChord([60, 64, 67])).toBe('C');
		expect(nameChord([60, 63, 67])).toBe('Cm');
		expect(nameChord([60, 64, 67, 70])).toBe('C7');
		expect(nameChord([60, 64, 67, 71])).toBe('Cmaj7');
		expect(nameChord([60])).toBeNull();
	});

	it('summarises a score into a compact prompt line', () => {
		const text = summarise(fixture());
		expect(text).toContain('C major');
		expect(text).toContain('4/4');
		expect(text).toContain('Piano');
	});

	it('reports per-part range and density', () => {
		const a = analyse(fixture());
		expect(a.totalNotes).toBe(4);
		expect(a.parts[0].lowMidi).toBe(60);
		expect(a.parts[0].highMidi).toBe(72);
		expect(a.parts[0].density).toBeGreaterThan(0);
	});
});

describe('instruments', () => {
	it('resolves GM names, aliases and fuzzy matches', () => {
		expect(gmProgramFor('Acoustic Grand Piano')).toBe(0);
		expect(gmProgramFor('violin')).toBe(40);
		expect(gmProgramFor('strings')).toBe(48);
		// Longest match wins, so this must not resolve through the "bass" alias.
		expect(gmName(gmProgramFor('Acoustic Bass'))).toBe('Acoustic Bass');
	});

	it('falls back to piano rather than throwing on nonsense', () => {
		expect(gmProgramFor('zzzz')).toBe(0);
	});
});

describe('validation', () => {
	it('repairs a document missing its tick-0 entries', () => {
		const { score, issues } = validateScore({
			title: 'Broken',
			ppq: 480,
			tempoMap: [{ tick: 960, bpm: 100 }],
			timeSigs: [{ tick: 960, num: 3, den: 4 }],
			keySigs: [],
			parts: [],
			sections: []
		});
		expect(score).not.toBeNull();
		expect(score!.tempoMap[0].tick).toBe(0);
		expect(score!.timeSigs[0].tick).toBe(0);
		expect(score!.keySigs[0].tick).toBe(0);
		expect(issues.some((i) => i.problem.includes('tick 0'))).toBe(true);
	});

	it('drops notes with no usable pitch rather than keeping an empty one', () => {
		const { score } = validateScore({
			title: 'X',
			parts: [{ id: 'p1', name: 'P', voices: [{ id: 'v1', events: [
				{ id: 'n1', kind: 'note', tick: 0, dur: 480, pitches: [] },
				{ id: 'n2', kind: 'note', tick: 480, dur: 480, pitches: [{ midi: 60 }] }
			] }] }],
			sections: []
		});
		expect(score!.parts[0].voices[0].events).toHaveLength(1);
		expect(score!.parts[0].voices[0].events[0].id).toBe('n2');
	});

	it('de-duplicates colliding ids', () => {
		const { score, issues } = validateScore({
			title: 'X',
			parts: [{ id: 'p1', name: 'P', voices: [{ id: 'v1', events: [
				{ id: 'dup', kind: 'note', tick: 0, dur: 480, pitches: [{ midi: 60 }] },
				{ id: 'dup', kind: 'note', tick: 480, dur: 480, pitches: [{ midi: 62 }] }
			] }] }],
			sections: []
		});
		const ids = score!.parts[0].voices[0].events.map((e) => e.id);
		expect(new Set(ids).size).toBe(2);
		expect(issues.some((i) => i.path === 'ids')).toBe(true);
	});

	it('rejects a non-object outright', () => {
		expect(validateScore('nope').score).toBeNull();
		expect(validateScore(null).score).toBeNull();
	});

	it('round-trips a valid score unchanged in substance', () => {
		const s = fixture();
		const { score } = validateScore(JSON.parse(JSON.stringify(s)));
		expect(score!.parts[0].voices[0].events).toHaveLength(4);
		expect(scoreEndTick(score!)).toBe(scoreEndTick(s));
	});
});
