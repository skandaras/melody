import type { ControlKind } from '../db/schema.js';

/**
 * The seeded control rack.
 *
 * `kind` is the architectural split, and it is the thing to understand before
 * adding anything here:
 *
 *   code    No model call at all. Deterministic TypeScript over the score,
 *           via an op from the registry. Instant, free, exactly reversible,
 *           works with no API key. Routing "transpose up a tone" through an
 *           LLM would be slower, dearer and less accurate.
 *
 *   prompt  One model call. The control IS its prompt — a template plus a
 *           params schema, stored as data. The model receives the selected
 *           music as JSON and returns an op patch. Because these are rows,
 *           a new one can be added from the admin panel with no deploy.
 *           This is the "skill / descriptive prompt" tier.
 *
 *   agent   A tool-use loop. The model reads the score, decides, writes, and
 *           can check its own work across several turns. Reserved for jobs
 *           that genuinely cannot be done in one shot — orchestration,
 *           extending a piece, composing from a seed.
 *
 * When in doubt, prefer the cheapest tier that can express the job. A control
 * that could be `code` but is written as `prompt` is a latent bug: it will be
 * slower, cost money, and occasionally do something different each run.
 */

export interface BuiltinControl {
	name: string;
	category: string;
	kind: ControlKind;
	icon?: string;
	description: string;
	/** kind=code only: which registered op to run. */
	opName?: string;
	/** kind=prompt|agent: the instruction template. {{param}} interpolated. */
	promptTemplate?: string;
	systemPrompt?: string;
	paramsSchema?: Record<string, unknown>;
	defaultParams?: Record<string, unknown>;
}

/** Shared preamble for every prompt-tier control. */
const PATCH_CONTRACT = `You edit music by returning operations, never by describing changes in prose.

You will be given the selected music as JSON and a summary of its key, harmony and instrumentation. Return only operations that achieve the requested change.

Rules that matter:
- Preserve what makes the music recognisable unless asked to replace it. A colour or mood change should leave the melody identifiable.
- Respect the key signature unless the change is explicitly harmonic.
- Keep every note inside its instrument's playable range.
- Prefer editing existing notes (set_articulation, set_velocity_curve, transpose) over rewriting a passage. Use replace_range only when the notes themselves must change.
- Amount is a real dial. At 20 the listener should barely notice; at 80 it should be unmistakable. Scale how much you change accordingly.`;

const AMOUNT_PARAM = {
	type: 'object',
	properties: {
		amount: {
			type: 'integer',
			minimum: 0,
			maximum: 100,
			title: 'Amount',
			description: 'How far to push it. 20 is subtle, 50 is clear, 80 is dramatic.'
		}
	},
	required: ['amount'],
	additionalProperties: false
};

export const BUILTIN_CONTROLS: BuiltinControl[] = [
	// ---------------------------------------------------------------- code
	// Deterministic. No API key needed, no tokens spent, no variability.
	{
		name: 'Transpose',
		category: 'Pitch',
		kind: 'code',
		icon: '↕',
		description: 'Move the selection by an interval, chromatically or within the key.',
		opName: 'transpose',
		paramsSchema: {
			type: 'object',
			properties: {
				semitones: { type: 'integer', minimum: -24, maximum: 24, title: 'Semitones' }
			},
			required: ['semitones'],
			additionalProperties: false
		},
		defaultParams: { semitones: 0 }
	},
	{
		name: 'Fit to key',
		category: 'Pitch',
		kind: 'code',
		icon: '♯',
		description:
			'Snap out-of-key notes to the nearest note of the key signature. The usual first fix after transcription.',
		opName: 'fit_to_key',
		defaultParams: {}
	},
	{
		name: 'Quantise',
		category: 'Rhythm',
		kind: 'code',
		icon: '⊞',
		description: 'Pull note starts onto a rhythmic grid. Strength below 1 keeps some human feel.',
		opName: 'quantise',
		paramsSchema: {
			type: 'object',
			properties: {
				grid: {
					type: 'integer',
					enum: [960, 480, 240, 160, 120, 60],
					title: 'Grid',
					description: '960 minim, 480 crotchet, 240 quaver, 160 triplet, 120 semiquaver.'
				},
				strength: { type: 'number', minimum: 0, maximum: 1, title: 'Strength' }
			},
			required: ['grid'],
			additionalProperties: false
		},
		defaultParams: { grid: 240, strength: 1 }
	},
	{
		name: 'Swing',
		category: 'Rhythm',
		kind: 'code',
		icon: '𝅘𝅥𝅮',
		description: 'Delay off-beats for a shuffle or swing feel. 0.5 straight, 0.67 classic swing.',
		opName: 'swing',
		paramsSchema: {
			type: 'object',
			properties: { ratio: { type: 'number', minimum: 0.5, maximum: 0.8, title: 'Swing' } },
			required: ['ratio'],
			additionalProperties: false
		},
		defaultParams: { ratio: 0.62 }
	},
	{
		name: 'Humanise',
		category: 'Rhythm',
		kind: 'code',
		icon: '～',
		description:
			'Nudge timing and velocity so playback stops sounding mechanical. Same seed gives the same result every time.',
		opName: 'humanise',
		paramsSchema: {
			type: 'object',
			properties: {
				timingTicks: { type: 'integer', minimum: 0, maximum: 60, title: 'Timing' },
				velocityRange: { type: 'integer', minimum: 0, maximum: 40, title: 'Velocity' },
				seed: { type: 'integer', title: 'Seed' }
			},
			required: [],
			additionalProperties: false
		},
		defaultParams: { timingTicks: 12, velocityRange: 10, seed: 1 }
	},
	{
		name: 'Half-time',
		category: 'Rhythm',
		kind: 'code',
		icon: '½',
		description: 'Stretch the selection to twice its length. Augmentation.',
		opName: 'scale_time',
		defaultParams: { factor: 2 }
	},
	{
		name: 'Double-time',
		category: 'Rhythm',
		kind: 'code',
		icon: '×2',
		description: 'Compress the selection to half its length. Diminution.',
		opName: 'scale_time',
		defaultParams: { factor: 0.5 }
	},
	{
		name: 'Invert',
		category: 'Development',
		kind: 'code',
		icon: '⇅',
		description: 'Mirror the melody around a pitch axis — rising intervals become falling ones.',
		opName: 'invert',
		defaultParams: {}
	},
	{
		name: 'Retrograde',
		category: 'Development',
		kind: 'code',
		icon: '⇄',
		description: 'Play the selection backwards.',
		opName: 'retrograde',
		defaultParams: {}
	},
	{
		name: 'Crescendo',
		category: 'Dynamics',
		kind: 'code',
		icon: '<',
		description: 'Ramp velocity upward across the selection.',
		opName: 'set_velocity_curve',
		paramsSchema: {
			type: 'object',
			properties: {
				from: { type: 'integer', minimum: 1, maximum: 127, title: 'From' },
				to: { type: 'integer', minimum: 1, maximum: 127, title: 'To' }
			},
			required: ['from', 'to'],
			additionalProperties: false
		},
		defaultParams: { from: 45, to: 105 }
	},
	{
		name: 'Diminuendo',
		category: 'Dynamics',
		kind: 'code',
		icon: '>',
		description: 'Ramp velocity downward across the selection.',
		opName: 'set_velocity_curve',
		defaultParams: { from: 105, to: 45 }
	},

	// -------------------------------------------------------------- prompt
	// One model call each. The control is entirely data — prompt plus params.

	{
		name: 'Darken',
		category: 'Colour & mood',
		kind: 'prompt',
		icon: '◐',
		description:
			'Shift the music toward a darker colour — lower register, minor inflections, heavier voicings.',
		systemPrompt: PATCH_CONTRACT,
		promptTemplate: `Darken this music by {{amount}}%.

Darkening is a colour change, not a rewrite. Reach for, in rough order of subtlety:
- lower register and wider spacing in the bass
- flattening the third, sixth or seventh where the harmony allows (modal borrowing from the parallel minor)
- softer articulations and lower velocities
- removing bright upper extensions (9ths, 13ths) and doubling the root lower
- slowing harmonic rhythm

Keep the melody recognisable. Do not change the tempo unless the amount is above 70.`,
		paramsSchema: AMOUNT_PARAM,
		defaultParams: { amount: 40 }
	},
	{
		name: 'Brighten',
		category: 'Colour & mood',
		kind: 'prompt',
		icon: '◑',
		description: 'Open the music up — higher register, major inflections, more air between voices.',
		systemPrompt: PATCH_CONTRACT,
		promptTemplate: `Brighten this music by {{amount}}%.

Reach for:
- raising the melody or its doublings by an octave
- sharpening flattened degrees where the harmony allows
- opening voicings so there is more space between the lower parts
- lighter articulations, a touch more velocity
- adding upper extensions (9ths, add9) rather than more notes in the bass

Keep the melody recognisable.`,
		paramsSchema: AMOUNT_PARAM,
		defaultParams: { amount: 40 }
	},
	{
		name: 'Warmth',
		category: 'Colour & mood',
		kind: 'prompt',
		icon: '◍',
		description: 'Fuller, rounder, more consonant — thirds and sixths, gentler attacks.',
		systemPrompt: PATCH_CONTRACT,
		promptTemplate: `Add warmth to this music, {{amount}}%.

Warmth comes from consonance and register, not volume:
- add thirds and sixths below or above the melody
- fill the tenor register, which is where warmth actually lives
- prefer tenuto and legato over accents
- avoid the extremes of any instrument's range
- resolve dissonances rather than leaving them hanging`,
		paramsSchema: AMOUNT_PARAM,
		defaultParams: { amount: 40 }
	},
	{
		name: 'Add tension',
		category: 'Colour & mood',
		kind: 'prompt',
		icon: '◭',
		description: 'Build harmonic and rhythmic unease — suspensions, dissonance, instability.',
		systemPrompt: PATCH_CONTRACT,
		promptTemplate: `Increase the tension in this music by {{amount}}%.

Tension is created, then held. Use:
- suspensions and appoggiaturas that delay resolution
- a pedal point underneath moving harmony
- tritones, minor seconds and unresolved sevenths
- rising sequences
- rhythmic instability: syncopation, off-beat accents

At high amounts, deliberately withhold the resolution the ear expects.`,
		paramsSchema: AMOUNT_PARAM,
		defaultParams: { amount: 50 }
	},
	{
		name: 'Release',
		category: 'Colour & mood',
		kind: 'prompt',
		icon: '◡',
		description: 'Resolve tension — cadence, settle the rhythm, come to rest.',
		systemPrompt: PATCH_CONTRACT,
		promptTemplate: `Release the tension in this music, {{amount}}%.

Resolve rather than merely soften:
- move dissonances to their expected resolution
- land on a strong cadence (V-I or IV-I)
- simplify the rhythm toward the beat
- reduce density, especially in the inner voices
- let the melody fall to a stable degree of the scale`,
		paramsSchema: AMOUNT_PARAM,
		defaultParams: { amount: 50 }
	},
	{
		name: 'Enrich harmony',
		category: 'Colour & mood',
		kind: 'prompt',
		icon: '◈',
		description: 'Add extensions and colour tones — 7ths, 9ths, richer voicings.',
		systemPrompt: PATCH_CONTRACT,
		promptTemplate: `Enrich the harmony by {{amount}}%.

Add colour without changing the progression's function:
- sevenths first, then ninths, then elevenths and thirteenths
- inner moving lines rather than static blocks
- passing and neighbour chords between existing ones
- keep the bass line intact so the progression still reads the same

Do not change the melody.`,
		paramsSchema: AMOUNT_PARAM,
		defaultParams: { amount: 45 }
	},
	{
		name: 'Simplify harmony',
		category: 'Colour & mood',
		kind: 'prompt',
		icon: '◇',
		description: 'Strip back to essentials — triads, fewer voices, clearer motion.',
		systemPrompt: PATCH_CONTRACT,
		promptTemplate: `Simplify the harmony by {{amount}}%.

Reduce to what carries the progression:
- extensions back to plain triads
- remove doublings that add nothing
- fewer chord changes per bar
- clear, singable voice leading

The progression must still sound like the same music, only plainer.`,
		paramsSchema: AMOUNT_PARAM,
		defaultParams: { amount: 45 }
	},
	{
		name: 'Reharmonise',
		category: 'Colour & mood',
		kind: 'prompt',
		icon: '⟳',
		description: 'Keep the melody, rewrite the chords underneath it.',
		systemPrompt: PATCH_CONTRACT,
		promptTemplate: `Reharmonise this music, changing the harmony by {{amount}}% while leaving the melody exactly as it is.

The melody notes must not change — every melody note has to still work against the new chords.

At low amounts: substitute related chords (relative minor, subdominant for tonic).
At medium: secondary dominants, modal interchange, tritone substitution.
At high: a genuinely different harmonic reading of the same tune.

State the new progression in the operation notes as roman numerals so the change is reviewable.`,
		paramsSchema: AMOUNT_PARAM,
		defaultParams: { amount: 45 }
	},
	{
		name: 'Modal interchange',
		category: 'Colour & mood',
		kind: 'prompt',
		icon: '◑',
		description: 'Borrow chords from the parallel major or minor.',
		systemPrompt: PATCH_CONTRACT,
		promptTemplate: `Apply modal interchange at {{amount}}% strength.

Borrow from the parallel mode: in a major key take bVI, bVII, iv or bIII from the parallel minor; in a minor key take IV or a Picardy third from the parallel major.

Place borrowed chords where they will be heard — approaching a cadence, or at the start of a phrase. One well-placed borrowed chord beats five scattered ones.`,
		paramsSchema: AMOUNT_PARAM,
		defaultParams: { amount: 40 }
	},
	{
		name: 'Add counter-melody',
		category: 'Colour & mood',
		kind: 'prompt',
		icon: '≈',
		description: 'Write a second line that answers the melody.',
		systemPrompt: PATCH_CONTRACT,
		promptTemplate: `Write a counter-melody against the existing music, {{amount}}% prominent.

A counter-melody must be independent enough to be interesting and subordinate enough not to compete:
- move when the melody rests, rest when the melody moves
- favour contrary motion
- avoid parallel fifths and octaves with the melody
- sit in a different register from the main line

Insert it into the part named in the selection if one is given, otherwise add a new part for it.`,
		paramsSchema: AMOUNT_PARAM,
		defaultParams: { amount: 45 }
	},
	{
		name: 'Add genre influence',
		category: 'Style & genre',
		kind: 'prompt',
		icon: '◎',
		description:
			'Push the music toward a named style. Free text or a preset, with an amount dial.',
		systemPrompt: PATCH_CONTRACT,
		promptTemplate: `Apply the influence of {{style}} to this music at {{amount}}% strength.

At 20% only the surface changes — articulation, a rhythmic inflection, one idiomatic voicing.
At 50% the rhythm and harmony clearly belong to the style, but the original tune is intact.
At 80% rewrite freely in the idiom, keeping only the melodic contour.

Work from the idiom's actual devices — its characteristic rhythm cells, voicings, bass movement and instrumentation — not from a generic impression of it. If a style reference is provided below, follow it.`,
		paramsSchema: {
			type: 'object',
			properties: {
				style: {
					type: 'string',
					title: 'Style',
					description: 'e.g. Bossa nova, Baroque, Lo-fi, Cinematic, Gospel, Synthwave, Klezmer'
				},
				amount: {
					type: 'integer',
					minimum: 0,
					maximum: 100,
					title: 'Amount',
					description: '20 subtle, 50 clear, 80 a rewrite in the idiom.'
				}
			},
			required: ['style', 'amount'],
			additionalProperties: false
		},
		defaultParams: { style: 'Bossa nova', amount: 40 }
	},
	{
		name: 'Increase energy',
		category: 'Energy',
		kind: 'prompt',
		icon: '▲',
		description: 'More drive — density, register, rhythmic activity, dynamics.',
		systemPrompt: PATCH_CONTRACT,
		promptTemplate: `Raise the energy by {{amount}}%.

Energy is density plus register plus rhythm, not just volume:
- shorter note values and more rhythmic activity
- move lines upward in register
- add syncopation and off-beat accents
- fuller voicings, more doubling
- raise velocities and add accents

Do not change the tempo — that is a separate decision.`,
		paramsSchema: AMOUNT_PARAM,
		defaultParams: { amount: 45 }
	},
	{
		name: 'Reduce energy',
		category: 'Energy',
		kind: 'prompt',
		icon: '▼',
		description: 'Pull back — thinner, lower, calmer, more space.',
		systemPrompt: PATCH_CONTRACT,
		promptTemplate: `Lower the energy by {{amount}}%.

- longer note values, more rests, more space
- thin the texture: remove doublings and inner voices
- settle rhythms onto the beat
- lower velocities, softer articulations
- narrow the register toward the middle

Do not change the tempo.`,
		paramsSchema: AMOUNT_PARAM,
		defaultParams: { amount: 45 }
	},

	// --------------------------------------------------------------- agent
	// Multi-step. The model reads the score before it writes.

	{
		name: 'Orchestrate as…',
		category: 'Orchestration',
		kind: 'agent',
		icon: '♬',
		description:
			'Arrange the music for a named ensemble, writing an idiomatic part for each instrument.',
		systemPrompt: `You are an orchestrator working inside a score editor.

Work in this order, using your tools:
1. Read the score and analyse it. Identify the melody, the bass, the harmony and the form.
2. Decide the instrumentation for the requested ensemble.
3. Add each part with add_part.
4. Write each part with insert_notes, one part at a time.
5. Check every part with check_playability and fix anything out of range.

What separates an arrangement from a transcription:
- Give each instrument something idiomatic. A cello should not play a violin part an octave down.
- Assign register deliberately: melody, counter-line, harmony, bass. Do not double everything.
- Respect each instrument's practical range and leave the extremes for moments that earn them.
- Let instruments rest. Constant tutti is exhausting and wastes your best colours.
- Keep the original melody intact and clearly audible in at least one part.`,
		promptTemplate: `Arrange this music for {{ensemble}}.

{{#notes}}Additional direction: {{notes}}{{/notes}}

Keep the existing music as the basis — this is an arrangement, not a new piece. When you are finished, briefly say which instrument carries the melody and what each other part is doing.`,
		paramsSchema: {
			type: 'object',
			properties: {
				ensemble: {
					type: 'string',
					title: 'Ensemble',
					description:
						'e.g. String quartet, Jazz combo, Rock band, Solo piano, SATB choir, Wind quintet, Full orchestra'
				},
				notes: { type: 'string', title: 'Notes', description: 'Optional extra direction.' },
				replaceExisting: {
					type: 'boolean',
					title: 'Replace existing parts',
					description: 'Off keeps the original parts alongside the new arrangement.'
				}
			},
			required: ['ensemble'],
			additionalProperties: false
		},
		defaultParams: { ensemble: 'String quartet', replaceExisting: false }
	},
	{
		name: 'Extend',
		category: 'Form',
		kind: 'agent',
		icon: '→',
		description: 'Continue the music for a number of bars in the same spirit.',
		systemPrompt: `You continue existing music inside a score editor.

Read and analyse the score before writing anything. Continuation means the listener should not be able to point at the join:
- carry the established harmonic rhythm and phrase length forward
- develop existing motifs rather than introducing unrelated new material
- keep the same instrumentation and texture unless asked otherwise
- shape the new bars — a continuation that merely repeats is filler`,
		promptTemplate: `Continue this music for {{bars}} more bars.

{{#direction}}Direction: {{direction}}{{/direction}}

Append to the end of the existing music. Do not modify what is already there.`,
		paramsSchema: {
			type: 'object',
			properties: {
				bars: { type: 'integer', minimum: 1, maximum: 64, title: 'Bars' },
				direction: {
					type: 'string',
					title: 'Direction',
					description: 'Optional, e.g. "build toward a climax" or "wind down to an ending".'
				}
			},
			required: ['bars'],
			additionalProperties: false
		},
		defaultParams: { bars: 8 }
	},
	{
		name: 'Develop',
		category: 'Form',
		kind: 'agent',
		icon: '✧',
		description: 'Vary the existing material — sequence, inversion, augmentation, fragmentation.',
		systemPrompt: `You develop musical material inside a score editor, in the classical sense: taking an idea and showing it from new angles.

Read and analyse first. Then use real developmental techniques — sequence, inversion, retrograde, augmentation, diminution, fragmentation, modulation, changing the harmonic context under the same tune. Say which technique you used.`,
		promptTemplate: `Develop this material into {{bars}} bars of variation.

{{#direction}}Direction: {{direction}}{{/direction}}`,
		paramsSchema: {
			type: 'object',
			properties: {
				bars: { type: 'integer', minimum: 2, maximum: 64, title: 'Bars' },
				direction: { type: 'string', title: 'Direction' }
			},
			required: ['bars'],
			additionalProperties: false
		},
		defaultParams: { bars: 8 }
	},
	{
		name: 'Add section',
		category: 'Form',
		kind: 'agent',
		icon: '⊕',
		description: 'Write an intro, bridge, outro or transition that fits what is already there.',
		systemPrompt: `You write structural sections inside a score editor.

Read and analyse the existing music first — a section only works in relation to what surrounds it.

- An intro establishes key, tempo and mood, and hands over cleanly to what follows.
- A bridge contrasts: different harmony, register or texture, then leads back.
- An outro resolves; it may recall earlier material.
- A transition connects two specific passages and must fit both ends.

Mark what you write with set_section so it is navigable afterwards.`,
		promptTemplate: `Add {{kind}} of about {{bars}} bars, {{position}}.

{{#direction}}Direction: {{direction}}{{/direction}}`,
		paramsSchema: {
			type: 'object',
			properties: {
				kind: {
					type: 'string',
					enum: ['an intro', 'a bridge', 'an outro', 'a transition'],
					title: 'Section'
				},
				bars: { type: 'integer', minimum: 1, maximum: 32, title: 'Bars' },
				position: {
					type: 'string',
					enum: ['at the start', 'at the end', 'at the selection'],
					title: 'Position'
				},
				direction: { type: 'string', title: 'Direction' }
			},
			required: ['kind', 'bars', 'position'],
			additionalProperties: false
		},
		defaultParams: { kind: 'a bridge', bars: 8, position: 'at the end' }
	},
	{
		name: 'Compose from seed',
		category: 'Form',
		kind: 'agent',
		icon: '✦',
		description:
			'Grow a short idea into a full piece: plan the form first, then write it section by section.',
		systemPrompt: `You compose complete pieces from a short seed, inside a score editor.

Work in two stages, and do not skip the first.

STAGE 1 — plan. Read and analyse the seed. Decide and state: key, tempo, time signature, instrumentation, and the form as a list of named sections with bar counts and a harmonic sketch for each. Keep it to a few lines.

STAGE 2 — realise. Write the piece section by section, in order. After each section, mark it with set_section. Work through the whole plan; do not stop after the first section.

Throughout:
- the seed must be audible in the finished piece, as the main theme or its most important motif
- give the piece a shape: something has to develop, not merely repeat
- vary texture between sections — that is what stops a piece sounding like a loop`,
		promptTemplate: `Compose a complete piece from this seed.

Length: about {{bars}} bars. Style: {{style}}. Ensemble: {{ensemble}}.

{{#direction}}Direction: {{direction}}{{/direction}}

Plan the form first, then write it.`,
		paramsSchema: {
			type: 'object',
			properties: {
				bars: { type: 'integer', minimum: 8, maximum: 256, title: 'Length in bars' },
				style: { type: 'string', title: 'Style' },
				ensemble: { type: 'string', title: 'Ensemble' },
				direction: { type: 'string', title: 'Direction' }
			},
			required: ['bars', 'style', 'ensemble'],
			additionalProperties: false
		},
		defaultParams: { bars: 32, style: 'Cinematic', ensemble: 'Solo piano' }
	}
];

/** Categories in the order the rack should show them. */
export const CONTROL_CATEGORIES = [
	'Colour & mood',
	'Style & genre',
	'Orchestration',
	'Form',
	'Energy',
	'Dynamics',
	'Rhythm',
	'Pitch',
	'Development'
];
