import { requireUser } from '$lib/server/api';
import { analysisOf, loadScore } from '$lib/server/scores';
import { hasProvider } from '$lib/server/ai/provider';
import { DEFAULT_AUDIO, getSetting, type AudioSettings } from '$lib/server/settings';
import type { PageServerLoad } from './$types';

/**
 * The finish stage: name it, understand it, take it away.
 *
 * No plan required, for the same reason as refinement — a score made before
 * the pipeline can be finished too.
 */
export const load: PageServerLoad = ({ locals, params }) => {
	const user = requireUser(locals);
	const row = loadScore(params.id, user.id);
	const audio = getSetting<AudioSettings>('audio', DEFAULT_AUDIO);

	return {
		flush: true,
		score: { id: row.id, title: row.title, doc: row.doc },
		pipeline: row.pipeline,
		analysis: analysisOf(row),
		canGenerate: hasProvider(),
		audio,
		soundfontUrl: audio.soundfontUrl
	};
};
