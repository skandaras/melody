import { requireUser } from '$lib/server/api';
import { loadScore } from '$lib/server/scores';
import { hasProvider } from '$lib/server/ai/provider';
import { listControls } from '$lib/server/controls/registry';
import { DEFAULT_AUDIO, getSetting, type AudioSettings } from '$lib/server/settings';
import type { PageServerLoad } from './$types';

/**
 * The refinement stage.
 *
 * Notation, a transport and a rack, so it keeps the editor's flush full-height
 * layout rather than the prose shape the brief and plan use.
 *
 * **No plan guard**, unlike melody and arrangement. Those two error without a
 * plan because they read it — for section spans and for the ensemble. This stage
 * reads nothing from it: expression applies to whatever notes are there. A score
 * that arrived here from Bench, or an older one someone advanced by hand, has
 * music to refine either way, and a guard with no data behind it would only
 * block work it does not need.
 */
export const load: PageServerLoad = ({ locals, params }) => {
	const user = requireUser(locals);
	const row = loadScore(params.id, user.id);
	const audio = getSetting<AudioSettings>('audio', DEFAULT_AUDIO);

	return {
		flush: true,
		score: { id: row.id, title: row.title, doc: row.doc },
		pipeline: row.pipeline,
		// Nine of the twenty-nine: seven of this stage's own, plus Humanise and
		// Swing reprised from Melody. Which nine is a fact about the rows, not
		// about this page — see $lib/server/controls/registry.ts.
		controls: listControls('refine'),
		canGenerate: hasProvider(),
		audio,
		soundfontUrl: audio.soundfontUrl
	};
};
