# Visual language: "understory"

Part of the [staged composition epic](staged-composition.md).

Organic and foresty, with a fog that reacts to where you are and what is
playing — and a hard rule that it costs essentially nothing.

**No canvas. No WebGL. No images. No new dependencies. No network requests. No
server work. No per-frame JavaScript.** The entire effect is a few hundred bytes
of CSS. Everything below is chosen because the compositor can do it on a thread
we are not using, or because it rasterizes once and never again.

---

## The fog means something

It is dense at Brief and thins as the piece takes shape, gone by Finish.

That does real work. It tells you where you are in the flow without a progress
bar, and it matches what is actually happening: something vague resolving into
something definite. A composition tool whose atmosphere clears as the
composition clears is a metaphor doing its job rather than decoration sitting on
top of one.

---

## How it is built

One fixed, full-viewport element behind everything — `pointer-events: none`,
`contain: strict` — rendered once in `src/routes/+layout.svelte` as a new
`src/lib/components/Atmosphere.svelte`.

**Three ingredients:**

1. **Two or three very large, very soft `radial-gradient` blobs** at low alpha,
   in mist tones drawn from the theme. A gradient rasterizes once and then
   composites on the GPU like any other texture.
2. **One static grain tile** — an inline SVG `feTurbulence` as a `data:` URI
   background-image at roughly 3% opacity, tiled at ~160×160. Fractal noise is
   expensive to *generate* and free to *reuse*: rasterized once at first paint,
   never animated, and no network request because it is a data URI.
3. **Drift** — each blob gets its own `@keyframes` over 60–120s animating
   **only `transform: translate3d()` and `opacity`**, alternating. These are the
   two properties the compositor can animate without touching layout, paint, or
   the main thread.

---

## Reactivity, all of it free

**Stage-reactive.** A `--fog` custom property (1 → 0) set on a wrapper by the
current stage, transitioned over ~1.2s. Cost: one attribute change per stage
transition. The browser does the rest.

**Playback-reactive.** A slow breathing keyframe whose duration derives from
tempo and whose `animation-play-state` toggles on play and stop:

```css
.blob {
  animation: breathe calc(60s / var(--bpm, 120) * 8) ease-in-out infinite;
  animation-play-state: paused;
}
:global([data-playing]) .blob { animation-play-state: running; }
```

Cost: two property writes per play/pause, never per frame. The fog breathes in
time with the music without a single `requestAnimationFrame`.

**Reduced motion.** `@media (prefers-reduced-motion: reduce)` sets
`animation: none`. The static gradient still reads as deliberate — this is a
graceful degradation, not a broken state.

---

## The cost discipline

These are prohibitions, not aspirations. Every stage doc inherits them.

- **Animate `transform` and `opacity` only.** Never `filter`,
  `background-position`, `width`, `height`, `top`, or `left`. Anything else
  forces layout or paint on every frame.
- **No `backdrop-filter` anywhere.** It is the most expensive common CSS effect
  and it recomposites on every scroll. It is also exactly what a "frosted fog"
  instinct reaches for first, which is why it is called out.
- **`will-change: transform` only on the drifting blobs.** Each one costs a
  compositor layer; sprinkling it is how you turn a cheap effect into an
  expensive one.
- **No `filter: blur()` on anything large.** A soft radial-gradient already
  looks blurred and costs nothing; a real blur is a per-frame convolution.
- **The notation layer is never behind fog.** The score sits on its opaque
  `--notation-paper` surface. PDF export draws from that same SVG
  (`src/lib/export/pdf.ts`), so anything overlaying the notation would change
  exported files. Atmosphere is chrome-only — this one is a correctness rule,
  not a taste rule.

---

## Palette and form

A new `Understory` preset in `src/lib/theme.ts`. Presets are pure data — there
are five today and this is a sixth — so the palette itself is a zero-risk
addition. Only the two or three new fog tokens touch the `Theme` interface and
`themeCss()`, and the settings editor binds to that interface, so it picks them
up automatically.

- **Chrome:** damp green-black. Bark, moss, wet stone.
- **Paper:** warm and light, via the existing `lightScorePaper` flag. The
  rationale is already written into `theme.ts`: reading music off a dark ground
  is a minority preference even among people who want a dark interface, and
  printed output is light regardless. A dark forest around a lit page is exactly
  the split that flag exists for.
- **Accent:** lichen, not blue.

**Form language:**

- Asymmetric `border-radius` (e.g. `12px 12px 12px 4px`) so panels read as leaf
  or stone rather than as boxes. Costs nothing.
- Low-alpha borders and one soft shadow, rather than heavy elevation.
- The stage stepper drawn as a **meandering trail** — one inline SVG path with
  six nodes that fill by CSS transition as you progress. Static geometry, no
  animation beyond the fill.

---

## Three collisions to resolve

**`diffAdd` is green.** It is `#4ade80` today, and it would disappear into green
chrome. The diff triad (`diffAdd` / `diffRemove` / `diffChange`) must be
re-picked for this preset — these colours mark added, removed and changed notes
in every AI review, so they have to stay unmistakable against the background and
against each other.

**There is already a preset named `Studio`** (`theme.ts:72`). That is why the
manual editor in this epic is called **Bench** rather than Studio. Worth stating
once rather than leaving two things with one name.

**Six stepper nodes on a phone.** The editor collapses to one column at 1000px.
A six-node trail will want to scroll horizontally on a narrow screen — decide
whether it collapses to "3 of 6 · Melody" with the trail hidden, or scrolls.
