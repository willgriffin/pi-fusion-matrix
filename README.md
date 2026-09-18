# pi-fusion-matrix

A [pi](https://pi.dev) extension that owns **fusion resolution** and nothing else: named fusions whose
five slots each carry an ordered fallback chain, executed through pi's own provider runtime, with a
pluggable decision backend used conservatively.

Status: planned. The implementation spec is [`docs/plan.md`](docs/plan.md); work is tracked in
[this repository's issues](../../issues).

## What it does

- **Shapes are config.** A `mode` is a stage list — `pair` (two experts + a merge), `lean` (two + a
  synthesizer that absorbs the judge), `committee` (three + judge + synthesis), `committee-merged`
  (four calls instead of five), `opinion` (fan out, no merge), `debate` (three rounds against peers'
  opinions), `single`, `committee-cascaded`. Adding one is a config edit.
- **Seats are config too.** A `persona` is what a seat is told and how it samples — prompt, temperature,
  thinking level. Persona prompts live in `prompts/*.md`, so changing what an expert is told is a text
  edit. A fusion binds a mode to a roster: `"deep": { "mode": "committee", "candidates": {…} }` gives you
  `fusion-matrix/deep` in `/model` and `--model`, with its own model chain per seat.
- **Two fallback layers** — inside an alias, providers are tried in order (same model, different
  billing route: quality-preserving); across a slot, aliases are tried in order (different model:
  reported as a substitution).
- **Version-free aliases** — a seat names `deepseek-flash`, never a vendor version. The id sent
  upstream lives in `aliases.<name>.model` and the routes in `providers` (pi's own provider ids:
  `opencode-go`, `zai`, `kimi-coding`, `openai`), so a vendor release edits one field and no alias
  name, fusion, or seat. Endpoints and credentials stay entirely pi's — no `models.json` block ships,
  and a vendor id does not need to be in pi's catalogue to be used.
- **Decisions** — a `decide` element for closed questions over an option set, backed by TypeSafe
  (default; calibrated `confidence`, no local service) or SemIf (local, zero marginal cost).
  Conservative by construction: `verify` reports and never rewrites; `route` selects a whole fusion
  (never a judge or synthesis model); and uncertainty escalates rather than guesses — at fusion level a
  decision that is unsure declines to route, and inside a slot a decision whose answer is not actionable
  escalates to the next candidate (the judge can be a cheap consensus read that falls through to a real
  judge when the panel is ambiguous). A backend without confidence cannot gate anything at all.

## What it does not do

- It does not own providers, endpoints, or credentials. Those are pi's (`~/.pi/agent/models.json`,
  `/login`, `auth.json`). This extension never resolves a secret and never constructs a base URL.
- It does not import or require `@quarkos/pi-fusion`. That project's pipeline behavior is a reference
  the spec re-derives; see "Reference-only" in `docs/plan.md`.
- It does not run stages that write to disk, iterate until a gate turns green, or schedule a task DAG.
  A seat is one model call; `verify` gates run once and report. See the boundary note in `docs/plan.md`.

## Install

pi auto-discovers `extensions/*/index.ts`. Point an install at it:

```bash
ln -s "$PWD/extensions/pi-fusion-matrix" ~/.pi/agent/extensions/pi-fusion-matrix
```

Reload in a running session with `/reload`. Provider names referenced by `matrix.json` must exist in
`~/.pi/agent/models.json` — model ids are resolved by pi, so any model any installed extension
registers is usable.

## What leaves your machine

Two things do, and both are worth knowing before the first run:

- **Decisions go to the backend you configure.** The packaged default is TypeSafe (`backends.typesafe`,
  `https://api.typesafe.ai/v1/systemone`, key from `TYPESAFE_API_KEY`), and every decision call sends the
  deliberation **state** there: the panel's raw responses for a cascade or a `score` stage (source code
  included, when the review carried it in), the synthesis for `verify`, and the prompt for `route`.
  TypeSafe bills input tokens only and does not train on requests, but that content does leave the host
  verbatim. Point `decide.defaultBackend` at the local `semif` backend (`backends.semif`,
  `http://127.0.0.1:8791/score`) for content that must not leave the host — see `tools/semif-server/`.
- **Seats go to the providers your aliases name.** Panel responses are sent to the judge and synthesis
  models, which may be different vendors. That is the point of a fusion, and it is why the alias table is
  the place to decide who sees what.

Nothing else is transmitted. There is no telemetry, and the extension does not read or cache credentials:
it asks pi for the credential of the provider a seat names, per request.

## Trust boundary

The session's `.pi-fusion-matrix.json` comes from whatever repository you are in, so it is treated as
untrusted. It may change aliases, personas, modes, and fusions — routing and billing — but it may **not**
introduce a decision backend, add a `verify` gate command, or point a persona prompt at a file: those are
the three surfaces that can send content to an endpoint, run a command, or read a file into a prompt.
Those come only from the packaged config and `~/.config/pi-fusion-matrix/matrix.json`, which are yours.
Validation rejects them with a message naming the offending entry.

## Configuration

`matrix.json` merges across layers, lowest priority first:

1. this repo's `matrix.json`
2. `~/.config/pi-fusion-matrix/matrix.json`
3. `<session cwd>/.pi-fusion-matrix.json`

Top-level knobs: `providerId` (default `fusion-matrix`), `providerName`, and `defaultFusion` for the
tool and command when no id is given. A project that must bill to another account adds that account as
its own provider in `~/.pi/agent/models.json` and lists it in the repo-local `matrix.json`; no profile
system is involved.

## Commands

- `/matrix <id> <prompt>` — run a named fusion; with no id, `defaultFusion` is used.
- `/matrix-info` — list resolvable aliases, fusions, backends, and the config layers loaded.
- `/matrix-doctor` — validate the config, check provider connectivity, and report catalogue drift
  (`--online` for the network checks, `--repair` prints the one additive fix).

## License

Private.