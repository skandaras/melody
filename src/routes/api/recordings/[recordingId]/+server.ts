import { error } from '@sveltejs/kit';
import { requireUser } from '$lib/server/api';
import { loadRecording } from '$lib/server/recordings';
import type { RequestHandler } from './$types';

/** Stream a stored recording back — same ownership rule as every score route. */
export const GET: RequestHandler = async ({ locals, params }) => {
	const user = requireUser(locals);
	const found = await loadRecording(params.recordingId, user.id);
	if (!found) error(404, 'Recording not found');

	return new Response(new Uint8Array(found.bytes), {
		headers: {
			'content-type': found.row.mime,
			'content-length': String(found.bytes.byteLength),
			'content-disposition': `inline; filename="${encodeURIComponent(found.row.name)}"`,
			'cache-control': 'private, max-age=3600'
		}
	});
};
