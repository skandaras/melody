import {
	Accidental,
	Annotation,
	Articulation,
	Beam,
	Dot,
	Formatter,
	Renderer,
	Stave,
	StaveConnector,
	StaveNote,
	Voice as VexVoice
} from 'vexflow';
import { keySigAt, timeSigAt } from '$lib/score/measures';
import { isNote } from '$lib/score/query';
import type { Note, Part, Score, ScoreEvent } from '$lib/score/types';
import { ticksToDuration } from './duration.js';
import { midiToVexKey, vexKeySignature } from './keys.js';
import { layoutScore, type LayoutOptions, type ScoreLayout } from './layout.js';

/**
 * Draw a score into an SVG element.
 *
 * The renderer is stateless between calls: `render()` clears and redraws. That
 * is simpler than diffing the SVG and, at the sizes involved (tens of systems,
 * hundreds of notes), fast enough that a full redraw on every edit is
 * imperceptible. If that ever stops being true, the layout module already
 * gives us the per-system geometry needed to redraw one system.
 */

export interface DiffHighlight {
	added: Set<string>;
	removed: Set<string>;
	changed: Set<string>;
}

export interface RenderOptions extends Partial<LayoutOptions> {
	/** Note ids currently selected, drawn in the accent colour. */
	selected?: Set<string>;
	/** Pending AI changes, drawn green/amber. */
	diff?: DiffHighlight;
	/** Resolved theme colours — passed in rather than read from CSS so the
	 *  same code can render to an offscreen SVG for PDF export. */
	colors: {
		notation: string;
		paper: string;
		accent: string;
		diffAdd: string;
		diffChange: string;
		dim: string;
	};
	scale?: number;
}

/** Where a rendered note ended up, for hit-testing and the diff overlay. */
export interface NoteHit {
	noteId: string;
	partId: string;
	tick: number;
	x: number;
	y: number;
	width: number;
	height: number;
}

/**
 * Where one measure of one part was actually drawn.
 *
 * Recorded during the render rather than recomputed afterwards, because the
 * only authority on where VexFlow put a stave line is VexFlow. Deriving it
 * from staveHeight would be a second implementation of the same thing, and the
 * two would disagree the moment a stave gained a clef change or an extra
 * modifier — which is exactly when clicking the wrong pitch is hardest to
 * explain.
 */
export interface StaveBox {
	partId: string;
	/** Index into score.parts, so a caller can find the part without a lookup. */
	partIndex: number;
	clef: string;
	/** Left edge and width of the notes area, past any clef and key signature. */
	x: number;
	width: number;
	/** y of the top stave line, and the gap between adjacent lines. */
	topLineY: number;
	lineSpacing: number;
	startTick: number;
	endTick: number;
}

export interface RenderResult {
	layout: ScoreLayout;
	hits: NoteHit[];
	/** Every drawn measure, for turning a click back into a position. */
	staves: StaveBox[];
	width: number;
	height: number;
}

const CLEF_MAP: Record<string, string> = {
	treble: 'treble',
	bass: 'bass',
	alto: 'alto',
	tenor: 'tenor',
	percussion: 'percussion'
};

/** Events of one part inside one measure, in tick order. */
function eventsIn(part: Part, startTick: number, endTick: number): ScoreEvent[] {
	const out: ScoreEvent[] = [];
	for (const voice of part.voices) {
		for (const e of voice.events) {
			if (e.tick >= startTick && e.tick < endTick) out.push(e);
		}
	}
	return out.sort((a, b) => a.tick - b.tick);
}

function buildNote(score: Score, part: Part, event: ScoreEvent, opts: RenderOptions): StaveNote {
	const key = keySigAt(score, event.tick);
	const { duration, dots } = ticksToDuration(event.dur, score.ppq);
	const clef = CLEF_MAP[part.clef] ?? 'treble';

	if (!isNote(event)) {
		const rest = new StaveNote({ keys: ['b/4'], duration: `${duration}r`, clef });
		for (let i = 0; i < dots; i++) Dot.buildAndAttach([rest], { all: true });
		rest.setStyle({ fillStyle: opts.colors.dim, strokeStyle: opts.colors.dim });
		return rest;
	}

	const note = event as Note;
	const spelled = note.pitches.map((p) => midiToVexKey(p.midi, key, p.spell));
	const staveNote = new StaveNote({
		keys: spelled.map((s) => s.key),
		duration,
		clef,
		autoStem: true
	});

	spelled.forEach((s, i) => {
		if (s.accidental) staveNote.addModifier(new Accidental(s.accidental), i);
	});
	for (let i = 0; i < dots; i++) Dot.buildAndAttach([staveNote], { all: true });

	// One syllable under the notehead. CENTER_STEM hangs it from the stem,
	// which keeps the text clear of the stave while staying attached to its
	// note; BOTTOM would push it below the stave's own lower margin.
	if (note.lyric) {
		const ann = new Annotation(note.lyric);
		ann.setVerticalJustification(Annotation.VerticalJustify.CENTER_STEM);
		ann.setFont({ family: 'Times', size: 11, style: 'normal' });
		staveNote.addModifier(ann, 0);
	}

	for (const a of note.artic ?? []) {
		const code = ARTICULATION_CODES[a];
		if (code) staveNote.addModifier(new Articulation(code).setPosition(3));
	}

	// Colour precedence: a selected note that is also newly added should read
	// as selected, because that is the state the user is acting on.
	const c = opts.colors;
	let colour: string | null = null;
	if (opts.selected?.has(note.id)) colour = c.accent;
	else if (opts.diff?.added.has(note.id)) colour = c.diffAdd;
	else if (opts.diff?.changed.has(note.id)) colour = c.diffChange;

	staveNote.setStyle({ fillStyle: colour ?? c.notation, strokeStyle: colour ?? c.notation });
	// Ledger lines are the one part of a note VexFlow will not take from
	// setStyle — they default to a hardcoded #444, which is legible on paper and
	// all but invisible on a dark sheet. Middle C is the note most likely to
	// have one, so this is not an edge case.
	staveNote.setLedgerLineStyle({
		fillStyle: colour ?? c.notation,
		strokeStyle: colour ?? c.notation
	});
	return staveNote;
}

const ARTICULATION_CODES: Record<string, string> = {
	staccato: 'a.',
	staccatissimo: 'av',
	accent: 'a>',
	marcato: 'a^',
	tenuto: 'a-',
	fermata: 'a@a'
};

export function renderScore(
	container: HTMLDivElement,
	score: Score,
	opts: RenderOptions
): RenderResult {
	container.replaceChildren();

	const layout = layoutScore(score, opts);
	const scale = opts.scale ?? 1;

	const renderer = new Renderer(container, Renderer.Backends.SVG);
	renderer.resize(layout.width * scale, layout.height * scale);
	const ctx = renderer.getContext();
	ctx.scale(scale, scale);

	// Make the score's ink the context default before anything is drawn.
	//
	// VexFlow initialises its context to black and only some elements get an
	// explicit setStyle from us — beams, and whatever a Stave draws through its
	// modifiers, inherit the context instead. On light paper that black is
	// indistinguishable from correct, which is why this survived until a dark
	// theme was selected: barlines and beams simply disappeared, leaving only
	// the notes we happened to colour by hand.
	ctx.setFillStyle(opts.colors.notation);
	ctx.setStrokeStyle(opts.colors.notation);

	const hits: NoteHit[] = [];
	const staveBoxes: StaveBox[] = [];
	const parts = score.parts.length ? score.parts : [];

	for (const system of layout.systems) {
		const pageOffset = system.page * (opts.pageHeight ?? 0);

		parts.forEach((part, partIndex) => {
			const staveY = pageOffset + system.y + partIndex * layout.staveHeight;
			const staves: Stave[] = [];

			for (const lm of system.measures) {
				const stave = new Stave(lm.x, staveY, lm.width);

				if (lm.leading) {
					stave.addClef(CLEF_MAP[part.clef] ?? 'treble');
					stave.addKeySignature(vexKeySignature(keySigAt(score, lm.measure.startTick)));
					// Time signature only when it actually changes, plus at the
					// very start — repeating it every line is wrong notation.
					if (lm.measure.index === 0 || lm.measure.timeChange) {
						const ts = timeSigAt(score, lm.measure.startTick);
						stave.addTimeSignature(`${ts.num}/${ts.den}`);
					}
				} else if (lm.measure.timeChange) {
					stave.addTimeSignature(`${lm.measure.timeSig.num}/${lm.measure.timeSig.den}`);
				}

				stave.setStyle({ fillStyle: opts.colors.notation, strokeStyle: opts.colors.notation });
				stave.setContext(ctx).draw();
				staves.push(stave);

				// Ask the stave where it actually put itself, now that its clef and
				// signatures have been added and it has been drawn.
				staveBoxes.push({
					partId: part.id,
					partIndex,
					clef: CLEF_MAP[part.clef] ?? 'treble',
					x: stave.getNoteStartX() * scale,
					width: Math.max(1, (stave.getNoteEndX() - stave.getNoteStartX()) * scale),
					topLineY: stave.getYForLine(0) * scale,
					lineSpacing: stave.getSpacingBetweenLines() * scale,
					startTick: lm.measure.startTick,
					endTick: lm.measure.endTick
				});

				const events = eventsIn(part, lm.measure.startTick, lm.measure.endTick);
				if (!events.length) continue;

				const notes = events.map((e) => buildNote(score, part, e, opts));

				// A voice whose contents don't fill the bar is normal while
				// editing, so run it non-strict rather than throwing.
				const voice = new VexVoice({
					numBeats: lm.measure.timeSig.num,
					beatValue: lm.measure.timeSig.den
				})
					.setStrict(false)
					.addTickables(notes);

				const beams = Beam.generateBeams(notes.filter((n) => !n.isRest()));
				new Formatter()
					.joinVoices([voice])
					.format([voice], Math.max(40, lm.width - (lm.leading ? 80 : 24)));

				voice.draw(ctx, stave);
				for (const beam of beams) {
					// Explicit as well as inherited: a beam joins notes that may
					// be individually coloured by selection or diff, and without
					// its own style it would keep whatever the last note set.
					beam.setStyle({
						fillStyle: opts.colors.notation,
						strokeStyle: opts.colors.notation
					});
					beam.setContext(ctx).draw();
				}

				events.forEach((event, i) => {
					if (!isNote(event)) return;
					const bb = notes[i].getBoundingBox();
					if (!bb) return;
					hits.push({
						noteId: event.id,
						partId: part.id,
						tick: event.tick,
						x: bb.getX() * scale,
						y: bb.getY() * scale,
						width: bb.getW() * scale,
						height: bb.getH() * scale
					});
				});
			}

			// A brace and a left barline tie the parts of a system together —
			// without them a multi-part score reads as unrelated staves.
			if (partIndex === 0 && parts.length > 1 && staves.length) {
				const lastStaveY = staveY + (parts.length - 1) * layout.staveHeight;
				const bottom = new Stave(staves[0].getX(), lastStaveY, staves[0].getWidth());
				new StaveConnector(staves[0], bottom)
					.setType(StaveConnector.type.BRACE)
					.setContext(ctx)
					.draw();
				new StaveConnector(staves[0], bottom)
					.setType(StaveConnector.type.SINGLE_LEFT)
					.setContext(ctx)
					.draw();
			}
		});
	}

	return {
		layout,
		hits,
		staves: staveBoxes,
		width: layout.width * scale,
		height: layout.height * scale
	};
}

/** Nearest note to a point, within a tolerance. Used for click selection. */
export function hitTest(hits: NoteHit[], x: number, y: number, tolerance = 14): NoteHit | null {
	let best: NoteHit | null = null;
	let bestDist = Infinity;

	for (const h of hits) {
		// Distance to the note's box, zero when the point is inside it.
		const dx = Math.max(h.x - x, 0, x - (h.x + h.width));
		const dy = Math.max(h.y - y, 0, y - (h.y + h.height));
		const dist = Math.hypot(dx, dy);
		if (dist < bestDist) {
			bestDist = dist;
			best = h;
		}
	}
	return bestDist <= tolerance ? best : null;
}

/** Every note whose box intersects a rubber-band rectangle. */
export function hitsInRect(
	hits: NoteHit[],
	x1: number,
	y1: number,
	x2: number,
	y2: number
): NoteHit[] {
	const lo = { x: Math.min(x1, x2), y: Math.min(y1, y2) };
	const hi = { x: Math.max(x1, x2), y: Math.max(y1, y2) };
	return hits.filter(
		(h) => h.x < hi.x && h.x + h.width > lo.x && h.y < hi.y && h.y + h.height > lo.y
	);
}
