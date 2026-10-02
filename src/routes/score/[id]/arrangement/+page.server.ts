import { error } from '@sveltejs/kit';
import { requireUser } from '$lib/server/api';
import { loadScore, stagedRevision } from '$lib/server/scores';
import { hasProvider } from '$lib/server/ai/provider';
import { listControls } from '$lib/server/controls/registry';
import { melodyPartOf } from '$lib/pipeline/realize';
import { DEFAULT_AUDIO, getSetting, type AudioSettings } from '$lib/server/settings';
import type { PageServerLoad } from './$types';

/**
 * The arrangement stage.
 *
 * Full height like the melody stage: the whole point is the full score, heard
 * part by part.
 */
export const load: PageServerLoad = ({ locals, params }) => {
	const user = requireUser(locals);
	const row = loadScore(params.id, user.id);

	// The ensemble comes from the plan, so without one there is nothing to
	// arrange for and no honest page to show.
	if (!row.pipeline.plan) error(400, 'This score has no approved plan yet.');

	const audio = getSetting<AudioSettings>('audio', DEFAULT_AUDIO);

	return {
		flush: true,
		score: { id: row.id, title: row.title, doc: row.doc },
		pipeline: row.pipeline,
		melodyPartId: melodyPartOf(row.doc, row.pipeline.plan, row.pipeline.brief),
		canGenerate: hasProvider(),
		controls: listControls('arrangement'),
		pending: stagedRevision(row.id, user.id),
		audio,
		soundfontUrl: audio.soundfontUrl
	};
};
