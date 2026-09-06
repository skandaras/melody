import { requireUser } from '$lib/server/api';
import { listRevisions, loadScore } from '$lib/server/scores';
import { DEFAULT_AUDIO, getSetting, type AudioSettings } from '$lib/server/settings';
import type { PageServerLoad } from './$types';

/**
 * Deliberately a subset of the editor's load.
 *
 * No controls, no transcription settings, no recording URL — Bench cannot use
 * any of them, and loading data a page has no way to act on is how a "manual
 * only" surface quietly grows back into the editor it was carved out of.
 */
export const load: PageServerLoad = ({ locals, params }) => {
	const user = requireUser(locals);
	const row = loadScore(params.id, user.id);
	const audio = getSetting<AudioSettings>('audio', DEFAULT_AUDIO);

	return {
		audio,
		score: { id: row.id, title: row.title, doc: row.doc },
		revisions: listRevisions(params.id, user.id, 40).map((r) => ({
			...r,
			createdAt: r.createdAt.getTime()
		})),
		soundfontUrl: audio.soundfontUrl
	};
};
