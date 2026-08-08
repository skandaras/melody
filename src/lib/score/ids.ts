/**
 * Id generation for score entities.
 *
 * Ids must be stable across a document's life (patches, diffs and the undo
 * stack all address by id) but need only be unique within one score, so short
 * prefixed counters beat UUIDs here: they survive a JSON round trip, they're
 * readable when a model emits them in a patch, and they keep the document
 * small enough to fit comfortably in a prompt.
 */

const PREFIXES = {
	part: 'p',
	voice: 'v',
	note: 'n',
	rest: 'r',
	section: 's'
} as const;

export type IdKind = keyof typeof PREFIXES;

/**
 * Mints ids that don't collide with anything already in the document.
 *
 * Seeded from the existing ids rather than from zero: generating a fresh
 * counter per operation would hand out `n1` again on the second edit and
 * silently alias two different notes.
 */
export class IdFactory {
	private counters = new Map<IdKind, number>();

	constructor(existing: Iterable<string> = []) {
		for (const id of existing) this.observe(id);
	}

	observe(id: string): void {
		const m = /^([a-z]+)(\d+)$/.exec(id);
		if (!m) return;
		const kind = (Object.keys(PREFIXES) as IdKind[]).find((k) => PREFIXES[k] === m[1]);
		if (!kind) return;
		const n = Number(m[2]);
		if (n > (this.counters.get(kind) ?? 0)) this.counters.set(kind, n);
	}

	next(kind: IdKind): string {
		const n = (this.counters.get(kind) ?? 0) + 1;
		this.counters.set(kind, n);
		return `${PREFIXES[kind]}${n}`;
	}
}

/** Every id in a score, for seeding an IdFactory. */
export function collectIds(score: {
	parts: { id: string; voices: { id: string; events: { id: string }[] }[] }[];
	sections: { id: string }[];
}): string[] {
	const ids: string[] = [];
	for (const p of score.parts) {
		ids.push(p.id);
		for (const v of p.voices) {
			ids.push(v.id);
			for (const e of v.events) ids.push(e.id);
		}
	}
	for (const s of score.sections) ids.push(s.id);
	return ids;
}
