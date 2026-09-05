import { measureTicks } from '$lib/score/measures.js';
import type { Op } from '$lib/score/apply.js';
import type { Score } from '$lib/score/types.js';
import type { Plan, PlanSection } from './types.js';

/**
 * Turning an approved plan into operations.
 *
 * Pure, and deliberately so: this is where the stage's real logic lives, and
 * keeping it free of the database, the model and the DOM is what makes it
 * testable at all. The whole vitest suite runs in Node.
 */

/** One section's span, in ticks, once the plan's metre is in force. */
export interface SectionSpan {
	section: PlanSection;
	startTick: number;
	endTick: number;
}

/**
 * Where each section starts and ends.
 *
 * Measured against `plan.timeSig` rather than the score's current metre, which
 * is the one thing about this function that is easy to get wrong. The obvious
 * implementation walks the score with `timeSigAt(score, t)` — but `set_time_sig`
 * earlier in the very same commit is about to change what that returns.
 * Approving a 3/4 plan onto a 4/4 score would lay the sections out in
 * 1920-tick bars and then re-bar the score at 1440, leaving an eight-bar verse
 * whose chorus begins two thirds of the way through bar 11.
 *
 * The plan carries a single metre precisely so this can be arithmetic on a
 * constant, independent of anything the batch mutates.
 */
export function sectionSpans(score: Score, plan: Plan): SectionSpan[] {
	// The tick is irrelevant to a bar's length and is only there because
	// TimeSig is a map entry; measureTicks reads num and den alone.
	const bar = Math.max(1, measureTicks(score.ppq, { tick: 0, ...plan.timeSig }));
	const spans: SectionSpan[] = [];
	let tick = 0;

	for (const section of plan.sections) {
		// A zero-bar section would give two sections the same start tick and make
		// the pair indistinguishable to anything selecting by range.
		const bars = Math.max(1, Math.round(section.bars));
		spans.push({ section, startTick: tick, endTick: tick + bars * bar });
		tick += bars * bar;
	}
	return spans;
}

/** Total length in ticks, so callers do not have to take the last span. */
export function planTicks(score: Score, plan: Plan): number {
	const spans = sectionSpans(score, plan);
	return spans.length ? spans[spans.length - 1].endTick : 0;
}

/**
 * Roughly how long the piece will run.
 *
 * Arithmetic on bars, metre and tempo — no model call and no document. It is
 * the cheapest possible check on "about two minutes", which is the kind of
 * thing a brief says and a plan silently disagrees with.
 */
export function estimateSeconds(plan: Plan): number {
	const beats = plan.sections.reduce(
		(n, s) => n + Math.max(1, Math.round(s.bars)) * beatsPerBar(plan),
		0
	);
	return (beats * 60) / Math.max(1, plan.tempoBpm);
}

/** Quarter-note beats in one bar — 6/8 is three quarters, not six. */
function beatsPerBar(plan: Plan): number {
	return (plan.timeSig.num * 4) / Math.max(1, plan.timeSig.den);
}

/** "2:07". Seconds are what people check a plan's length against. */
export function formatDuration(seconds: number): string {
	const total = Math.max(0, Math.round(seconds));
	return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

/**
 * The operations that commit a plan to the score.
 *
 * Ordered, and the order is load-bearing. The header facts land first because
 * `set_section` is written in ticks that only mean what the plan intends once
 * the metre is the plan's — the spans are computed from the plan rather than
 * the score for exactly that reason, but a reader stepping through the commit
 * should still see the metre set before anything is measured against it.
 *
 * `previous` is the plan as last approved. It is what makes a second approval
 * an update rather than a duplication.
 */
export function planToOps(score: Score, plan: Plan, previous?: Plan | null): Op[] {
	const ops: Op[] = [];

	if (plan.title.trim()) ops.push({ op: 'set_title', args: { title: plan.title.trim() } });
	ops.push({ op: 'set_tempo', args: { tick: 0, bpm: plan.tempoBpm } });
	ops.push({ op: 'set_time_sig', args: { tick: 0, num: plan.timeSig.num, den: plan.timeSig.den } });
	ops.push({ op: 'set_key', args: { tick: 0, tonic: plan.key.tonic, mode: plan.key.mode } });

	// A part the plan already stands for is left alone. An id that no longer
	// resolves — a hallucinated one, or a part deleted since — costs a new part
	// rather than a failed approval, which is the kinder failure of the two.
	const existing = new Set(score.parts.map((p) => p.id));
	for (const part of plan.ensemble) {
		if (part.partId && existing.has(part.partId)) continue;
		ops.push({ op: 'add_part', args: { name: part.name, instrument: part.instrument } });
	}

	for (const { section, startTick, endTick } of sectionSpans(score, plan)) {
		const args: Record<string, unknown> = { name: section.name, startTick, endTick };
		// Passing a stale id would be worse than passing none: set_section now
		// refuses an id it cannot resolve rather than quietly minting a section.
		if (section.sectionId && score.sections.some((s) => s.id === section.sectionId)) {
			args.sectionId = section.sectionId;
		}
		ops.push({ op: 'set_section', args });
	}

	// Sections the last approval created and this plan no longer has. Parts get
	// no equivalent on purpose: removing one deletes its music, and at this
	// stage the only music in the score is the seed the user hummed.
	for (const id of droppedSectionIds(plan, previous)) {
		if (score.sections.some((s) => s.id === id)) {
			ops.push({ op: 'remove_section', args: { sectionId: id } });
		}
	}

	return ops;
}

/** Section ids the previous plan owned that the current one has dropped. */
export function droppedSectionIds(plan: Plan, previous?: Plan | null): string[] {
	if (!previous) return [];
	const kept = new Set(plan.sections.map((s) => s.sectionId).filter(Boolean));
	return previous.sections
		.map((s) => s.sectionId)
		.filter((id): id is string => Boolean(id) && !kept.has(id));
}

/**
 * Record what approval created, so the next approval can update it.
 *
 * Sections are matched to `created` entries in order, because `planToOps`
 * emits one `set_section` per card in order and an op that updated an existing
 * section creates nothing — so the created list lines up with exactly the
 * cards that had no id yet.
 */
export function withCreatedIds(
	plan: Plan,
	created: { kind: string; id: string }[] | undefined
): Plan {
	const fresh = (created ?? []).filter((c) => c.kind === 'section').map((c) => c.id);
	let next = 0;

	return {
		...plan,
		approved: true,
		sections: plan.sections.map((s) => (s.sectionId ? s : { ...s, sectionId: fresh[next++] }))
	};
}

/**
 * Adopt the part ids approval just created.
 *
 * Same ordering argument as sections: `planToOps` skips entries that already
 * resolve, so the created parts line up with the entries that did not.
 */
export function withCreatedPartIds(
	plan: Plan,
	score: Score,
	created: { kind: string; id: string }[] | undefined
): Plan {
	const existed = new Set(score.parts.map((p) => p.id));
	const fresh = (created ?? []).filter((c) => c.kind === 'part').map((c) => c.id);
	let next = 0;

	return {
		...plan,
		ensemble: plan.ensemble.map((p) =>
			p.partId && existed.has(p.partId) ? p : { ...p, partId: fresh[next++] }
		)
	};
}

/**
 * The most non-drum parts a plan may ask for.
 *
 * Fifteen is not a taste judgement, it is the number of non-drum MIDI channels
 * — 0-8 and 10-15. Past it, parts share a channel and stop being separately
 * controllable in playback.
 */
export const MAX_ENSEMBLE = 15;

/** Sections beyond this stop being a plan and start being a score. */
const MAX_SECTIONS = 24;

/**
 * Turn whatever the model returned into a plan, or nothing.
 *
 * The reply is untrusted even with a schema attached: the retry path runs with
 * no schema at all, and a strict schema still permits an explicit null for
 * every optional field. Everything here is clamped rather than rejected —
 * a plan with one silly bar count is worth showing to a person who can fix it,
 * which is the entire premise of the stage.
 */
export function coercePlan(raw: unknown, score: Score): Plan | null {
	if (!raw || typeof raw !== 'object') return null;
	const r = raw as Record<string, unknown>;

	const sections = asArray(r.sections)
		.slice(0, MAX_SECTIONS)
		.map((entry) => {
			const s = entry as Record<string, unknown>;
			return {
				name: str(s.name) || 'Section',
				bars: clamp(num(s.bars, 8), 1, 64),
				harmony: str(s.harmony),
				role: str(s.role),
				...(str(s.sectionId) ? { sectionId: str(s.sectionId) } : {})
			};
		});
	// No sections is no plan. Everything else has a defensible default; this
	// does not, and approving it would move the score on with nothing to show.
	if (!sections.length) return null;

	const known = new Set(score.parts.map((p) => p.id));
	const ensemble = asArray(r.ensemble)
		.slice(0, MAX_ENSEMBLE)
		.map((entry) => {
			const p = entry as Record<string, unknown>;
			const partId = str(p.partId);
			return {
				name: str(p.name) || 'Part',
				instrument: str(p.instrument) || 'Acoustic Grand Piano',
				// Dropped rather than kept when it names nothing: carrying an id
				// the score does not have would show the user an ensemble row
				// claiming to be an existing part that is not there.
				...(partId && known.has(partId) ? { partId } : {})
			};
		});

	const key = (r.key ?? {}) as Record<string, unknown>;
	const sig = (r.timeSig ?? {}) as Record<string, unknown>;
	const den = num(sig.den, 4);

	return {
		title: str(r.title),
		key: {
			tonic: str(key.tonic) || 'C',
			mode: key.mode === 'minor' ? 'minor' : 'major'
		},
		tempoBpm: clamp(num(r.tempoBpm, 100), 20, 300),
		timeSig: {
			num: clamp(num(sig.num, 4), 1, 32),
			// A denominator that is not a real note value would give every bar a
			// nonsense length, and every section boundary with it.
			den: [1, 2, 4, 8, 16, 32].includes(den) ? den : 4
		},
		ensemble,
		sections,
		approved: false
	};
}

function asArray(value: unknown): unknown[] {
	return Array.isArray(value) ? value.filter((v) => v && typeof v === 'object') : [];
}

function str(value: unknown): string {
	return typeof value === 'string' ? value.trim() : '';
}

function num(value: unknown, fallback: number): number {
	return typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : fallback;
}

function clamp(n: number, lo: number, hi: number): number {
	return Math.max(lo, Math.min(hi, n));
}
