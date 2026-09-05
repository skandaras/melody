/**
 * What clicking a note does to the current selection.
 *
 * Small, and the kind of set arithmetic that goes wrong silently rather than
 * loudly: an additive click that replaces instead of adding still looks like a
 * working selection, it just quietly loses the four notes you had picked. It
 * lives here, pure and DOM-free, so it can be tested in Node like the rest of
 * the interesting logic in this codebase.
 */

/**
 * A plain click replaces; a modified click toggles each id in turn.
 *
 * Returns a new set every time. Mutating the one passed in would work by
 * accident under Svelte's proxied state and then fail the moment a caller
 * held the old value to compare against — which is exactly what a component
 * re-render does.
 */
export function toggleSelection(
	current: Set<string>,
	ids: string[],
	additive: boolean
): Set<string> {
	if (!additive) return new Set(ids);

	const next = new Set(current);
	for (const id of ids) {
		if (next.has(id)) next.delete(id);
		else next.add(id);
	}
	return next;
}
