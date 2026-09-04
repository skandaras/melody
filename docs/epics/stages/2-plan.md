# Stage 2 — Plan

Part of the [staged composition epic](../staged-composition.md).

## Purpose

Turn the brief into a concrete, editable blueprint — key, tempo, metre,
instrumentation, and a list of sections with bar counts and a harmonic sketch —
and get it **approved before any notes are written**.

This is the highest-value stage in the epic. It is cheap, fast and legible, and
it is where "that's not what I meant" gets caught before money is spent
realizing eight bars of the wrong thing. It is also a visible artifact, which is
exactly what was missing when the model reported reading the score and analysing
the range and then showed nothing.

## What the user sees

The plan as editable cards, not prose.

- **Header facts** — key, tempo, time signature. Each directly editable.
- **Ensemble** — a row per part with instrument and role. Add, remove, swap.
- **Sections** — a card each: name, bar count, harmonic sketch, role, which
  parts play. Reorderable, renameable, resizable. Regenerate one card without
  touching the others.
- **Where the seed goes** — if the brief was audio-seeded, the plan states
  explicitly whether the seed is the main theme, the chorus hook, or a motif.
- **Approve and continue** — the only thing that writes to the score.

Fog thins one step.

## Machinery it uses

- `compose_plan` (CORE_TASK) — has a written prompt at
  `src/lib/server/ai/prompts.ts:36` and has never been called. Its guidance is
  already right: "Be specific and short. 'Verse, 8 bars, i-VI-III-VII in A
  minor, piano and bass only' is a plan. 'A verse section with an interesting
  progression' is not."
- A new `src/lib/server/ai/structured.ts` (see gotchas).
- The new `plan` JSON column on `scores`.
- Existing ops for approval: `set_title`, `set_tempo`, `set_time_sig`,
  `set_key`, `add_part`, `set_section`.

## What "continue" commits

One `commitOps` call, in this order — the order is load-bearing:

```
set_title → set_tempo → set_time_sig → set_key → add_part×n → set_section×n
```

`set_section` takes raw ticks, and bars→ticks depends on the metre, so section
boundaries must be walked forward with
`measureTicks(ppq, timeSigAt(score, t))` (`src/lib/score/measures.ts:23-38`) —
**never `bars * 1920`**, because the plan may change metre mid-piece.

## Gotchas

- **`compose_plan` must return JSON, and `runAgentLoop` cannot carry a
  response schema.** `CompletionRequest.responseSchema` exists
  (`ai/types.ts:57`) and `OpenRouterAdapter.body()` wires it
  (`ai/openrouter.ts:147-156`), but `LoopOptions` has no such field and
  `loop.ts:102-110` never passes one. Do not bolt it onto the loop: a structured
  plan run has no tool loop, no ops to collect and no `commitOps`, and giving
  `runAgentLoop` a mode where `LoopResult.ops` is permanently empty muddies
  exactly the `done`-vs-`no_effect` distinction F1 exists to fix. Add
  `runStructured<T>()` in `src/lib/server/ai/structured.ts`, reusing `emit` and
  `finishJob`.
- **`strict: true` is hardcoded** (`openrouter.ts:152`), so the plan schema
  faces the same restrictions as tool schemas: every property in `required`,
  `additionalProperties: false` at every level, no `minimum`/`maxItems`, and
  enums that admit `null`. `toStrictSchema()` (`ai/tools.ts:95`) already does
  this and is exported — author the schema normally and run it through, or
  OpenRouter 400s on something as innocent as `{ bars: { minimum: 1 } }`.
- **Deployment risk worth naming.** `provider.require_parameters: true`
  (`openrouter.ts:128-136`) restricts routing to providers honouring everything
  sent, and `compose_plan` seeds at `effort: 'high'` (`bootstrap.ts:41`).
  Reasoning plus structured output is where provider support is patchiest, and
  the failure mode is a hard error rather than degradation. Retry once without
  `response_format` and parse JSON out of the prose.
- **`set_key` takes `{ tonic, mode }`, not `fifths`** (`ops/global.ts:41-72`),
  and its own summary notes it does not transpose existing notes. If the brief
  was audio-seeded in a different key, approval must also emit a `transpose` or
  the seed ends up wrong against a new signature.
- **`set_section` silently creates on a stale id.** `ops/global.ts:120` does
  `score.sections.find(s => s.id === args.sectionId)` and falls through to
  minting a *new* id when it misses — so re-approving an edited plan duplicates
  sections rather than erroring. Harden it: if `sectionId` was supplied and did
  not resolve, return an empty result with no log line. The loop already treats
  a log-less op as an error to correct (`loop.ts:263-266`).
- **`add_part` wraps channels past 16** (`ops/parts.ts:38-43`), round-robin
  skipping 9. Cap instrumentation at 15 non-drum parts in the plan schema.
- **Mapping cards to section ids needs F0.** Without `OpResult.created` there is
  no way to know which section id belongs to which plan card.
- **Undo across approval.** Revisions restore `doc` only
  (`scores.ts:309-338`), so undoing past the approval leaves `stage: 'melody'`
  and `plan.approved: true` while the parts and sections it created are gone.
  Snapshot `stage`/`brief`/`plan` beside `doc` on the revision.

## Open questions

- Should editing an approved plan re-run approval as a diff against the existing
  sections, or require discarding realized material first? The second is honest
  and simpler; the first is what people will expect.
- Does the plan need a duration estimate ("about 2:10 at 92bpm") shown before
  approval? Cheap to compute from bars, metre and tempo — no model call.
