import { requireUser } from '$lib/server/api';
import { loadScore } from '$lib/server/scores';
import { listAdminSkills } from '$lib/server/ai/skills-admin';
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

/**
 * The brief stage.
 *
 * Prose-shaped rather than tool-shaped, so it opts out of the flush full-height
 * layout the editor uses — see `flush` below, read by the root layout.
 */
export const load: PageServerLoad = ({ locals, params }) => {
	const user = requireUser(locals);
	const row = loadScore(params.id, user.id);
	const audio = getSetting<AudioSettings>('audio', DEFAULT_AUDIO);
	const retention = getSetting<RetentionSettings>('retention', DEFAULT_RETENTION);

	return {
		flush: false,
		score: { id: row.id, title: row.title, doc: row.doc },
		pipeline: row.pipeline,
		transcribe: getSetting<TranscribeSettings>('transcribe', DEFAULT_TRANSCRIBE),
		countInBars: audio.countInBars,
		recordingUrl: retention.keepRecordings ? `/api/scores/${params.id}/recordings` : undefined,
		/** Offered as reference styles. Only the enabled ones are usable. */
		styles: listAdminSkills()
			.filter((s) => s.enabled)
			.map((s) => s.name)
	};
};
