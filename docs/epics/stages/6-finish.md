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
- ~~**Exports are generated server-side into `DATA_DIR/exports/`** and are
  subject to retention.~~ **Wrong on both counts, and checked.** Every exporter
  in `$lib/export` runs in the browser against the document the page already
  holds, there is no export route, nothing has ever written to that directory,
  and `RetentionSettings` has no field for it. `DATA_DIR/exports/` was a
  directory created at boot for a feature that was never built — a third piece of
  latent intent alongside `check_playability` and the two dead tasks — so
  `ensureDataDirs` no longer makes it. Export stays a read: nothing about
  exporting touches the document.

## Open questions

- Does finishing mean anything in the data model — a `completed` flag, a
  read-only state — or is Finish just the last stage you can leave and re-enter
  freely? Leaning: no flag. Music is never finished, and a lock would be
  friction with no payoff.
  **Taken: no flag.** There is no `approve` on this stage and nothing to set —
  `nextStage('finish')` is null. Finish is the last stage you can leave and
  re-enter like any other.
- Should the analysis text be stored with the score, so it is there next time
  without paying for it again?
  **Yes, with the digest it was written from.** Prose about a piece stops being
  true the moment the piece changes, so storing the text alone would be keeping a
  claim that silently rots — the failure this epic exists to remove. `basis` is
  the exact input the model saw; regenerating it and comparing is exact rather
  than approximate, and a stored analysis whose basis no longer matches says so
  instead of presenting an old reading as a current one. It lives on the `plan`
  JSON column, which costs no migration. The price, worth naming: `PipelineState`
  is snapshotted into every revision, so the text is copied beside each one.
  Refinement deliberately does *not* keep its analysis — it is the stage most
  likely to invalidate one within a few clicks.
