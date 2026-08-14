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
