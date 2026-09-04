# Foundations

Part of the [staged composition epic](../staged-composition.md).

The substrate all six stages share. Built first, because every stage depends on
it and because F1 begins by fixing two live bugs that are already shipping.

---

## F0 — Make created ids visible

**Purpose.** After approving a plan you must be able to say which section id
belongs to `plan.sections[2]`. Right now you cannot.

`OpResult` carries only *note* ids (`src/lib/score/ops/types.ts:26-35`), but
`set_section` mints ids via `ctx.ids.next('section')`
(`src/lib/score/ops/global.ts:128`) and `add_part` via `ctx.ids.next('part')`
(`src/lib/score/ops/parts.ts:46`). The ids are deterministic counters seeded by
`collectIds` (`src/lib/score/ids.ts:28-49`), so on a virgin score you *could*
predict `s1..sn` — but that breaks the moment a Brief seed has already added a
part, or a plan is re-approved after editing.

**The change.** Extend `OpResult`:

```ts
created?: { kind: IdKind; id: string; name?: string }[];
```

Populate it in `addPart` and `setSection`, merge it in `applyOps`
(`src/lib/score/apply.ts:60-64`), return it from `commitOps`. Purely additive —
every existing op keeps working untouched.

**Same problem for the seed.** `mergeParts` returns `addedParts` as a *count*
(`src/lib/score/merge.ts:70`), not ids. The Brief stage needs
`brief.seedPartId` so Plan and Melody can refer to "the theme". Add
`addedPartIds: string[]` to `MergeResult` and surface it through
`mergeIntoScore`.

**Testable.** Pure functions in the score layer; extend `score.test.ts` and
`merge.test.ts`.

---

## F1 — A run model with phases and one terminal state

**Purpose.** Every stage runs work that takes time and can fail. Today a run has
no declared shape, no working cancel, and no way to say "finished, changed
nothing". Two of the items below are live bugs, not new features — do those
first.

### The two live bugs

**Cancelling a run still commits its edits.** `runAgentLoop` returns
`result('aborted')` *normally* rather than throwing
(`src/lib/server/ai/loop.ts:92,117`), so `src/lib/server/ai/run.ts:84-114` and
`src/lib/server/controls/run.ts:150-179` fall straight through to `commitOps`.
Cancelling an eight-op turn still writes a staged revision. Both call sites need
an early return:

```ts
if (result.stopReason === 'aborted') { finishJob(jobId, 'cancelled'); return; }
```

**Two writers race the terminal state.** `cancelJob`
(`src/lib/server/ai/jobs.ts:143`) calls `finishJob(jobId, 'cancelled')` and sets
`buffer.done = true`; the executor then calls `finishJob(jobId, 'done')`,
overwriting the DB status and logging a second `recordJobEvent`
(`src/lib/server/events.ts:59-91`). `cancelJob` should only call `abort()`. The
executor is the sole writer of the terminal state.

**And `cancelJob` is called from nowhere** — grep confirms no route exists. Add
`DELETE /api/jobs/[id]/+server.ts`, guarded by `jobOwner`.

### `no_effect`

`loop.ts:142-144` returns `done` whenever `finishReason !== 'tool_calls'`. Add
`no_effect` to `LoopResult['stopReason']`, returned when the reason would be
`done` and `ops.length === 0`.

The loop already computes a sharper signal that is currently thrown away:
`handleCall` returns `ok: false, detail: "<op> matched nothing"` for an op that
resolved to zero notes (`loop.ts:259-266`). Add `LoopResult.rejectedOps` so
`no_effect` can distinguish:

- *wrote nothing* — the model read the score and answered in prose; and
- *tried three edits, all matched nothing* — which is the actual shape of the
  reported "read the score, analysed the range, then nothing" bug.

**Breaking:** `loop.test.ts:55` and `loop.test.ts:280` both assert
`stopReason === 'done'` for zero-op turns. Both must change.

### Phases

Two new wire events:

- `plan` — emitted once at run start: `{ phases: { id, label }[] }`.
- `phase` — `{ id, index, total, label }` on entry to each.

For a chunked realization the phase list is known up front from the approved
plan (n sections → n chunks plus `finalise`), so the progress bar has an honest
denominator instead of a spinner.

Phases belong to the **run orchestrator**, not to `runAgentLoop` — the loop runs
*within* a phase. Give `LoopOptions` an optional `phase?: { id, label }` so
`iteration` and `tool` events can be tagged and the client attributes them
correctly.

### Statuses, and what else must change

Widening `JOB_STATUSES` (`src/lib/server/db/schema.ts:282`) to
`['running','succeeded','no_effect','failed','cancelled','timed_out']` **needs
no migration** — Drizzle emitted no CHECK constraint
(`drizzle/0000_keen_victor_mancha.sql:58-67` shows a bare `status text NOT
NULL`). Per the expand-migrate-contract doctrine in
`src/lib/server/db/index.ts:34-41`, keep `done` and `error` readable for
existing rows. Consumers to update: `finishJob`'s `status === 'error'` branch
(`jobs.ts:97`) and `recordJobEvent`'s `status !== 'error'` → `ok` mapping
(`events.ts:77`).

### One uniform result payload

Today `emit(jobId, 'result', …)` carries `ops` as a count plus `stopReason`
(`run.ts:105-113`), and `AiPanel.svelte:93-98` infers "no changes" from the
*absence* of `doc` and `revisionId`. Replace with a typed payload:

```ts
{ outcome, opsApplied, opsRejected, stopReason, summary,
  warnings, revisionId?, diff?, doc? }
```

### Three more gaps

**Restart amnesia.** Job buffers are in-memory (`jobs.ts:44`). After a restart,
`subscribe` on a still-live job hits `if (!buffer)` and sends `__end__`
immediately (`jobs.ts:127-131`) — indistinguishable from "finished long ago" —
while the `jobs` row stays `running` forever. Fix both ends: on boot, mark
orphaned `running` rows as `failed` ("the server restarted"); in the SSE
handler, when there is no buffer, read the row and emit a synthetic terminal
event before closing.

**Timeouts.** Nothing bounds wall-clock anywhere. `timed_out` needs a
server-side timer calling the same abort path.

**The code tier has no job at all.** `runControl` returns
`{ kind: 'applied', doc, revisionId, diff }` synchronously with no job id and no
SSE (`src/lib/server/controls/run.ts:64-87`). The run model must be able to
represent a run that is **born terminal** — zero phases, `succeeded`
immediately — or `ControlRack.svelte:89-95`'s special-case branch just moves
somewhere else rather than disappearing.

**Undeclared event already on the wire:** `status` is emitted at `run.ts:59` and
`controls/run.ts:112` and consumed at `AiPanel.svelte:67`, but it is not part of
any declared vocabulary. Fold it into `phase` or declare it.

---

## F2 — One progress primitive

**Purpose.** Three components implement progress three ways; none of them
handles a stalled run.

`AiPanel.svelte:63-117` and `ControlRack.svelte:104-133` open near-identical
`EventSource`s, parse the same six event names, and end with the same
`source.onerror = () => { if (readyState === CLOSED) stop() }`.

**The change.** A `Run` store at `src/lib/runs/run.svelte.ts`, following
`PlayerStore`'s class-with-runes shape
(`src/lib/audio/player.svelte.ts:26`) — the one existing precedent for a
stateful store here, so follow it rather than inventing a second style.

It owns `phases`, `currentPhase`, `deltas`, `toolLog`, `outcome`, `error`,
`cancel()`, `retry()`, and the watchdog.

**Key runs by jobId in a `Map`**, not a single `source` field — a stage page may
have several realizations in flight.

**Transcription is not a job.** `AudioInput.svelte:219-223` gets
`p.phase === 'model'` and `p.fraction` from `detectNotesInWorker`, not from SSE.
Model it as the same `Run` type with a **local driver** instead of an
EventSource, so one `RunProgress` component renders all three sources.
Otherwise you unify two of three and leave the third as exactly the bespoke case
this foundation exists to remove.

**The watchdog already exists in one place.** `AudioInput.svelte:54,209` has a
`slow` state that explains a long-running detection ("Still going. Your browser
may be running the detector without GPU…"). Generalize that one good instance
rather than writing a second.

**And fix the overflow while replacing it:** `<progress>` with `flex: 1` keeps
its default `min-width: auto`, which resolves to the element's ~160px intrinsic
width — more than fits beside a label in a 220px rail. `min-width: 0`.

---

## F3 — One coordinate transform

**Purpose.** Both reported canvas bugs, and the playhead that does not exist.

### The 16px offset — a one-line fix

`localPoint` measures against `host`, the `.canvas` div
(`ScoreCanvas.svelte:99-102, 188`), but `.ghost` and `.band` are
`position: absolute` inside `.paper`, which is the `position: relative` ancestor
and carries `padding: var(--space-4)` (`ScoreCanvas.svelte:217-223`). With
`spaceBase: 0.25rem` that is exactly 16px up and to the left.

**Move `position: relative` from `.paper` onto `.canvas`.** No arithmetic.

### The zoom mismatch — read the factor, don't compute it

`renderScore` multiplies every hit and stave box by `scale`
(`render.ts:250-257, 298-302`) and sizes the SVG to `layout.width * scale`
(`render.ts:200`), while `.canvas :global(svg) { max-width: 100% }`
(`ScoreCanvas.svelte:239-242`) shrinks the *displayed* width. Note this only
bites when zoomed **in** past the container — at `scale < 1` the SVG is narrower
than its box and `max-width` never applies, so the symptom is asymmetric.

```ts
const svg = host.querySelector('svg')!;
const r = svg.getBoundingClientRect();
const k = renderResult.width / r.width;   // user units per CSS px
const x = (e.clientX - r.left) * k;
```

Scale-, padding- and layout-independent.

**Where it lives.** `src/lib/render/locate.ts` claims DOM-freedom in its header
comment and is unit-tested by `locate.test.ts` — keep it pure. Put the
DOM-touching helper in a sibling `src/lib/render/viewport.ts`.

### The playhead needs a function that does not exist

`player.transport.position` is in **seconds** (`src/lib/audio/synth.ts:244`),
and `scoreDurationSeconds` (`src/lib/export/midi.ts:213-230`) only walks
tick → seconds. Add the inverse `secondsToTick(score, seconds)` to
`src/lib/score/measures.ts`, beside `tempoAt` — that module is pure and imports
nothing, so it is directly unit-testable.

Then x = the `StaveBox` whose `[startTick, endTick)` contains the tick,
interpolated linearly across `box.width`.

**Reactivity trap.** `staves` is a plain non-reactive local
(`ScoreCanvas.svelte:33`) assigned inside `draw()`. A playhead needs it
reactive, but the drawing `$effect` (lines 79-87) both reads its inputs and
would now write `staves` — publish a shallow copy outside the tracked read set,
or the effect loops.

---

## F4 — The atmosphere layer

See [visual-language.md](../visual-language.md). Built early because it settles
the palette and spacing that every stage is then designed against.

---

## Open questions

- Does `no_effect` warrant its own UI treatment, or is it a `succeeded` with an
  explanatory summary? It is a real outcome, not an error — the model may
  legitimately conclude nothing needs changing.
- Should a per-score run lock be part of F1, or does it wait until the Melody
  stage makes concurrent runs normal? (See the concurrency risk in the epic.)
