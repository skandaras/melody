import { error } from '@sveltejs/kit';
import { requireUser } from '$lib/server/api';
import { loadScore } from '$lib/server/scores';
import { hasProvider } from '$lib/server/ai/provider';
import type { PageServerLoad } from './$types';

/**
 * The plan stage.
 *
 * Prose-shaped like the brief, so it opts out of the editor's flush full-height
 * layout — see `flush`, read by the root layout.
 */
export const load: PageServerLoad = ({ locals, params }) => {
	const user = requireUser(locals);
	const row = loadScore(params.id, user.id);

	// Planning reads the brief. Arriving here without one means the stage was
	// reached sideways — a typed URL, or a stale tab — and there is nothing
	// honest to show.
	if (!row.pipeline.brief) error(400, 'This score has no brief yet.');

	return {
		flush: false,
		score: { id: row.id, title: row.title },
		pipeline: row.pipeline,
		/** Whether the parts the plan may claim still exist, for the ensemble rows. */
		parts: row.doc.parts.map((p) => ({ id: p.id, name: p.name })),
		/** Generating needs a model; editing and approving do not. */
		canGenerate: hasProvider()
	};
};
