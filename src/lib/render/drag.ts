import type { Op } from '$lib/score/apply';
import type { Position } from './locate.js';

/**
 * Turning a drag into operations.
 *
 * Kept apart from the component and free of the DOM so the parts that are easy
 * to get silently wrong — which direction is "up", and the clamp that stops a
 * selection collapsing onto tick 0 — can be tested rather than eyeballed.
 *
 * Dragging needs no new operations. `transpose` and `shift_time` already do
 * exactly this, already accept a note-id selection, and already go through the
 * one write path, so a dragged note lands in the revision history and the
 * accept/reject diff like every other edit.
 *
 * Known limit, worth stating rather than discovering: `diatonicTranspose`
 * resolves a chromatic note to the scale tone *below* it before moving
 * (`snapToKey` tries `midi - d` first), so an Eb in C major — written on the E
 * line — transposes as though it were a D. Dragging such a note up one step
 * moves it from D to E, which is where it already appeared to be, so it does
 * not visibly move. Diatonic notes, which is nearly all of them, are exact.
 * Fixing it properly wants an absolute `set_pitch` operation rather than a
 * relative one.
 */

export interface DragInput {
	/** The notes being moved. Empty means there is nothing to do. */
	noteIds: string[];
	/** Where the drag started and where it was released. */
	from: Position;
	to: Position;
	/**
	 * Earliest tick among the dragged notes.
	 *
	 * `shift_time` clamps each note independently at zero, so a selection
	 * dragged left past the start would pile up on tick 0 and lose its internal
	 * spacing — permanently, since the clamp is applied per note as it moves.
	 * Clamping the delta here instead moves the whole group or none of it.
	 */
	minTick: number;
}

/**
 * The ops a drag should commit, or an empty list if it changed nothing.
 *
 * Cross-part drags are rejected by the caller before reaching here — no
 * operation moves a note between parts, and faking it with delete + insert
 * would lose the note id, and with it the diff, the undo entry and any tie or
 * slur attached to it.
 */
export function dragOps(input: DragInput): Op[] {
	const { noteIds, from, to } = input;
	if (!noteIds.length) return [];

	const ops: Op[] = [];

	// Time first, deliberately. `transpose` reads the key signature in force at
	// each note's tick, so a drag that crosses a key change must land in the
	// new key before it is transposed or it is transposed against the old one.
	// Both ops go in one request, so this costs nothing.
	const tickDelta = clampTickDelta(to.tick - from.tick, input.minTick);
	if (tickDelta !== 0) {
		ops.push({ op: 'shift_time', args: { selection: { noteIds }, deltaTicks: tickDelta } } as Op);
	}

	// `step` counts downward from the top stave line, so dragging upward makes
	// it smaller — and raising the pitch means negating the difference. Getting
	// this backwards inverts every drag, which is why it is tested.
	//
	// Diatonic only. A literal-semitone alternative looks obvious and does not
	// work: `transpose` respells every pitch it moves, and `spellMidi` prefers
	// sharps, so a chromatic drag lands on D# — which renders on the D line,
	// not the E line the pointer was over. Offering it would be offering a
	// gesture that visibly disobeys the pointer.
	const stepDelta = from.step - to.step;
	if (stepDelta !== 0) {
		ops.push({
			op: 'transpose',
			args: { selection: { noteIds }, scaleSteps: stepDelta }
		} as Op);
	}

	return ops;
}

/** Never let a group move further left than its earliest member can go. */
export function clampTickDelta(delta: number, minTick: number): number {
	return Math.max(delta, -minTick);
}
