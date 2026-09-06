import { error, json } from '@sveltejs/kit';
import { readJson, requireUser } from '$lib/server/api';
import { commitOps } from '$lib/server/scores';
import { DEFAULT_AI, getSetting, type AiSettings } from '$lib/server/settings';
import type { Op } from '$lib/score/apply';
import type { RequestHandler } from './$types';

/**
 * The single write path for score content, exposed.
 *
 * Manual edits from the notation canvas, deterministic controls and the AI
 * layer all POST here, which is why undo and the diff work identically for
 * all three without any of them implementing it.
 */
export const POST: RequestHandler = async ({ locals, params, request }) => {
	const user = requireUser(locals);
	const body = await readJson<{ ops?: Op[]; label?: string; source?: 'user' | 'control' }>(request);

	const ops = body.ops;
	if (!Array.isArray(ops) || ops.length === 0) error(400, 'No operations supplied');

	// A runaway batch is almost always a bug or a model that decided to rewrite
	// the whole piece. Refuse it rather than spend a minute applying it.
	const { maxOpsPerTurn } = getSetting<AiSettings>('ai', DEFAULT_AI);
	if (ops.length > maxOpsPerTurn) {
		error(413, `Too many operations in one batch (${ops.length} > ${maxOpsPerTurn})`);
	}

	const result = commitOps(params.id, user.id, ops, {
		source: body.source === 'control' ? 'control' : 'user',
		label: body.label?.trim() || `${ops.length} edit(s)`
	});

	return json({
		doc: result.score,
		revisionId: result.revisionId,
		diff: result.diff,
		// Which parts and sections it made. F0 computes this; without
		// forwarding it a caller cannot tell what it just created.
		created: result.created,
		log: result.log,
		errors: result.errors
	});
};
