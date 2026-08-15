import { describe, it, expect } from 'vitest';
import { describeClip, extractClip } from './extract.js';
import { mergeParts } from './merge.js';
import { applyOps } from './apply.js';
import { isNote } from './query.js';
import { emptyScore, type Score } from './types.js';

/**
 * A clip is a complete little Score, not a bag of notes — so what these tests
 * really check is that the context travels with it: tempo, metre, key,
 * instrument, and the fragment's placement within its bar.
 */

function fixture(): Score {
	let s = emptyScore('Source');
	s = applyOps(s, [
		{ op: 'set_tempo', args: { bpm: 92 } },
		{ op: 'set_time_sig', args: { num: 3, den: 4 } },
		{ op: 'add_part', args: { name: 'Piano', instrument: 'Acoustic Grand Piano' } }
	]).score;
	const partId = s.parts[0].id;
	// Three bars of 3/4 at PPQ 480 — a bar is 1440 ticks.
	return applyOps(s, [
		{
			op: 'insert_notes',
			args: {
				partId,
				notes: [
					{ tick: 0, dur: 480, pitches: ['C4'] },
					{ tick: 1440, dur: 480, pitches: ['E4'] },
					{ tick: 1920, dur: 480, pitches: ['G4'] },
					{ tick: 2880, dur: 480, pitches: ['C5'] }
				]
			}
		}
	]).score;
}

const noteIds = (s: Score) => s.parts[0].voices[0].events.map((e) => e.id);

describe('extractClip', () => {
	it('takes only the selected notes', () => {
		const s = fixture();
		const ids = noteIds(s);
		const { clip, noteCount } = extractClip(s, { noteIds: [ids[1], ids[2]] });

		expect(noteCount).toBe(2);
		const notes = clip.parts[0].voices[0].events.filter(isNote);
		expect(notes.map((n) => n.pitches[0].midi)).toEqual([64, 67]);
	});

	it('carries tempo, metre and instrument so the clip is reusable', () => {
		const s = fixture();
		const { clip } = extractClip(s, { noteIds: [noteIds(s)[1]] });

		expect(clip.tempoMap[0].bpm).toBe(92);
		expect(clip.timeSigs[0]).toMatchObject({ num: 3, den: 4 });
		expect(clip.parts[0].name).toBe('Piano');
		expect(clip.ppq).toBe(s.ppq);
	});

	it('rebases to the start of the bar, keeping placement within it', () => {
		const s = fixture();
		const ids = noteIds(s);
		// Notes at 1440 (bar 2 beat 1) and 1920 (bar 2 beat 2).
		const { clip, sourceStartTick } = extractClip(s, { noteIds: [ids[1], ids[2]] });

		expect(sourceStartTick).toBe(1440);
		const ticks = clip.parts[0].voices[0].events.map((e) => e.tick);
		expect(ticks).toEqual([0, 480]);
	});

	it('keeps an off-beat start off-beat', () => {
		const s = fixture();
		// The note at 1920 is beat 2 of bar 2; rebasing to the bar must keep it
		// on beat 2, or it re-inserts as an anacrusis.
		const { clip } = extractClip(s, { noteIds: [noteIds(s)[2]] });
		expect(clip.parts[0].voices[0].events[0].tick).toBe(480);
	});

	it('can rebase to the first note instead when asked', () => {
		const s = fixture();
		const { clip } = extractClip(s, { noteIds: [noteIds(s)[2]] }, );
		expect(clip.parts[0].voices[0].events[0].tick).toBe(480);

		const tight = extractClip(s, { noteIds: [noteIds(s)[2]] }, { alignToBar: false });
		expect(tight.clip.parts[0].voices[0].events[0].tick).toBe(0);
	});

	it('counts the bars it spans', () => {
		const s = fixture();
		const ids = noteIds(s);
		// Bar 2 beat 1 through bar 3 beat 1 — two bars.
		expect(extractClip(s, { noteIds: [ids[1], ids[3]] }).bars).toBe(2);
	});

	it('keeps two parts as two parts', () => {
		let s = fixture();
		s = applyOps(s, [{ op: 'add_part', args: { name: 'Bass', instrument: 'Acoustic Bass' } }]).score;
		const bassId = s.parts[1].id;
		s = applyOps(s, [
			{ op: 'insert_notes', args: { partId: bassId, notes: [{ tick: 0, dur: 480, pitches: ['C2'] }] } }
		]).score;

		const { clip } = extractClip(s, {});
		expect(clip.parts).toHaveLength(2);
		expect(clip.parts.map((p) => p.name).sort()).toEqual(['Bass', 'Piano']);
	});

	it('gives every event in the clip a fresh id', () => {
		const s = fixture();
		const { clip } = extractClip(s, {});
		const ids = clip.parts.flatMap((p) => p.voices.flatMap((v) => v.events.map((e) => e.id)));
		expect(new Set(ids).size).toBe(ids.length);
	});

	it('does not mutate the source', () => {
		const s = fixture();
		const before = JSON.stringify(s);
		extractClip(s, {});
		expect(JSON.stringify(s)).toBe(before);
	});

	it('returns an empty clip rather than throwing on an empty selection', () => {
		const s = fixture();
		const { clip, bars, noteCount } = extractClip(s, { noteIds: ['nope'] });
		expect(noteCount).toBe(0);
		expect(bars).toBe(0);
		expect(clip.parts).toHaveLength(0);
	});

	it('round-trips back into a score through mergeParts', () => {
		// Extraction and insertion are inverses; this is the whole point of the
		// library, so it is worth asserting rather than assuming.
		const s = fixture();
		const ids = noteIds(s);
		const { clip } = extractClip(s, { noteIds: [ids[1], ids[2]] });

		const target = emptyScore('Target');
		const { score: merged } = mergeParts(target, clip);

		const notes = merged.parts[0].voices[0].events.filter(isNote);
		expect(notes.map((n) => n.pitches[0].midi)).toEqual([64, 67]);
		expect(merged.tempoMap[0].bpm).toBe(92);
		expect(merged.timeSigs[0].num).toBe(3);
	});
});

describe('describeClip', () => {
	it('summarises what the clip is', () => {
		const s = fixture();
		const { clip, bars } = extractClip(s, {});
		expect(describeClip(clip, bars)).toBe('3 bars · 3/4 · 92bpm · Piano');
	});

	it('says "1 bar", not "1 bars"', () => {
		const s = fixture();
		const { clip } = extractClip(s, { noteIds: [noteIds(s)[0]] });
		expect(describeClip(clip, 1)).toContain('1 bar ·');
	});
});
