import { analyse, summarise } from '$lib/score/analyse.js';
import { measureTicks, timeSigAt } from '$lib/score/measures.js';
import { isNote, resolveSelection } from '$lib/score/query.js';
import type { Score, Selection } from '$lib/score/types.js';

/**
 * Deciding what the model actually sees.
 *
 * A score is hundreds of KB of JSON. Sending it whole on every iteration of an
 * agent loop is the shortest route to a large bill and a model that has lost
 * the thread by turn four. So the prompt carries a summary plus the selection,
 * and anything else the model wants it asks for through `read_score` — which
 * is the entire reason that tool exists.
 *
 * Notes are rendered as compact lines rather than JSON. `n12 @1920 +480 60,64,67 v80`
 * costs a fraction of the equivalent object and is no harder for a model to
 * read, which buys back context for the parts of the prompt that matter.
 */

export interface ContextOptions {
	/** Hard ceiling on rendered note lines. Beyond this the model gets a count
	 *  and a pointer to read_score rather than a wall of text. */
	maxNotes?: number;
}

const DEFAULT_MAX_NOTES = 400;

/** One note per line: id, tick, duration, pitches, velocity, then extras. */
export function renderNotes(score: Score, sel: Selection, opts: ContextOptions = {}): string {
	const max = opts.maxNotes ?? DEFAULT_MAX_NOTES;
	const resolved = resolveSelection(score, sel);
	if (resolved.length === 0) return '(no notes in range)';

	const lines: string[] = [];
	for (const { note, part } of resolved.slice(0, max)) {
		if (!isNote(note)) continue;
		const pitches = note.pitches.map((p) => p.midi).join(',');
		let line = `${note.id} @${note.tick} +${note.dur} ${pitches} v${note.vel} [${part.id}]`;
		if (note.artic?.length) line += ` ${note.artic.join(',')}`;
		if (note.dynamic) line += ` ${note.dynamic}`;
		if (note.pitches.some((p) => p.tie)) line += ' tie';
		lines.push(line);
	}

	if (resolved.length > max) {
		lines.push(
			`… ${resolved.length - max} more notes not shown. Use read_score with a tick range to see them.`
		);
	}
	return lines.join('\n');
}

/** The structural facts a model needs before it edits anything. */
export function describeScore(score: Score): string {
	const lines = [summarise(score)];

	if (score.parts.length) {
		lines.push('', 'Parts:');
		for (const part of score.parts) {
			const count = part.voices.reduce((n, v) => n + v.events.filter(isNote).length, 0);
			lines.push(
				`  ${part.id} "${part.name}" — ${part.clef} clef, GM program ${part.gmProgram}, ` +
					`channel ${part.channel}${part.isDrum ? ' (drums)' : ''}, ${count} notes`
			);
		}
	}

	if (score.sections.length) {
		lines.push('', 'Sections:');
		for (const s of score.sections) {
			lines.push(`  ${s.id} "${s.name}" — ticks ${s.startTick}–${s.endTick}`);
		}
	}

	const sig = timeSigAt(score, 0);
	lines.push(
		'',
		`Timing: ${score.ppq} ticks per quarter note, ${measureTicks(score.ppq, sig)} ticks per bar at ${sig.num}/${sig.den}.`
	);
	return lines.join('\n');
}

/**
 * The user-turn content for an edit request.
 *
 * Ordered stable-to-volatile even within the message: the structural summary
 * changes rarely, the selection changes constantly. Anything further up the
 * prompt than this — system prompt, style skills, tool definitions — is
 * expected to be byte-identical between turns so the cached prefix survives.
 */
export function buildEditContext(
	score: Score,
	sel: Selection,
	instruction: string,
	opts: ContextOptions = {}
): string {
	const scoped = Object.keys(sel).length > 0;
	return [
		describeScore(score),
		'',
		scoped ? 'Selected notes (edit these):' : 'All notes:',
		renderNotes(score, sel, opts),
		'',
		scoped
			? 'Apply the request to the selected notes. Leave everything else alone.'
			: 'Apply the request to the whole piece.',
		'',
		`Request: ${instruction}`
	].join('\n');
}

/** Result of the `analyse_range` tool. */
export function analysisReport(score: Score, sel: Selection = {}): string {
	const a = analyse(score, sel);
	const lines = [
		`Key: ${a.key.name} (confidence ${a.key.confidence})`,
		`Tempo: ${a.tempoBpm} bpm · Metre: ${a.timeSig} · Bars: ${a.barCount} · Notes: ${a.totalNotes}`
	];
	if (a.bars.length) {
		lines.push('', 'Bar-by-bar:');
		for (const bar of a.bars.slice(0, 64)) {
			const chord = bar.chord ? ` ${bar.chord}` : '';
			lines.push(`  bar ${bar.bar} @${bar.startTick}${chord} — ${bar.noteCount} notes`);
		}
	}
	return lines.join('\n');
}

/**
 * The user-turn content for one chunk of a realization.
 *
 * Ordered stable-to-volatile like `buildEditContext`, and assembled from the
 * same three primitives above rather than a fourth renderer. The pieces are
 * chosen so the model can do what its prompt already asks of it: "connect to
 * what came before — match the register, texture and rhythmic feel of the
 * preceding bars" is only actionable if it can see those bars.
 */
export function buildRealizeContext(args: {
	score: Score;
	/** The plan, as prose, so the piece has a shape beyond this chunk. */
	planSummary: string;
	/** This chunk's section: name, bars, harmony, role. */
	sectionBrief: string;
	/** What the section after this one is for, so the chunk can aim at it. */
	nextRole?: string;
	startTick: number;
	endTick: number;
	/** The one part this chunk may write into. */
	partId: string;
	/** The hummed theme, if there was one. */
	motifPartId?: string;
	/** Free-text direction, when this is a feedback run rather than a first pass. */
	instruction?: string;
	opts?: ContextOptions;
}): string {
	const { score, startTick, endTick, partId } = args;
	const lines = [describeScore(score), '', 'The plan:', args.planSummary, '', 'Write this section:', args.sectionBrief];

	if (args.nextRole) lines.push('', `What comes next: ${args.nextRole}. Lead into it.`);

	// A bar or two of tail. Without it "match what came before" is aspirational,
	// and with the whole score it would be expensive and mostly irrelevant.
	const sig = timeSigAt(score, startTick);
	const lookback = measureTicks(score.ppq, sig) * 2;
	if (startTick > 0) {
		const before = renderNotes(
			score,
			{ startTick: Math.max(0, startTick - lookback), endTick: startTick },
			args.opts
		);
		lines.push('', 'The bars immediately before this section:', before);
	}

	// The motif, forwarded rather than hoped for. Small, and far cheaper than
	// discovering at chunk five that the theme has been quietly abandoned.
	if (args.motifPartId && args.motifPartId !== partId) {
		lines.push(
			'',
			'The theme this piece is built on:',
			renderNotes(score, { partIds: [args.motifPartId] }, args.opts)
		);
	}

	// Existing notes in the window. Naming the operation matters: insert_notes
	// adds to what is there, so a rewrite that reached for it would layer the new
	// phrase on top of the old one and sound like both at once. Its own summary
	// says to use replace_range instead, but a rewrite is exactly the moment not
	// to leave that to inference.
	const existing = renderNotes(score, { partIds: [partId], startTick, endTick }, args.opts);
	const rewriting = !existing.startsWith('(no notes');
	if (rewriting) {
		lines.push(
			'',
			'This section already has notes in it:',
			existing,
			'',
			`You are replacing them. Use replace_range on part ${partId} from tick ${startTick} to ${endTick} — insert_notes would add your new phrase on top of the existing one.`
		);
	}

	lines.push(
		'',
		`Write into part ${partId} only, from tick ${startTick} up to but not including tick ${endTick}.`,
		'Every note must start inside that window. Do not touch any other part or any other bar.'
	);

	if (args.instruction) lines.push('', `The person asked for: ${args.instruction}`);
	return lines.join('\n');
}

/** The plan as a few lines of prose, for a realization's prompt. */
export function planSummary(plan: {
	title: string;
	key: { tonic: string; mode: string };
	tempoBpm: number;
	timeSig: { num: number; den: number };
	sections: { name: string; bars: number; harmony: string; role: string }[];
}): string {
	const lines = [
		`"${plan.title || 'Untitled'}" — ${plan.key.tonic} ${plan.key.mode}, ${plan.tempoBpm}bpm, ${plan.timeSig.num}/${plan.timeSig.den}.`,
		'Form:'
	];
	for (const s of plan.sections) {
		lines.push(`  ${s.name} — ${s.bars} bars, ${s.harmony || 'no set harmony'}, ${s.role}`);
	}
	return lines.join('\n');
}
