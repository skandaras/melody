import { error } from '@sveltejs/kit';
import { requireUser } from '$lib/server/api';
import { loadScore, stagedRevision } from '$lib/server/scores';
import { listControls } from '$lib/server/controls/registry';
import { hasProvider } from '$lib/server/ai/provider';
import { melodyPartOf } from '$lib/pipeline/realize';
import {
	DEFAULT_AUDIO,
	getSetting,
	type AudioSettings
} from '$lib/server/settings';
import type { PageServerLoad } from './$types';

/**
 * The melody stage.
 *
 * Notation and a transport, so this one keeps the editor's flush full-height
 * layout rather than the prose shape the brief and plan use.
 */
export const load: PageServerLoad = ({ locals, params }) => {
	const user = requireUser(locals);
	const row = loadScore(params.id, user.id);

	// Realization reads the plan for harmony and role, and the committed
	// sections for the tick spans. Arriving without one means the stage was
	// reached sideways, and there is nothing honest to show.
	if (!row.pipeline.plan) error(400, 'This score has no approved plan yet.');

	const audio = getSetting<AudioSettings>('audio', DEFAULT_AUDIO);

	return {
		flush: true,
		score: { id: row.id, title: row.title, doc: row.doc },
		pipeline: row.pipeline,
		melodyPartId: melodyPartOf(row.doc, row.pipeline.plan, row.pipeline.brief),
		canGenerate: hasProvider(),
		controls: listControls('melody'),
		// A control's staged result survives a reload, so the review has to too.
		pending: stagedRevision(row.id, user.id),
		audio,
		soundfontUrl: audio.soundfontUrl
	};
};
