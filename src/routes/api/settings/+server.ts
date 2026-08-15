import { json } from '@sveltejs/kit';
import { readJson, requireUser } from '$lib/server/api';
import { getUserTheme, setSetting } from '$lib/server/settings';
import { DEFAULT_THEME, normalizeTheme } from '$lib/theme';
import type { RequestHandler } from './$types';

/**
 * Per-user preferences.
 *
 * The theme is normalised before it is stored, not on the way out: these
 * values are interpolated straight into a <style> block, so a colour like
 * `red; } body { display:none` would otherwise let one saved preference
 * rewrite the whole page. normalizeTheme is the gate, and it runs here so a
 * bad value can never reach the database in the first place.
 */
export const POST: RequestHandler = async ({ locals, request }) => {
	const user = requireUser(locals);
	const body = await readJson<{ theme?: unknown }>(request);

	if (body.theme !== undefined) {
		setSetting('theme', normalizeTheme(body.theme), user.id);
	}
	return json({ theme: getUserTheme(user.id, DEFAULT_THEME) });
};
