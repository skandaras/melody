import { gmName, rangeKeyFor } from './instruments.js';
import { INSTRUMENT_RANGES } from './pitch.js';
import { isNote } from './query.js';
import type { Part, Score } from './types.js';

/**
 * Whether the notes written for a part are actually playable on it.
 *
 * `INSTRUMENT_RANGES` has existed since the beginning, its own comment says it
 * is "used by check_playability and orchestration", and it was used by neither:
 * `check_playability` was never built, and nothing anywhere compares a note to
 * a range. Meanwhile the `Orchestrate as…` control instructs the model, as step
 * 5 of 5, to "check every part with check_playability and fix anything out of
 * range" — a call it cannot make, on a tool that does not exist.
 *
 * So a cello part written an octave too low was caught by nothing and reported
 * by nobody. This module is the check both of those referred to, and it is pure
 * so the arrangement page and the model's own tool can share one answer.
 */

export interface RangeIssue {
	partId: string;
	partName: string;
	/** The General MIDI instrument the range was looked up from. */
	instrument: string;
	low: number;
	high: number;
	/** Notes below `low` and above `high`. */
	below: number;
	above: number;
	/** The worst offenders, for a message that points somewhere. */
	lowest: number;
	highest: number;
}

/**
 * Range problems in a score, one entry per part that has any.
 *
 * Drum parts are skipped rather than judged: on channel 9 a pitch names a kit
 * piece, not a note, so "out of range" is a category error there.
 *
 * A part whose instrument has no entry falls back to piano via `rangeKeyFor`,
 * which is deliberately permissive — 21 to 108 flags only notes no keyboard
 * has, so an unknown instrument produces near-silence rather than noise.
 */
export function checkPlayability(score: Score, partIds?: readonly string[]): RangeIssue[] {
	const wanted = partIds?.length ? new Set(partIds) : null;
	const issues: RangeIssue[] = [];

	for (const part of score.parts) {
		if (wanted && !wanted.has(part.id)) continue;
		const issue = partRange(part);
		if (issue) issues.push(issue);
	}
	return issues;
}

function partRange(part: Part): RangeIssue | null {
	if (part.isDrum) return null;

	const instrument = gmName(part.gmProgram);
	const range = INSTRUMENT_RANGES[rangeKeyFor(instrument)] ?? INSTRUMENT_RANGES.piano;

	// The sounding pitch, not the written one. A part with a transpose is
	// notated in one key and sounds in another, and the range is a fact about
	// the instrument — so comparing written pitches would clear a Bb trumpet
	// part that is two semitones past its top note.
	const pitches: number[] = [];
	for (const voice of part.voices) {
		for (const event of voice.events) {
			if (!isNote(event)) continue;
			for (const pitch of event.pitches) pitches.push(pitch.midi + part.transpose);
		}
	}
	if (!pitches.length) return null;

	const below = pitches.filter((p) => p < range.low).length;
	const above = pitches.filter((p) => p > range.high).length;
	if (!below && !above) return null;

	return {
		partId: part.id,
		partName: part.name,
		instrument,
		low: range.low,
		high: range.high,
		below,
		above,
		lowest: Math.min(...pitches),
		highest: Math.max(...pitches)
	};
}

/** One issue as a line a person or a model can act on. */
export function describeIssue(issue: RangeIssue): string {
	const parts: string[] = [];
	if (issue.below) parts.push(`${issue.below} below (lowest ${issue.lowest})`);
	if (issue.above) parts.push(`${issue.above} above (highest ${issue.highest})`);
	return (
		`${issue.partName} (${issue.instrument}, range ${issue.low}–${issue.high}): ` +
		`${parts.join(', ')}`
	);
}

/** The whole report, for the `check_playability` tool. */
export function playabilityReport(score: Score, partIds?: readonly string[]): string {
	const issues = checkPlayability(score, partIds);
	if (!issues.length) return 'Every part is within its instrument\'s practical range.';
	return ['Out of range:', ...issues.map((i) => `  ${describeIssue(i)}`)].join('\n');
}
