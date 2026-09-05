import { error, json } from '@sveltejs/kit';
import { readJson, requireUser } from '$lib/server/api';
import { NoModelError, NoProviderError } from '$lib/server/ai/provider';
import { startPlan } from '$lib/server/ai/plan';
import { commitOps, loadScore, setPipeline } from '$lib/server/scores';
import { coercePlan, planToOps, withCreatedIds, withCreatedPartIds } from '$lib/pipeline/plan';
import { isPlanUsable, nextStage, type Plan } from '$lib/pipeline/types';
import type { RequestHandler } from './$types';

/**
 * The plan stage's three verbs.
 *
 * `generate` asks the model for one and returns a job id — a plan takes tens of
 * seconds and holding the request open for it would lose the work to any
 * dropped connection. `save` stores an edited draft. `approve` is the only one
 * that writes to the score.
 */
export const POST: RequestHandler = async ({ locals, params, request, url }) => {
	const user = requireUser(locals);
	const body = await readJson<{ action?: string; plan?: unknown }>(request);

	switch (body.action) {
		case 'generate':
			return generate(params.id, user.id, url.origin);
		case 'save':
			return save(params.id, user.id, body.plan);
		case 'approve':
			return approve(params.id, user.id, body.plan);
		default:
			error(400, `Unknown action: ${body.action ?? '(none)'}`);
	}
};

function generate(scoreId: string, userId: string, origin: string) {
	// Checked here rather than caught from startPlan by message: matching on the
	// text of an error is a test that passes until someone rewords it.
	if (!loadScore(scoreId, userId).pipeline.brief) {
		error(400, 'Write a brief before planning.');
	}
	try {
		return json(startPlan({ scoreId, userId, origin }));
	} catch (err) {
		// A missing key is a configuration problem with a clear fix, not a
		// server fault — say so rather than returning a 500.
		if (err instanceof NoProviderError || err instanceof NoModelError) error(400, err.message);
		throw err;
	}
}

function save(scoreId: string, userId: string, raw: unknown) {
	const row = loadScore(scoreId, userId);
	const plan = coercePlan(raw, row.doc);
	if (!plan) error(400, 'That plan has no sections in it.');

	// A saved draft keeps whatever approval the stored plan already earned:
	// editing the harmony of an approved plan does not un-write the sections it
	// created, and claiming otherwise would make the next approval add a
	// duplicate set rather than update them.
	const merged = mergeApproval(plan, row.pipeline.plan);
	return json({ pipeline: setPipeline(scoreId, userId, { plan: merged }) });
}

/**
 * Commit the plan to the score.
 *
 * One `commitOps`, accepted rather than staged: the user has just approved it,
 * and asking them to approve it a second time in the editor's review panel
 * would be the same decision twice.
 */
function approve(scoreId: string, userId: string, raw: unknown) {
	const row = loadScore(scoreId, userId);
	const edited = coercePlan(raw, row.doc);
	if (!edited) error(400, 'That plan has no sections in it.');
	if (!isPlanUsable(edited)) error(400, 'Every section needs a bar count before approving.');

	const previous = row.pipeline.plan;
	const plan = mergeApproval(edited, previous);
	const ops = planToOps(row.doc, plan, previous);

	const result = commitOps(scoreId, userId, ops, {
		source: 'user',
		label: `Approved plan: ${plan.title || 'untitled'}`,
		accepted: true
	});

	// Record what the commit created so a later edit updates those parts and
	// sections rather than adding a second set beside them.
	const recorded = withCreatedPartIds(
		withCreatedIds(plan, result.created),
		row.doc,
		result.created
	);

	const pipeline = setPipeline(scoreId, userId, {
		plan: recorded,
		stage: nextStage('plan') ?? 'plan'
	});

	return json({ pipeline, doc: result.score, revisionId: result.revisionId, log: result.log });
}

/**
 * Carry the ids a previous approval recorded onto an edited plan.
 *
 * The client round-trips the plan through JSON, so the ids come back with it —
 * but only for cards that survived the edit, and never for cards the user
 * added. Matching by position would reassign an id to a different section the
 * moment somebody reorders the list, so ids are matched by id alone: a card
 * that arrives without one is genuinely new.
 */
function mergeApproval(plan: Plan, previous: Plan | null): Plan {
	if (!previous) return plan;
	// Owned by this plan, not merely present in the score: a section id the
	// editor made belongs to the editor, and a plan should not adopt it just
	// because a client sent one. `planToOps` then checks it still exists.
	const owned = new Set(previous.sections.map((s) => s.sectionId).filter(Boolean));

	return {
		...plan,
		approved: previous.approved,
		sections: plan.sections.map((s) =>
			s.sectionId && owned.has(s.sectionId) ? s : { ...s, sectionId: undefined }
		)
	};
}
