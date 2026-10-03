import { error, json } from '@sveltejs/kit';
import { readJson, requireUser } from '$lib/server/api';
import { BudgetExceededError } from '$lib/server/budget';
import { NoModelError, NoProviderError } from '$lib/server/ai/provider';
import { NothingToArrangeError, startArrange } from '$lib/server/ai/arrange';
import {
	acceptRevision,
	assertNothingStaged,
	commitOps,
	loadScore,
	setPipeline
} from '$lib/server/scores';
import { accompanimentParts, clearPartOps, syncPlanSections } from '$lib/pipeline/arrange';
import { nextStage } from '$lib/pipeline/types';
import type { RequestHandler } from './$types';

/**
 * The arrangement stage's verbs.
 *
 * `arrange` writes parts and `clear` empties one; between them they are
 * per-part accept and reject. Each run is held to one part at a time, so
 * clearing a part undoes exactly the work that wrote it.
 */
export const POST: RequestHandler = async ({ locals, params, request, url }) => {
	const user = requireUser(locals);
	const body = await readJson<{
		action?: string;
		partIds?: string[];
		partId?: string;
		instruction?: string;
		revisionId?: string;
	}>(request);

	switch (body.action) {
		case 'arrange':
			return arrange(params.id, user.id, url.origin, body.partIds, body.instruction);
		case 'clear':
			return clear(params.id, user.id, body.partId);
		case 'accept':
			return accept(params.id, user.id, body.revisionId);
		case 'approve':
			return approve(params.id, user.id);
		default:
			error(400, `Unknown action: ${body.action ?? '(none)'}`);
	}
};

function arrange(
	scoreId: string,
	userId: string,
	origin: string,
	partIds?: string[],
	instruction?: string
) {
	try {
		return json(startArrange({ scoreId, userId, partIds, instruction, origin }));
	} catch (err) {
		if (
			err instanceof NothingToArrangeError ||
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
 * Empty one part: per-part reject.
 *
 * Accepted rather than staged, like a code-tier control. It is deterministic,
 * and undoable through history like any other edit, so a review would only add
 * a click. Only the parts this stage writes can be cleared — the melody was
 * approved in the previous stage and the hummed seed is a recording.
 */
function clear(scoreId: string, userId: string, partId?: string) {
	const row = loadScore(scoreId, userId);
	const plan = row.pipeline.plan;
	if (!plan) error(400, 'This score has no plan.');
	assertNothingStaged(scoreId, userId);

	const part = accompanimentParts(row.doc, plan, row.pipeline.brief).find(
		(p) => p.partId === partId
	);
	if (!part) error(400, 'That part is not one this stage writes.');

	const ops = clearPartOps(row.doc, part.partId);
	if (!ops.length) error(400, `${part.name} is already empty.`);

	const commit = commitOps(scoreId, userId, ops, {
		source: 'user',
		label: `Cleared ${part.name}`,
		accepted: true
	});
	return json({ doc: commit.score });
}

/**
 * Accept a staged control result, and tell the plan about any new section.
 *
 * `Add section` lives here because a bridge usually only becomes obvious once
 * the piece can be heard, but the form belongs to the plan — so accepting is
 * where a section written here becomes a card the plan knows about.
 */
function accept(scoreId: string, userId: string, revisionId?: string) {
	if (!revisionId) error(400, 'revisionId is required');
	acceptRevision(scoreId, userId, revisionId);

	const row = loadScore(scoreId, userId);
	const plan = row.pipeline.plan;
	if (plan) {
		const synced = syncPlanSections(plan, row.doc);
		if (synced !== plan) setPipeline(scoreId, userId, { plan: synced });
	}
	return json({ ok: true, doc: row.doc });
}

/**
 * Move on to refinement.
 *
 * Writes nothing, like the melody stage's approval: every run has already
 * landed. A plan with no instruments besides the melody has nothing to arrange
 * and may move straight on — a solo line is a legitimate piece.
 */
function approve(scoreId: string, userId: string) {
	const row = loadScore(scoreId, userId);
	const plan = row.pipeline.plan;
	if (!plan) error(400, 'This score has no plan.');
	assertNothingStaged(scoreId, userId);

	const parts = accompanimentParts(row.doc, plan, row.pipeline.brief);
	if (parts.length && !parts.some((p) => p.state === 'written')) {
		error(400, 'Arrange at least one part before continuing.');
	}

	return json({
		pipeline: setPipeline(scoreId, userId, { stage: nextStage('arrangement') ?? 'arrangement' })
	});
}
