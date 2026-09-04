import { IdFactory, collectIds } from './ids.js';
import type { Part, Score, ScoreEvent } from './types.js';

/**
 * Grafting one score's parts onto another.
 *
 * This exists because a transcription is not expressible as `insert_notes`.
 * That operation takes notes, and a transcription is notes *plus* the rests
 * between them and the ties across bar lines — the engraver draws only what
 * the document contains, so dropping either produces wrong notation. Rather
 * than widen an op the model uses constantly, merging gets its own pure
 * function, tested on its own terms.
 *
 * Ids are re-minted against the target, because both documents were built by
 * independent IdFactories and both will happily have used `n1`.
 */

export interface MergeOptions {
	/** Where the incoming material starts in the target, in ticks. Default 0. */
	atTick?: number;
	/**
	 * Adopt the incoming tempo, key and time signature. Sensible when the
	 * target is empty — a transcription's own tempo is the only one anyone has
	 * measured — and wrong when it already has music, where it would silently
	 * reinterpret everything already written.
	 */
	adoptGlobals?: boolean;
}

export interface MergeResult {
	score: Score;
	/** Ids of everything that arrived, for the diff overlay. */
	addedIds: string[];
	addedParts: number;
	/**
	 * Ids of the parts created, in the order they arrived. The count alone is
	 * enough to write a log line but not to refer to a part afterwards, which is
	 * what a transcription seed needs so later stages can point at "the theme".
	 */
	addedPartIds: string[];
}

export function mergeParts(target: Score, incoming: Score, opts: MergeOptions = {}): MergeResult {
	const score: Score = structuredClone(target);
	const atTick = Math.max(0, Math.round(opts.atTick ?? 0));
	const adopt = opts.adoptGlobals ?? score.parts.length === 0;

	if (adopt) {
		score.tempoMap = incoming.tempoMap.length ? structuredClone(incoming.tempoMap) : score.tempoMap;
		score.timeSigs = incoming.timeSigs.length ? structuredClone(incoming.timeSigs) : score.timeSigs;
		score.keySigs = incoming.keySigs.length ? structuredClone(incoming.keySigs) : score.keySigs;
	}

	const ids = new IdFactory(collectIds(score));
	const usedChannels = new Set(score.parts.map((p) => p.channel));
	const addedIds: string[] = [];
	const addedPartIds: string[] = [];

	for (const source of incoming.parts) {
		const part: Part = {
			...structuredClone(source),
			id: ids.next('part'),
			channel: source.isDrum ? 9 : nextFreeChannel(usedChannels),
			voices: source.voices.map((voice) => ({
				id: ids.next('voice'),
				events: voice.events.map((event): ScoreEvent => {
					const id = ids.next(event.kind === 'rest' ? 'rest' : 'note');
					addedIds.push(id);
					return { ...structuredClone(event), id, tick: event.tick + atTick };
				})
			}))
		};
		usedChannels.add(part.channel);
		score.parts.push(part);
		addedPartIds.push(part.id);
	}

	return { score, addedIds, addedParts: incoming.parts.length, addedPartIds };
}

/** Next channel that is free and is not the GM drum channel. */
function nextFreeChannel(used: Set<number>): number {
	for (let c = 0; c < 16; c++) {
		if (c !== 9 && !used.has(c)) return c;
	}
	// Beyond sixteen parts channels have to be shared. That is a playback
	// limitation, not a notation one, so it is not worth refusing the merge.
	return 0;
}
