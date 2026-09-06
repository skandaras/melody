# Stage 5 — Refinement

Part of the [staged composition epic](../staged-composition.md).

## Purpose

Tone and feel. Dynamics, colour, tension, humanity — expression rather than
structure. Nothing here should change what the piece *is*, only how it sounds.

This is also the **re-entry point**. Coming back from Bench or from Finish to
re-prompt lands here, which is why the manual editor does not need an Ask box of
its own.

## What the user sees

- **The full score**, with a working playhead, so you can hear what a change did
  and see where it happened.
- **Seven controls, plus two reprised from Melody:**

  | Category | Controls | Tier |
  |---|---|---|
  | Dynamics | `Crescendo`, `Diminuendo` | code — free |
  | Colour & mood | `Darken`, `Brighten`, `Warmth`, `Add tension`, `Release` | prompt |
  | Rhythm (reprise) | `Humanise`, `Swing` | code — free |

  `Humanise` and `Swing` appear in both Melody and Refinement deliberately: in
  Melody they are rhythm, here they are feel. The `stages` column is a
  `string[]` precisely so a control can belong to more than one stage.

- **A free read-out** from `analyse()` / `summarise()`
  (`src/lib/score/analyse.ts`) — key, tempo, metre, bars, note count, and
  detected harmony. No model call. The paid `analyse` task sits behind an
  explicit "explain this" button.
- **A feedback box** for anything the controls do not cover, backed by
  `edit_selection`.

Fog is nearly clear.

## Machinery it uses

- `control_prompt` (CORE_TASK) — already wired at
  `src/lib/server/controls/run.ts:89` for prompt-tier controls. Its prompt is
  well-judged and worth preserving: "the amount is a real dial, not a
  suggestion. At low amounts the change should be genuinely subtle; at high
  amounts it should be unmistakable."
- `edit_selection` (CORE_TASK) — currently the Ask box; here it is the feedback
  box, scoped to a selection.
- `analyse` (CORE_TASK) — dead today, wired here and in Finish.
- `set_dynamic`, `set_articulation`, `set_velocity_curve`, `humanise`, `swing`.

## What "continue" commits

Expressive edits. Approving moves to Finish.

## Gotchas

- **Selection defaults to the whole score.** `resolveSelection(score, {})`
  returns everything. A control fired here with no selection would darken the
  entire piece — which is sometimes what you want, so make it *stated* rather
  than defaulted. Show the scope on the button: "Darken · selection" vs.
  "Darken · whole piece".
- **`analyse` and `title` are dead code today.** If Refinement and Finish do not
  actually use them, delete them rather than leaving a second generation of
  latent intent for someone to rediscover.
- **The `code` tier has no job**, so free controls return synchronously with no
  job id and no SSE (`controls/run.ts:64-87`). F1's run model must represent a
  run born terminal, or this page needs two code paths for what looks to the
  user like one action.
- **Prompt-tier controls are rows in a table**, so an operator can add one
  without a deploy. Anything this page hardcodes about which controls exist
  breaks that.

## Open questions

- Is there a meaningful difference between Refinement and Arrangement for a
  solo-piano piece, where there is nothing to arrange? Possibly the two collapse
  when the ensemble is one part — worth deciding rather than shipping an empty
  stage.
- Should re-entry from Finish land here or offer a choice of stage? Landing here
  is simpler; a choice is more honest about what the person might want to change.
