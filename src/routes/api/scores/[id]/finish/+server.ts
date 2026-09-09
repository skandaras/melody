import { error, json } from '@sveltejs/kit';
import { readJson, requireUser } from '$lib/server/api';
import { BudgetExceededError } from '$lib/server/budget';
import { NoModelError, NoProviderError } from '$lib/server/ai/provider';
import { startExplain, startName } from '$lib/server/ai/describe';
import { commitOps, loadScore, setPipeline } from '$lib/server/scores';
import type { RequestHandler } from './$types';

/**
 * The finish stage's verbs.
 *
 * There is no `approve`. `nextStage('finish')` is null, and the stage's own
 * open question answers itself: no `completed` flag and no read-only state.
 * Music is never finished, and a lock would be friction with no payoff. Finish
 * is simply the last stage, which you can leave and re-enter like any other.
 *
 * Export is not here either, and should not be: it is a read. Every exporter in
 * `$lib/export` runs in the browser against the document the page already has,
 * so exporting cannot change the score and needs no endpoint to prove it.
 */
export const POST: RequestHandler = async ({ locals, params, request, url }) => {
	const user = requireUser(locals);
	const body = await readJson<{
		action?: string;
		title?: string;
		analysis?: string;
		/** The digest the analysis was written from, echoed back by the page. */
		basis?: string;
	}>(request);

	switch (body.action) {
		case 'suggestTitle':
			return start(() => startName({ scoreId: params.id, userId: user.id, origin: url.origin }));
		case 'explain':
			return start(() => startExplain({ scoreId: params.id, userId: user.id, origin: url.origin }));
		case 'setTitle':
			return setTitle(params.id, user.id, body.title);
		case 'rememberAnalysis':
			return rememberAnalysis(params.id, user.id, body.analysis, body.basis);
		default:
			error(400, `Unknown action: ${body.action ?? '(none)'}`);
	}
};

/** Both model calls fail the same three ways, all of them the user's to fix. */
function start(begin: () => { jobId: string }) {
	try {
		return json(begin());
	} catch (err) {
		if (
			err instanceof NoProviderError ||
			err instanceof NoModelError ||
			err instanceof BudgetExceededError
		) {
			error(400, err.message);
		}
		throw err;
	}
}

/**
 * Name the piece.
 *
 * Through `commitOps` and `set_title` rather than `renameScore`, for two
 * reasons: naming is the one thing this stage commits, so it should land in the
 * history like every other edit and be undoable there; and `commitOps` already
 * mirrors the document's title into the `scores.title` column, so the op is the
 * complete answer rather than half of one.
 */
function setTitle(scoreId: string, userId: string, title?: string) {
	const clean = title?.trim();
	if (!clean) error(400, 'A title cannot be empty.');
	if (clean.length > 200) error(400, 'That title is too long.');

	const commit = commitOps(scoreId, userId, [{ op: 'set_title', args: { title: clean } }], {
		source: 'user',
		label: `Named it "${clean}"`,
		accepted: true
	});

	if (commit.errors.length) error(400, commit.errors.map((e) => e.reason).join('; '));
	return json({ doc: commit.score, revisionId: commit.revisionId, title: commit.score.title });
}

/**
 * Keep the written analysis, so a second visit does not pay for it again.
 *
 * Stored with `basis` — the exact digest the model was given — because prose
 * about a piece stops being true the moment the piece changes, and an analysis
 * that silently rots is the failure this whole epic exists to remove. Comparing
 * the digest is exact rather than approximate: if it regenerates identically,
 * every fact the answer rested on is unchanged.
 *
 * On the `plan` JSON column, which costs no migration. Worth naming the price:
 * `PipelineState` is snapshotted into every revision, so the text is copied
 * alongside each one. A few hundred words against the gzipped document
 * snapshots that already dominate that table is a trade worth making for
 * something the person asked to keep.
 */
function rememberAnalysis(scoreId: string, userId: string, text?: string, basis?: string) {
	const row = loadScore(scoreId, userId);
	const plan = row.pipeline.plan;
	// A score that never went through the Plan stage has nowhere to keep this.
	// That is not a failure the person can act on, and refusing would put a 400
	// in the console every time they asked a question — so it quietly keeps
	// nothing, and the next visit simply offers to ask again.
	if (!plan) return json({ pipeline: row.pipeline });

	const analysis = text?.trim()
		? { text: text.trim(), basis: basis ?? '' }
		: undefined;

	return json({
		pipeline: setPipeline(scoreId, userId, { plan: { ...plan, analysis } })
	});
}
