import { requireUser } from '$lib/server/api';
import { entryRoute } from '$lib/pipeline/types';
import { hasNotes } from '$lib/score/query';
import { listRevisions, loadScore } from '$lib/server/scores';
import { DEFAULT_AUDIO, getSetting, type AudioSettings } from '$lib/server/settings';
import type { PageServerLoad } from './$types';

/**
 * Deliberately small.
 *
 * No controls, no transcription settings, no recording URL — Bench cannot use
 * any of them, and loading data a page has no way to act on is how a "manual
 * only" surface quietly grows back into the three-column editor it replaced.
 */
export const load: PageServerLoad = ({ locals, params }) => {
	const user = requireUser(locals);
	const row = loadScore(params.id, user.id);
	const audio = getSetting<AudioSettings>('audio', DEFAULT_AUDIO);

	return {
		audio,
		score: { id: row.id, title: row.title, doc: row.doc },
		/**
		 * For the fog: Bench shows the atmosphere of the stage its score opens
		 * at — which for a score from before the pipeline is refinement, not the
		 * brief its stage column says by default.
		 */
		stage: entryRoute(row.pipeline, hasNotes(row.doc)),
		revisions: listRevisions(params.id, user.id, 40).map((r) => ({
			...r,
			createdAt: r.createdAt.getTime()
		})),
		soundfontUrl: audio.soundfontUrl
	};
};
