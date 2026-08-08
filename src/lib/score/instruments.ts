/**
 * The General MIDI instrument set.
 *
 * The names are the GM standard ones, in program order, because that's what
 * the soundfont is indexed by and what a model already knows from training.
 * Asking Claude for "Acoustic Grand Piano" gets a reliable answer; asking it
 * for "program 0" does not.
 */

export const GM_INSTRUMENTS = [
	'Acoustic Grand Piano', 'Bright Acoustic Piano', 'Electric Grand Piano', 'Honky-tonk Piano',
	'Electric Piano 1', 'Electric Piano 2', 'Harpsichord', 'Clavi',
	'Celesta', 'Glockenspiel', 'Music Box', 'Vibraphone',
	'Marimba', 'Xylophone', 'Tubular Bells', 'Dulcimer',
	'Drawbar Organ', 'Percussive Organ', 'Rock Organ', 'Church Organ',
	'Reed Organ', 'Accordion', 'Harmonica', 'Tango Accordion',
	'Acoustic Guitar (nylon)', 'Acoustic Guitar (steel)', 'Electric Guitar (jazz)',
	'Electric Guitar (clean)', 'Electric Guitar (muted)', 'Overdriven Guitar',
	'Distortion Guitar', 'Guitar Harmonics',
	'Acoustic Bass', 'Electric Bass (finger)', 'Electric Bass (pick)', 'Fretless Bass',
	'Slap Bass 1', 'Slap Bass 2', 'Synth Bass 1', 'Synth Bass 2',
	'Violin', 'Viola', 'Cello', 'Contrabass',
	'Tremolo Strings', 'Pizzicato Strings', 'Orchestral Harp', 'Timpani',
	'String Ensemble 1', 'String Ensemble 2', 'Synth Strings 1', 'Synth Strings 2',
	'Choir Aahs', 'Voice Oohs', 'Synth Voice', 'Orchestra Hit',
	'Trumpet', 'Trombone', 'Tuba', 'Muted Trumpet',
	'French Horn', 'Brass Section', 'Synth Brass 1', 'Synth Brass 2',
	'Soprano Sax', 'Alto Sax', 'Tenor Sax', 'Baritone Sax',
	'Oboe', 'English Horn', 'Bassoon', 'Clarinet',
	'Piccolo', 'Flute', 'Recorder', 'Pan Flute',
	'Blown Bottle', 'Shakuhachi', 'Whistle', 'Ocarina',
	'Lead 1 (square)', 'Lead 2 (sawtooth)', 'Lead 3 (calliope)', 'Lead 4 (chiff)',
	'Lead 5 (charang)', 'Lead 6 (voice)', 'Lead 7 (fifths)', 'Lead 8 (bass + lead)',
	'Pad 1 (new age)', 'Pad 2 (warm)', 'Pad 3 (polysynth)', 'Pad 4 (choir)',
	'Pad 5 (bowed)', 'Pad 6 (metallic)', 'Pad 7 (halo)', 'Pad 8 (sweep)',
	'FX 1 (rain)', 'FX 2 (soundtrack)', 'FX 3 (crystal)', 'FX 4 (atmosphere)',
	'FX 5 (brightness)', 'FX 6 (goblins)', 'FX 7 (echoes)', 'FX 8 (sci-fi)',
	'Sitar', 'Banjo', 'Shamisen', 'Koto',
	'Kalimba', 'Bagpipe', 'Fiddle', 'Shanai',
	'Tinkle Bell', 'Agogo', 'Steel Drums', 'Woodblock',
	'Taiko Drum', 'Melodic Tom', 'Synth Drum', 'Reverse Cymbal',
	'Guitar Fret Noise', 'Breath Noise', 'Seashore', 'Bird Tweet',
	'Telephone Ring', 'Helicopter', 'Applause', 'Gunshot'
] as const;

/** Common names people (and models) actually use, mapped to GM programs. */
const ALIASES: Record<string, number> = {
	piano: 0,
	'grand piano': 0,
	'electric piano': 4,
	organ: 19,
	guitar: 25,
	'acoustic guitar': 25,
	'electric guitar': 27,
	bass: 33,
	'double bass': 43,
	'upright bass': 32,
	strings: 48,
	'string ensemble': 48,
	harp: 46,
	choir: 52,
	voice: 53,
	horn: 60,
	'french horn': 60,
	brass: 61,
	sax: 65,
	saxophone: 65,
	drums: 0,
	'drum kit': 0,
	percussion: 0,
	synth: 81,
	pad: 89,
	'synth pad': 89,
	'synth lead': 80
};

const NORMALISED = new Map<string, number>();
GM_INSTRUMENTS.forEach((name, i) => NORMALISED.set(name.toLowerCase(), i));
for (const [k, v] of Object.entries(ALIASES)) if (!NORMALISED.has(k)) NORMALISED.set(k, v);

/**
 * Resolve an instrument name to a GM program number.
 *
 * Exact match, then alias, then a substring search — because a model will
 * happily write "Violin I" or "solo cello", and silently defaulting all of
 * those to piano would be a very confusing bug to chase.
 */
export function gmProgramFor(name: string): number {
	const s = name.trim().toLowerCase();
	const exact = NORMALISED.get(s);
	if (exact != null) return exact;

	// Longest match wins so "acoustic bass" doesn't resolve via "bass".
	let best: { idx: number; len: number } | null = null;
	for (const [key, idx] of NORMALISED) {
		if ((s.includes(key) || key.includes(s)) && (!best || key.length > best.len)) {
			best = { idx, len: key.length };
		}
	}
	return best?.idx ?? 0;
}

export function gmName(program: number): string {
	return GM_INSTRUMENTS[Math.max(0, Math.min(127, program))] ?? 'Acoustic Grand Piano';
}

/** Instrument name → the key used in INSTRUMENT_RANGES, for playability checks. */
export function rangeKeyFor(name: string): string {
	const s = name.toLowerCase();
	for (const key of [
		'piano', 'violin', 'viola', 'cello', 'contrabass', 'flute', 'oboe', 'clarinet',
		'bassoon', 'trumpet', 'horn', 'trombone', 'tuba', 'guitar', 'bass',
		'soprano', 'alto', 'tenor', 'baritone', 'voice'
	]) {
		if (s.includes(key)) return key;
	}
	return 'piano';
}
