import { requireUser } from '$lib/server/api';
import { analysisOf, listRevisions, loadScore, stagedRevision } from '$lib/server/scores';
import { hasProvider } from '$lib/server/ai/provider';
import { listControls } from '$lib/server/controls/registry';
import { DEFAULT_AUDIO, getSetting, type AudioSettings } from '$lib/server/settings';
import type { PageServerLoad } from './$types';

/**
 * The refinement stage.
 *
 * Unlike the stages before it this needs no plan: refining is expression on
 * whatever notes are there, which is also what makes it the place a score
 * written before the pipeline existed can be worked on.
 */
export const load: PageServerLoad = ({ locals, params }) => {
	const user = requireUser(locals);
	const row = loadScore(params.id, user.id);
	const audio = getSetting<AudioSettings>('audio', DEFAULT_AUDIO);

	return {
		flush: true,
		score: { id: row.id, title: row.title, doc: row.doc },
		pipeline: row.pipeline,
		canGenerate: hasProvider(),
		controls: listControls('refine'),
		pending: stagedRevision(row.id, user.id),
		analysis: analysisOf(row),
		revisions: listRevisions(row.id, user.id, 40).map((r) => ({
			...r,
			createdAt: r.createdAt.getTime()
		})),
		audio,
		soundfontUrl: audio.soundfontUrl
	};
};
