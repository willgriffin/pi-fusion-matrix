# Repository Agent Instructions

Shared policy, portable skills, and the generated kernel arrive from the private control-plane
repository. This file adds repository-specific rules only; it never weakens the kernel.

## What this repository is

A pi extension that resolves fusions, executes each slot through pi's own provider runtime, and
returns a normal pi assistant-message stream. It owns resolution and reporting; pi owns providers,
credentials, transport, and accounting.

Read `.agents/project.yaml` first, then the nearest `AGENTS.md` files.

## Source of truth

[`docs/plan.md`](docs/plan.md) is the implementation spec. It is decision-complete: implementers work
from it rather than re-deriving design. Where this file and the plan disagree about repo-local
conventions, this file wins; where they disagree about behavior, the plan wins and the disagreement
is a bug in one of them.

## Hard constraints

- **No credential handling.** Never read, resolve, cache, or log an API key. Providers arrive from
  `~/.pi/agent/models.json`; this package references provider ids only.
- **No absolute or sibling-checkout imports.** Nothing may import from a developer checkout path.
  `@quarkos/pi-fusion` is a
  reference implementation to be re-derived, never a dependency — it must run in a container with no
  developer checkout present.
- **No silent degradation.** Every substitution, skipped slot, truncated decision state, or failed
  verification is reported in the stream and in tool `details`. A run that degraded quietly is a
  wrong answer.
- **Decisions stay conservative.** `verify` is report-only; `route` selects a whole fusion and never a
  judge or synthesis model; a backend that reports no `confidence` (SemIf) may not gate anything.
- **Uncertainty escalates, never guesses.** The rule is uniform: at fusion level an unsure decision
  declines to route, and at slot level a decision whose answer is not actionable (`sufficientWhen`
  unmet) advances to the next candidate with reason `"insufficient"` — reported distinctly from a
  failure, with its answer and confidence, and handed forward as a prior. Every run records
  `details.cascades`, because a cascade whose cheap path rarely wins is configuration to delete.
- **Aliases are version-free.** A vendor id appears only in `aliases.<name>.model` (and fixtures/docs),
  never in a `fusions` entry, a `slots` list, or code. It cannot live in `models.json` instead: pi sends
  a model's `id` upstream verbatim and keys the registry by `provider` + `id`.

## Validation

Run before shipping, from the repository root:

```bash
node scripts/semif-probe.mjs --backend http://127.0.0.1:8792/score      # offline contract
node scripts/typesafe-probe.mjs --backend http://127.0.0.1:8793/v1/systemone
```

Both stubs must be running first (`node scripts/semif-stub.mjs &`, `node scripts/typesafe-stub.mjs &`).
End-to-end checks are listed in `docs/plan.md` §Verification and require pi plus, for live decision
calls, `TYPESAFE_API_KEY`.

## Conventions

- Conventional Commits, no scope unless the repository's own commitlint allows it.
- `docs/plan.md` changes only as part of the change that invalidates it.