import { env } from '$env/dynamic/private';
import { DEFAULT_THEME, normalizeTheme } from '$lib/theme';
import { getSetting } from '$lib/server/settings';
import type { LayoutServerLoad } from './$types';

/**
 * The only place identity and theme reach the client.
 *
 * SSR stays on for the layout, unlike galaxy: the theme tokens have to be in
 * the initial HTML or a light theme flashes dark on every navigation. That
 * matters here because Melody ships light presets people will actually use.
 */
export const load: LayoutServerLoad = ({ locals }) => {
	return {
		user: locals.user,
		env: env.MELODY_ENV || 'dev',
		theme: locals.user
			? normalizeTheme(getSetting('theme', DEFAULT_THEME, locals.user.id))
			: DEFAULT_THEME
	};
};
