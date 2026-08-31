import { error, json } from '@sveltejs/kit';
import { requireUser } from '$lib/server/api';
import { saveRecording } from '$lib/server/recordings';
import { loadScore } from '$lib/server/scores';
import type { RequestHandler } from './$types';

/**
 * Store the take behind a transcription.
 *
 * Multipart rather than JSON because audio is bytes, not text. The client
 * uploads after a transcription lands and deletes the row when the user
 * discards it; keepRecordings=false makes the upload a courtesy copy that the
 * retention sweep removes after a day, so nothing piles up unnoticed.
 */
export const POST: RequestHandler = async ({ locals, params, request }) => {
	const user = requireUser(locals);
	loadScore(params.id, user.id); // 404 when the score is not theirs.

	const form = await request.formData().catch(() => null);
	const file = form?.get('file');
	if (!(file instanceof File) || file.size === 0) {
		error(400, 'No audio file supplied');
	}

	const durationRaw = form?.get('durationMs');
	const durationMs =
		typeof durationRaw === 'string' && Number.isFinite(Number(durationRaw))
			? Math.max(0, Math.round(Number(durationRaw)))
			: null;

	try {
		const saved = await saveRecording({
			userId: user.id,
			scoreId: params.id,
			file,
			durationMs
		});
		return json(saved, { status: 201 });
	} catch (e) {
		error(400, e instanceof Error ? e.message : 'Upload failed');
	}
};
