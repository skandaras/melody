import { insertNotes, deleteNotes, replaceRange, setLyric } from './notes.js';
import { setArticulation, setDynamic, setVelocityCurve, setDuration } from './attributes.js';
import { transpose, fitToKey, invert, retrograde, octaveShift } from './pitch-ops.js';
import { quantise, swing, humanise, scaleTime, shiftTime } from './time-ops.js';
import { addPart, removePart, setInstrument } from './parts.js';
import { setTempo, setKey, setTimeSig, setSection, removeSection, setTitle } from './global.js';
import type { OpDef } from './types.js';

/**
 * The operation registry — the extension seam for the whole application.
 *
 * Adding a capability means writing an OpDef and adding it to this list. From
 * that one change you automatically get: a validated mutation path, an entry
 * in the undo history, a diff the UI can render, and a strict tool definition
 * the model can call. Nothing else needs to know the operation exists.
 *
 * Ops are grouped by domain rather than one-file-per-op. The seam that matters
 * is this registry, not the file boundary, and twenty three-line files would
 * cost more to navigate than they'd buy.
 */
export const OPS: OpDef<never>[] = [
	// Notes
	insertNotes, deleteNotes, replaceRange, setLyric,
	// Expression
	setArticulation, setDynamic, setVelocityCurve, setDuration,
	// Pitch
	transpose, fitToKey, invert, retrograde, octaveShift,
	// Rhythm
	quantise, swing, humanise, scaleTime, shiftTime,
	// Parts
	addPart, removePart, setInstrument,
	// Score-wide
	setTempo, setKey, setTimeSig, setSection, removeSection, setTitle
] as unknown as OpDef<never>[];

export const OP_MAP: Map<string, OpDef<never>> = new Map(OPS.map((o) => [o.name, o]));

export function getOp(name: string): OpDef<never> | undefined {
	return OP_MAP.get(name);
}

export const OP_NAMES = OPS.map((o) => o.name);

export type { OpDef, OpResult, OpContext } from './types.js';
