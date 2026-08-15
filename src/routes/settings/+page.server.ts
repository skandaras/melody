import { requireUser } from '$lib/server/api';
import { getUserTheme } from '$lib/server/settings';
import { DEFAULT_THEME } from '$lib/theme';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = ({ locals }) => {
	const user = requireUser(locals);
	return { theme: getUserTheme(user.id, DEFAULT_THEME) };
};
