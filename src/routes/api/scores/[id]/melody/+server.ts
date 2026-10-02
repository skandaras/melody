import { error, json } from '@sveltejs/kit';
import { readJson, requireUser } from '$lib/server/api';
import { BudgetExceededError } from '$lib/server/budget';
import { NoModelError, NoProviderError } from '$lib/server/ai/provider';
import { NothingToRealizeError, startRealize } from '$lib/server/ai/realize';
import { assertNothingStaged, loadScore, setPipeline } from '$lib/server/scores';
import { melodyPartOf, sectionStates } from '$lib/pipeline/realize';
import { nextStage } from '$lib/pipeline/types';
import type { RequestHandler } from './$types';

/**
 * The melody stage's verbs.
 *
 * `realize` covers three things that are the same operation with different
 * targets: writing the whole melody, rewriting one section, and answering
 * feedback on one. Sections are the unit, so "which sections" and "what to say
 * about them" are the only differences.
 */
export const POST: RequestHandler = async ({ locals, params, request, url }) => {
	const user = requireUser(locals);
	const body = await readJson<{
		action?: string;
		sectionIds?: string[];
		instruction?: string;
		partId?: string;
	}>(request);

	switch (body.action) {
		case 'realize':
			return realize(params.id, user.id, url.origin, body.sectionIds, body.instruction);
		case 'melodyPart':
			return setMelodyPart(params.id, user.id, body.partId);
		case 'approve':
			return approve(params.id, user.id);
		default:
			error(400, `Unknown action: ${body.action ?? '(none)'}`);
	}
};

function realize(
	scoreId: string,
	userId: string,
	origin: string,
	sectionIds?: string[],
	instruction?: string
) {
	assertNothingStaged(scoreId, userId);
	try {
		return json(startRealize({ scoreId, userId, sectionIds, instruction, origin }));
	} catch (err) {
		// Each of these is something the person can act on — an unapproved plan, a
		// missing key, a spent budget — rather than a server fault.
		if (
			err instanceof NothingToRealizeError ||
			err instanceof NoProviderError ||
			err instanceof NoModelError ||
			err instanceof BudgetExceededError
		) {
			error(400, err.message);
		}
		throw err;
	}
}

/** Choose the staff the tune is written into. Stored on the plan. */
function setMelodyPart(scoreId: string, userId: string, partId?: string) {
	const row = loadScore(scoreId, userId);
	const plan = row.pipeline.plan;
	if (!plan) error(400, 'This score has no plan.');
	if (!partId || !row.doc.parts.some((p) => p.id === partId)) {
		error(400, 'That part is not in this score.');
	}

	return json({ pipeline: setPipeline(scoreId, userId, { plan: { ...plan, melodyPartId: partId } }) });
}

/**
 * Move on to the arrangement.
 *
 * Writes nothing: the melody is already committed, one revision per run. All
 * this does is say the stage is finished, which is why it needs no ops and no
 * confirmation of work already accepted.
 */
function approve(scoreId: string, userId: string) {
	const row = loadScore(scoreId, userId);
	const plan = row.pipeline.plan;
	if (!plan) error(400, 'This score has no plan.');
	// Moving on would leave a staged change behind with nobody looking at it.
	assertNothingStaged(scoreId, userId);

	// Notes, not events: a part holding only rests is not a melody, and counting
	// events would let it through while the page still showed every section as
	// unwritten.
	const partId = melodyPartOf(row.doc, plan, row.pipeline.brief);
	const written = sectionStates(row.doc, plan, partId).some((s) => s.state === 'written');
	if (!written) error(400, 'Write some melody before continuing.');

	return json({
		pipeline: setPipeline(scoreId, userId, { stage: nextStage('melody') ?? 'melody' })
	});
}
