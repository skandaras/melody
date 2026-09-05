import { error, json } from '@sveltejs/kit';
import { readJson, requireUser } from '$lib/server/api';
import { startEdit } from '$lib/server/ai/run';
import { mergeIntoScore } from '$lib/server/scores';
import { DEFAULT_TRANSCRIBE, getSetting, type TranscribeSettings } from '$lib/server/settings';
import type { Score } from '$lib/score/types';
import type { RequestHandler } from './$types';

/**
 * Take delivery of a transcription.
 *
 * The audio never reaches this endpoint. Recording, resampling and pitch
 * detection all happen in the browser, and what arrives here is the finished
 * score fragment — which is what keeps a 2GB droplet out of the business of
 * running neural networks.
 *
 * It lands unaccepted, so the editor's existing accept/reject review covers
 * it: a hummed melody is a draft, and rejecting the lot in one click beats
 * deleting fifty wrong notes by hand.
 */
export const POST: RequestHandler = async ({ locals, params, request, url }) => {
	const user = requireUser(locals);
	const body = await readJson<{
		fragment?: Score;
		label?: string;
		atTick?: number;
		adoptGlobals?: boolean;
	}>(request);

	if (!body.fragment || typeof body.fragment !== 'object') {
		error(400, 'No transcription supplied');
	}

	const result = mergeIntoScore(params.id, user.id, body.fragment, {
		label: body.label?.trim() || 'Transcription',
		atTick: body.atTick,
		adoptGlobals: body.adoptGlobals
	});

	// Optional AI cleanup pass, admin-configured. Fire-and-forget: the
	// transcription is already saved and staged, so a pass with no model
	// configured — or no budget left — changes nothing the user sees.
	const { autoCleanup } = getSetting<TranscribeSettings>('transcribe', DEFAULT_TRANSCRIBE);
	if (autoCleanup && result.diff.added.length > 0) {
		try {
			startEdit({
				scoreId: params.id,
				userId: user.id,
				instruction:
					'Clean up this transcribed fragment: correct pitch spellings against the key, remove spurious very short notes, and nudge the rhythm onto the grid. Keep every note you are confident about.',
				selection: {},
				task: 'transcribe_cleanup',
				origin: url.origin
			});
		} catch {
			// The manual cleanup task still exists in the rack, so silence here
			// is right: a transcription must never fail because cleanup can't.
		}
	}

	return json({
		doc: result.score,
		revisionId: result.revisionId,
		diff: result.diff,
		// Which parts and sections it made. F0 computes this; without
		// forwarding it a caller cannot tell what it just created.
		created: result.created,
		log: result.log
	});
};
