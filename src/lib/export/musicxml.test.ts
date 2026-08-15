/**
 * @vitest-environment happy-dom
 *
 * Scoped to this file rather than set globally: everything else in the suite
 * is pure and runs faster without a DOM. Here a real parser is the point —
 * well-formedness is the contract, and string-matching would miss exactly the
 * failures that matter.
 */
import { describe, it, expect } from 'vitest';
import { escapeXml, pitchToXml, scoreToMusicXml } from './musicxml.js';
import { applyOps } from '$lib/score/apply.js';
import { emptyScore, type Score } from '$lib/score/types.js';

/**
 * MusicXML is the format that carries the *notation* — spelling, clefs, ties,
 * articulations — where MIDI carries only the sound. So these tests are mostly
 * about the half MIDI throws away.
 *
 * Parsed with DOMParser rather than string-matched: a well-formedness failure
 * is the whole ball game here, and asserting on substrings would miss it.
 */

function parse(xml: string): Document {
	const doc = new DOMParser().parseFromString(xml, 'application/xml');
	const err = doc.querySelector('parsererror');
	if (err) throw new Error(`Not well-formed: ${err.textContent}`);
	return doc;
}

function fixture(): Score {
	let s = emptyScore('Test Piece');
	s = applyOps(s, [{ op: 'add_part', args: { name: 'Violin', instrument: 'Violin' } }]).score;
	const partId = s.parts[0].id;
	return applyOps(s, [
		{
			op: 'insert_notes',
			args: {
				partId,
				notes: [
					{ tick: 0, dur: 480, pitches: ['C4'] },
					{ tick: 480, dur: 480, pitches: ['E4'] },
					{ tick: 960, dur: 960, pitches: ['G4', 'C5'] }
				]
			}
		}
	]).score;
}

const text = (doc: Document | Element, sel: string) =>
	doc.querySelector(sel)?.textContent ?? null;

describe('escapeXml', () => {
	it('escapes everything that would break a document', () => {
		expect(escapeXml(`Tom & Jerry's <"Duet">`)).toBe(
			'Tom &amp; Jerry&apos;s &lt;&quot;Duet&quot;&gt;'
		);
	});
});

describe('pitchToXml', () => {
	it('spells from the sharp side in a sharp key', () => {
		expect(pitchToXml(61, 2)).toEqual({ step: 'C', alter: 1, octave: 4 });
	});

	it('spells from the flat side in a flat key', () => {
		expect(pitchToXml(61, -3)).toEqual({ step: 'D', alter: -1, octave: 4 });
	});

	it('honours an explicit spelling over the key', () => {
		expect(pitchToXml(61, 2, 'Db4')).toEqual({ step: 'D', alter: -1, octave: 4 });
	});

	it('reads double accidentals', () => {
		expect(pitchToXml(62, 0, 'C##4')).toEqual({ step: 'C', alter: 2, octave: 4 });
		expect(pitchToXml(60, 0, 'Dbb4')).toEqual({ step: 'D', alter: -2, octave: 4 });
	});

	it('gives natural notes no alteration', () => {
		expect(pitchToXml(60, 0)).toEqual({ step: 'C', alter: 0, octave: 4 });
		expect(pitchToXml(71, 0)).toEqual({ step: 'B', alter: 0, octave: 4 });
	});

	it('keeps the octave with the letter, not the pitch class', () => {
		// B#3 and C4 are the same key; writing octave 4 for a B# would move it
		// up a step on the stave.
		expect(pitchToXml(60, 0, 'B#3')).toEqual({ step: 'B', alter: 1, octave: 3 });
		expect(pitchToXml(59, 0, 'Cb4')).toEqual({ step: 'C', alter: -1, octave: 4 });
	});

	it('ignores an unparseable spelling rather than producing nonsense', () => {
		expect(pitchToXml(60, 0, 'not-a-pitch')).toEqual({ step: 'C', alter: 0, octave: 4 });
	});
});

describe('scoreToMusicXml', () => {
	it('produces a well-formed partwise document', () => {
		const doc = parse(scoreToMusicXml(fixture()));
		expect(doc.documentElement.tagName).toBe('score-partwise');
		expect(doc.documentElement.getAttribute('version')).toBe('4.0');
	});

	it('carries the title and composer', () => {
		const score = fixture();
		score.composer = 'A. Person';
		const doc = parse(scoreToMusicXml(score));
		expect(text(doc, 'work-title')).toBe('Test Piece');
		expect(text(doc, 'creator[type="composer"]')).toBe('A. Person');
	});

	it('declares divisions matching the tick resolution', () => {
		// Every <duration> is in these units; getting it wrong rescales the piece.
		expect(text(parse(scoreToMusicXml(fixture())), 'divisions')).toBe('480');
	});

	it('lists each part with 1-based channel and program', () => {
		const doc = parse(scoreToMusicXml(fixture()));
		expect(text(doc, 'part-name')).toBe('Violin');
		// GM violin is program 40 for us, 41 in MusicXML; channel 0 becomes 1.
		expect(text(doc, 'midi-program')).toBe('41');
		expect(text(doc, 'midi-channel')).toBe('1');
	});

	it('writes the clef', () => {
		const doc = parse(scoreToMusicXml(fixture()));
		expect(text(doc, 'clef sign')).toBe('G');
		expect(text(doc, 'clef line')).toBe('2');
	});

	it('writes key, time signature and tempo', () => {
		let score = fixture();
		score = applyOps(score, [
			{ op: 'set_key', args: { tonic: 'Eb', mode: 'major' } },
			{ op: 'set_time_sig', args: { num: 3, den: 4 } },
			{ op: 'set_tempo', args: { bpm: 88 } }
		]).score;

		const doc = parse(scoreToMusicXml(score));
		expect(text(doc, 'key fifths')).toBe('-3');
		expect(text(doc, 'key mode')).toBe('major');
		expect(text(doc, 'time beats')).toBe('3');
		expect(text(doc, 'time beat-type')).toBe('4');
		expect(text(doc, 'per-minute')).toBe('88');
	});

	it('writes notes with pitch, duration and type', () => {
		const doc = parse(scoreToMusicXml(fixture()));
		const first = doc.querySelectorAll('note')[0];
		expect(text(first, 'step')).toBe('C');
		expect(text(first, 'octave')).toBe('4');
		expect(text(first, 'duration')).toBe('480');
		expect(text(first, 'type')).toBe('quarter');
	});

	it('flags the second note of a chord, not the first', () => {
		// Chords are expressed as a flag on the following notes rather than a
		// container, which is the easiest thing in this format to get backwards.
		const doc = parse(scoreToMusicXml(fixture()));
		const notes = [...doc.querySelectorAll('note')];
		const chordFlagged = notes.filter((n) => n.querySelector('chord'));
		expect(chordFlagged).toHaveLength(1);
		expect(text(chordFlagged[0], 'step')).toBe('C'); // C5, the upper note
		expect(text(chordFlagged[0], 'octave')).toBe('5');
	});

	it('writes both halves of a tie, so it sounds and looks right', () => {
		const score = fixture();
		const note = score.parts[0].voices[0].events[0];
		if (note.kind !== 'note') throw new Error('fixture should start with a note');
		note.pitches[0].tie = 'start';

		const doc = parse(scoreToMusicXml(score));
		expect(doc.querySelector('tie[type="start"]')).not.toBeNull();
		expect(doc.querySelector('tied[type="start"]')).not.toBeNull();
	});

	it('writes articulations and ornaments under the right parents', () => {
		let score = fixture();
		const ids = score.parts[0].voices[0].events.map((e) => e.id);
		score = applyOps(score, [
			{ op: 'set_articulation', args: { selection: { noteIds: [ids[0]] }, articulations: ['staccato'] } },
			{ op: 'set_articulation', args: { selection: { noteIds: [ids[1]] }, articulations: ['trill'] } }
		]).score;

		const doc = parse(scoreToMusicXml(score));
		expect(doc.querySelector('notations articulations staccato')).not.toBeNull();
		expect(doc.querySelector('notations ornaments trill-mark')).not.toBeNull();
	});

	it('maps marcato to strong-accent, which is what the format calls it', () => {
		let score = fixture();
		const id = score.parts[0].voices[0].events[0].id;
		score = applyOps(score, [
			{ op: 'set_articulation', args: { selection: { noteIds: [id] }, articulations: ['marcato'] } }
		]).score;
		expect(parse(scoreToMusicXml(score)).querySelector('strong-accent')).not.toBeNull();
	});

	it('fills silence with rests so every measure accounts for its length', () => {
		let score = emptyScore('Gaps');
		score = applyOps(score, [{ op: 'add_part', args: { name: 'P', instrument: 'Piano' } }]).score;
		const partId = score.parts[0].id;
		score = applyOps(score, [
			{ op: 'insert_notes', args: { partId, notes: [{ tick: 960, dur: 480, pitches: ['C4'] }] } }
		]).score;

		const doc = parse(scoreToMusicXml(score));
		const bar = doc.querySelector('measure')!;
		const durations = [...bar.querySelectorAll('note')].map((n) =>
			Number(n.querySelector('duration')!.textContent)
		);
		// Two beats of rest, the note, then a beat of rest — a full 4/4 bar.
		expect(durations.reduce((a, b) => a + b, 0)).toBe(1920);
		expect(bar.querySelectorAll('rest')).toHaveLength(2);
	});

	it('writes a full-bar rest for an empty measure', () => {
		let score = emptyScore('Sparse');
		score = applyOps(score, [{ op: 'add_part', args: { name: 'P', instrument: 'Piano' } }]).score;
		const partId = score.parts[0].id;
		// A note in bar 3 leaves bars 1 and 2 empty.
		score = applyOps(score, [
			{ op: 'insert_notes', args: { partId, notes: [{ tick: 3840, dur: 480, pitches: ['C4'] }] } }
		]).score;

		const doc = parse(scoreToMusicXml(score));
		const bars = [...doc.querySelectorAll('measure')];
		expect(bars.length).toBeGreaterThanOrEqual(3);
		expect(bars[0].querySelector('rest')).not.toBeNull();
	});

	it('numbers measures from one', () => {
		const doc = parse(scoreToMusicXml(fixture()));
		expect(doc.querySelector('measure')!.getAttribute('number')).toBe('1');
	});

	it('writes every part', () => {
		let score = fixture();
		score = applyOps(score, [{ op: 'add_part', args: { name: 'Cello', instrument: 'Cello' } }]).score;
		const doc = parse(scoreToMusicXml(score));
		expect(doc.querySelectorAll('score-part')).toHaveLength(2);
		expect(doc.querySelectorAll('part')).toHaveLength(2);
	});

	it('escapes a title that would otherwise break the document', () => {
		const score = fixture();
		score.title = 'Rock & <Roll>';
		const doc = parse(scoreToMusicXml(score));
		expect(text(doc, 'work-title')).toBe('Rock & <Roll>');
	});

	it('handles an empty score without producing invalid XML', () => {
		const doc = parse(scoreToMusicXml(emptyScore('Nothing')));
		expect(doc.documentElement.tagName).toBe('score-partwise');
		expect(doc.querySelectorAll('part')).toHaveLength(0);
	});
});
