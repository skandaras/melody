import type { Op } from '$lib/score/apply';
import type { Score, Selection } from '$lib/score/types';
import { toggleSelection } from './selection.js';

/**
 * One score, being edited.
 *
 * Extracted from the editor page because two routes now edit the same
 * document — the full editor and Bench — and two copies of this state would
 * become two write paths. Everything in melody goes through `applyOps` on the
 * server precisely so that undo, revisions and the accept/reject diff are the
 * same mechanism for a human, a control and the model; a second client-side
 * write path would undo that from the other end.
 *
 * Shaped after `PlayerStore` and `Run`, the two existing rune stores, so there
 * is one pattern here rather than three. It lives outside `$lib/score/`, which
 * imports nothing and must stay that way — this does `fetch`.
 */

export interface RevisionRow {
	id: string;
	seq: number;
	source: string;
	label: string;
	accepted: boolean;
	createdAt: number;
}

/** What a staged, unaccepted change looks like while it waits for review. */
export interface PendingDiff {
	added: string[];
	removed: string[];
	changed: string[];
	revisionId: string;
	label: string;
}

/** The slice of page data a session is seeded from. */
export interface SessionSeed {
	score: { id: string; title: string; doc: Score };
	revisions: RevisionRow[];
}

export class ScoreSession {
	scoreId = $state('');
	doc = $state<Score>(null as unknown as Score);
	title = $state('');
	selected = $state<Set<string>>(new Set());
	revisions = $state<RevisionRow[]>([]);

	/**
	 * A change waiting to be accepted or rejected.
	 *
	 * One slot, shared by AI turns, controls and transcription. Bench never
	 * writes to it: a manual edit competing for the same slot as a staged
	 * suggestion would leave one of them unreviewable.
	 */
	pending = $state<PendingDiff | null>(null);

	busy = $state(false);
	error = $state('');

	constructor(seed: SessionSeed) {
		this.reseed(seed);
	}

	/** `{}` means the whole score, which is what an empty selection implies. */
	get selection(): Selection {
		return this.selected.size ? { noteIds: [...this.selected] } : {};
	}

	get selectionCount(): number {
		return this.selected.size;
	}

	/**
	 * Point this session at a different score.
	 *
	 * SvelteKit reuses a component across `/score/A → /score/B`, so without
	 * this the previous score's notes are rendered — and then **saved under the
	 * new score's id**. The guard travels with the state it protects.
	 */
	reseed(seed: SessionSeed): void {
		this.scoreId = seed.score.id;
		this.doc = seed.score.doc;
		this.title = seed.score.title;
		this.revisions = seed.revisions;
		this.selected = new Set();
		this.pending = null;
		this.error = '';
	}

	/** True when the seed names a different score than the one loaded. */
	isStale(seed: SessionSeed): boolean {
		return seed.score.id !== this.scoreId;
	}

	select(ids: string[], additive: boolean): void {
		this.selected = toggleSelection(this.selected, ids, additive);
	}

	clearSelection(): void {
		this.selected = new Set();
	}

	/** Apply operations through the one write path, so undo and diff work. */
	async runOps(ops: Op[], label: string, source: 'user' | 'control' = 'user'): Promise<void> {
		this.busy = true;
		this.error = '';
		try {
			const r = await this.#post(`/api/scores/${this.scoreId}/ops`, { ops, label, source });
			this.doc = r.doc;
			await this.refreshHistory();
			if (r.errors?.length) {
				this.error = r.errors.map((e: { reason: string }) => e.reason).join('; ');
			}
		} catch (e) {
			this.error = e instanceof Error ? e.message : String(e);
		} finally {
			this.busy = false;
		}
	}

	/** Restore a revision — undo, redo and history clicks are all this. */
	async restore(revisionId: string): Promise<void> {
		if (this.busy) return;
		this.busy = true;
		this.error = '';
		try {
			const r = await this.#post(`/api/scores/${this.scoreId}/revisions`, {
				action: 'restore',
				revisionId
			});
			this.doc = r.doc;
			this.pending = null;
			this.selected = new Set();
			await this.refreshHistory();
		} catch (e) {
			this.error = e instanceof Error ? e.message : String(e);
		} finally {
			this.busy = false;
		}
	}

	async resolvePending(action: 'accept' | 'reject'): Promise<void> {
		if (!this.pending) return;
		this.busy = true;
		try {
			const r = await this.#post(`/api/scores/${this.scoreId}/revisions`, {
				action,
				revisionId: this.pending.revisionId
			});
			this.doc = r.doc;
			this.pending = null;
			this.selected = new Set();
			await this.refreshHistory();
		} catch (e) {
			this.error = e instanceof Error ? e.message : String(e);
		} finally {
			this.busy = false;
		}
	}

	/**
	 * Take a whole fragment rather than operations.
	 *
	 * A transcription carries rests and ties, which `insert_notes` cannot
	 * express, so it goes through the merge path instead. It still lands staged,
	 * so the same accept/reject review covers it.
	 */
	async merge(fragment: Score, label: string): Promise<void> {
		this.busy = true;
		this.error = '';
		try {
			const r = await this.#post(`/api/scores/${this.scoreId}/transcribe`, { fragment, label });
			this.doc = r.doc;
			this.pending = { ...r.diff, revisionId: r.revisionId, label };
			await this.refreshHistory();
		} catch (e) {
			this.error = e instanceof Error ? e.message : String(e);
			// Rethrown: the audio panel needs to know its take did not land, so
			// it can keep the recording rather than clearing it.
			throw e;
		} finally {
			this.busy = false;
		}
	}

	/** Adopt a document a component produced for us — an AI turn, or a control. */
	adopt(doc: Score, pending: PendingDiff | null): void {
		this.doc = doc;
		this.pending = pending;
		void this.refreshHistory();
	}

	async saveTitle(): Promise<void> {
		await fetch(`/api/scores/${this.scoreId}`, {
			method: 'PATCH',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ title: this.title })
		});
	}

	/** Re-pull the revision list after anything that could have added one. */
	async refreshHistory(): Promise<void> {
		try {
			const res = await fetch(`/api/scores/${this.scoreId}/revisions`);
			if (res.ok) this.revisions = (await res.json()).revisions;
		} catch {
			// History refresh is cosmetic; the next successful action retries.
		}
	}

	async #post(path: string, body: unknown) {
		const res = await fetch(path, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(body)
		});
		if (!res.ok) throw new Error((await res.text()) || res.statusText);
		return res.json();
	}
}
