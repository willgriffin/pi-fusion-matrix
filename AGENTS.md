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

## Where the boundary is

Pipeline shapes (`modes`), seats (`personas`), and rosters (`fusions`) are configuration. The stage
*kinds* (`parallel`, `single`, `decide`, `score`, `render`), the connector set, and the assembly rules
are code. Adding a shape or re-pointing a seat is a config edit; adding a new kind of stage is a code
change, and a config language needing its own interpreter branches is one whose validity nobody can
check.

Out of scope by decision: stages that write to disk (that needs a subprocess with tools), gate loops
that iterate until green, and plan-then-DAG execution. `verify` gates run once and report.

## Hard constraints

- **No credential handling.** Never read, resolve, cache, or log an API key. Provider ids are pi's own
  built-ins; the credential comes from pi (`ctx.modelRegistry.getApiKeyAndHeaders`). This package
  references provider ids only and ships no `models.json` block.
- **Never substitute a model to make a list line up.** An alias's `model` is exactly what runs. A vendor
  id absent from pi's catalogue is fine — seats resolve by provider + id — and drift is reported by the
  doctor, never repaired by rewriting an alias.
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

## Coding rules

- **Source files are edited with the editor, never by string replacement in a shell.** No
  `sed -i`, no `python3 -c` rewriting a file, no heredoc that does `text.replace(old, new)`: a
  mismatch is a silent no-op rather than an error, and there is no diff to review. Read the region,
  edit it, and read it back. Scripted *investigation* is fine; scripted *mutation of the tree* is not.
- **Stage what you changed, by name. Never `git add -A`.** A working tree holds what the repository is not
  supposed to have — local environment files, scratch scripts, an operator's notes — and `-A` commits all of it.
  It did: a sweep staged an untracked `.envrc` holding a live provider key, pushed it, and the key had to be
  rotated. Name the paths in the commit, and read `git status` before and after.
- **One behaviour per module, exported.** A function that can only be exercised through a whole
  pipeline run is a function whose contract nobody can test in isolation. Export the unit; the
  pipeline test then covers the wiring.
- **Every fixture is named, local, and self-contained.** No mutable module-level state shared between
  checks — a suite where check 40 depends on what check 3 left behind reports failures that move when
  you reorder it.
- **No assertion on source text, wiring, or field forwarding.** Assert what a consumer observes:
  the stream, the record, the named error. A check that reads the implementation back to itself
  fails the day the implementation is refactored correctly.
- **No unbounded waits in test code.** Anything that can await must carry its own deadline, and a
  deadline that fires is a *failed check with a message*, never a hung suite. A test that hangs is
  indistinguishable from a test that found a deadlock and from one that found nothing.
- **No test may depend on the machine it runs on.** `npm test` removes `TYPESAFE_API_KEY` from the environment
  before running, because a unit test that passes only where a key happens to be exported is a test that lies
  about its isolation — it fails in CI for a reason nobody wrote down. A test that needs a credential sets its
  own fixture value and restores the environment afterwards.

## Tests

Two kinds, and the difference is deliberate:

- `test/*.test.mjs` — unit tests, `node --test`, one file per module, run by `npm test`. Every
  exported decision (validation rules, truncation, the failure taxonomy, deadline handling) has one
  here, and the report reader's own accounting lives here too rather than in a `--check` branch: a
  module whose behaviour can only be exercised by running its script is a module nobody can test.
- **Coverage is a ratchet, and it is measured over the modules the unit tests load.** `npm test` carries
  `--test-coverage-{lines,branches,functions}` thresholds, so removing a test fails the run even when every
  remaining test passes. The floor is pinned just under the achieved figure and raised by each slice that adds
  tests; lowering it is a reviewed decision recorded in the commit that does it. What it does *not* cover is
  the contract runner below — a percentage over a script whose job is to wire canned collaborators would reward
  the wrong thing — so a module with no unit test contributes no number rather than a flattering one.
- `scripts/interp-check.mjs` — the offline *contract* runner: whole `runPipeline` runs against canned
  collaborators, no keys, no network, no quota. Its job is the wiring between modules and the shape
  of a run; it is not where a single module's behaviour belongs, and it must still pass when every
  provider is exhausted.

## Validation

Run before shipping, from the repository root:

```bash
npm test                                                                # unit tests, and the coverage floor
npm run lint                                                            # eslint, and the two repo guards
npm run format:check                                                    # prettier, code only
npm run lint:commits                                                    # conventional commits
```

```bash
node scripts/typesafe-stub.mjs & node scripts/semif-stub.mjs &          # local backends
node scripts/typesafe-probe.mjs --backend http://127.0.0.1:8793/v1/systemone
node scripts/semif-probe.mjs    --backend http://127.0.0.1:8792/score
node scripts/interp-check.mjs                                           # interpreter contracts
node scripts/doctor.mjs                                                 # config + connectivity
node scripts/session-report.mjs --json > /dev/null                       # the reader, as a program
```

The interpreter and doctor checks need no keys, no network, and no quota — they are the checks that must
still run when a provider's limit blocks a live one. Live end-to-end runs are in `docs/plan.md`
§Verification and need pi plus the providers the aliases name.
End-to-end checks are listed in `docs/plan.md` §Verification and require pi plus, for live decision
calls, `TYPESAFE_API_KEY`.

## Conventions

- Conventional Commits, with a scope from the closed list in `commitlint.config.js` — a module of this
  package, or the concern the change belongs to. `npm run lint:commits` checks every commit a branch adds over
  the default branch, and `npm run lint:commits -- --message "<title>"` checks one message, which is how a pull
  request's title is checked. An unknown scope is a failure, not a preference: the log is the only index this
  repository keeps for free.
- `docs/plan.md` changes only as part of the change that invalidates it.