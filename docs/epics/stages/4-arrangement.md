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
  **Resolved:** chunks come from `plan.ensemble`, and `addedParts()` compares
  the part list either side of each call so an invented instrument is kept but
  reported. Not prevented: withholding `add_part` from the tool list is ruled
  out by `tools.ts`, which keeps the list identical for every task so the cached
  prefix survives.
- **`add_part` wraps channels past 16** (`ops/parts.ts:38-43`), skipping 9 for
  drums. With the plan capped at 15 non-drum parts this is safe, but an
  `Add section` or `Orchestrate as…` that adds parts here can still exceed it.
- **Instrument ranges.** **Checked, and the answer was no.** Nothing enforced
  them anywhere: `INSTRUMENT_RANGES` was used by no caller despite its own
  comment claiming otherwise, and `check_playability` — which the
  `Orchestrate as…` prompt has instructed the model to call, as step 5 of 5,
  since it was written — did not exist. `$lib/score/playability.ts` is that
  check, wired as a read tool and warned on after each part.
- **Per-part accept/reject vs. one revision per turn.** **Resolved by the
  chunking axis.** The part is the unit of a call, so it is also the unit of
  review: a run still lands as one accepted revision, and rejecting one part
  deletes its notes as its own revision. No diff splitting and no second
  pending slot.

## Open questions

- Does `Add section` belong here or in Plan? It changes form, which the Plan
  stage owns — but wanting a bridge usually only becomes obvious once you can
  hear the thing. Leaning: keep it here, and have it write back into the stored
  plan so the two do not drift.
  **Still open.** It is offered here, and the write-back is *not* built: a
  section added from this page is invisible to `plan.sections`, so the melody
  stage will not realize it. `controls/run.ts` is stage-agnostic and has no
  notion of a plan, so the sync needs a seam that does not exist yet.
- Should the melody part be locked against edits at this stage, so arranging
  cannot quietly rewrite the tune that was already approved?
  **Answered: not locked, but never targeted and always checked.** No run is
  given the melody as a chunk, every prompt names the one part it may write to,
  and `melodyChanged()` compares the tune either side of each call and warns if
  it moved. Controls on the page are scoped to the accompaniment for the same
  reason — and withheld entirely on a solo piece, because an empty `partIds`
  resolves to the whole score rather than to nothing.
