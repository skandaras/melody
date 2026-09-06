# Stage 3 — Melody

Part of the [staged composition epic](../staged-composition.md).

## Purpose

Write the core tune over the approved plan — one melodic line, nothing else —
and let the person shape it with feedback and a small set of controls until it
is right.

This is the stage people will spend the most time in, which is why almost all of
its controls are free and instant.

## What the user sees

Notation, a play button, and a short list of things to try.

- **The score so far**, section by section, realized in order. Each section
  shows its state: written, being written, or queued.
- **Per-section progress that is real.** Because realization is chunked by
  section, the run declares its phases up front and the progress bar has an
  honest denominator: `Verse 8 bars ✓ · Chorus 8 bars ⟳ · Bridge …`. This is the
  direct answer to "no progress of what it's doing".
- **A feedback box** — "lift the chorus", "make the verse less busy" — scoped to
  the selected section, never the whole piece.
- **Regenerate one section**, keeping the others. Variants are revisions, so
  comparing and reverting is the existing history mechanism, not a new one.
- **Eleven controls**, nine of them free:

  | Category | Controls | Tier |
  |---|---|---|
  | Pitch | `Transpose`, `Fit to key` | code — free |
  | Rhythm | `Quantise`, `Swing`, `Humanise`, `Half-time`, `Double-time` | code — free |
  | Development | `Invert`, `Retrograde` | code — free |
  | Form | `Extend`, `Develop` | agent — costs calls |

- **Open in Bench** appears from here onward, for manual note surgery.

## Machinery it uses

- `compose_realize` (CORE_TASK) — prompt at
  `src/lib/server/ai/prompts.ts:46`, never called. It already assumes this
  design: "You are given the plan, the music written so far, and which section
  to write now. Write only that section."
- `AiSettings.realizeChunkBars` (default 8, `settings.ts:59`) — also dead today.
- `runAgentLoop` per chunk, `applyOps` between chunks, one `commitOps` at the
  end.
- `renderNotes` and `describeScore` from `src/lib/server/ai/context.ts`.

## Chunking

**The unit is the plan section, not `realizeChunkBars`.** The prompt says write
only that section, so a chunk that straddles a boundary defeats its own
instruction. Iterate sections; split any section longer than the chunk size into
`ceil(bars / chunkBars)` sub-chunks; **never merge two sections into one chunk.**

Per-chunk context, in this order:

1. `describeScore(working)` — parts, sections, ticks per bar
   (`context.ts:54-81`).
2. This section's plan entry verbatim — bars, harmony, role, which parts play.
3. `renderNotes(working, { startTick: chunkStart - lookback, endTick:
   chunkStart })` — one or two bars of tail. This is what makes "match the
   register, texture and rhythmic feel of the preceding bars"
   (`prompts.ts:53`) actionable rather than aspirational.
4. The **next** section's role, one line, so the chunk can aim at it.
5. `analysisReport(working, …)` for the section just written, if there is one.
6. The exact tick window and the exact `partId`s it may write to.
7. **The motif, forwarded** — `renderNotes(score, { partIds: [brief.seedPartId]
   })`. Small, and much cheaper than hoping the model still remembers the theme
   by chunk five.

## What "continue" commits

The melody part, as per-section revisions. Approving moves to Arrangement.

## Gotchas

- **`checkBudget()` runs once per run** (`run.ts:43`), so a chunked realization
  is N model calls behind one check and overshoots the cap by N−1 chunks.
  **Check per chunk.**
- **`maxOpsPerTurn` (400) is per loop**, so a six-chunk realization can emit
  2400 ops into a single unreviewable revision. Guard the accumulated total.
- **One working score across chunks.** The loop advances `working` per op
  (`loop.ts:89,154`) but only *within* one loop, so the orchestrator must
  `applyOps` chunk N's ops before building chunk N+1's context. Emit the
  intermediate `doc` on the `phase` event so the canvas shows progress without
  creating a revision per chunk — per-chunk commits would fight the single
  `pendingDiff` slot.
- **Keep the tool list byte-identical across chunks.** `tools.ts:163-181` warns
  that tools are sorted and identical for every task specifically to preserve
  the cached prefix. Pick one tool set for the whole realization; do not
  alternate between `agentTools()` and `opTools()`.
- **Bars → ticks** via `measureTicks(ppq, timeSigAt(score, t))` walked forward,
  never `bars * 1920`.
- **Selection must be explicit.** `resolveSelection(score, {})` returns
  *everything* (`query.ts:29,62-73`), so a control fired with the default
  selection edits the whole piece. Every control on this page passes a
  section-scoped selection.

## Open questions

- If a chunk fails halfway through a six-section realization, do we keep the
  sections already written and offer to resume, or roll back the whole run?
  Leaning: keep and resume — that is why sections are the unit.
- Should `Extend` and `Develop` (agent-tier, so they cost calls) be visually
  separated from the nine free controls, so the free/paid boundary is legible?
