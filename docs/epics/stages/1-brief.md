# Stage 1 — Brief

Part of the [staged composition epic](../staged-composition.md).

## Purpose

Capture what the person wants before anything is generated. A written
description, a hummed melody, or both.

This replaces "New score creates an empty document and drops you into an
editor". The brief is the only stage with no model call of its own unless audio
is involved, so it is instant and free.

## What the user sees

A single page, prose-shaped rather than tool-shaped. Fog at its densest.

- **A description field.** Free text, generous. "A slow waltz that sounds like
  rain on a window, piano and cello, about two minutes."
- **Optional chips** for the things a description usually leaves ambiguous and
  the plan will otherwise guess at: length, mood, tempo feel, ensemble size,
  and reference style drawn from the six seeded style skills
  (`skills/style/*` — baroque, bossa-nova, cinematic, gospel, lo-fi, synthwave).
  Chips are a shortcut, not a requirement; everything they express can be said
  in the text.
- **Seed with audio** — record from the microphone, or drop a file. The existing
  `AudioInput.svelte` path, unchanged in substance: capture, then pitch
  detection in a Web Worker, then quantisation and bar-splitting into a draft
  score. Free, no API key, no server round-trip for the detection itself.
- If seeded, the detected melody is shown as notation with a play button, and
  the person says what it *is*: **main theme**, **chorus hook**, or **a motif to
  develop**. `compose_plan`'s prompt already requires this — "The seed must have
  a defined role in the plan" — so ask for it here rather than letting the model
  guess.

## Machinery it uses

- `AudioInput.svelte`, `src/lib/audio/capture.ts`,
  `src/lib/audio/transcribe.worker.ts`, `src/lib/audio/transcribe.ts` — reused.
- `transcribe_cleanup` (CORE_TASK) — optional, only when audio-seeded, to tidy
  detection output into readable rhythm. Already wired at
  `src/routes/api/scores/[id]/transcribe/+server.ts:52`.
- `mergeIntoScore` (`src/lib/server/scores.ts`) for the seed, **not**
  `insert_notes` — a transcription carries rests and ties that `insert_notes`
  cannot express.
- The new `brief` JSON column on `scores`.

## What "continue" commits

1. The `Brief` record — description, chips, seed role.
2. If audio-seeded, the seed part, **force-accepted**.

## Gotchas

- **The seed lands staged.** `mergeIntoScore` writes `accepted: false`
  (`scores.ts:266`). If Plan runs against an unaccepted revision, the plan is
  built on a document that may still be rolled back. Force acceptance as part of
  continuing.
- **`adoptGlobals` defaults to `score.parts.length === 0`** (`merge.ts:40`).
  Seeding first works — the seed's detected tempo is adopted and then overridden
  by the plan. Planning first and seeding second **silently discards the seed's
  detected tempo**. Either enforce the order or pass `adoptGlobals` explicitly.
- **`brief.seedPartId` requires F0.** `mergeParts` returns a count, not ids.
  Without `addedPartIds`, Plan and Melody cannot refer to "the theme".
- **Prose-shaped page vs. the editor layout.** `isEditor` in
  `src/routes/+layout.svelte:21` forces `overflow: hidden; height: 100vh` on
  anything under `/score/`. This page needs to scroll. Make flush a per-route
  decision (`page.data.flush`) rather than a path prefix.

## Open questions

- Should a brief be editable after Plan has run, or does changing it mean
  starting a new plan? Leaning: editable, with an explicit "re-plan" that warns
  what it will discard.
- Do we keep the raw recording? `keepRecordings` in admin already governs this;
  the stage should honour it rather than adding a second switch.
