# Melody

Self-hosted AI music composition. Hum, sing, play or upload something; melody
turns it into real notation you can edit, restyle, hear and export.

It runs beside [galaxy](https://github.com/skandaras/galaxy) on the same
2GB droplet, behind the same Caddy and Authelia, and follows the same
conventions: forward-auth identity, SQLite on a volume, `:dev` → `:stable`
image promotion, an admin panel for everything that would otherwise be an
environment variable.

---

## What it does

**Get music in.** Record from the microphone or drop in an audio file.
Pitch detection runs in the browser (a Web Worker running Spotify's
basic-pitch), then tempo estimation, quantisation and bar-splitting turn the
detected notes into a draft score. No key required — this whole path is free.

**Edit it.** Notation is engraved with VexFlow and directly editable. In
Select mode: click a note, shift-click to add, or rubber-band a region; arrow
keys transpose (shift for octaves), delete removes. In Add mode: pick a
duration and click the stave to place a note, with a ghost notehead showing
exactly where it will land. Every mutation in the app — yours, a control's,
the model's — goes through one registry of 27 operations, so undo, revisions
and AI edits all work the same way.

**Ask for changes.** Describe what you want: *make this darker*, *add a
walking bass*, *orchestrate for string quartet*. The model works through the
same 27 operations, and its edits arrive as a **diff you accept or reject**
rather than as a silent overwrite.

**Turn the knobs.** A rack of 29 controls sits beside the score. They come in
three tiers, which matters more than it sounds:

| Tier | What it is | Cost |
|---|---|---|
| `code` (11) | Pure functions — transpose, quantise, swing, humanise | Free, instant, no model |
| `prompt` (13) | One model round-trip with a scoped instruction | One call |
| `agent` (5) | A bounded tool-calling loop that can read the score back | Several calls |

*Darken*, *Increase energy* and *Add genre influence* are the interesting
ones; *Transpose* and *Quantise* never touch the network. A fresh install
with no API key is a working, if quieter, program.

**Get music out.** PDF (vector, drawn from the same SVG you're looking at),
MusicXML (opens in MuseScore, Sibelius, Dorico), MIDI, and rendered WAV. Save
selections to a clip library organised in folders.

**Make it yours.** Presets plus thirteen colours and four scale axes, with
notation size deliberately independent of interface size. Themes are
per-user.

---

## How it's put together

The organising constraint is the droplet: 2GB, shared with galaxy. So
**almost nothing heavy happens on the server**.

```
browser                                      server
─────────────────────────────────────        ──────────────────────────
pitch detection      (Web Worker)            identity from Authelia headers
tempo / quantise     (pure TS)               score JSON in SQLite
engraving            (VexFlow → SVG)         the ops registry (one write path)
playback / synthesis (SpessaSynth)           OpenRouter calls + SSE job stream
WAV render           (OfflineAudioContext)   encrypted provider keys
PDF                  (svg2pdf + jspdf)       skills, clips, revisions
MusicXML / MIDI      (pure serialisation)
```

The server stores JSON, calls OpenRouter, and serves assets. It never
renders a note.

**AI goes through OpenRouter, not a vendor SDK.** One key, 400+ models, real
per-generation cost reporting, and automatic fallback when a model is
rate-limited. The client is a ~200-line typed `fetch` wrapper rather than a
vendor package, because the OpenRouter-specific fields we depend on
(`provider.require_parameters`, `reasoning`, `models`, `usage.include`) are
exactly the ones a vendor SDK doesn't type.

`provider: {require_parameters: true}` is set on every request. Without it,
OpenRouter may route a tool-bearing request to an upstream provider that
silently ignores `tools`, and the failure looks like the model refusing to
follow instructions.

**The model's edits are proposals.** Every AI turn lands as one revision with
`accepted: false`. You see added/changed/removed notes highlighted, and
nothing is committed until you say so.

---

## Running it locally

```bash
npm install          # postinstall copies the soundfont and ML model into static/
cp .env.example .env
npm run dev
```

Open <http://localhost:5173>. The default `.env` sets `AUTH_MODE=dev`, which
bypasses Authelia and signs you in as `DEV_USER` with admin rights. That mode
exists for local work and must never be set in production.

`npm install` pulls a 58MB soundfont package and a ~900KB TensorFlow model.
Both are copied into `static/` by `scripts/setup-assets.mjs` and the package
is pruned from the runtime image, so neither is in git and neither is
downloaded at runtime.

```bash
npm test          # 389 tests, no network, no API key
npm run check     # svelte-check + tsc
npm run build     # adapter-node output in build/
npm start         # run the built server
```

---

## Deploying to the droplet

### 1. Authelia

melody has no login of its own. Caddy's `(authelia)` snippet gates the
subdomain and forwards `Remote-User`, `Remote-Groups`, `Remote-Name` and
`Remote-Email`; melody turns those into a user.

Two groups are worth creating, though only the second is read by the app:

```yaml
# authelia/configuration.yml — under access_control.rules, BEFORE the
# catch-all *.starbasehome.net rule, or it will never be reached.
- domain: melody.starbasehome.net
  policy: two_factor
  subject:
    - 'group:melody-users'
```

- **`melody-users`** — enforced by *Authelia*, not by melody. It decides who
  can reach the app at all. Skip this rule entirely if the existing
  `*.starbasehome.net` rule is the access policy you want; melody works
  either way.
- **`melody-admins`** — read by *melody*, via `ADMIN_GROUP`. Members get
  `/admin`: the OpenRouter key, model curation, and defaults. Everyone else
  gets 403 on both the page and its API.

Add yourself to both in `users_database.yml`, then restart Authelia.

### 2. Caddy

```bash
scp deploy/melody.caddy droplet:~/stack/caddy/sites-enabled/melody.caddy
ssh droplet 'cd ~/stack && docker compose restart caddy'
```

Caddy does not hot-reload a mounted config file, so the restart is required.

### 3. The app

`docker-compose.yml` is a single service on Caddy's external `proxy` network,
following `ghcr.io/skandaras/melody:stable`. Two values have no default and
compose will refuse to start without them:

```bash
# ~/stack/melody/.env
TRUSTED_PROXY_IPS=172.18.0.0/16          # your Caddy container's network
MELODY_ORIGIN=https://melody.starbasehome.net
```

```bash
docker compose up -d
docker compose logs -f melody
```

`TRUSTED_PROXY_IPS` is the load-bearing security control in the whole auth
path. melody refuses to read identity headers from any other address —
without it, anything that can reach the container's port could set
`Remote-User: you` and `Remote-Groups: melody-admins`. Find Caddy's subnet
with:

```bash
docker network inspect proxy -f '{{range .IPAM.Config}}{{.Subnet}}{{end}}'
```

Migrations ship inside the image and run at boot. There is no separate
migration step.

### 4. First run

Sign in and go to **Admin**. Until a key is entered, the eleven `code`
controls work and nothing else does.

1. **OpenRouter** — paste your key from
   <https://openrouter.ai/keys>. It is encrypted with AES-256-GCM before it
   touches the database and is never sent back to the browser; the panel
   shows only whether a key exists and its last four characters.
2. **Models** — press *Sync*. This pulls OpenRouter's catalogue with pricing
   and capabilities. **New models arrive disabled**; enable the handful you
   actually want in the picker. The list is filtered to tool-capable models
   by default, because a model that can't call tools can't edit a score and
   fails in a way that's hard to read.
3. **Defaults** — pick the primary model, ordered fallbacks, token ceiling and
   budget cap. **Nothing is preselected.** melody will not choose a vendor, or
   spend your credit, on your behalf; until you pick one, anything that calls a
   model says so and names where to fix it.
4. **Tasks** — optional, but this is where the money is. Each of the eight jobs
   can take its own model, reasoning mode, effort and token ceiling, with its
   system prompt and version history beside it. Titling a piece and
   orchestrating one want very different things; leaving both on one global
   setting means paying arranging rates to generate a title.

### 5. Your first score

**New score** opens an empty document — no parts, so the canvas starts blank.
Three ways forward:

- **Audio in**, in the left rail — record or drop a file. Transcription creates
  the part for you. This is the intended path and the one worth testing first:
  hum eight bars, and you should get notation back without a single call to
  OpenRouter.
- **Add part**, also in the left rail — start from an empty piano stave.
- **Add note**, in the toolbar above the score — switch the pointer to Add,
  pick a note value, and click the stave. How you write something from nothing
  without a microphone.

Once there are notes: select a few, try *Transpose* (free, instant), then
*Darken* or *Increase energy*. AI edits arrive as a highlighted diff with
**Accept** and **Reject** in the toolbar — nothing is committed until you
choose.

---

## Configuration

Everything tunable at runtime lives in the admin panel and the database. The
environment holds only what must be known before the database opens.

| Variable | Default | Notes |
|---|---|---|
| `DATA_DIR` | `./data` | SQLite, recordings, skills, exports |
| `ORIGIN` | — | **Required behind a proxy.** SvelteKit's CSRF check rejects multipart uploads without it, which is how audio arrives |
| `BODY_SIZE_LIMIT` | `64M` | adapter-node defaults to 512K, far below a few minutes of audio |
| `AUTH_MODE` | `dev` | `authelia` trusts forwarded headers; `dev` bypasses auth entirely |
| `DEV_USER` | `dev` | Username granted admin under `AUTH_MODE=dev` |
| `TRUSTED_PROXY_IPS` | `127.0.0.1,::1` | IPs/CIDRs allowed to assert identity. Fail-closed |
| `ADMIN_GROUP` | `melody-admins` | Authelia group granting `/admin` |
| `MELODY_ENV` | `dev` | Cosmetic badge; also reported by `/healthz` |
| `SECRET_KEY` | generated | 64 hex chars, AES-256-GCM master key for provider keys at rest |

If `SECRET_KEY` is unset, one is generated into `DATA_DIR/melody.key` on
first boot. Losing it means re-entering the OpenRouter key — nothing worse,
since nothing else is encrypted with it.

Model choice, iteration and op caps, budget, transcription thresholds,
retention and audio settings are all admin-panel settings, not environment
variables. They are deliberately not deploy-time decisions.

---

## Data and backups

Everything lives in the `melody-data` volume:

```
melody.db          SQLite (WAL) — scores, revisions, clips, users, settings, usage
melody.key         generated master key, if SECRET_KEY is unset
recordings/        source audio, if retention keeps it
skills/style/      style skills as markdown — six seeded, add your own
exports/           generated files
```

Stop the container before copying. The database is in WAL mode, so a tar of a
running volume can capture a `.db` without the `-wal` that completes it:

```bash
docker volume ls | grep melody          # confirm the name — it is prefixed
                                        # with the compose project directory
docker compose stop melody
docker run --rm -v melody_melody-data:/data -v "$PWD:/out" alpine \
  tar czf /out/melody-backup.tgz -C /data .
docker compose start melody
```

Style skills are plain markdown in `skills/style/<name>/SKILL.md`. Six ship
seeded — baroque, bossa-nova, cinematic, gospel, lo-fi, synthwave. Adding a
directory adds a style the prompt and agent tiers can reference by name.
The database holds only an index into these files, and it is rebuilt at
startup, so a newly added skill needs a `docker compose restart melody` to be
picked up. Editing an existing skill's markdown takes effect immediately —
the body is read at prompt time, not cached.

---

## Development

```
src/lib/score/       document model, 27 ops, analysis, validation — all pure
src/lib/render/      VexFlow engraving, line breaking, hit testing, note placement
src/lib/audio/       capture, transcription, synthesis, mixing
src/lib/export/      MIDI, MusicXML, PDF, WAV
src/lib/server/ai/   OpenRouter client, strict tool schemas, agent loop, SSE jobs
src/lib/server/      auth, db, settings, crypto, clips, controls
src/routes/          pages and API
```

Two conventions carry most of the weight:

**Ticks, not durations.** The score model is absolute ticks at PPQ 480 with
stable note ids. It has no dependency on rendering, audio or the DOM, so most
of the interesting logic is testable as pure functions — which is why the
suite runs in five seconds with no network.

**`OpDef.schema` is the tool definition.** The 27 operations describe
themselves in JSON Schema, and `ai/tools.ts` derives the model's function
definitions from that same source. An op cannot drift out of step with the
tool the model calls, because there is only one of them.

Strict function calling has sharp edges worth knowing before you edit
`tools.ts`: no `minimum`/`maximum`/`minItems`/`pattern` anywhere in the tree,
every property must appear in `required`, and an optional property must be a
nullable union — *including its enum*, which must admit `null` too. The
bounds aren't lost; every op already clamps its own arguments, and the
stripped constraints are folded into the property descriptions where they
still steer the model.

Tests cover the streaming tool-call reassembly from recorded fixtures (the
sharpest edge in the codebase — `function.arguments` arrives as string
fragments to be accumulated by `index`), loop termination and caps, malformed
tool arguments, SSE replay to a late subscriber, and the auth boundary. A
`MockAdapter` stands in for OpenRouter, so the suite needs no key.

CI runs `check`, `test` and `build` on every push, then publishes
`ghcr.io/skandaras/melody:dev`. The promote workflow retags `:dev` as
`:stable`, which is what the droplet follows.

---

## Status

Working: capture and transcription, notation editing, the ops registry,
playback and mixing, the AI layer and agent loop, all three control tiers,
PDF/MusicXML/MIDI/WAV export, the clip library, per-user theming, and the
admin panel's provider and model management.

Not built yet: the remaining admin tabs — usage and budget reporting,
controls CRUD, and skill editing. Their data is already recorded; only the UI
is missing, and everything they would configure has a working default.
