/**
 * Seed style skills, written to disk on first boot.
 *
 * These are markdown files, not code, and that is the point: adding a genre
 * means writing a file into DATA_DIR/skills/style/<name>/SKILL.md and hitting
 * reindex. No deploy, no schema change, no restart.
 *
 * What makes a skill useful is specifics — actual rhythm cells, actual
 * voicings, actual bass movement. A model already knows what bossa nova sounds
 * like in the abstract; what it needs is the concrete devices to reach for.
 */

export interface SeedSkill {
	name: string;
	category: string;
	body: string;
}

export const SEED_SKILLS: SeedSkill[] = [
	{
		name: 'bossa-nova',
		category: 'style',
		body: `# Bossa nova

> Brazilian, cool, understated. Syncopated guitar comping over a steady two-feel bass, sung softly.

## Rhythm
The defining pattern is a two-bar guitar cell in 4/4. In ticks from the bar start, chord stabs fall at:
bar 1: 0, 720, 1200 — bar 2: 240, 960, 1440.
Do not play on every beat. The space is the style.

Bass plays a two-feel: root on beat 1, fifth on beat 3 (ticks 0 and 960), often with a quaver pickup into the next bar.

Drums, if present, stay on brushes or rim: soft, steady, never driving.

## Harmony
- Sevenths and ninths everywhere; a plain triad sounds wrong in this idiom.
- Common: Imaj7 – ii7 – V7 – Imaj7, with frequent ii-V motion into unexpected keys.
- Tritone substitution is idiomatic (bII7 for V7).
- Chromatic descending bass lines under static upper voices.

## Voicing
Guitar voicings are close, mid-register, usually four notes with the root omitted when the bass has it. Keep chords between C3 and C5.

## Melody
Narrow range, mostly stepwise, lots of repeated notes. Phrases start off the beat and end early, leaving air. Sung, not belted — velocities 50-75.

## Tempo
120-150 bpm, but felt in two, so it reads as relaxed rather than fast.
`
	},
	{
		name: 'baroque',
		category: 'style',
		body: `# Baroque

> Contrapuntal, motoric, ornamented. Independent lines rather than melody-plus-accompaniment.

## Texture
Two to four independent voices, each of which would be worth listening to alone. This is the single biggest difference from later styles: there is no "accompaniment" part.

- Continuous quaver or semiquaver motion in at least one voice ("motoric rhythm").
- Voices imitate each other: a subject stated in one voice answers in another a bar or two later, usually at the fifth.
- Suspensions on strong beats, resolving down by step.

## Harmony
- Functional and directional: circle-of-fifths sequences are the engine.
- Cadences are clearly prepared. Perfect cadences with a 4-3 suspension.
- Modulate to the dominant (major keys) or relative major (minor keys) by the midpoint.
- Picardy third at a final cadence in a minor key.

## Voice leading
Strict. No parallel fifths or octaves. Resolve leading notes upward. Keep voices within a ninth of each other except the bass.

## Ornamentation
Trills on cadential notes, mordents on strong beats, appoggiaturas before resolutions. Notate as articulations, not as extra notes.

## Instrumentation
Harpsichord, strings, recorder, oboe. No dynamics markings beyond terraced contrast — Baroque dynamics are structural, not gradual, so avoid crescendos.
`
	},
	{
		name: 'lo-fi',
		category: 'style',
		body: `# Lo-fi

> Hazy, warm, unhurried. Simple loops, jazz harmony, deliberately imperfect timing.

## Rhythm
- 70-90 bpm. Slow enough to feel like a held breath.
- Swung quavers, around 0.58-0.62 — less than jazz swing, enough to stop it feeling square.
- Drums land slightly behind the beat. Humanise timing by 15-30 ticks, velocity by 12-20.
- Loop a 2 or 4 bar pattern with only small variations.

## Harmony
Jazz chords, simple progressions:
- Imaj7 – vi7 – ii7 – V7
- iv7 – bVII7 – Imaj7
- Extended chords held for a whole bar or two. Slow harmonic rhythm is essential.

## Voicing
Piano or electric piano playing rootless, close voicings in the middle register (C3-C5), often with the 9th on top. Bass takes the root, plain and low.

## Melody
Sparse. Long notes, lots of rests, a short motif repeated with small changes. It should feel like something half-remembered rather than a tune being performed.

## Texture
Three or four elements maximum: drums, bass, keys, one melodic voice. Adding more breaks the style.
`
	},
	{
		name: 'cinematic',
		category: 'style',
		body: `# Cinematic

> Wide, patient, built for picture. Slow harmonic rhythm and long dynamic arcs.

## Form
Cinematic writing is about arc, not sections. Build over 16-32 bars: start with one element, add a layer every 4-8 bars, peak, then drop away sharply.

## Harmony
- Slow: one or two chords per bar at most, often one chord for two bars.
- Modal rather than functional. Aeolian and Dorian for weight, Lydian for wonder.
- bVI and bVII are the workhorse chords.
- Pedal points under changing harmony create suspension without needing dissonance.
- Avoid strong perfect cadences until the very end; they close things down.

## Orchestration by layer
1. Foundation: sustained low strings or a pad, whole notes.
2. Pulse: repeated quavers or semiquavers in violas or piano — this is what creates motion.
3. Melody: violins, cello or horn, long phrases, mostly stepwise, wide leaps saved for the peak.
4. Colour: piano octaves, harp, high sustained strings at the climax.
5. Weight: low brass and timpani, held back until the final third.

## Dynamics
Long crescendos across many bars, not within one. Velocity from 40 at the opening to 110+ at the peak. The drop after a climax should be sudden.
`
	},
	{
		name: 'gospel',
		category: 'style',
		body: `# Gospel

> Rich harmony, driving rhythm, call and response. Everything is voiced fully.

## Harmony
The richest of the common idioms. Reach for:
- Extended and altered dominants everywhere; a plain V is a wasted opportunity.
- Chromatic passing chords between diatonic ones — especially diminished sevenths.
- bIII7, bVI7 and bVII7 as passing colour in a major key.
- Frequent ii-V-I, often in quick succession through several keys.
- The "amen" plagal cadence (IV-I) at endings.

## Piano
Both hands full. Left hand plays root-and-tenth or octaves; right hand plays four-note voicings, often in parallel motion. Fills between vocal phrases are essential — chromatic runs, grace notes, and octave tremolos.

## Rhythm
- Straight or lightly swung, 70-110 bpm.
- Heavy anticipation: chords land an quaver *before* the beat (tick 1680 rather than 1920).
- Strong backbeat on 2 and 4.

## Voices
SATB with the melody usually in the soprano but sometimes doubled an octave below. Close harmony, all four parts moving together in block chords. Call and response between a lead line and the choir.

## Dynamics
Wide. Verses can be genuinely quiet; choruses are full. Velocities 55 to 115.
`
	},
	{
		name: 'synthwave',
		category: 'style',
		body: `# Synthwave

> 1980s film-score nostalgia. Arpeggios, wide pads, gated drums, minor keys.

## Rhythm
- 80-118 bpm, straight quavers, no swing at all.
- Sixteenth-note arpeggios running continuously underneath everything.
- Drums: heavy kick on 1 and 3, snare on 2 and 4, nothing clever.

## Harmony
- Minor keys almost exclusively. Aeolian.
- i – bVI – bIII – bVII is the archetypal loop. Also i – bVII – bVI – bVII.
- Slow harmonic rhythm: one chord per bar, or per two bars.
- Almost no sevenths — triads and power chords. This is deliberately less sophisticated than jazz idioms.

## Layers
1. Bass: pulsing quavers or semiquavers on the root, low, relentless.
2. Arpeggio: a synth arpeggiating the chord in semiquavers across two octaves.
3. Pad: sustained whole-note chords, wide, high.
4. Lead: a bright melody in long notes, wide vibrato, sitting above everything. Simple and singable.

## Melody
Long notes, big intervals, mostly on chord tones. It should sound heroic and slightly sad.

## Instrumentation (GM equivalents)
Lead 2 (sawtooth) for the lead, Pad 2 (warm) for pads, Synth Bass 1 for bass, Lead 1 (square) for arpeggios.
`
	}
];
