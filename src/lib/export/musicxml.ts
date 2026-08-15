import { measuresOf } from '$lib/score/measures.js';
import { isNote } from '$lib/score/query.js';
import { ticksToDuration } from '$lib/render/duration.js';
import { gmName } from '$lib/score/instruments.js';
import type { Clef, Note, Part, Score, ScoreEvent } from '$lib/score/types.js';

/**
 * Score → MusicXML 4.0 (partwise).
 *
 * This is the interchange format: it is what opens in MuseScore, Sibelius,
 * Finale and Dorico. MIDI carries the sound but loses the notation — spelling,
 * clefs, articulations, ties, the difference between F♯ and G♭ — and that lost
 * half is exactly what someone exporting a *score* wants.
 *
 * Written by hand for the same reason as the MIDI encoder: the format is
 * verbose but simple, and the awkward parts (chords being a flag on the second
 * note rather than a container, ties being two elements that must agree) are
 * precisely what a wrapper would hide until they went wrong.
 */

/** Note-type names, keyed by the VexFlow codes our duration helper returns. */
const TYPE_NAMES: Record<string, string> = {
	w: 'whole',
	h: 'half',
	q: 'quarter',
	'8': 'eighth',
	'16': '16th',
	'32': '32nd',
	'64': '64th'
};

const CLEF_SIGNS: Record<Clef, { sign: string; line: number; octaveChange?: number }> = {
	treble: { sign: 'G', line: 2 },
	bass: { sign: 'F', line: 4 },
	alto: { sign: 'C', line: 3 },
	tenor: { sign: 'C', line: 4 },
	percussion: { sign: 'percussion', line: 2 }
};

const SHARP_STEPS = ['C', 'C', 'D', 'D', 'E', 'F', 'F', 'G', 'G', 'A', 'A', 'B'];
const SHARP_ALTER = [0, 1, 0, 1, 0, 0, 1, 0, 1, 0, 1, 0];
const FLAT_STEPS = ['C', 'D', 'D', 'E', 'E', 'F', 'G', 'G', 'A', 'A', 'B', 'B'];
const FLAT_ALTER = [0, -1, 0, -1, 0, 0, -1, 0, -1, 0, -1, 0];

/** MusicXML articulation elements, by our vocabulary. */
const ARTICULATIONS: Record<string, string> = {
	staccato: 'staccato',
	staccatissimo: 'staccatissimo',
	accent: 'accent',
	marcato: 'strong-accent',
	tenuto: 'tenuto'
};
/** These are ornaments rather than articulations — a different parent element. */
const ORNAMENTS: Record<string, string> = {
	trill: 'trill-mark',
	mordent: 'mordent',
	turn: 'turn'
};

export function escapeXml(value: string): string {
	return value
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&apos;');
}

/**
 * MIDI number → step, alter and octave.
 *
 * Spelling follows the key signature's side of the circle of fifths, and an
 * explicit `spell` on the pitch overrides it — the same rule the on-screen
 * renderer uses, so an exported score reads the way it looked.
 */
export function pitchToXml(
	midi: number,
	fifths: number,
	spell?: string
): { step: string; alter: number; octave: number } {
	if (spell) {
		const m = /^([A-Ga-g])(#{1,2}|b{1,2}|)(-?\d+)$/.exec(spell.trim());
		if (m) {
			const step = m[1].toUpperCase();
			const accidental = m[2];
			const alter = accidental.startsWith('#') ? accidental.length : -accidental.length;
			return { step, alter, octave: Number(m[3]) };
		}
	}

	const pc = ((midi % 12) + 12) % 12;
	const flatSide = fifths < 0;
	const step = flatSide ? FLAT_STEPS[pc] : SHARP_STEPS[pc];
	const alter = flatSide ? FLAT_ALTER[pc] : SHARP_ALTER[pc];
	// The octave belongs to the *letter*, not the pitch class: B♯3 and C4 are
	// the same key, and writing octave 4 for a B♯ would move it a step.
	let octave = Math.floor(midi / 12) - 1;
	if (alter === -1 && step === 'C') octave += 1; // C♭ spelled from B
	if (alter === 1 && step === 'B') octave -= 1; // B♯ spelled from C
	return { step, alter, octave };
}

interface XmlOptions {
	/** Software name in the encoding block. */
	software?: string;
}

export function scoreToMusicXml(score: Score, opts: XmlOptions = {}): string {
	const lines: string[] = [
		'<?xml version="1.0" encoding="UTF-8"?>',
		'<!DOCTYPE score-partwise PUBLIC "-//Recordare//DTD MusicXML 4.0 Partwise//EN" "http://www.musicxml.org/dtds/partwise.dtd">',
		'<score-partwise version="4.0">',
		'  <work>',
		`    <work-title>${escapeXml(score.title)}</work-title>`,
		'  </work>',
		'  <identification>'
	];

	if (score.composer) {
		lines.push(`    <creator type="composer">${escapeXml(score.composer)}</creator>`);
	}
	lines.push(
		'    <encoding>',
		`      <software>${escapeXml(opts.software ?? 'Melody')}</software>`,
		`      <encoding-date>${new Date().toISOString().slice(0, 10)}</encoding-date>`,
		'    </encoding>',
		'  </identification>',
		'  <part-list>'
	);

	score.parts.forEach((part, i) => {
		const id = `P${i + 1}`;
		lines.push(
			`    <score-part id="${id}">`,
			`      <part-name>${escapeXml(part.name)}</part-name>`,
			`      <score-instrument id="${id}-I1">`,
			`        <instrument-name>${escapeXml(gmName(part.gmProgram))}</instrument-name>`,
			'      </score-instrument>',
			`      <midi-instrument id="${id}-I1">`,
			// MusicXML counts channels and programs from 1; we store both from 0.
			`        <midi-channel>${part.channel + 1}</midi-channel>`,
			`        <midi-program>${part.gmProgram + 1}</midi-program>`,
			'      </midi-instrument>',
			'    </score-part>'
		);
	});
	lines.push('  </part-list>');

	const measures = measuresOf(score);
	score.parts.forEach((part, i) => {
		lines.push(`  <part id="P${i + 1}">`);
		lines.push(...partBody(score, part, measures));
		lines.push('  </part>');
	});

	lines.push('</score-partwise>');
	return lines.join('\n');
}

function partBody(
	score: Score,
	part: Part,
	measures: ReturnType<typeof measuresOf>
): string[] {
	const out: string[] = [];
	const events = part.voices
		.flatMap((v) => v.events)
		.slice()
		.sort((a, b) => a.tick - b.tick);

	// An empty score still needs one measure, or the file is invalid.
	const bars = measures.length ? measures : [];

	for (const measure of bars) {
		out.push(`    <measure number="${measure.number}">`);

		const isFirst = measure.index === 0;
		if (isFirst || measure.keyChange || measure.timeChange) {
			out.push('      <attributes>');
			if (isFirst) out.push(`        <divisions>${score.ppq}</divisions>`);

			const key = measure.keyChange ?? (isFirst ? keyAt(score, measure.startTick) : undefined);
			if (key) {
				out.push(
					'        <key>',
					`          <fifths>${key.fifths}</fifths>`,
					`          <mode>${key.mode}</mode>`,
					'        </key>'
				);
			}
			const sig = measure.timeChange ?? (isFirst ? measure.timeSig : undefined);
			if (sig) {
				out.push(
					'        <time>',
					`          <beats>${sig.num}</beats>`,
					`          <beat-type>${sig.den}</beat-type>`,
					'        </time>'
				);
			}
			if (isFirst) {
				const clef = CLEF_SIGNS[part.clef] ?? CLEF_SIGNS.treble;
				out.push(
					'        <clef>',
					`          <sign>${clef.sign}</sign>`,
					`          <line>${clef.line}</line>`,
					'        </clef>'
				);
			}
			out.push('      </attributes>');
		}

		const tempo = measure.tempoChange ?? (isFirst ? tempoAt(score, measure.startTick) : undefined);
		if (tempo) {
			out.push(
				'      <direction placement="above">',
				'        <direction-type>',
				'          <metronome>',
				'            <beat-unit>quarter</beat-unit>',
				`            <per-minute>${Math.round(tempo.bpm)}</per-minute>`,
				'          </metronome>',
				'        </direction-type>',
				`        <sound tempo="${Math.round(tempo.bpm)}"/>`,
				'      </direction>'
			);
		}

		const inBar = events.filter((e) => e.tick >= measure.startTick && e.tick < measure.endTick);
		const fifths = keyAt(score, measure.startTick).fifths;

		if (inBar.length === 0) {
			// A measure with no content still has to account for its full
			// length, or every bar after it shifts.
			out.push(...restXml(measure.endTick - measure.startTick, score.ppq));
		} else {
			let cursor = measure.startTick;
			for (const event of inBar) {
				// Silence before this event is a rest, not a gap.
				if (event.tick > cursor) out.push(...restXml(event.tick - cursor, score.ppq));
				out.push(...eventXml(event, score.ppq, fifths));
				cursor = event.tick + event.dur;
			}
			if (cursor < measure.endTick) {
				out.push(...restXml(measure.endTick - cursor, score.ppq));
			}
		}

		out.push('    </measure>');
	}

	return out;
}

function eventXml(event: ScoreEvent, ppq: number, fifths: number): string[] {
	if (!isNote(event)) return restXml(event.dur, ppq);

	const note = event as Note;
	const { duration, dots } = ticksToDuration(note.dur, ppq);
	const type = TYPE_NAMES[duration] ?? 'quarter';
	const out: string[] = [];

	note.pitches.forEach((pitch, index) => {
		const { step, alter, octave } = pitchToXml(pitch.midi, fifths, pitch.spell);
		out.push('      <note>');
		// A chord is expressed by flagging every note *after* the first, which
		// is why this cannot be built as a container.
		if (index > 0) out.push('        <chord/>');
		out.push('        <pitch>', `          <step>${step}</step>`);
		if (alter !== 0) out.push(`          <alter>${alter}</alter>`);
		out.push(`          <octave>${octave}</octave>`, '        </pitch>');
		out.push(`        <duration>${Math.max(1, Math.round(note.dur))}</duration>`);

		// A tie is two things that must agree: <tie> is the sound, <tied> is
		// the printed slur. Writing one without the other is a common way to
		// produce a file that plays right and looks wrong.
		const tie = pitch.tie;
		if (tie === 'start' || tie === 'both') out.push('        <tie type="start"/>');
		if (tie === 'stop' || tie === 'both') out.push('        <tie type="stop"/>');

		out.push('        <voice>1</voice>', `        <type>${type}</type>`);
		for (let d = 0; d < dots; d++) out.push('        <dot/>');

		const notations = notationsXml(note, tie, index === 0);
		out.push(...notations);
		out.push('      </note>');
	});

	return out;
}

function notationsXml(note: Note, tie: string | undefined, first: boolean): string[] {
	const arts = (note.artic ?? []).filter((a) => a in ARTICULATIONS);
	const orns = (note.artic ?? []).filter((a) => a in ORNAMENTS);
	const fermata = (note.artic ?? []).includes('fermata');
	const tied = tie === 'start' || tie === 'stop' || tie === 'both';
	const slur = first && note.slur;

	if (!arts.length && !orns.length && !fermata && !tied && !slur) return [];

	const out = ['        <notations>'];
	if (tie === 'start' || tie === 'both') out.push('          <tied type="start"/>');
	if (tie === 'stop' || tie === 'both') out.push('          <tied type="stop"/>');
	if (slur) out.push(`          <slur type="${note.slur}" number="1"/>`);
	if (arts.length) {
		out.push('          <articulations>');
		for (const a of arts) out.push(`            <${ARTICULATIONS[a]}/>`);
		out.push('          </articulations>');
	}
	if (orns.length) {
		out.push('          <ornaments>');
		for (const o of orns) out.push(`            <${ORNAMENTS[o]}/>`);
		out.push('          </ornaments>');
	}
	if (fermata) out.push('          <fermata/>');
	out.push('        </notations>');
	return out;
}

function restXml(ticks: number, ppq: number): string[] {
	if (ticks <= 0) return [];
	const { duration, dots } = ticksToDuration(ticks, ppq);
	const out = [
		'      <note>',
		'        <rest/>',
		`        <duration>${Math.max(1, Math.round(ticks))}</duration>`,
		'        <voice>1</voice>',
		`        <type>${TYPE_NAMES[duration] ?? 'quarter'}</type>`
	];
	for (let d = 0; d < dots; d++) out.push('        <dot/>');
	out.push('      </note>');
	return out;
}

function keyAt(score: Score, tick: number) {
	let current = score.keySigs[0] ?? { tick: 0, fifths: 0, mode: 'major' as const };
	for (const k of score.keySigs) if (k.tick <= tick) current = k;
	return current;
}

function tempoAt(score: Score, tick: number) {
	let current = score.tempoMap[0] ?? { tick: 0, bpm: 120 };
	for (const t of score.tempoMap) if (t.tick <= tick) current = t;
	return current;
}

export function scoreToMusicXmlBlob(score: Score): Blob {
	return new Blob([scoreToMusicXml(score)], { type: 'application/vnd.recordare.musicxml+xml' });
}
