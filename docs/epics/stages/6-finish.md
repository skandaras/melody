# Stage 6 — Finish

Part of the [staged composition epic](../staged-composition.md).

## Purpose

Name it, understand it, take it away.

## What the user sees

- **The finished score**, full width, playhead working, fog gone.
- **Title suggestions** from the `title` task, plus a free text field. The
  prompt is already written and already opinionated: "Name the music, not the
  request: prefer 'Slow Light in November' over 'Piano Piece in A Minor' and
  never start with 'A Song About'."
- **What this piece actually does** — the free `analyse()` facts always, and an
  optional prose explanation from the `analyse` task. Its prompt is worth
  honouring: "Be concrete and brief. Point at bar numbers. If something is
  unusual or not working, say so and say why. Do not pad with praise."
- **Export** — PDF, MusicXML, MIDI, WAV, via the existing `ExportMenu.svelte`,
  reused unchanged.
- **Go back and change something** — returns to Refinement.

## Machinery it uses

- `title` (CORE_TASK) — prompt at `prompts.ts:93`, never called. Seeded for
  speed rather than depth, which is exactly right for a one-line answer.
- `analyse` (CORE_TASK) — prompt at `prompts.ts:87`, never called.
- `analyse()` / `summarise()` (`src/lib/score/analyse.ts`) — pure, free.
- `ExportMenu.svelte`, `src/lib/export/{pdf,musicxml,midi}.ts`, and the offline
  WAV render in `src/lib/audio/synth.ts`.
- `set_title` for committing the chosen name.

## What "continue" commits

The title. Export is a read, not a commit — nothing about exporting should
change the document.

## Gotchas

- **PDF export draws from the same SVG the canvas renders**
  (`src/lib/export/pdf.ts` via `svg2pdf`). This is why the atmosphere layer must
  never overlay the notation: fog behind the score would end up in exported
  files. See [visual-language.md](../visual-language.md).
- **`title` is the cheapest task in the app** and should be configured that way.
  `TASK_BLURBS` already says so: "Names a piece. Wants speed, not depth." If an
  operator has left every task on one global model, this is the clearest place
  the per-task configuration pays for itself.
- **Exports are generated server-side into `DATA_DIR/exports/`** and are subject
  to retention. A finished piece the person expects to keep is not the same as a
  cached export; do not conflate them.

## Open questions

- Does finishing mean anything in the data model — a `completed` flag, a
  read-only state — or is Finish just the last stage you can leave and re-enter
  freely? Leaning: no flag. Music is never finished, and a lock would be
  friction with no payoff.
- Should the analysis text be stored with the score, so it is there next time
  without paying for it again?
