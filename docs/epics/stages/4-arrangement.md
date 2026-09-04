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
  should not silently invent new instruments. If `Orchestrate as…` wants a part
  the plan did not name, that is a plan change and should say so.
- **`add_part` wraps channels past 16** (`ops/parts.ts:38-43`), skipping 9 for
  drums. With the plan capped at 15 non-drum parts this is safe, but an
  `Add section` or `Orchestrate as…` that adds parts here can still exceed it.
- **Instrument ranges.** The prompt asks the model to check each part stays in
  range, and `list_instruments` (`tools.ts:191-248`) is available as a read
  tool. Whether ranges are actually enforced anywhere is worth checking before
  relying on the prompt alone.
- **Per-part accept/reject vs. one revision per turn.** Today an AI turn lands
  as a single revision with a single `pendingDiff`. Per-part granularity either
  needs the diff split by part at review time, or one run per part.

## Open questions

- Does `Add section` belong here or in Plan? It changes form, which the Plan
  stage owns — but wanting a bridge usually only becomes obvious once you can
  hear the thing. Leaning: keep it here, and have it write back into the stored
  plan so the two do not drift.
- Should the melody part be locked against edits at this stage, so arranging
  cannot quietly rewrite the tune that was already approved?
