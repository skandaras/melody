import { describe, it, expect } from 'vitest';
import { mergeParts } from './merge.js';
import { applyOps } from './apply.js';
import { isNote } from './query.js';
import { emptyScore, type Score } from './types.js';

function withPart(title: string, instrument = 'Violin'): Score {
	let s = emptyScore(title);
	s = applyOps(s, [{ op: 'add_part', args: { name: instrument, instrument } }]).score;
	const partId = s.parts[0].id;
	return applyOps(s, [
		{
			op: 'insert_notes',
			args: {
				partId,
				notes: [
					{ tick: 0, dur: 480, pitches: ['C4'] },
					{ tick: 480, dur: 480, pitches: ['E4'] }
				]
			}
		}
	]).score;
}

describe('mergeParts', () => {
	it('appends the incoming part without disturbing the existing one', () => {
		const target = withPart('Target', 'Piano');
		const before = structuredClone(target.parts[0]);
		const { score, addedParts } = mergeParts(target, withPart('Incoming'));
		expect(addedParts).toBe(1);
		expect(score.parts).toHaveLength(2);
		expect(score.parts[0]).toEqual(before);
	});

	it('does not mutate the target', () => {
		const target = withPart('Target');
		const snapshot = JSON.stringify(target);
		mergeParts(target, withPart('Incoming'));
		expect(JSON.stringify(target)).toBe(snapshot);
	});

	it('re-mints ids so two independently-built documents cannot collide', () => {
		const target = withPart('Target');
		const incoming = withPart('Incoming');
		// Both were built by their own IdFactory, so both start at n1.
		expect(incoming.parts[0].voices[0].events[0].id).toBe(
			target.parts[0].voices[0].events[0].id
		);

		const { score } = mergeParts(target, incoming);
		const ids = score.parts.flatMap((p) => [
			p.id,
			...p.voices.flatMap((v) => [v.id, ...v.events.map((e) => e.id)])
		]);
		expect(new Set(ids).size).toBe(ids.length);
	});

	it('reports the ids it added, and they exist in the result', () => {
		const { score, addedIds } = mergeParts(withPart('Target'), withPart('Incoming'));
		const present = new Set(score.parts.flatMap((p) => p.voices.flatMap((v) => v.events)).map((e) => e.id));
		expect(addedIds.length).toBe(2);
		for (const id of addedIds) expect(present.has(id)).toBe(true);
	});

	it('keeps rests and ties, which insert_notes cannot carry', () => {
		const incoming = emptyScore('Incoming');
		incoming.parts = [
			{
				id: 'p1',
				name: 'Voice',
				gmProgram: 0,
				channel: 0,
				isDrum: false,
				clef: 'treble',
				transpose: 0,
				volume: 0.8,
				muted: false,
				voices: [
					{
						id: 'v1',
						events: [
							{ id: 'r1', kind: 'rest', tick: 0, dur: 480 },
							{ id: 'n1', kind: 'note', tick: 480, dur: 480, pitches: [{ midi: 60, tie: 'start' }], vel: 80 },
							{ id: 'n2', kind: 'note', tick: 960, dur: 480, pitches: [{ midi: 60, tie: 'stop' }], vel: 80 }
						]
					}
				]
			}
		];
		const { score } = mergeParts(emptyScore('Target'), incoming);
		const events = score.parts[0].voices[0].events;
		expect(events[0].kind).toBe('rest');
		expect(events.filter(isNote).map((n) => n.pitches[0].tie)).toEqual(['start', 'stop']);
	});

	it('offsets the incoming material when asked', () => {
		const { score } = mergeParts(emptyScore('T'), withPart('I'), { atTick: 1920 });
		expect(score.parts[0].voices[0].events.map((e) => e.tick)).toEqual([1920, 2400]);
	});

	it('adopts tempo, key and metre into an empty target', () => {
		const incoming = withPart('Incoming');
		incoming.tempoMap = [{ tick: 0, bpm: 76 }];
		incoming.keySigs = [{ tick: 0, fifths: -3, mode: 'minor' }];
		incoming.timeSigs = [{ tick: 0, num: 6, den: 8 }];

		const { score } = mergeParts(emptyScore('Empty'), incoming);
		expect(score.tempoMap[0].bpm).toBe(76);
		expect(score.keySigs[0].fifths).toBe(-3);
		expect(score.timeSigs[0].num).toBe(6);
	});

	it('leaves an occupied target’s tempo and key alone', () => {
		const target = withPart('Target');
		target.tempoMap = [{ tick: 0, bpm: 132 }];
		const incoming = withPart('Incoming');
		incoming.tempoMap = [{ tick: 0, bpm: 76 }];

		expect(mergeParts(target, incoming).score.tempoMap[0].bpm).toBe(132);
	});

	it('can be told to adopt globals even into an occupied target', () => {
		const target = withPart('Target');
		target.tempoMap = [{ tick: 0, bpm: 132 }];
		const incoming = withPart('Incoming');
		incoming.tempoMap = [{ tick: 0, bpm: 76 }];

		const { score } = mergeParts(target, incoming, { adoptGlobals: true });
		expect(score.tempoMap[0].bpm).toBe(76);
	});

	it('gives the new part a free channel', () => {
		const target = withPart('Target');
		const { score } = mergeParts(target, withPart('Incoming'));
		expect(score.parts[1].channel).not.toBe(score.parts[0].channel);
		expect(score.parts[1].channel).not.toBe(9);
	});

	it('puts a drum part on channel 9', () => {
		const incoming = withPart('Kit');
		incoming.parts[0].isDrum = true;
		expect(mergeParts(emptyScore('T'), incoming).score.parts[0].channel).toBe(9);
	});

	it('merges nothing gracefully', () => {
		const target = withPart('Target');
		const { score, addedIds, addedParts } = mergeParts(target, emptyScore('Nothing'));
		expect(addedParts).toBe(0);
		expect(addedIds).toHaveLength(0);
		expect(score.parts).toHaveLength(1);
	});
});

describe('created parts', () => {
	// addedParts is a count, which is enough to write a log line and not enough
	// to refer to a part afterwards. The Brief stage needs to record which part
	// the transcription became so later stages can point at "the theme".
	it('returns the ids of the parts it added, matching the count', () => {
		const target = withPart('Target');
		const incoming = withPart('Incoming', 'Flute');

		const before = target.parts.map((p) => p.id);
		const r = mergeParts(target, incoming);

		expect(r.addedPartIds).toHaveLength(r.addedParts);
		expect(r.addedPartIds).toEqual(r.score.parts.map((p) => p.id).filter((id) => !before.includes(id)));
	});

	it('returns an empty list when nothing arrives', () => {
		const r = mergeParts(withPart('Target'), emptyScore('Empty'));
		expect(r.addedParts).toBe(0);
		expect(r.addedPartIds).toEqual([]);
	});
});
