import { error } from '@sveltejs/kit';
import { requireUser } from '$lib/server/api';
import { loadScore } from '$lib/server/scores';
import { hasProvider } from '$lib/server/ai/provider';
import { listControls } from '$lib/server/controls/registry';
import { melodyPartOf } from '$lib/pipeline/realize';
import { DEFAULT_AUDIO, getSetting, type AudioSettings } from '$lib/server/settings';
import type { PageServerLoad } from './$types';

/**
 * The arrangement stage.
 *
 * Notation, a transport and a mixer, so this keeps the editor's flush
 * full-height layout rather than the prose shape the brief and plan use.
 */
export const load: PageServerLoad = ({ locals, params }) => {
	const user = requireUser(locals);
	const row = loadScore(params.id, user.id);

	// Arranging reads the plan for the ensemble and for the form the parts
	// serve. Arriving without one means the stage was reached sideways, and
	// there is nothing honest to show.
	if (!row.pipeline.plan) error(400, 'This score has no approved plan yet.');

	const audio = getSetting<AudioSettings>('audio', DEFAULT_AUDIO);

	return {
		flush: true,
		score: { id: row.id, title: row.title, doc: row.doc },
		pipeline: row.pipeline,
		melodyPartId: melodyPartOf(row.doc, row.pipeline.plan, row.pipeline.brief),
		// Ten of the twenty-nine. The rack is not reduced, it is scoped — see
		// $lib/server/controls/registry.ts.
		controls: listControls('arrangement'),
		canGenerate: hasProvider(),
		audio,
		soundfontUrl: audio.soundfontUrl
	};
};
