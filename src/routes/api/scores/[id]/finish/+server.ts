import { error, json } from '@sveltejs/kit';
import { readJson, requireUser } from '$lib/server/api';
import { BudgetExceededError } from '$lib/server/budget';
import { NoModelError, NoProviderError } from '$lib/server/ai/provider';
import { startExplain, startTitles } from '$lib/server/ai/finish';
import { assertNothingStaged, commitOps, loadScore, setPipeline } from '$lib/server/scores';
import type { RequestHandler } from './$types';

/**
 * The finish stage's verbs: suggest a name, explain the piece, keep a name.
 *
 * `explain` is also offered on the refinement page — it describes the piece
 * wherever it is asked for, and the stored text is the same either way.
 */
export const POST: RequestHandler = async ({ locals, params, request, url }) => {
	const user = requireUser(locals);
	const body = await readJson<{ action?: string; title?: string }>(request);
	const opts = { scoreId: params.id, userId: user.id, origin: url.origin };

	switch (body.action) {
		case 'titles':
			return job(() => startTitles(opts));
		case 'explain':
			return job(() => startExplain(opts));
		case 'title':
			return saveTitle(params.id, user.id, body.title);
		default:
			error(400, `Unknown action: ${body.action ?? '(none)'}`);
	}
};

function job(start: () => { jobId: string }) {
	try {
		return json(start());
	} catch (err) {
		// A missing key or a spent budget is something to act on, not a fault.
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
 * Keep a name.
 *
 * A set_title commit, so it is in the history like any other change, and the
 * plan's title follows it — otherwise the plan page would go on showing the
 * working title the piece no longer has.
 */
function saveTitle(scoreId: string, userId: string, raw?: string) {
	const title = raw?.trim().slice(0, 200);
	if (!title) error(400, 'A title cannot be empty.');

	const row = loadScore(scoreId, userId);
	assertNothingStaged(scoreId, userId);

	const commit = commitOps(scoreId, userId, [{ op: 'set_title', args: { title } }], {
		source: 'user',
		label: `Named it "${title}"`,
		accepted: true
	});
	if (row.pipeline.plan) setPipeline(scoreId, userId, { plan: { ...row.pipeline.plan, title } });

	return json({ doc: commit.score, title: commit.score.title });
}
