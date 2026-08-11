import { keySigAt } from '$lib/score/measures';
import { isNote } from '$lib/score/query';
import type { Note, Score } from '$lib/score/types';

/**
 * Score → Standard MIDI File (format 1).
 *
 * This is the most load-bearing module in the audio stack, because three
 * features consume its output rather than one:
 *
 *   Score → SMF ─┬─► download                         (MIDI export)
 *                ├─► BasicMIDI.fromArrayBuffer ─┬─► Sequencer   (playback)
 *                └──────────────────────────────┴─► offline render (WAV/MP3)
 *
 * Playback and the exported audio are therefore literally the same bytes, so
 * they cannot drift apart — which is the usual way "it sounded different when
 * I exported it" bugs happen.
 *
 * Written by hand rather than via a library: SMF is a simple format, and the
 * awkward parts (running status, variable-length quantities, the tempo
 * meta-event's 24-bit microseconds) are exactly the parts a wrapper hides
 * until they go wrong.
 */

/** Variable-length quantity: 7 bits per byte, high bit set on all but the last. */
function vlq(value: number): number[] {
	let v = Math.max(0, Math.round(value));
	const out = [v & 0x7f];
	v >>= 7;
	while (v > 0) {
		out.unshift((v & 0x7f) | 0x80);
		v >>= 7;
	}
	return out;
}

function u32(n: number): number[] {
	return [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
}

function u16(n: number): number[] {
	return [(n >>> 8) & 0xff, n & 0xff];
}

function ascii(s: string): number[] {
	return [...s].map((c) => c.charCodeAt(0) & 0xff);
}

/** A MIDI event before delta-time encoding. */
interface RawEvent {
	tick: number;
	/** Lower sorts first at the same tick. Note-offs must precede note-ons so a
	 *  repeated pitch retriggers instead of being cut short by its predecessor. */
	order: number;
	bytes: number[];
}

function chunk(type: string, data: number[]): number[] {
	return [...ascii(type), ...u32(data.length), ...data];
}

function trackChunk(events: RawEvent[]): number[] {
	const sorted = [...events].sort((a, b) => a.tick - b.tick || a.order - b.order);
	const data: number[] = [];
	let last = 0;
	for (const e of sorted) {
		data.push(...vlq(e.tick - last), ...e.bytes);
		last = e.tick;
	}
	// End of track. Required; some parsers reject a track without it.
	data.push(...vlq(0), 0xff, 0x2f, 0x00);
	return chunk('MTrk', data);
}

/** Articulations that change how long a note actually sounds. */
function articulationDuration(note: Note, dur: number): number {
	const a = note.artic ?? [];
	if (a.includes('staccatissimo')) return Math.max(1, Math.round(dur * 0.25));
	if (a.includes('staccato')) return Math.max(1, Math.round(dur * 0.5));
	if (a.includes('tenuto')) return Math.max(1, Math.round(dur * 0.98));
	if (a.includes('fermata')) return Math.round(dur * 1.75);
	// A hair short by default so repeated pitches articulate rather than slur.
	return Math.max(1, Math.round(dur * 0.92));
}

function articulationVelocity(note: Note): number {
	const a = note.artic ?? [];
	let vel = note.vel;
	if (a.includes('accent')) vel = Math.round(vel * 1.2);
	if (a.includes('marcato')) vel = Math.round(vel * 1.3);
	return Math.max(1, Math.min(127, vel));
}

export interface MidiOptions {
	/** Apply per-part volume as CC7. Off for export where a DAW should decide. */
	applyMix?: boolean;
	/** Skip muted parts entirely rather than writing them at volume 0. */
	skipMuted?: boolean;
}

/**
 * Serialise to a format-1 SMF.
 *
 * Track 0 is the conductor track (tempo, time and key signatures, title);
 * every part gets its own track after it. That is the layout every DAW and
 * notation program expects, and it keeps tempo edits away from note data.
 */
export function scoreToMidi(score: Score, opts: MidiOptions = {}): Uint8Array {
	const applyMix = opts.applyMix ?? true;
	const skipMuted = opts.skipMuted ?? true;

	// ---- conductor track -------------------------------------------------
	const conductor: RawEvent[] = [];

	if (score.title) {
		const name = ascii(score.title).slice(0, 127);
		conductor.push({ tick: 0, order: 0, bytes: [0xff, 0x03, name.length, ...name] });
	}

	for (const t of score.tempoMap) {
		// Tempo is microseconds per quarter note, in 24 bits.
		const uspq = Math.max(1, Math.min(0xffffff, Math.round(60_000_000 / Math.max(1, t.bpm))));
		conductor.push({
			tick: t.tick,
			order: 1,
			bytes: [0xff, 0x51, 0x03, (uspq >> 16) & 0xff, (uspq >> 8) & 0xff, uspq & 0xff]
		});
	}

	for (const ts of score.timeSigs) {
		// The denominator is stored as a power of two, not the number itself.
		const dd = Math.round(Math.log2(Math.max(1, ts.den)));
		conductor.push({ tick: ts.tick, order: 2, bytes: [0xff, 0x58, 0x04, ts.num, dd, 24, 8] });
	}

	for (const ks of score.keySigs) {
		// sf is signed; two's complement in one byte.
		const sf = ks.fifths < 0 ? 256 + ks.fifths : ks.fifths;
		conductor.push({
			tick: ks.tick,
			order: 3,
			bytes: [0xff, 0x59, 0x02, sf & 0xff, ks.mode === 'minor' ? 1 : 0]
		});
	}

	const tracks: number[][] = [trackChunk(conductor)];

	// ---- one track per part ---------------------------------------------
	for (const part of score.parts) {
		if (skipMuted && part.muted) continue;

		const ch = Math.max(0, Math.min(15, part.channel));
		const events: RawEvent[] = [];

		const name = ascii(part.name).slice(0, 127);
		events.push({ tick: 0, order: 0, bytes: [0xff, 0x03, name.length, ...name] });

		// A drum part's program is meaningless — channel 10 selects the kit.
		if (!part.isDrum) {
			events.push({ tick: 0, order: 1, bytes: [0xc0 | ch, part.gmProgram & 0x7f] });
		}
		if (applyMix) {
			const vol = Math.round(Math.max(0, Math.min(1, part.volume)) * 127);
			events.push({ tick: 0, order: 2, bytes: [0xb0 | ch, 7, vol] });
		}

		for (const voice of part.voices) {
			for (const event of voice.events) {
				if (!isNote(event)) continue;
				const note = event;
				const vel = articulationVelocity(note);
				const dur = articulationDuration(note, note.dur);

				for (const pitch of note.pitches) {
					// A tie continuation is already sounding from the tied-from
					// note, so emitting it again would retrigger the attack.
					if (pitch.tie === 'stop') continue;

					const midi = Math.max(0, Math.min(127, pitch.midi + part.transpose));
					const start = Math.max(0, note.tick);

					events.push({ tick: start, order: 10, bytes: [0x90 | ch, midi, vel] });
					// order 5 < 10 so a note-off at tick T is written before a
					// note-on at the same tick — otherwise a repeated pitch is
					// silenced the instant it restarts.
					events.push({ tick: start + dur, order: 5, bytes: [0x80 | ch, midi, 0] });
				}
			}
		}

		tracks.push(trackChunk(events));
	}

	const header = chunk('MThd', [...u16(1), ...u16(tracks.length), ...u16(score.ppq)]);
	return Uint8Array.from([...header, ...tracks.flat()]);
}

/** Convenience for the download path and for BasicMIDI.fromArrayBuffer. */
export function scoreToMidiBuffer(score: Score, opts?: MidiOptions): ArrayBuffer {
	const bytes = scoreToMidi(score, opts);
	// Copy into a standalone ArrayBuffer: the view may be a slice of a larger
	// pooled buffer, and passing that whole buffer to a parser reads garbage.
	const out = new ArrayBuffer(bytes.byteLength);
	new Uint8Array(out).set(bytes);
	return out;
}

export function scoreToMidiBlob(score: Score, opts?: MidiOptions): Blob {
	return new Blob([scoreToMidiBuffer(score, opts)], { type: 'audio/midi' });
}

/** Sounding length of the score in seconds, honouring every tempo change. */
export function scoreDurationSeconds(score: Score): number {
	let endTick = 0;
	for (const part of score.parts) {
		for (const voice of part.voices) {
			for (const e of voice.events) endTick = Math.max(endTick, e.tick + e.dur);
		}
	}
	if (endTick === 0) return 0;

	const marks = [...score.tempoMap].sort((a, b) => a.tick - b.tick);
	let seconds = 0;
	for (let i = 0; i < marks.length; i++) {
		const from = marks[i].tick;
		const to = Math.min(marks[i + 1]?.tick ?? endTick, endTick);
		if (to <= from) continue;
		seconds += ((to - from) / score.ppq) * (60 / Math.max(1, marks[i].bpm));
	}
	return seconds;
}

export { keySigAt };
