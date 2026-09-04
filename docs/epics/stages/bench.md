# Bench — the manual editor

Part of the [staged composition epic](../staged-composition.md).

Named Bench rather than Studio because `Studio` is already a theme preset
(`src/lib/theme.ts:72`), and two things with one name is one thing too many.

## Purpose

Fix one note by hand. Nothing else.

Bench is what the current editor becomes once every AI affordance is removed
from it: **no Ask box, no control rack, no diff review.** To re-prompt, you
leave and re-enter a stage — which is why Refinement is the designated re-entry
point.

The reasoning is the whole premise of the epic. The current editor fails not
because any one tool is bad but because everything is present at once. A manual
editor with five tools that work perfectly is more useful than one with thirty
that mostly do. Removing the AI from it is what makes the remaining controls
small enough to be worth getting right.

## Enterable from

Melody onward. There is nothing to edit by hand before there are notes.
Returns to whichever stage you came from.

## What the user sees

A score, a transport, and a small toolbar.

- **Select** — click a note; shift-click to add; rubber-band a region.
- **Add** — pick a duration, click the stave, with a ghost notehead showing
  exactly where it will land.
- **Drag** — a note up and down for pitch, left and right in time. This does not
  exist today and is the single most-requested thing in the feedback.
- **Delete**, and **arrow keys** to transpose (shift for octaves).
- **A playhead** that shows what is sounding, which also does not exist today.
- Zoom, which must keep working at every scale — see F3.

## Machinery it uses

- `ScoreCanvas.svelte`, `src/lib/render/{render,locate,layout}.ts` — extended,
  not replaced.
- The new `src/lib/render/viewport.ts` and `secondsToTick` from F3.
- `Transport.svelte`, `PlayerStore`.
- Existing ops only: `transpose`, `shift_time`, `insert_notes`, `delete_notes`.

## Note dragging

Drag composes operations that already exist — `pointToPosition`
(`src/lib/render/locate.ts`) already returns `{ partId, tick, midi, step }` for
any point and already honours the key signature — but every one of these edges
is real:

- **`shift_time` clamps per note.** `time-ops.ts:180` does
  `Math.max(0, note.tick + deltaTicks)`, so dragging a multi-note selection left
  past tick 0 collapses notes onto 0 and destroys their relative spacing. Clamp
  the delta at the call site: `delta = Math.max(delta, -minSelectedTick)`.
- **`transpose` respells everything.** `pitch-ops.ts:43` overwrites `p.spell`
  via `spellMidi` for every pitch, discarding deliberate enharmonics, and moves
  **all** pitches of a chord. There is no way to drag one notehead of a chord.
  Accept "drag moves the whole event" and say so in the UI, or add an op.
- **Prefer `scaleSteps` over `semitones`.** `pointToPosition` returns `step`
  alongside `midi`, and `stepToMidi` already applies the key signature
  (`locate.ts:73-76`). Emit `transpose { scaleSteps }` so a drag stays in key;
  fall back to `semitones` when the source note is chromatic against
  `keySigAt(score, tick)` or a modifier is held.
- **Cross-staff drag has no op.** `pointToPosition` returns `partId` so you can
  *detect* it, but nothing in the registry moves a note between parts.
  `delete_notes` + `insert_notes` loses the id, the diff continuity, and
  `slur`/`tuplet`/`Pitch.tie`. Either forbid cross-staff drag in v1 or add
  `move_notes { noteIds, partId, voiceId? }` — a small op, and the
  registry-extension answer rather than a parallel mutation path.
- **Resize has no op either.** `set_duration_ratio` is a *ratio* and changes
  sounding length, not notated rhythm (`ops/attributes.ts:119-141`). A visible
  resize handle needs `set_duration { noteIds, dur }`.
- **Rests never move.** `resolveSelection` filters to notes (`query.ts:65`), so
  `shift_time` skips rests entirely. Dragging a note past a rest leaves the rest
  in place and produces an overlap. `render.ts:267-272` runs voices non-strict
  so nothing throws — the bar just renders wrong.

### The performance trap

**`draw()` does a full `container.replaceChildren()` plus `layoutScore` plus a
VexFlow re-render** (`ScoreCanvas.svelte:58-75`, `render.ts:194-196`). A drag
preview that goes through `score` mutation therefore relayouts the entire piece
on every `pointermove`.

**The drag ghost must be an SVG or DOM overlay on top of the existing render,
and the ops must fire once on `pointerup`.** This is the single biggest risk in
the feature.

## Gotchas

- **Keyboard handling.** `onkeydown` is on `<svelte:window>`
  (`+page.svelte:311`) and guards only `tagName === 'INPUT' || 'TEXTAREA'`. A
  `<select>` or a contenteditable is not covered. If the handler moves to a
  shared layout it will also fire over the Brief page's text fields.
- **Revision pruning.** One revision per drag, at 100 revisions per score, eats
  undo history fast — and each carries a full gzipped document. Consider
  coalescing consecutive drags of the same selection.
- **`pendingDiff` is a single slot** shared by AI, controls and transcription.
  Bench does not review diffs, so it should not touch it at all.

## Open questions

- Does Bench need its own undo, or is the global revision history enough? A drag
  that costs a revision feels heavy; a drag that cannot be undone feels worse.
- Should `move_notes` and `set_duration` be built now, or should v1 simply
  forbid cross-staff drag and resize? Leaning: forbid in v1, add the ops when
  the interaction has proven itself.
