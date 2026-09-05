import { redirect } from '@sveltejs/kit';
import { requireUser } from '$lib/server/api';
import { stageRoute } from '$lib/pipeline/types';
import { listRevisions, loadScore } from '$lib/server/scores';
import { listControls } from '$lib/server/controls/registry';
import {
	DEFAULT_AUDIO,
	DEFAULT_RETENTION,
	DEFAULT_TRANSCRIBE,
	getSetting,
	type AudioSettings,
	type RetentionSettings,
	type TranscribeSettings
} from '$lib/server/settings';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = ({ locals, params }) => {
	const user = requireUser(locals);
	const row = loadScore(params.id, user.id);

	// A score that belongs to a stage with its own page is sent there. The table
	// lives in $lib/pipeline so the rule that keeps legacy scores out of it is
	// testable rather than merely commented.
	const segment = stageRoute(row.pipeline.stage);
	if (segment) redirect(307, `/score/${params.id}/${segment}`);
	const audio = getSetting<AudioSettings>('audio', DEFAULT_AUDIO);
	const retention = getSetting<RetentionSettings>('retention', DEFAULT_RETENTION);
	return {
		audio,
		transcribe: getSetting<TranscribeSettings>('transcribe', DEFAULT_TRANSCRIBE),
		/** Supplied only when retention keeps audio — the client uploads
		 *  exclusively through it, so off means no take is ever stored. */
		recordingUrl: retention.keepRecordings ? `/api/scores/${params.id}/recordings` : undefined,
		score: { id: row.id, title: row.title, doc: row.doc },
		revisions: listRevisions(params.id, user.id, 40).map((r) => ({
			...r,
			createdAt: r.createdAt.getTime()
		})),
		controls: listControls(),
		soundfontUrl: audio.soundfontUrl
	};
};
