# pi-fusion-matrix

Several models deliberate; one answer comes back — and every step of how that happened, including
**who got routed to what**, is configuration you can read and a run record you can audit.

A [pi](https://pi.dev) extension — and one for [omp](https://github.com/can1357/oh-my-pi), the fork of the same
stack — for multi-model deliberation. One codebase, both harnesses. It owns resolution, routing, and
execution: which model chain answers each seat, whether a cheap decision can answer instead of a model
call, which shape a run takes, which fusion a request should even use in the first place, and whether a
coding turn deliberates at all or goes to one model. It
registers one model per fusion (`fusion-matrix/best`, `fusion-matrix/cheap`, …), runs each seat
through the harness's own provider runtime and credential store, and returns a normal
assistant-message stream. Providers, endpoints, credentials, transport, and accounting stay the
harness's.

Status: implemented and verified on both harnesses — eight fusions register and run on pi
0.84.2/0.85.1 and on omp 18.2.6, from one codebase, and a pinned rung answers agent turns with the
harness's own tools. The twenty-five verification items in
[`docs/plan.md`](docs/plan.md) carry their evidence inline, and the repository's own offline contracts
(`scripts/interp-check.mjs`, `scripts/doctor.mjs`, both probes) pass with no keys and no network.

## Why this exists

Two failures of the obvious implementation:

- **Hardcoding is the default failure mode.** A fusion that pins one provider, one key, and five bare
  model ids cannot express "the same model on a second billing route", and every vendor rename becomes
  a code change. Here, providers are pi's own ids and the model chain is `matrix.json`, so a vendor
  release edits one field and no code.
- **Silent degradation is the dangerous one.** A pipeline that quietly substitutes a cheaper model, or
  streams two models' answers into one message, or presents progress lines as a result, is worse than
  one that fails. Every substitution, skipped stage, failed seat, truncated decision state, and
  declined route here is reported in the stream and recorded in the run's `details`.

## Install

```bash
pi install git:github.com/willgriffin/pi-fusion-matrix
```

Or point pi at a checkout — useful while editing config, since a local path is not copied:

```bash
pi install /absolute/path/to/pi-fusion-matrix
pi -e /absolute/path/to/pi-fusion-matrix   # try it for one run, installs nothing
```

Then `/reload` in a running session. A git install is pinned to the ref you installed — pin one
explicitly (`…@v1`, `…@<sha>`) if you want a fixed point; `pi update --extensions` reconciles the clone
to that ref rather than moving it. It declares no runtime dependencies — pi bundles the peers it lists
— so there is nothing for the installer to fetch.

The same directory loads in **omp**, which reads the same pi-style extension API:

```bash
ln -s "$PWD/extensions/pi-fusion-matrix" ~/.omp/agent/extensions/pi-fusion-matrix   # omp's own extension dir
omp --extension "$PWD/extensions/pi-fusion-matrix/index.js" -p "…" --model fusion-matrix/cheap   # or for one run
```

Both were verified end to end: the same commit answers `ZQX1` through the one-seat fusion shipped then
(`solo`; `cheap` and `quick` are those rungs now), streams a panel, runs the file agent (writing a
file through the harness's own tool call), and reports the same substitutions on pi 0.84.2/0.85.1 and
omp 18.2.6.

### One extension, two harnesses

| | pi | omp |
|---|---|---|
| extension dir | `~/.pi/agent/extensions/` | `~/.omp/agent/extensions/` |
| machine config | `~/.pi/agent/pi-fusion-matrix.json` | `~/.omp/agent/pi-fusion-matrix.json` |
| project config | `<cwd>/.pi/pi-fusion-matrix.json` | `<cwd>/.omp/pi-fusion-matrix.json` |
| streaming peer | `@earendil-works/pi-ai/compat` (`streamSimple`) | `@oh-my-pi/pi-ai` (`streamSimple`) |
| tool schema builder | the extension brings `typebox` (`Type.Object`) | the harness injects `pi.zod` (`z.object`) |
| thinking levels | passed through; the provider may ignore an unsupported level | enforced per model — an unsupported level is refused up front |

Everything in those rows is harness-specific for the same reason: provider ids, credentials, and model
capabilities differ between them. The extension detects its harness from the entry script it was
launched with, so config and peer both land on the right side without a flag.

Each peer is resolved from the running harness's own installation, realpath-verified to live inside it,
and never from a search path (a module planted in a writable ancestor directory would be executed
before any check, and would then be handed the harness's resolved credentials). An unsupported thinking
level is retried once at no reasoning level and reported — never silently lowered to a guess — and the
refusal is learned per model *and* level, so a level that is supported is still requested next time.

Requirements before the first run:

- **The providers your aliases name must exist in pi.** The packaged aliases route through
  `opencode-go`, `zai`, `kimi-coding`, and `openai`; a provider pi does not know produces a reported
  `missing provider` substitution, not a crash. Add your own with `/login` or a `models.json` entry.
- **`TYPESAFE_API_KEY` for the packaged decision backend** (`route`, `verify`, and cascades). Nothing
  else needs a key: `matrix.json` ships no `models.json` block, and this extension never reads or
  caches a credential — it asks pi for the credential of the provider a seat names, per request.
- **A catalogued model id is not required.** Seats resolve by provider + id, so an alias may name a
  model pi's curated list has never heard of. The id that answered is in `details.seats[].model`.

## Run it

```bash
pi -p "In two sentences: when is optimistic locking the wrong default?" \
   --model fusion-matrix/best --no-session
```

`best` is the ladder's ceiling — two seats, a judge, and a synthesis. A recorded five-seat committee
run (the fusion was then named `deep`; `review-check` ships the same five seats today) shows the
stream's anatomy:

```
 ├─ plan technical: kimi@opencode-go → kimi@kimi-coding → qwen-max@opencode-go
 ├─ plan skeptic: deepseek-pro@opencode-go
 ├─ plan systems: glm@opencode-go → glm@zai
 ├─ plan judge: deepseek-pro@opencode-go
 ├─ plan synth: kimi@opencode-go → kimi@kimi-coding → qwen-max@opencode-go
 ├─ ⏳ technical: opencode-go/kimi-k3 @medium
 ├─ ⏳ skeptic: opencode-go/deepseek-v4-pro
 ├─ ⏳ systems: opencode-go/glm-5.3
 ├─ ⏳ judge: opencode-go/deepseek-v4-pro @high
 ├─ ⏳ synth: opencode-go/kimi-k3
# When Optimistic Locking Is the Wrong Default
…
```

Read that transcript as the run's shape. `plan …` is the expansion of the roster into routes, printed
before the first call, so the route each seat *will* take is visible rather than inferred. `⏳` is a
seat starting, named as `provider/vendor-model @thinking` — the judge's `@high` came from that fusion's
`thinking` override, and the vendor ids are the ones actually sent upstream. Then the answer streams
from the synthesis seat only; the other four report status lines, because five interleaved answers are
unreadable.

A fusion is reachable three ways:

| surface | how |
|---|---|
| model id | `--model fusion-matrix/<id>` or `/model` — one registered model per fusion |
| tool | the `matrix` tool (fusion + prompt), for an agent that should deliberate mid-task |
| command | `/matrix <id> <prompt>`, with `/matrix` alone using `defaultFusion` |

`pi --list-models fusion` lists all eight, and `/matrix-info` prints the resolvable aliases with
their routes, the modes, the fusions with their rosters and their execute faces, and the config layers
loaded.

### A fusion as your session's model

Every fusion is also a model id, so one can be pinned as the session's model
(`modelRoles.default: fusion-matrix/quick`) — and then it gets *agent* turns: tools, the harness's own
system prompt, and a conversation that grows. Those go to one model, not through the panel:

```
turn arrives (messages + tools + system prompt)
  ├─ PROXY     forwarded verbatim to the fusion's executor; its events, tool calls included, come back
  └─ PIPELINE  the panel above, when deliberating is what you asked for
```

The branch is decided by invocation, never guessed: a tool-bearing turn on a fusion that declares an
executor proxies; `matrix`, `/matrix`, a rung whose mode writes nothing (`opinions`, `debate`), and any
turn that arrives with no tools run the pipeline exactly as before. (With this extension loaded, the
tool list is never empty — the `matrix` tool is in it — so a pinned rung proxies in practice; the
tool-less turns are the harness's side-channel calls, a title or a compaction, and those keep the
pipeline in phase 1.) Nothing is added to a proxied turn's message — no banner, no seat line, no
substitutions — because in a coding turn that text lands in the conversation and corrupts the agent
loop. A target that cannot be reached is an error message rather than a quiet deliberation; a level it
does not support is dropped once and the turn continues; and every route the alias walked is recorded
in `details.proxied.attempts`.

The executor is the fusion's **writing seat** — a pipeline's synthesis, or the single seat — so
re-pointing that one seat re-points what codes under the rung:

| rung | deliberate face | execute face |
|---|---|---|
| `cheap` | one `qwen-flash` seat @low | `qwen-flash` @low |
| `quick` | one `deepseek-flash` seat @low | `deepseek-flash` @low |
| `good` | two flash seats + a `qwen-flash` merge | `qwen-flash` @low |
| `best` | `deepseek-pro` + `glm`, judge @high, synthesis @high | `glm-flash` @high |
| `default-smrt` | one `deepseek-flash` seat, routed by a decision | `deepseek-flash` @low |
| `review-check` | five-seat committee, cascaded | `kimi` @harness |
| `opinions`, `debate` | three seats, rendered | — every turn deliberates |

`proxy: { "alias": "gpt" }` names the executor outright, for when the writer is a fine merge and a thin
coder; it is also how a `render`-ended mode declares an execute face at all. The writing seat's
`thinking` takes a concrete level, `"harness"` (run at whatever level the harness sent — it resolves
`auto` before the extension ever sees it), or nothing (the writing seat's persona level, else the
harness's). A proxying fusion registers its executor's context window and max output rather than a
facade, so a session's own context budget is the model's real one.

## The primitives

Ten things, and that is the whole vocabulary. Five are nouns you write in config (`alias`,
`persona`, `mode`, `fusion`, and the `candidate` entries inside a roster); five are behaviours you
compose (`decide`, `route`, `verify`, `fileAgent`, and the `score` stage kind).

**Routing happens in three places**, and it is worth knowing which one you are changing:

| where | decides | written with |
|---|---|---|
| before the run | which **fusion** this request deserves — `cheap`, `quick`, `good`, or `best` | `route` |
| inside a run, per seat | which **model and which account** answers it, in what fallback order | `aliases.*.providers`, a slot's `candidates` |
| inside a seat | whether a **decision** answers it outright, or escalates to a model call | a `decide` candidate + `sufficientWhen` |

The conservative rule that shapes all three: routing is always at the *whole-fusion* or *whole-seat*
level, never a silent swap of one seat inside a run. `route` picks a fusion, not a judge or a
synthesis model; a per-seat choice is a candidate list, which is ordered, validated, and reported.
Nothing swaps a model mid-run to make something fit.

The line the design draws: **shapes and seats are configuration, the interpreter is code.** Adding a
pipeline shape or re-pointing a seat is a `matrix.json` edit. The stage *kinds*, the connector set, and
the assembly rules are code, because a config language expressive enough to need interpreter branches
of its own is one whose validity nobody can check. Everything below is validated at load: a config that
cannot run fails loudly instead of registering models that pretend it can.

### `alias` — a version-free name for a vendor model

```json
{
  "aliases": {
    "deepseek-flash": { "model": "deepseek-v4.1-flash", "providers": ["opencode-go"] },
    "glm":            { "model": "glm-5.3",             "providers": ["opencode-go", "zai"] },
    "kimi":           { "model": "kimi-k3",             "providers": [
                         "opencode-go",
                         { "id": "kimi-coding", "modelOverride": "k3" }
                       ] }
  }
}
```

`model` is the vendor id sent upstream verbatim; `providers` is the **ordered route list** — same
model, tried in order, which is how one model reaches a second billing account or survives one
account's outage. The name is what every fusion mentions, so a vendor release that renames
`deepseek-v4.1-flash` to `deepseek-v4-flash` is a one-field edit that no fusion, seat, or mode sees.

The object form (`{ "id": ..., "modelOverride": ... }`) is for when two providers name the same model
differently. `maxTokens`, `contextWindow`, and `reasoning` are optional per alias, and a declared value
wins over pi's catalogue template for that provider — an undeclared one leaves the template alone,
because those fields feed the request's output envelope and pi's thinking-budget maths. They also decide
what a fusion whose executor is that alias registers to the harness, so declaring them is how a re-pointed
writer keeps a real context window instead of the package default (see
[A fusion as your session's model](#a-fusion-as-your-sessions-model)).

### `persona` — a seat: what it is told, how it samples

```json
{
  "personas": {
    "technical": { "prompt": "prompts/technical.md", "temperature": 0.5, "thinking": "medium" },
    "judge":     { "prompt": "prompts/judge.md",     "temperature": 0.2, "output": "json" },
    "terse":     { "prompt": "Answer in one paragraph.\nName the strongest objection to the proposal above." }
  }
}
```

Defined once and reused by every mode and fusion, so "the judge" is one definition rather than a
property of one pipeline position. `prompt` is a path — relative to the config file that declares it,
so your own persona file never has to live in this repo — or inline text. The rule that separates
them, and it is worth knowing because the loader takes it literally: **a prompt containing a newline
is text; one without is a filename.** A one-line inline prompt therefore needs an explicit `\n` (as
above), and a persona whose path does not exist is a load error naming it, not a silent empty prompt.
`thinking` is pi's reasoning level for that seat, `temperature` its sampling, and `output: "json"` asks
the seat for a JSON object, parses it with a fence-then-braces recovery, and keeps the raw text under
`unique_insights` if parsing fails, so a downstream stage still receives something.

A fusion can override one persona's prompt for one fusion only, and its `thinking` level the same
way — `good` uses the latter to hold all three of its seats at `low`.

### `mode` — a shape: an ordered list of stages

```json
{
  "modes": {
    "pair": {
      "stages": [
        { "parallel": ["technical", "skeptic"], "input": "prompt" },
        { "single": "merge", "input": "panel" }
      ]
    }
  }
}
```

A mode says what happens, never which model does it. Nine ship, and the call count is the feature —
a shape that quietly adds or drops a call is a bug:

| mode | stages | model calls |
|---|---|---|
| `single` | `single` | 1 |
| `pair` | `parallel` → `single` | 3 |
| `pair-judged` | `parallel` → `single` → `single` | 4 |
| `lean` | `parallel` → `single` (synthesizer absorbs the judge) | 3 |
| `committee` | `parallel` → `single` → `single` | 5 |
| `committee-merged` | `parallel` → `single` `alsoSynthesize` | 4 |
| `opinion` | `parallel` → `render` | 3, no generation |
| `debate` | `parallel` `rounds: 3` → `render` | 9 |
| `committee-cascaded` | `parallel` → `decide` → `single` → `single` | 5 + 1 decision call |

`pair`, `committee`, and `committee-merged` ship as vocabulary with no fusion on them. The eight
fusions sit on `single` (`cheap`, `quick`, and `default-smrt`, which adds one route decision),
`lean` (`good`), `pair-judged` (`best`), `opinion` (`opinions`), `debate` (`debate`), and
`committee-cascaded` (`review-check`).

### `fusion` — a mode bound to a roster, and the model pi registers

```json
{
  "fusions": {
    "best": {
      "mode": "pair-judged",
      "thinking": { "judge": "high", "synth": "high" },
      "candidates": {
        "technical": ["deepseek-pro"],
        "skeptic": ["glm"],
        "judge": ["deepseek-flash"],
        "synth": ["glm-flash"]
      },
      "fileAgent": false
    }
  }
}
```

This is the object you actually invoke: it becomes `fusion-matrix/best`. Every persona the mode uses
must appear in the roster and nothing may appear that the mode does not use — the loader rejects the
mismatch rather than orphaning a model silently. Optional keys: `thinking` and `prompts` (per-persona
overrides), `fileAgent`, `maxAdvance` (how many candidates one seat may walk, default 3), `verify`, and
`route`.

That roster is one face of the definition; the other is what answers an *agent* turn. The writing seat
— the persona of the mode's final `single` stage — is the fusion's executor, unless `proxy.alias` names
another one:

```json
{
  "fusions": {
    "best": {
      "mode": "pair-judged",
      "proxy": { "alias": "gpt" },
      "candidates": { "technical": ["deepseek-pro"], "skeptic": ["glm"], "judge": ["deepseek-flash"], "synth": ["glm-flash"] }
    }
  }
}
```

`proxy` and `route` on one fusion is a load error — a proxied turn runs no pipeline, so the route could
never fire — and `thinking: { "synth": "harness" }` is legal for the writing seat alone, since no other
seat has a harness level to inherit.

### `candidate` — one slot in a roster, three forms

```json
{
  "candidates": {
    "technical": [
      "glm",
      { "alias": "kimi", "providers": ["kimi-coding", "opencode-go"], "thinking": "high" },
      {
        "decide": {
          "instructions": "Do the experts agree on a single recommendation?",
          "criteria": {
            "agrees": "They converge on the same recommendation.",
            "partial": "They overlap but differ on something substantive.",
            "disagrees": "They recommend different things."
          }
        },
        "sufficientWhen": { "choiceIs": "agrees", "minConfidence": 0.85 }
      }
    ]
  }
}
```

A bare alias id, an alias with its route list or thinking re-ordered for this slot only, or **a
decision** — which is what makes a cascade possible. A seat walks its candidates in order: a model
candidate is a model call, a decision candidate is one backend call that may answer the slot outright.
Falling from an alias to the next alias is a *substitution* (a different model, always reported);
falling to the next provider inside an alias is a re-route (the same model, also reported).

### Stage kinds

Each stage declares exactly one kind, plus its `input` (the connector below).

```jsonc
{ "parallel": ["technical", "skeptic", "systems"], "input": "prompt" }          // concurrent seats
{ "parallel": […], "rounds": 3, "roundInput": "peers" }                          // debate: each round sees every OTHER seat's last answer
{ "single": "judge", "input": "panel" }                                          // one seat
{ "single": "judge", "input": "panel", "alsoSynthesize": true }                  // …and it answers, in the same message
{ "decide": { "instructions": "…", "criteria": { … } }, "input": "panel" }       // one backend call, no generation
{ "score": { "instructions": "How well does this response address the question?",
             "criteria": ["off-topic", "partial", "solid", "thorough"] }, "over": "panel" }   // one batched call
{ "render": "panel", "input": "panel+weights" }                                  // assemble text, call no model
```

`parallel` runs its seats concurrently and drops a degraded seat from later rounds. `single` is one
call; a mode must end in `single` or `render`, because anything else produces no assistant message
(the loader says so). `decide` is a closed question — with a `sufficientWhen` it also *gates* the next
stage, which is the cheap-read-before-expensive-judge pattern. `score` rates every panel seat against
a level list in one request. `render` is how a shape ends without generating, and its output is sent
to the caller like any answer.

### Connectors — what a stage receives

```jsonc
{ "single": "synth", "input": "panel+judge" }
```

| connector | resolves to |
|---|---|
| `prompt` | the user's request |
| `panel` | every seat of the most recent `parallel` stage, labelled with the model that answered |
| `panel+judge` | that panel, plus the output of the `single` stage immediately before this one |
| `panel+weights` | that panel, plus per-seat `score (confidence)` lines from the most recent `score` |
| `peers` | inside a `rounds` stage: every **other** seat's previous-round output |
| `previous` | the immediately preceding stage's output |
| `{{name}}` | the output of the earlier stage that declared `"name": "…"` |

An unresolved connector is a load error — the validator walks the stage list as dataflow, so a shape
that reads something nobody produced never reaches a run.

### `decide` and the backend seam

```json
{
  "decide": { "defaultBackend": "typesafe" },
  "backends": {
    "typesafe": { "kind": "typesafe", "url": "https://api.typesafe.ai/v1/systemone",
                  "apiKeyEnv": "TYPESAFE_API_KEY", "model": "jev-1.13.0" },
    "semif":    { "kind": "semif", "url": "http://127.0.0.1:8791/score", "model": "qwen3.5-4b" }
  }
}
```

One vocabulary, two backends, normalised so no stage code branches on which one answered. A decision
is either a **criteria** choice (an option map, the common case) or **typed questions** (`noul`,
`choice`, `score`, batched — TypeSafe only; SemIf's row schema is one question per request, and that
is a load error rather than a runtime surprise). `state` may use any connector, and defaults to the
stage's input (for `route`, to `{{prompt}}`); it is truncated from the middle, with a notice, rather
than sent oversized.

| | `typesafe` | `semif` |
|---|---|---|
| answers | choices, scores, noul, with calibrated `confidence` | option probabilities, **no** confidence |
| batching | all questions in one request | one question per request |
| gating | may gate a route or a slot cascade | may gate nothing — a load error |
| placement | hosted; input tokens billed | local (`tools/semif-server/`), zero marginal cost |

SemIf's own output calls its probabilities "uncalibrated as decision confidence", which is why a
backend without confidence cannot steer cost: a threshold against an uncalibrated number would be
noise pretending to be a policy.

### `sufficientWhen` — the cascade

```json
{
  "decide": { "instructions": "Do the experts agree?", "criteria": { "agrees": "…", "disagrees": "…" } },
  "sufficientWhen": { "choiceIs": "agrees", "minConfidence": 0.85 }
}
```

A decision is *actionable* when its answer matches and its confidence clears the bar. When it is not,
the seat (or the stage) escalates: the next candidate runs, or the next stage runs, with the cheap
read's answer handed forward as a prior so the expensive stage addresses the ambiguity instead of
rediscovering it. A cascade that escalates every time is measurable dead weight — which is why every
run records `details.cascades` with the answer, whether it was sufficient, and what it advanced to.
Tune thresholds from that data, not intuition. Thresholds live in `sufficientWhen` and nowhere else.

### `route` — pick a fusion before the first stage

```json
{
  "route": {
    "instructions": "How much deliberation does this request need?",
    "criteria": {
      "trivial":       { "description": "A direct factual or mechanical question", "then": "quick" },
      "architectural": "System-level tradeoffs with long-lived consequences"
    }
  }
}
```

One decision before anything runs; the option that wins may name another fusion to run instead. The
action lives with the option it applies to, options without `then` simply run this fusion, and a
target may not route again (one hop). The gate defaults to `minConfidence` 0.5 and the effective
threshold is recorded, because "unsure means spend, not gamble" has to be visible when it declines.
An outage is reported as an outage — never as "no option matched".

This is the escalation route: `default-smrt` sends `"Reply with exactly: ZQX1"` to `cheap`, and keeps
an architectural prompt on its own seat — its criteria are `cheap`, `quick`, `good`, and `best`, with
`unsure` falling to `quick`, and it is the packaged `defaultFusion`. As recorded on 2026-09-18, the
router shipped then (`review-routed`; `default-smrt` has since replaced it) printed
` ├─ ↪ routed to quick (trivial, conf 1.00)` and
` ├─  route declined (architectural); running review-routed`.

### `verify` — report after the synthesis, never rewrite it

```json
{
  "verify": [
    { "state": "{{synthesis}}",
      "questions": { "grounded_in_panel": { "type": "noul",
                     "instructions": "Every substantive claim traces to the expert responses." } } },
    { "gate": { "command": ["just", "test"], "expectExit": 0, "timeoutMs": 120000 } }
  ]
}
```

A decision entry or a gate. Both are **report-only**: a low `noul`, a pessimistic choice, a low
confidence, or a gate that exits unexpectedly emits one warning line and changes nothing about the
answer; a backend failure is recorded as skipped, not as a run failure. A gate runs its argv once, in
the session cwd, with bounded output and an escalating kill — no loop, no feedback into a stage. Gates
and backends may only be declared by the packaged config or `~/.config/pi-fusion-matrix/matrix.json`
(see the trust boundary below).

### `fileAgent` — files out of a synthesis

```json
{ "fusions": { "best": { "fileAgent": { "alias": "deepseek-flash" } } } }
```

One cheap seat, after the synthesis, decides whether the answer contains files worth saving and asks
to write them. It is not a stage — it cannot change the answer — and `"fileAgent": false` disables it.
The packaged fusions all ship it disabled; enabling it for one fusion is the line above.
In a streamed pi run the writes are handed to pi as tool calls, so pi's own permission gate applies; a
write result ends the run with a confirmation rather than starting a second deliberation. Through the
tool and command paths there is no such gate, so the extension confines writes to the session
directory, refuses absolute paths and `..`, and reports what it refused.

## Fallback and reporting

Two layers, independently configured and always reported. Lines from real runs:

```
 ├─ ↩ skeptic deepseek-pro@nope → deepseek-pro@opencode-go (missing provider)
 ├─ ↩ systems kimi@nope → glm@opencode-go (missing provider)
 ├─ ↩ synth-lean glm@opencode-go → glm@zai (quota)
 ├─ ⚠️ No deliberation happened: 3 of 3 seats were unavailable (quota). Nothing was synthesized — this is not an answer.
```

A failure is classified (`quota`, `credential`, `missing model`, `transient`), retried once if
transient, then advanced — and text already streamed is never extended by the next provider's reply.
A seat that dies does not abort the run; a run whose every seat died says so instead of presenting
progress lines as an answer; a stage a sufficient decision skipped is recorded as `skipped`.

The run record is the audit trail: `details.stages` (kind and calls per stage — the cost contract),
`details.seats` (persona, alias, provider, vendor `model`, `template`, thinking, usage), plus
`details.seatErrors`, `details.substitutions`, `details.cascades`, `details.routing`,
`details.verification`, `details.rounds`, and `details.usage` — with `seatErrors` and `substitutions`
always present, empty arrays included.

A proxied turn is one model call, so it records `details.proxied` instead: the `alias`, `provider`,
vendor `model`, and `template` that answered, the `thinking` level it ran at, and `attempts` — every
route the alias walked before one answered. Nothing about it is in the message, which is the point;
the record is where a proxied turn's routing is auditable.

## What leaves your machine

Two things, and both are worth knowing before the first run:

- **Decisions go to the backend you configure.** The packaged default is TypeSafe
  (`https://api.typesafe.ai/v1/systemone`, key from `TYPESAFE_API_KEY`), and every decision call sends
  the deliberation **state** there: the panel's raw responses for a cascade or a `score` stage (source
  code included, when a review carried it in), the synthesis for `verify`, and the prompt for `route`.
  That content leaves the host verbatim. Point `decide.defaultBackend` at the local `semif` backend
  (`http://127.0.0.1:8791/score`, see `tools/semif-server/`) for content that must not leave the host.
- **Seats go to the providers your aliases name.** Panel responses are sent to the judge and synthesis
  seats, which may be different vendors — that is the point of a fusion, and it is why the alias table
  is where you decide who sees what.

Nothing else is transmitted. There is no telemetry, and the extension does not read, resolve, cache, or
log a credential: it asks pi for the credential of the provider a seat names, per request.

## Trust boundary

The project layer — `.pi/pi-fusion-matrix.json` under pi, `.omp/pi-fusion-matrix.json` under omp —
comes from whatever repository you are in, so it is treated as untrusted. It may change aliases,
personas, modes, and fusions — routing and billing — but it may **not** introduce a decision backend,
add a `verify` gate command, or point a persona prompt at a file outside the repo that declared it.
Those are the three surfaces that can send content to an endpoint, run a command, or read a file into a
prompt, and they come only from the packaged config and the machine layer, which are yours. Validation
rejects them, naming the entry.

## Configuration layers

`matrix.json` merges across layers, lowest priority first; objects merge field by field, arrays and
scalars replace. The machine and project layers are **per harness**, because the things they carry —
provider ids, credentials, thinking levels — are harness facts: the same account is `kimi-coding` in pi
and `kimi-code` in omp, and one harness's key can be stale while the other's still works.

| layer | pi | omp | trust |
|---|---|---|---|
| packaged | this repo's `matrix.json` | same file | trusted |
| machine | `~/.pi/agent/pi-fusion-matrix.json` | `~/.omp/agent/pi-fusion-matrix.json` | trusted (yours) |
| project | `<cwd>/.pi/pi-fusion-matrix.json` | `<cwd>/.omp/pi-fusion-matrix.json` | untrusted (see above) |

Those are the directories each harness already reads — `<cwd>/.pi/settings.json` and
`<cwd>/.omp/settings.json` are its own project settings — so this config sits beside every other
harness-specific setting rather than inventing a second convention. `PI_CODING_AGENT_DIR` moves the
agent directory for both harnesses, so pointing it at a scratch directory isolates the config too;
`/matrix-info` and `matrix doctor` both print the harness and the layers they actually loaded.

So a project can re-point one alias at another account, or swap a slot's roster, without touching a
fusion or this repository:

```json
{ "aliases": { "glm": { "providers": ["opencode-go-work", "opencode-go", "zai"] } } }
```

Top-level knobs: `providerId` (default `fusion-matrix`), `providerName`, `defaultFusion` for the tool
and the bare `/matrix`.

## Commands, the tool, and the doctor

- `/matrix <id> <prompt>` — run a named fusion; `/matrix` alone uses `defaultFusion`.
- `/matrix-info` — resolvable aliases with their routes, modes, fusions with rosters and execute faces, backends, layers.
- `/matrix-doctor` (`--online`, `--repair`) — validate the config, check provider connectivity, and
  report catalogue drift. `node scripts/doctor.mjs` runs the same checks outside a session:

```
matrix doctor — layers: ~/…/pi-fusion-matrix/matrix.json → ~/.config/pi-fusion-matrix/matrix.json
· [connect] no model registry available (running outside pi); connectivity not checked
· [connect] alias "glm-flash" has a single route, so a quota or outage on opencode-go has no fallback
…
```

Exit status separates *broken* from *out of date*: `0` clean, `1` config errors, `2` connectivity,
`3` reachability or drift — so CI and a pre-run hook can tell "fix this" from "review this". Repairs
are additive only: `--repair` prints the `models.json` upsert snippet for an id you want in pi's own
picker, never rewrites an alias, and never picks a replacement model. Drift is a report, not a rewrite.

## Verifying the package itself

Offline — no keys, no network, no GPU. These are the checks that must still run when a provider's
quota blocks a live one:

```bash
node scripts/typesafe-stub.mjs & node scripts/semif-stub.mjs &      # local backends
node scripts/interp-check.mjs                                       # 27 interpreter contracts
node scripts/doctor.mjs                                             # config + connectivity
node scripts/typesafe-probe.mjs --backend http://127.0.0.1:8793/v1/systemone
node scripts/semif-probe.mjs    --backend http://127.0.0.1:8792/score
```

The same two probes run against the real backends when you want the contract checked live
(`--backend https://api.typesafe.ai/v1/systemone`, and export `TYPESAFE_API_KEY`; the probe defaults to
the pinned model in `matrix.json`).

`interp-check` covers the contracts a refactor breaks first: a sufficient stage decision skips the
stage it gates with no judge call, an ambiguous one escalates with a prior, debate makes 3 seats × 3
rounds with peers' opinions, a `score` stage issues **one** batched request, `verify` warns without
blocking, and a confident route redirects while an unconfident one declines. Its proxy cases drive the
real stream against a stub peer: the harness's `messages`, `tools`, and `systemPrompt` forwarded
byte-identical, the target's tool call reaching the caller, the message holding the model's output and
nothing else, no seat call, `details.proxied` on the terminal event's message, a render-ended rung still
deliberating with tools present, the thinking table's cases, an unresolvable route advancing with the
attempt recorded, a refused level dropped once, a route that dies mid-stream ending the turn, and an
unreachable executor ending as an error instead of a deliberation. The same file asserts what the
extension *registers* — the executor's numbers and thinking capability per rung — and what
`/matrix-info` prints for each fusion's execute face.

## What it does not do

- **No providers, endpoints, or credentials.** Those are pi's (`models.json`, `/login`, `auth.json`).
- **No dependency on `@quarkos/pi-fusion`.** That project's pipeline behaviour is a reference the spec
  re-derives; nothing here imports a sibling checkout or an absolute path, and the package runs with
  every other extension disabled.
- **No stages that write to disk, no gate loops, no task DAG.** A seat is one model call; a gate runs
  once and reports. Plan-then-DAG execution is a scheduler, not a deliberation pipeline.
- **No panel inside the agent loop.** A proxied turn is one model call. Deliberation stays behind
  `matrix`, `/matrix`, or an explicitly invoked rung — four calls per agent turn is exactly what proxy
  mode exists to avoid — and pi/omp keep the loop, the tools, and the approval gates either way.
- **No silent model substitution, ever.** An alias's `model` is exactly what runs; a finding about an
  id that moved is a doctor report, not an automatic repair.

## Credits

This project exists because someone else worked out how to make several models deliberate inside an
agent, and published it.

- **[pi-fusion](https://github.com/QuarkOS/Pi-Fusion)** (`@quarkos/pi-fusion`) by **Antigravity Pair** —
  the multi-model deliberation harness the whole design is derived from: its pipeline order, committee
  shapes, seat assembly, prompt-assembly headers, failure taxonomy, temperature-rejection memory, and
  `streamSimple` event sequence are what this repository re-derives in its own code — the judge →
  synthesis stages under `best` and the cascaded committee `review-check` runs are its panel → judge →
  synthesis pipeline. The persona prompts in `prompts/*.md`
  are transcribed verbatim from its `pi-harness.config.json`, so its **MIT licence (© 2026 Quark)** and
  notice travel with them — see [`THIRD-PARTY-NOTICES.md`](THIRD-PARTY-NOTICES.md). It is a reference,
  never a dependency: nothing here imports it, and the locally-patched vendored copy that served as the
  working reference is archived and can be deleted.
- **[fusion-harness](https://github.com/disler/fusion-harness)** by **IndyDevDan** (MIT, © 2026) — the
  other reference, and the source of this project's `single` and pair shapes (one model; two seats and
  a merge) and of its deliberation surface: N-way independent opinions,
  and debate rounds where each seat receives every other seat's labelled prior opinion, a failed seat is
  dropped from later rounds, and no judge arbitrates. Its single-writer rule is why the file agent is
  one seat and not many. Three of its shapes are deliberately *not* here, and that boundary is stated in
  the spec: its sole-writer FUSION agent writes to disk through a subprocess with tools — served here by
  proxy mode, where the harness holds the tools and the write, rather than by a stage — its gate-first
  loop iterates until green, and its plan-then-DAG collaboration is a task scheduler. No text is copied
  from it; the patterns are re-derived, as the notices file records.
- **[SemIf](https://github.com/TheoLeeCJ/SemIf)** (formerly OpenJev) by
  [TheoLeeCJ](https://github.com/TheoLeeCJ), MIT — the local, zero-marginal-cost decision backend.
  `tools/semif-server/` wraps it as published, importing `semif_phase1` rather than reimplementing the
  model loading or the logit readout; no SemIf changes are made by this repository. SemIf is an
  independent project, unaffiliated with TypeSafe, and nothing here implies otherwise.
- **[TypeSafe](https://api.typesafe.ai)** ([docs](https://docs.typesafe.ai)) — the hosted decision
  backend behind `route`, `verify`, and every cascade by default. `decide.js` is an original client for
  its published `/v1/systemone` shapes.
- **[pi](https://github.com/earendil-works/pi)** by Mario Zechner, and
  **[omp](https://github.com/can1357/oh-my-pi)** by Stencil Labs, Inc. — the two harnesses this runs
  inside, each of which owns the providers, credentials, transport, and accounting this file keeps
  pointing at.

## Reference

- [`docs/plan.md`](docs/plan.md) — the canonical spec: config schema, the seat algorithm, the failure
  taxonomy, the decision contract, and the verification items with their evidence.
- [`docs/plan.md` §Critical files](docs/plan.md) — upstream references used to derive behaviour
  (pi's provider docs, TypeSafe's API, SemIf), never vendored.

Private / unlicensed.