# pi-fusion-matrix

A [pi](https://pi.dev) extension that owns **fusion resolution** and nothing else: named fusions whose
five slots each carry an ordered fallback chain, executed through pi's own provider runtime, with a
pluggable decision backend used conservatively.

Status: planned. The implementation spec is [`docs/plan.md`](docs/plan.md); work is tracked in
[this repository's issues](../../issues).

## What it does

- **Fusions** — a named pipeline (`3x` = two experts + synthesizer, `5x` = panel + judge + synthesis)
  registered as models under the `fusion-matrix` provider. The fusion key *is* the model id, so
  `"deep": {…}` in `matrix.json` gives you `fusion-matrix/deep`; name them whatever you like and they
  appear in `/model` and `--model` with no code change.
- **Two fallback layers** — inside an alias, providers are tried in order (same model, different
  billing route: quality-preserving); across a slot, aliases are tried in order (different model:
  reported as a substitution).
- **Version-free aliases** — a slot names `deepseek-flash`, not `deepseek-v4.1-flash`. Vendor ids and
  endpoints live in pi's own `~/.pi/agent/models.json`, so a version bump edits one line there.
- **Decisions** — a `decide` element for closed questions over an option set, backed by TypeSafe
  (default; calibrated `confidence`, no local service) or SemIf (local, zero marginal cost).
  Conservative by construction: `verify` reports and never rewrites, `route` selects a whole fusion (never
  a judge or synthesis model) and declines to act below its confidence threshold, and a backend without
  confidence cannot steer cost at all.

## What it does not do

- It does not own providers, endpoints, or credentials. Those are pi's (`~/.pi/agent/models.json`,
  `/login`, `auth.json`). This extension never resolves a secret and never constructs a base URL.
- It does not import or require `@quarkos/pi-fusion`. That project's pipeline behavior is a reference
  the spec re-derives; see "Reference-only" in `docs/plan.md`.

## Install

pi auto-discovers `extensions/*/index.ts`. Point an install at it:

```bash
ln -s "$PWD/extensions/pi-fusion-matrix" ~/.pi/agent/extensions/pi-fusion-matrix
```

Reload in a running session with `/reload`. Provider names referenced by `matrix.json` must exist in
`~/.pi/agent/models.json` — model ids are resolved by pi, so any model any installed extension
registers is usable.

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

- `/fusion <id> <prompt>` — run a named fusion; with no id, `defaultFusion` is used.
- `/fusion-matrix` — list resolvable aliases, fusions, backends, and the config layers loaded.

## License

Private.