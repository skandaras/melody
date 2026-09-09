import { requireUser } from '$lib/server/api';
import { loadScore } from '$lib/server/scores';
import { hasProvider } from '$lib/server/ai/provider';
import { analysisReport } from '$lib/server/ai/context';
import { DEFAULT_AUDIO, getSetting, type AudioSettings } from '$lib/server/settings';
import type { PageServerLoad } from './$types';

/**
 * The finish stage.
 *
 * No guard at all. Every earlier stage can refuse to open on missing data it
 * genuinely reads; this one shows the score, offers a name and exports what is
 * there, all of which work on any document. A score arriving here has, by
 * definition, been through everything that had an opinion about it.
 */
export const load: PageServerLoad = ({ locals, params }) => {
	const user = requireUser(locals);
	const row = loadScore(params.id, user.id);
	const audio = getSetting<AudioSettings>('audio', DEFAULT_AUDIO);
	const stored = row.pipeline.plan?.analysis;

	return {
		flush: true,
		score: { id: row.id, title: row.title, doc: row.doc },
		pipeline: row.pipeline,
		/**
		 * A kept analysis, and whether it still describes this score.
		 *
		 * `basis` is the exact digest the model was given. Regenerating it here
		 * and comparing is what turns "we saved some prose once" into a claim the
		 * page can stand behind: identical means every fact the answer rested on
		 * is unchanged, and anything else means say so rather than present an old
		 * reading as a current one.
		 */
		analysis: stored
			? { text: stored.text, stale: stored.basis !== analysisReport(row.doc) }
			: null,
		canGenerate: hasProvider(),
		audio,
		soundfontUrl: audio.soundfontUrl
	};
};
