# Epic: the staged composition flow

**Status:** proposed · **Branch:** `claude/music-composition-refactor-qa8anq`

melody becomes a stepped process instead of an open-ended platform. You describe
a song, approve a plan, hear a melody, arrange it, refine its tone, and finish
it — six stages, each with one job and a small number of controls that actually
matter at that moment.

---

## Why

Today "New score" creates an empty document and drops you into a three-column
editor: six left-rail panels, a 29-knob control rack, an Ask box, and a blank
canvas. Everything is available at once and nothing suggests what to do first.
Every capability works in isolation; together they are a workshop with no bench.

The engine underneath is not the problem and does not change:

- `src/lib/score/types.ts` — absolute ticks at PPQ 480, stable note ids, imports
  nothing. Testable as pure functions, and the source every export derives from.
- `src/lib/score/ops/index.ts` — 27 operations that describe themselves in JSON
  Schema. `src/lib/server/ai/tools.ts` derives the model's tool definitions from
  that same schema, so ops and tools cannot drift apart.
- `src/lib/score/apply.ts` — `applyOps()`, the single mutation path, returning a
  diff and never throwing.
- Revisions with gzipped snapshots, VexFlow engraving, SpessaSynth playback, the
  OpenRouter client, and a replayable SSE job buffer.

What changes is the experience layer wrapped around them.

### Three findings that shaped this

**1. The staged flow is already half-built and unreachable.** Four of the eight
`CORE_TASKS` — `compose_plan`, `compose_realize`, `analyse`, `title` — have
written system prompts, per-task model configuration and admin-editable version
history, and are **never invoked from any code path**. `compose_plan`'s seeded
prompt ends:

> Return the plan as prose, not operations. Something else will realise it.

The something else was never written. `AiSettings.realizeChunkBars` (default 8)
exists to chunk that realization and is likewise dead. This epic largely
completes an intent already latent in the codebase rather than inventing one.

**2. Most reported bugs are symptoms of a missing run model.** "No progress, so
a failed run might just never resolve" and "it said it read the score, analysed
the range and then nothing" are the same root cause: a turn has no declared
phases, and a turn that changes nothing is reported as a success.

**3. Two live correctness bugs sit underneath, neither of them reported.**
Cancelling a run still commits its edits, and a job's terminal state has two
competing writers. Both are in the path every stage will depend on, so both are
fixed before any stage is built.

---

## The shape

```
Brief ──▶ Plan ──▶ Melody ──▶ Arrangement ──▶ Refinement ──▶ Finish
             ▲         │            │              │
             └─────────┴────────────┴──────────────┘
                    re-enter any earlier stage

                         Bench (manual editing)
                    enterable from Melody onward
```

Each stage has one job, a small set of controls chosen for that job, and an
explicit **approve and continue** that commits its result. Nothing is committed
silently; every AI turn still lands as a revision you accept or reject.

| # | Stage | AI task | Controls | Approving commits |
|---|---|---|---|---|
| 1 | [Brief](stages/1-brief.md) | `transcribe_cleanup` (only if audio-seeded) | — | A `Brief`; seed part force-accepted |
| 2 | [Plan](stages/2-plan.md) | `compose_plan` (structured) | — | `set_title` → `set_tempo` → `set_time_sig` → `set_key` → `add_part`×n → `set_section`×n |
| 3 | [Melody](stages/3-melody.md) | `compose_realize`, per section | 11 — Pitch, Rhythm, Development, Form | Melody part, per-section revisions |
| 4 | [Arrangement](stages/4-arrangement.md) | `orchestrate` | 10 — Orchestration, Style & genre, Form, Energy, harmony | Accompaniment parts |
| 5 | [Refinement](stages/5-refinement.md) | `control_prompt`, `edit_selection`, `analyse` | 7 + 2 reprised — Dynamics, Colour & mood | Expressive edits |
| 6 | [Finish](stages/6-finish.md) | `title`, `analyse` | — | Title, export |

Plus [Bench](stages/bench.md), the manual-only editor, and
[foundations](stages/0-foundations.md), the substrate all six share.

### Why the Plan stage earns its click

It is the highest-value step and the one that answers the original complaint
most directly. It is cheap, fast and legible, and it is where "that's not what I
meant" gets caught **before** money is spent writing notes. A plan is also a
visible artifact — which is precisely what was missing when the model said it
had read the score and analysed the range, and then showed nothing.

Approving a plan is just a `commitOps` call using operations that already exist.
No new mutation path.

### Where the controls go

The 29 controls are not reduced, they are **scoped**. Today all 29 sit in one
rack regardless of what you are doing; most are meaningless at any given moment.
Assigned to stages they become a short, relevant list:

- **Melody** (11) — 9 free code-tier (`Transpose`, `Fit to key`, `Quantise`,
  `Swing`, `Humanise`, `Half-time`, `Double-time`, `Invert`, `Retrograde`) plus
  two agent-tier (`Extend`, `Develop`). The stage you iterate on most is almost
  entirely free and needs no API key.
- **Arrangement** (10) — `Orchestrate as…`, `Add section`, `Enrich harmony`,
  `Simplify harmony`, `Reharmonise`, `Modal interchange`, `Add counter-melody`,
  `Add genre influence`, `Increase energy`, `Reduce energy`.
- **Refinement** (7, plus `Humanise` and `Swing` reprised) — `Crescendo`,
  `Diminuendo`, `Darken`, `Brighten`, `Warmth`, `Add tension`, `Release`.

**`Compose from seed` is retired.** That agent control *is* the pipeline;
keeping it in the rack after building six stages offers two contradictory routes
to the same result.

The mapping lives in **data, not code**. `controls` is a table with `category`
and `sortOrder`, and prompt-tier controls are rows precisely so a new one needs
no deploy. A hardcoded `CATEGORY_TO_STAGE` map in the client would throw that
away. Add a nullable `stages` JSON column (`string[]`; null or empty means
everywhere). Note `seedControls` is insert-if-absent by name, so existing
installs need a one-off backfill.

### `analyse` is two different things

Worth separating explicitly, because the names collide:

- `analyse()` / `summarise()` in `src/lib/score/analyse.ts` are **pure and
  free** — key, tempo, metre, bar and note counts, no model call. This is what
  the current left-rail Analysis panel shows.
- The `analyse` **CORE_TASK** is prose explanation layered on top, and costs a
  call.

Show the free one always; offer the paid one on request.

---

## Foundations

Built before any stage, because every stage depends on them. Detailed in
[stages/0-foundations.md](stages/0-foundations.md).

- **F0 — Make created ids visible.** `OpResult` carries only *note* ids, but
  `set_section` and `add_part` mint ids internally. After the plan-approval
  commit there is no way to map `plan.sections[i] → sectionId`. Additive change
  to the op registry; everything downstream needs it.
- **F1 — A run model with phases and one terminal state.** Declared phases, a
  single terminal outcome (`succeeded | no_effect | failed | cancelled |
  timed_out`), working cancel, retry, and a watchdog. Starts by fixing the two
  live bugs above.
- **F2 — One progress primitive.** A `Run` store and one `RunProgress`
  component, replacing three bespoke implementations.
- **F3 — One coordinate transform.** Fixes both canvas bugs and makes the
  playhead possible.
- **F4 — The atmosphere layer.** See [visual-language.md](visual-language.md).

---

## Bug triage

Every entry verified against the code rather than taken on report.

| Reported | Verdict | Lands in |
|---|---|---|
| Select draws a shape but you can't click a note | **Real, two causes.** Pointer coords are measured against `.canvas`, but `.ghost`/`.band` are absolutely positioned inside `.paper`, which carries `padding: var(--space-4)` = 16px. Separately, hit coords are multiplied by `scale` while `svg { max-width: 100% }` shrinks the SVG, so clicks are off whenever zoomed in past the container | F3 |
| Click a note and drag it up/down the bars | **Not a bug — it does not exist.** `onpointerdown` selects and returns. New feature | Bench |
| Note shape and cursor don't line up | **Real** — the same 16px offset, visible as the ghost notehead sitting up and to the left of the pointer | F3 |
| No progress; a failed run may never resolve | **Real**, promoted to a foundation | F1 + F2 |
| "Read the score, analysed the range, then nothing" | **Real** — a turn with zero ops returns `done`, indistinguishable from success. Its actual shape is likely `rejectedOps > 0`: edits were attempted and all matched nothing | F1 |
| Audio doesn't line up with the notes | **Real, but misdiagnosed.** Not drift — there is no playhead at all. `Player` emits `position` every frame, `Transport` shows a readout, and `ScoreCanvas` draws nothing. `secondsToTick` does not exist to build one | F3 + Bench |
| Progress bar never moves, overflows its box | **Real, superseded, deprioritised.** Never moves: `synth.ts` divides decompressed bytes by a possibly-compressed `content-length`. A `.sf3` is already compressed so the server likely does not gzip it, making real impact low. Overflows: `<progress flex:1>` has default `min-width: auto` ≈ 160px intrinsic, more than fits in a 220px rail. Both components are replaced wholesale | F2 |
| *(unreported)* Cancelling a run still commits its edits | **Real, live bug** | F1 |
| *(unreported)* Two writers race a job's terminal state | **Real, live bug** | F1 |

Also: `/library` in `src/routes/+layout.svelte:11` is a dead link to a route
that does not exist.

---

## Build order

Chosen so the app works throughout and value lands early.

1. **F0** — `OpResult.created` and `mergeParts.addedPartIds`. Small, additive,
   and everything later depends on it.
2. **F1–F3** — the run model, the progress primitive, the coordinate transform.
   These ship against today's UI and fix most of the reported bugs before any
   restructuring begins.
3. **Bench** — strip AI from the editor, add drag and the playhead.
4. **Extract `session.svelte.ts`** — move `runOps` and the score state into a
   shared store *in place*, before any routing change.
5. **Migration, shell and routing** — the stage columns, `+layout.svelte`, and
   the stage routes passing through.
6. **Brief and Plan** — the new front door, where `compose_plan` is wired.
7. **Melody** — `compose_realize` with per-section chunking.
8. **Arrangement, Refinement, Finish**, then retire the old entry point and fix
   the dead `/library` link.

Steps 1–4 are individually revertable. Step 5 is the one that cannot be
half-done.

---

## Risks

- **Concurrent commits silently lose ops.** `commitOps` does load → apply →
  update with no concurrency guard. Rare today; normal once a pipeline fires
  per-section realizations. Needs a version guard or a per-score run lock.
- **Revision pruning will eat undo.** Pruning runs on every commit at 100 per
  score. One revision per note drag, plus six per realization, burns that fast —
  and once pruned, reject finds no previous snapshot and 409s. Each revision
  also carries a full gzipped document.
- **The Brief seed lands staged** (`accepted: false`), so it must be
  force-accepted before Plan runs, or the plan is built against a document that
  may still be rolled back.
- **A staged flow makes cost legible in a way the current UI hides.** Six stages
  with regeneration invite more calls than one Ask box, and the budget check
  already runs *before* a turn and can overshoot. Show a per-stage estimate.
- **Renaming a `CoreTask` orphans its row and its prompt version history** —
  `seedTaskConfigs` is insert-if-absent, and `TASK_EFFORT` has a `??` fallback
  so TypeScript will not catch a missing entry.
- **If Finish does not use `analyse` and `title`, delete them** rather than
  leaving a second generation of latent intent behind.
