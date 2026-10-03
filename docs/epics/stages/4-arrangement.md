# Stage 4 — Arrangement

Part of the [staged composition epic](../staged-composition.md).

## Purpose

Spread the melody across the ensemble the plan named: who has the tune, who
supports, who rests.

## What the user sees

- **The full score**, with the melody part visually distinguished from the parts
  being added.
- **Per-part accept and reject.** An arrangement that gets the strings right and
  the bass wrong should not be all-or-nothing.
- **Audition** — mute and solo per part, via the existing `Mixer.svelte` and
  `PlayerStore`. Solo is deliberately session-only and never document state
  (`player.svelte.ts:31-36`); keep it that way.
- **Ten controls:**

  | Category | Controls | Tier |
  |---|---|---|
  | Orchestration | `Orchestrate as…` | agent |
  | Form | `Add section` | agent |
  | Colour & mood | `Enrich harmony`, `Simplify harmony`, `Reharmonise`, `Modal interchange`, `Add counter-melody` | prompt |
  | Style & genre | `Add genre influence` | prompt |
  | Energy | `Increase energy`, `Reduce energy` | prompt |

## Machinery it uses

- `orchestrate` (CORE_TASK) — the one compose-adjacent task that *is* already
  wired, at `src/lib/server/controls/run.ts:89`, for agent-tier controls. Its
  prompt (`prompts.ts:79`) is good and needs no change: "Read the score before
  writing. Decide the instrumentation, then write one part at a time, checking
  each stays in range."
- Style skills — `src/lib/server/ai/skills.ts` appends style markdown fenced in
  `<style_reference name="…">`, but only for controls with a `style`, `genre`,
  `influence` or `ensemble` parameter. `Add genre influence` and
  `Orchestrate as…` both qualify.
- `Mixer.svelte`, `PlayerStore`, `add_part`, `set_instrument`.

## What "continue" commits

The accompaniment parts. Approving moves to Refinement.

## Gotchas

- **The ensemble was already decided in the Plan.** This stage realizes it; it
  should not silently invent new instruments. *Enforced:* each part's run is
  held to that part by `onlyPart` (`src/lib/pipeline/arrange.ts`), which
  refuses `add_part` and tells the model to say it wants another instrument
  instead.
- **`add_part` wraps channels past 16** (`ops/parts.ts:38-43`), skipping 9 for
  drums. With the plan capped at 15 non-drum parts this is safe, and arranging
  can no longer add parts. `Orchestrate as…` run from this stage's rack is not
  held to one part and still can.
- **Instrument ranges.** *Checked:* they were enforced nowhere, and the
  `Orchestrate as…` prompt named a `check_playability` tool that did not exist.
  It does now, as a read tool over a practical-range table
  (`src/lib/score/ranges.ts`). It reports and never refuses; a range is a
  convention.
- **Per-part accept/reject vs. one revision per turn.** *Resolved* with one run
  per part, not by splitting a diff. A run writes parts in plan order, one loop
  each, into one accepted commit, and each loop may touch only its own part, so
  **Clear** on a part is a clean per-part reject and **Rewrite** a clean redo. A
  rewrite clears the part server-side first and keeps the clear only if
  something replaced it.

## Decisions

- **`Add section` stays here.** Accepting its staged result through this
  stage's `accept` action runs `syncPlanSections`, which gives the plan a card
  for any section it does not know about, so the two do not drift.
- **The melody is locked, server-side.** `melodyLock` refuses any op that
  removes or changes a note of the approved melody. It applies to arrangement
  runs (through `onlyPart`) and to every control run while the score is at
  this stage, the free code tier included. New notes in the melody part are
  allowed, so a new section can have a tune. Bench remains the place to edit
  the melody itself.
- **A staged control result blocks other writes** on this page and the
  melody page. Rejecting restores the revision before the staged one, so
  anything committed on top of it would be lost.
