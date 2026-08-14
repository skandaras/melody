/**
 * Where to put prompt-cache breakpoints.
 *
 * Caching behaviour differs by model family and OpenRouter does not paper over
 * it: most providers cache automatically, but Anthropic and Qwen only cache
 * spans you explicitly mark with a `cache_control` breakpoint. Marking is
 * harmless on the providers that ignore it, so the rule is simply "mark when
 * the family needs it".
 *
 * What gets marked matters more than the mechanism. Caching is a prefix match,
 * so the breakpoint goes at the end of the *stable* part of the prompt — the
 * system prompt and style skills, which are identical from turn to turn. The
 * score fragment goes after it, because it changes on every edit and would
 * invalidate everything behind it.
 */

/** Model-slug prefixes whose providers need explicit breakpoints. */
const NEEDS_EXPLICIT_BREAKPOINTS = ['anthropic/', 'qwen/'];

export function needsCacheBreakpoints(modelSlug: string): boolean {
	const slug = modelSlug.toLowerCase();
	return NEEDS_EXPLICIT_BREAKPOINTS.some((prefix) => slug.startsWith(prefix));
}

/**
 * OpenRouter takes `cache_control` on a content *part*, not on the message, so
 * a marked message has to carry its text as a one-element array rather than a
 * bare string.
 */
export function withCacheControl(text: string): Array<Record<string, unknown>> {
	return [{ type: 'text', text, cache_control: { type: 'ephemeral' } }];
}

/**
 * Caching only pays for itself above a certain prefix size — the exact
 * threshold varies by provider, but every one of them silently declines to
 * cache a short prefix. Marking one anyway costs a write premium for a read
 * that never comes, so don't bother below roughly 1k tokens.
 *
 * Estimated from characters rather than tokenised: this only has to be right
 * to within a factor of two, and a real tokeniser here would mean shipping one
 * per model family.
 */
export function worthCaching(text: string): boolean {
	return text.length >= 4000;
}
