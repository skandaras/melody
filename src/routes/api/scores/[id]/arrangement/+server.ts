import { error, json } from '@sveltejs/kit';
import { readJson, requireUser } from '$lib/server/api';
import { BudgetExceededError } from '$lib/server/budget';
import { NoModelError, NoProviderError } from '$lib/server/ai/provider';
import { NothingToArrangeError, startArrange } from '$lib/server/ai/arrange';
import { commitOps, loadScore, setPipeline } from '$lib/server/scores';
import { isArranged, noteIdsIn, partStates } from '$lib/pipeline/arrange';
import { melodyPartOf } from '$lib/pipeline/realize';
import { furthest, nextStage } from '$lib/pipeline/types';
import type { RequestHandler } from './$types';

/**
 * The arrangement stage's verbs.
 *
 * `arrange` covers three things that are one operation with different targets,
 * exactly as `realize` does for the melody: arranging the whole ensemble,
 * rewriting one part, and answering feedback on one. Parts are the unit, so
 * "which parts" and "what to say about them" are the only differences.
 *
 * `reject` is the fourth verb and the one the melody stage has no equivalent
 * of, because per-part accept and reject is what this stage promises.
 */
export const POST: RequestHandler = async ({ locals, params, request, url }) => {
	const user = requireUser(locals);
	const body = await readJson<{
		action?: string;
		partIds?: string[];
		instruction?: string;
		partId?: string;
	}>(request);

	switch (body.action) {
		case 'arrange':
			return arrange(params.id, user.id, url.origin, body.partIds, body.instruction);
		case 'reject':
			return reject(params.id, user.id, body.partId);
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
		// Each of these is something the person can act on — an unapproved plan, a
		// missing key, a spent budget — rather than a server fault.
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
 * Reject one part's arrangement.
 *
 * Clears the notes and keeps the part. The part belongs to the plan — approving
 * the plan is what created it — and only the notes in it are this stage's
 * proposal, so deleting the part would silently edit the ensemble the person
 * approved and leave "arrange what is left" an instrument short.
 *
 * A revision of its own, accepted, like any other deliberate edit: it is
 * reversible through the history that already exists, so it needs no staging.
 */
function reject(scoreId: string, userId: string, partId?: string) {
	const row = loadScore(scoreId, userId);
	const plan = row.pipeline.plan;
	if (!plan) error(400, 'This score has no plan.');

	const part = partId ? row.doc.parts.find((p) => p.id === partId) : undefined;
	if (!part) error(400, 'That part is not in this score.');

	// The melody was approved a stage ago and is not this stage's to discard.
	const melodyPartId = melodyPartOf(row.doc, plan, row.pipeline.brief);
	if (part.id === melodyPartId) {
		error(400, 'That is the melody. Go back to the melody stage to change it.');
	}

	const noteIds = noteIdsIn(row.doc, part.id);
	if (!noteIds.length) error(400, `${part.name} has nothing written in it.`);

	const commit = commitOps(
		scoreId,
		userId,
		[{ op: 'delete_notes', args: { noteIds } }],
		{ source: 'user', label: `Rejected the ${part.name} part`, accepted: true }
	);

	if (commit.errors.length) error(400, commit.errors.map((e) => e.reason).join('; '));
	return json({ doc: commit.score, revisionId: commit.revisionId, diff: commit.diff });
}

/**
 * Move on to the refinement.
 *
 * Writes nothing: the arrangement is already committed, one revision per run.
 * All this does is say the stage is finished.
 */
function approve(scoreId: string, userId: string) {
	const row = loadScore(scoreId, userId);
	const plan = row.pipeline.plan;
	if (!plan) error(400, 'This score has no plan.');

	const melodyPartId = melodyPartOf(row.doc, plan, row.pipeline.brief);

	// A plan with one instrument is a solo piece, and there is no accompaniment
	// to wait for. Refusing to continue would strand it here with no way out.
	const hasAccompaniment = partStates(row.doc, plan, melodyPartId).some(
		(s) => s.role === 'accompaniment'
	);
	if (hasAccompaniment && !isArranged(row.doc, plan, melodyPartId)) {
		error(400, 'Arrange at least one part before continuing.');
	}

	return json({
		// `furthest`, not a bare assignment: the stepper makes it possible to walk
		// back into this stage from a later one, and approving it again must not
		// rewind a finished score to where it was three stages ago.
		pipeline: setPipeline(scoreId, userId, {
			stage: furthest(row.pipeline.stage, nextStage('arrangement') ?? 'arrangement')
		})
	});
}
