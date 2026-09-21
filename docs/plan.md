# pi-fusion-matrix — fusions with per-slot fallback, native providers, and a SemIf decision backend

## Context

`@quarkos/pi-fusion` ([upstream](https://github.com/QuarkOS/Pi-Fusion) by Antigravity Pair, MIT;
a local vendored copy serves as the reference implementation) hardcodes one
provider per fusion: `applyProfile` sets `config.provider` and a single
`providers[provider].defaultModels` map of five bare model ids, and `lib/api.js` builds one
`ApiClient` with one baseUrl and one key. Its shape is also fixed in code — `mode` selects one of two
hard-coded pipelines — so a different arrangement needs a different build. Neither can express what is
needed: named pipeline shapes, seats with ordered fallback candidates, aliases that survive vendor
version bumps, and decision backends inside the pipeline.

Build a new extension `pi-fusion-matrix` in its own repo that owns fusion resolution only. Providers,
endpoints, and credentials stay pi's job in `~/.pi/agent/models.json` (or an extension-registered
provider): the extension never resolves a secret, never owns a baseUrl, and leans on pi for auth,
caching, and telemetry. It resolves aliases to *native* provider/model pairs, executes each seat
through pi's own `streamSimple`, and falls back provider-by-provider inside an alias and
model-by-model across a seat's candidate entries, with every substitution reported. Pipeline shapes
(`modes`) and seats (`personas`) are configuration, so a cheap two-model pair and a five-call
committee are two stage lists, not two code paths. The existing `pi-fusion`
fork stays installed and untouched, and is read as a *reference* for behaviors re-derived here (Step 6);
nothing imports it at runtime.

Required outcomes: (1) pipeline shapes defined in config — a stage list per mode, seats defined once
as personas and filled by ordered candidate chains — including the pair-and-pick-one heart of
[`disler/fusion-harness`](https://github.com/disler/fusion-harness) and the committee shape of
[`@quarkos/pi-fusion`](https://github.com/QuarkOS/Pi-Fusion); (2) version-free aliases so a vendor model
bump edits one field and no fusion; (3) a pluggable decision backend usable as a pipeline stage (a
question, a scored fan-out, a cascade that escalates when its answer is not actionable), a
post-synthesis check, or a routing gate — TypeSafe (`https://api.typesafe.ai/v1/systemone`, calibrated
`confidence`, no local service) as the default here, SemIf as the local zero-marginal-cost
alternative; (4) every substitution, decision, and cascade observable in the transcript and in tool
details; (5) credentials and endpoints remain entirely pi-owned; (6) the maps when they are asked for
and one competent model the rest of the time — a fusion that declares an executor answers a
tool-bearing turn itself (Step 9), so a rung can be a session's model and code with the harness's own
tools rather than describing what it would do with them.

Decisions run conservatively: they never replace a frontier pipeline call. They only (a) verify a
degraded or substituted slot's output and report it, and (b) select a cheaper fusion when confident.
Low confidence escalates to the expensive path rather than silently deciding.

## Approach

### Step 1 — New repo, package skeleton, config loading

Create the repository root with:

```
package.json            # private package declaring pi.extensions
matrix.json             # the packaged config (aliases, personas, modes, fusions, decide, backends)
README.md
AGENTS.md
docs/plan.md            # this spec
prompts/                # persona prompts, referenced by path from matrix.json
  technical.md skeptic.md systems.md judge.md synth.md synth-lean.md merge.md
extensions/pi-fusion-matrix/
  index.js              # entry: provider, tool, commands
  config.js             # layered load, merge, interpolation, the Step 1 rule set
  resolve.js            # alias → provider/model, the credential seam, template choice
  pipeline.js           # stage interpreter: parallel/single/decide/score/render, rounds, cascades
  run.js                # pi's stream protocol, route, verify, file agent, proxy branch, peer resolution
  decide.js             # TypeSafe and SemIf clients
  doctor.js             # config, connect, metadata, reach, drift
scripts/
  doctor.mjs            # standalone doctor entry point
  interp-check.mjs      # offline interpreter contracts (no keys, no quota)
  semif-stub.mjs typesafe-stub.mjs
  semif-probe.mjs typesafe-probe.mjs
tools/semif-server/     # operator-run scoring service
  server.py requirements.txt Dockerfile README.md
```

There is no `accounts.ts`, no credential resolution, and no baseUrl anywhere in this extension:
`models.json` is the single place a key or endpoint is named.

Layout rationale: pi auto-discovers `extensions/*/index.ts` and treats a directory with a `pi`
manifest in `package.json` as a package (`dist/core/extensions/loader.js:506-508` — read this
session). The directory form is used so the module can grow; the manifest declares the entry point.

`package.json`:

```json
{
  "name": "pi-fusion-matrix",
  "private": true,
  "version": "0.1.0",
  "type": "module",
  "keywords": ["pi-package"],
  "pi": { "extensions": ["./extensions"] },
  "dependencies": {},
  "peerDependencies": {
    "@earendil-works/pi-ai": "*",
    "@earendil-works/pi-coding-agent": "*",
    "typebox": "*"
  }
}
```

`dependencies` stays empty: the extension uses node builtins plus pi-bundled peers. Do not add npm
deps; pi installs nothing for a local-path package.

Wire it into the pi config repo by symlink (documented local-path sharing; no npm publish):

```bash
ln -s "$PWD/extensions/pi-fusion-matrix" ~/.pi/agent/extensions/pi-fusion-matrix
```

`config.ts` exports these types and functions:

```ts
/** A native pi provider that some installed source registers: pi's models.json, or another extension. */
export type ProviderRef = { id: string; modelOverride?: string };

/**
 * An alias is a stable, version-free name for a model slot ("deepseek-flash"). `model` is the vendor
 * id actually sent upstream — the only place a version appears — so a vendor release edits that one
 * field and no alias name, fusion, or slot changes. `providers` is the ordered native-provider list to
 * try (the same-model fallback layer), and `modelOverride` on a provider covers a catalogue that names
 * the same model differently.
 *
 * The vendor id must live here: pi's `models.json` passes a model's `id` to the provider verbatim, and
 * the registry is keyed by `provider` + `id`, so an alias name cannot stand in for vendor id upstream.
 */
export type AliasSpec = {
  model: string;
  providers: (string | ProviderRef)[];
  maxTokens?: number;
  contextWindow?: number;
  reasoning?: boolean;
};

/**
 * A decision: a closed question over an option set, answered by whichever backend the config selects.
 * `state` may contain {{prompt}} {{panel}} {{judge}} {{synthesis}} {{cwd}}.
 * `questions` (batched, typed, TypeSafe only) and `options` (single choice, both kinds) are exclusive:
 * declaring both, or neither, is a load error.
 */
export type TsQuestion =
  | { type: "noul"; instructions: string; criteria?: { true?: string; false?: string } }
  | { type: "choice"; instructions: string; criteria: Record<string, string | null> }
  | { type: "score"; instructions: string; criteria: string[] };

export type DecideSpec =
  | { state: string; options: { id: string; description: string }[]; question: string; backend?: string }
  | { state: string; questions: Record<string, TsQuestion>; backend?: string };

/** A routing option: a description the model reads, and the fusion to run when this option wins. */
export type RouteCriterion = string | { description?: string; then?: string };

export type RouteSpec = {
  instructions: string;
  criteria: Record<string, RouteCriterion>;   // 2..16 option ids; at least one carries `then`
  state?: string;                             // default "{{prompt}}"
  backend?: string;
  /**
   * Same predicate as a slot cascade, at fusion level: the winning option must carry `then`, and
   * `sufficientWhen` (default `{ minConfidence: 0.5 }`) must hold. Otherwise the run proceeds as this
   * fusion — unsure means spend, not gamble.
   */
  sufficientWhen?: SufficientWhen;
};

/**
 * When a decision's answer is actionable enough to stop the cascade. Omitted conditions are not
 * tested; all supplied conditions must hold. A candidate whose answer is not sufficient advances to
 * the next candidate with reason `"insufficient"` — a success that escalates, not a failure.
 */
export type SufficientWhen = {
  choiceIs?: string | string[];   // the winning option id, or any of several
  noulAbove?: number;             // noul at or above this counts
  scoreAbove?: number;            // score at or above this counts
  scoreBelow?: number;            // score at or below this counts
  minConfidence?: number;         // choice/score confidence at or above this counts
};

/** A slot entry is an alias id, an object pinning/reordering that alias's providers, or a decision. */
export type SlotCandidate =
  | string
  | { alias: string; providers?: (string | ProviderRef)[]; thinking?: Persona["thinking"] }
  | { decide: DecideSpec; sufficientWhen?: SufficientWhen };

/**
 * A persona is a seat: what it is told, how it samples. Defined once and reused by any mode or fusion,
 * so "the judge" is one definition rather than one property of one pipeline position.
 * `prompt` is inline text or a path relative to the config file that declares the persona.
 */
export type Persona = {
  prompt: string;
  temperature?: number;               // default 0.7
  thinking?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
  output?: "text" | "json";           // `json` requests JSON and parses it with the two-stage recovery
};

/**
 * What a stage receives. Every connector but `prompt` must name something an earlier stage produced,
 * which the loader verifies by walking the stage list (a dataflow error, not a syntax error).
 *   prompt       the user's request
 *   panel        every seat of the most recent `parallel` stage, labelled by persona
 *   panel+judge  that, plus the output of the single stage immediately before this one
 *   panel+weights  that, plus per-seat weights from the most recent `score` stage
 *   peers        inside a `rounds` stage: every other seat's previous-round output, labelled
 *   previous     the immediately preceding stage's output
 *   {{name}}     the output of the stage that declared `name`
 */
export type StageInput = "prompt" | "panel" | "panel+judge" | "panel+weights" | "peers" | "previous" | string;

/**
 * A `score` stage rates each item of `over` against an ordered list of levels — `criteria` is the one
 * surface where it is an array rather than an option map — and all items travel as `score` questions
 * batched into one request, so the answer carries a level and a confidence per seat.
 */
export type ScoreSpec = { instructions: string; criteria: string[]; state?: string; backend?: string };

/**
 * A stage. Exactly one of `parallel`, `single`, `decide`, `score`, `render` is set.
 *   parallel  run every listed persona concurrently, one candidate chain each
 *   single    run one persona once (`alsoSynthesize` folds the final answer into this call)
 *   decide    one choice question over `criteria`; a `then`-bearing option may route to a fusion
 *   score     one question per item of `over`, batched into a single backend request
 *   render    assemble text from an input without calling a model — how a shape ends without generating
 */
export type Stage =
  | { parallel: string[]; input: StageInput; name?: string; rounds?: number; roundInput?: StageInput }
  | { single: string; input: StageInput; name?: string; alsoSynthesize?: boolean }
  | { decide: DecideSpec; input: StageInput; name?: string; sufficientWhen?: SufficientWhen }
  | { score: ScoreSpec; over: "panel"; input?: StageInput; name?: string }
  | { render: "panel"; input?: StageInput };

/** A named pipeline shape. `3x`-style and `5x`-style delibitation are stage lists, not code branches. */
export type Mode = { stages: Stage[] };

export type FusionSpec = {
  /** Picker label for the registered model. Default `Fusion · <id>`. */
  name?: string;
  /**
   * Metadata for the registered model, used where the executor alias declares none (Step 9). The
   * pipeline itself is unaffected.
   */
  model?: { contextWindow?: number; maxTokens?: number };
  /** Which named shape this fusion runs. */
  mode: string;
  /** Model chains per persona seat. Every persona the mode uses must appear here, and vice versa. */
  candidates: Record<string, SlotCandidate[]>;
  /**
   * Per-fusion thinking-level override by persona. `"harness"` is legal for the writing seat alone: a
   * proxied turn then runs at whatever level the harness sent (Step 9).
   */
  thinking?: Record<string, Persona["thinking"] | "harness">;
  fileAgent?: false | { alias: string };
  /** Per-fusion prompt override by persona. */
  prompts?: Record<string, string>;
  maxAdvance?: number;                // default 3
  /**
   * Post-synthesis checks, run in order. A `decide` entry reports as before; a `gate` entry runs a
   * command and reports its exit status. Both are report-only: neither rewrites nor blocks the answer.
   */
  verify?: (DecideSpec | { gate: { command: string[]; expectExit?: number; timeoutMs?: number } })[];
  /**
   * Pre-run routing. The action to take lives with the option it applies to: a `criteria` entry may
   * carry `then`, naming the fusion to run instead of this one. Options without `then` do not route,
   * and several options may route to different fusions. A target must not declare `route` itself
   * (one hop). Routing never happens silently: the answer and its confidence are reported.
   */
  route?: RouteSpec;
  /**
   * The execute face (Step 9). Without it the executor is the writing seat — the persona of the mode's
   * final `single` stage — so re-pointing that seat re-points what codes under this rung. `alias`
   * re-points which model that seat acts as, when the writer is not the model you want acting; a fusion
   * whose mode writes nothing has no writing seat, so a `proxy` on one is a load error rather than an
   * executor with no persona for the thinking rule to read. `proxy` and `route` on one fusion is a load
   * error too: a proxied turn runs no pipeline, so the route could never fire.
   */
  proxy?: { alias: string };
};

export type BackendSpec =
  | {
      kind: "typesafe";
      url: string;                    // https://api.typesafe.ai/v1/systemone
      apiKeyEnv: string;              // TYPESAFE_API_KEY
      model: string;                  // pin a version id, e.g. jev-1.13.0; aliases drift under thresholds
      timeoutMs?: number;
    }
  | {
      kind: "semif";
      url: string;                    // http://127.0.0.1:8791/score, or a hosted deployment
      apiKeyEnv?: string;
      timeoutMs?: number;
    };

export type MatrixConfig = {
  /** Provider the fusions register under. Default "fusion-matrix". */
  providerId?: string;
  /** Display name for that provider. Default "Fusion Matrix". */
  providerName?: string;
  /** Fusion used by `/matrix` with no id and by the `matrix` tool with no `fusion` argument. */
  defaultFusion?: string;
  aliases: Record<string, AliasSpec>;
  /** Seats, defined once and reused across modes. */
  personas: Record<string, Persona>;
  /** Named pipeline shapes. */
  modes: Record<string, Mode>;
  /** Key is the registered model id; the value is the shape plus the roster that fills it. */
  fusions: Record<string, FusionSpec>;
  decide: {
    defaultBackend: string;           // key into backends; used when a DecideSpec names none
    /** SemIf model table, consumed by the scoring server, never by this extension's own calls. */
    models?: Record<string, { source: string; revision: string }>;
  };
  backends: Record<string, BackendSpec>;
};

export function loadMatrixConfig(): { config: MatrixConfig; layers: string[] };
```

`loadMatrixConfig()` deep-merges three optional layers, lowest priority first:

1. `<repo>/matrix.json` (always present)
2. `<agent dir>/pi-fusion-matrix.json` — `~/.pi/agent` under pi, `~/.omp/agent` under omp
3. `<session cwd>/<project dir>/pi-fusion-matrix.json` — `.pi/` under pi, `.omp/` under omp

The machine and project layers are **per harness**, because a provider id and a credential are harness
facts rather than extension facts: one account is `kimi-coding` in pi and `kimi-code` in omp, one
harness's key can be stale while the other's still works, and omp enforces a model's supported thinking
levels where pi passes them through. Both harnesses read their own agent directory (and both honour
`PI_CODING_AGENT_DIR`, so a scratch agent dir isolates tests completely), and each already reads its own
project directory — `.pi/settings.json` for pi, `.omp/settings.json` for omp — so this config sits
beside every other harness-specific setting instead of inventing a second convention. Which harness is
running is read synchronously from the entry script the harness was launched with, the same evidence
peer resolution uses later.

Reuse the merge shape the reference implementation uses (
`<vendored-fork>/lib/config.js:58-67` (`mergeConfig`: objects merge field by field, arrays and
scalars replace; it is verified working in this session). Copy that function rather than writing a
new one.

Interpolation applies to every string value: `{{prompt}}`, `{{panel}}`, `{{judge}}`, `{{synthesis}}`,
`{{cwd}}`. An unresolved name throws `pi-fusion-matrix: unknown template variable "{{x}}"`.

Validation runs on every load and throws `pi-fusion-matrix: <problem>`; never fall back silently:
- alias with an empty `providers` list → `alias "glm" has no providers`.
- alias with no `model` → `alias "glm" has no model; set the vendor id sent upstream`.
- a fusion id containing `:` or `/` → error, because pi parses `provider/id:thinking` and the id would
  be unaddressable (`fusion id "best:cheap" may not contain ":" or "/"`).
- `defaultFusion` naming an unknown fusion → error.
- `fusions.<id>.mode` naming an unknown mode → error, listing the known modes.
- a fusion's `candidates` keys not matching the personas its mode uses → error naming both sides
  (`fusion "best" is missing candidates for: synth; unknown: synthesis`). The roster and the shape must
  agree, which is what keeps a mode rename from silently orphaning a model.
- a candidate entry naming an unknown alias → error, listing `aliases` keys; an empty candidate list →
  error naming the persona.
- a stage naming an unknown persona → error.
- a mode whose last stage is not `single` or `render` → error, because it would produce no assistant
  message.
- a stage `input` that resolves to nothing produced by an earlier stage → error. The validator walks
  the stage list as dataflow: `panel` needs a preceding `parallel`, `panel+judge` a preceding `single`
  or `decide` after a `parallel`, `panel+weights` a preceding `score`, `{{name}}` an earlier stage that
  declared that name.
- `peers` outside a `rounds` stage, `rounds` of 1, or `rounds` above 10 → error (`rounds` is a cost
  ceiling, not just a shape).
- `alsoSynthesize` on anything but the final stage → error.
- `score` without `over`, or `over` other than `panel` → error.
- a `score` stage's `criteria` is a list of 2..16 rating levels with `instructions`; an array
  `criteria` on any other decision surface → error, naming the score stage as the only legal home.
- `thinking` overrides naming a persona the mode does not use → error.
- a persona `prompt` path that does not exist → error naming the persona and the resolved path.
- `temperature` outside 0..2, or `output` other than `text`/`json` → error.
- a `verify` gate with an empty `command` → error; `timeoutMs` above 600000 → error.
- `DecideSpec` declaring both `options` and `questions`, or neither → error.
- a `criteria` map outside 2..16 options → error.
- `questions` with zero entries, or a `score` question with fewer than two `criteria` levels → error.
- a decision naming a `backend` absent from `backends` → error; `decide.defaultBackend` absent → error.
- `questions` on a `kind: "semif"` backend → error, naming the option-form alternative, because the
  SemIf row schema carries one question and typed batching does not exist there.
- `route.criteria` with fewer than two options, or with no entry carrying `then` → error, because
  such a route can never fire.
- a `then` naming an unknown fusion, this fusion, or a fusion that itself declares `route` → error.
- `sufficientWhen` on a model candidate → error (`models produce no answer to test`); it applies to
  decision candidates only.
- `sufficientWhen` with none of `choiceIs`/`noulAbove`/`scoreAbove`/`scoreBelow`/`minConfidence` →
  error, because it would always pass and make the rest of the chain dead config.
- `sufficientWhen.choiceIs` naming an option absent from that decision's `criteria` → error.
- a `sufficientWhen` threshold outside 0..1 → error.
- a `route` resolving to a `kind: "semif"` backend → error: `routing requires a backend that reports
  confidence; "semif" does not`, because an uncalibrated probability must not steer cost.

Provider names are resolved lazily, not validated at load: `resolve` reports
`native provider "go" is not registered (edit ~/.pi/agent/models.json)` when a run reaches that
provider inside an alias. This is deliberate — the extension cannot know which providers another
piece of configuration registers, and a stale name must fail at use, not at startup.

### Step 2 — The packaged config and the matching `models.json`

`matrix.json` in this repository is the single copy of the packaged config — the plan does not
duplicate it. Only the vocabulary is illustrated here; read the file for the eight fusions it ships.

```jsonc
{
  "providerId": "fusion-matrix",
  "defaultFusion": "default-smrt",

  "personas": {                                   // seats: told once, reused everywhere
    "technical":  { "prompt": "prompts/technical.md", "temperature": 0.5, "thinking": "medium" },
    "skeptic":    { "prompt": "prompts/skeptic.md", "temperature": 0.8 },
    "systems":    { "prompt": "prompts/systems.md", "temperature": 0.6 },
    "judge":      { "prompt": "prompts/judge.md", "temperature": 0.2, "output": "json" },
    "synth":      { "prompt": "prompts/synth.md", "temperature": 0.5 },
    "synth-lean": { "prompt": "prompts/synth-lean.md", "temperature": 0.5, "thinking": "medium" }
  },

  "modes": {                                      // shapes: stage lists, no code
    "lean": { "stages": [
      { "parallel": ["technical", "skeptic"], "input": "prompt" },
      { "single": "synth-lean", "input": "panel" }
    ] },
    "pair-judged": { "stages": [
      { "parallel": ["technical", "skeptic"], "input": "prompt" },
      { "single": "judge", "input": "panel" },
      { "single": "synth", "input": "panel+judge" }
    ] },
    "debate": { "stages": [
      { "parallel": ["technical", "skeptic", "systems"], "input": "prompt",
        "rounds": 3, "roundInput": "peers" },
      { "render": "panel" }
    ] }
  },

  "fusions": {                                    // a mode plus the roster that fills its seats
    "good": { "mode": "lean", "fileAgent": false,
      "candidates": { "technical": ["deepseek-flash"], "skeptic": ["glm-flash"],
                      "synth-lean": ["qwen-flash"] } },
    "best": { "mode": "pair-judged", "thinking": { "judge": "high", "synth": "high" },
      "candidates": { "technical": ["deepseek-pro"], "skeptic": ["glm"],
                      "judge": ["deepseek-flash"], "synth": ["glm-flash"] } }
  }
}
```

Eight fusions ship, and the call count is the cost contract. `cheap` (one seat on `qwen-flash`) and
`quick` (one seat on `deepseek-flash`) are the rungs the ladder starts on, one call each. `good` is
the pair shape — two flash seats and a merge — at three calls. `best` is that pair extended with a
judge and a synthesis at four calls, and it is the ceiling of the ladder. `default-smrt` is one seat
behind a complexity `route` that sends the request to `cheap`, `quick`, `good`, or `best` (`unsure`
falls to `quick`), is the `defaultFusion`, and costs one call plus one route decision. `opinions` is
the panel-only grid (three calls, no generation). `debate` is three rounds against peers' opinions
(nine calls). `review-check` is the cascaded committee plus a three-question verification (five calls
plus one stage decision). The ladder defaults cheap — `default-smrt` budgets the cheapest rung that can
carry the request — and `best` is its ceiling.

Where each fusion's shape comes from:

| fusion (shape) | from | which surfaces |
|---|---|---|
| `cheap`, `quick` (`single`) | [`disler/fusion-harness`](https://github.com/disler/fusion-harness) | `/fh-only` (one model) |
| `good` (the pair shape: two seats and a merge, packaged as `lean`) | the same | its cheap/frontier pair commands |
| `best` (that pair plus a judge → synthesis, packaged as `pair-judged`) | both | the pair shape above, extended with [`@quarkos/pi-fusion`](https://github.com/QuarkOS/Pi-Fusion)'s panel → judge → synthesis stages |
| `default-smrt` (one seat behind a `route` gate) | this repository | its own routing gate; no upstream shape |
| `opinions`, `debate` | [`disler/fusion-harness`](https://github.com/disler/fusion-harness) | `/fh-opinion` (N models answer independently, read-only, side by side, no merge) and `/fh-debate` (each round every surviving agent receives every other agent's labelled prior opinion; failed agents are dropped; no judge and no hidden merge) |
| `review-check` (the committee, as `committee-cascaded`, and the seat assembly) | [`@quarkos/pi-fusion`](https://github.com/QuarkOS/Pi-Fusion) | its panel → judge → synthesis pipelines, and the seat algorithm of Step 6 |

`pair`, `committee`, and `committee-merged` ship as vocabulary with no fusion on them; the eight
fusions sit on `single`, `lean`, `pair-judged`, `opinion`, `debate`, and `committee-cascaded` (the
`review-check` shape).

fusion-harness's three other shapes are deliberately absent — see the boundary note under Assumptions
(its disk-writing FUSION agent, its gate-first loop, and its plan-then-DAG collaboration).

Persona prompts live in `prompts/*.md` and are referenced by path, so editing what a seat is told is
an edit to a text file, not to code. A `prompt` may also be inline, and `fusions.<id>.prompts` overrides
one persona for one fusion only. An override is resolved by existence rather than by shape — a file
beside the config that declared the fusion wins, and its own text is used when there is no such file —
because an override that is one line of prose would otherwise read as a filename.

The provider ids in `aliases.*.providers` are **pi's own** — `opencode-go`, `zai`, `kimi-coding`,
`openai`, and whatever a repository adds — and each provider's endpoint, api flavour, and catalogue come
from pi. The packaged defaults therefore need **no `models.json` block at all**: they route only through
providers this machine already has authenticated (`opencode-go`, `zai`, `kimi-coding` from pi's
credential store; `openai` from `OPENAI_API_KEY`; `qwen-cloud-token-plan` as the operator's own
`models.json` entry).

Two cases still touch `models.json`, and neither is required for the packaged config to run:

- **Adding an account or a gateway.** A private gateway, or a second account for a vendor that is
  already a built-in provider, is a provider block the operator writes — the same pattern as their
  existing `qwen-cloud-token-plan` entry (`baseUrl`, `api`, `apiKey` as `$ENV_VAR` or a `!command`, and
  a `models` list). The alias then names that id. Nothing in this repository ships such a block.
- **Wanting an id in pi's own picker.** Seats do not need a catalogued id (Step 3's credential seam), so
  this is a convenience only: `{"providers": {"opencode-go": {"models": [{"id": "glm-5.3-flash"}]}}}`
  upserts into a built-in provider, keeping its existing models (pi's documented merge semantics). The
  doctor can print this snippet on request; it never writes it silently.

### Step 3 — Registration, resolution, execution

`index.ts` exports `export default async function (pi: ExtensionAPI)` so config load completes before
startup continues (pi awaits an async factory: `docs/extensions.md`, "Async factory functions").

Provider registration:

```ts
const providerId = config.providerId ?? "fusion-matrix";

pi.registerProvider(providerId, {
  name: config.providerName ?? "Fusion Matrix",
  baseUrl: "http://127.0.0.1:1/unused",   // never used: our api id only matches our own models
  apiKey: "unused",                        // provider-composer requires apiKey or oauth
  api: "fusion-matrix",
  // The fusion key is the model id, verbatim: no prefixing, no reserved "default" id. A fusion with an
  // execute face advertises that executor's numbers and thinking capability (Step 9) — registration runs
  // before any session exists, so there is no catalogue to consult and the alias declares them.
  models: Object.entries(config.fusions).map(([id, fusion]) => {
    const executor = executorOf(config, fusion);            // Step 9: the writing seat, or `proxy.alias`
    const alias = executor ? config.aliases[executor.alias] : undefined;
    // `reasoning` follows the alias's declaration and defaults to the executor being a reasoning model;
    // nothing reads `fusion.model.reasoning`, so an operator cannot half-configure it.
    return {
      id,
      name: fusion.name ?? `Fusion · ${id}`,
      api: "fusion-matrix",
      provider: providerId,
      // `alias.reasoning` also settles whether the harness passes a thinking level through at all: both
      // harnesses gate `reasoning` on this flag, so a proxying fusion that says `false` makes `--thinking`
      // inert and the target falls back to its own default.
      reasoning: executor ? (alias?.reasoning ?? true) : false,
      input: ["text"],
      contextWindow: alias?.contextWindow ?? fusion.model?.contextWindow ?? 128000,
      maxTokens: alias?.maxTokens ?? fusion.model?.maxTokens ?? 8192,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    };
  }),
  streamSimple: (model, context, options) => runFusion(model, context, options),
});
```

Verified mechanics in pi 0.84.2: `dist/core/provider-composer.js:310-322` dispatches
`extension.streamSimple` when `model.api === extension.api`, otherwise falls through to the base
provider or the api-registry. A dedicated api id therefore intercepts only this extension's models
while every real model keeps resolving normally. `provider-composer.js:304-306` throws when a
provider has neither `apiKey` nor `oauth`, hence the `"unused"` literal; pi's docs state the same
requirement (`docs/custom-provider.md`).

`streamSimple` MUST return its stream synchronously and then push real `AssistantMessage` events
(`start`, `text_start`, `text_delta`, `text_end`, `done` or `error`). Copy this structure from the
working vendored implementation rather than inventing it: `<vendored-fork>/index.js:507-745`
(base message, `freshUsage`, `msg`, `sendDelta`, abort checks, `toolcall_start`/`toolcall_end`
emission) and `<vendored-fork>/lib/event-stream.js` for the duck-typed stream.

`resolve.ts`:

```ts
export type Resolved = { alias: string; provider: string; model: string; maxTokens?: number; reasoning?: boolean; thinking?: Persona["thinking"] };
/** Every (provider, model) pair an alias or slot entry can produce, in order. */
export function resolveCandidates(config: MatrixConfig, candidate: SlotCandidate): Resolved[];
```

`resolveCandidates` expands one candidate entry into an ordered list — this is the whole resolution
model, and it consults only the alias table (provider ids are pi's; nothing here reads a key or a URL):

1. A `{ semif }` entry returns `[]`; the caller handles SemIf separately (Step 4).
2. Normalize the entry: a bare string is `{ alias: string }`; an object carries `alias` plus optional
   per-slot `providers` and `thinking` overrides.
3. `alias = config.aliases[aliasId]`; missing → throw `unknown alias "x"; known: ...`.
4. `refs = providers ?? alias.providers`; empty after the override → throw `alias "x" has no providers`.
5. For each ref in order, push `{ alias: aliasId, provider: ref.id ?? ref, model:
   ref.modelOverride ?? alias.model, maxTokens: alias.maxTokens, reasoning: alias.reasoning }`.
   Both knobs are optional, and only what the alias declares is carried: the alias wins where it
   declares them and pi's template supplies the rest, because pi's model object is what the adapters
   read — they gate thinking on `model.reasoning` (`dist/api/anthropic-messages.js:773`,
   `azure-openai-responses.js:219`) and size the request from `model.maxTokens` — so a default here
   would overwrite pi's accurate sibling value for every alias that declares neither, silently
   disabling thinking and capping output.
   The alias name stays version-free in every fusion and slot; the vendor id sent upstream comes from
   `alias.model` (optionally overridden per provider), so a vendor release edits one field in
   `matrix.json` and touches nothing else.

**The credential seam, and why a vendor id need not be in pi's catalogue.** pi's model list is curated
and lags the live catalogues — `opencode-go` is catalogued with 19 ids while its live catalogue serves
roughly twice that, so `glm-5.3-flash`, `deepseek-v4.1-flash`, and `grok-4.6` are absent from pi's list
yet accepted by the provider. A seat therefore does **not** look its id up in the registry. It takes a
same-provider model as the shape template and asks pi for the credential:

```ts
const template = ctx.modelRegistry.find(provider, anyCataloguedIdOf(provider));   // api, baseUrl, compat
if (!template) → the provider is not configured at all
const seatModel = { ...template, id: resolved.model };                            // our id, not pi's list
const auth = await ctx.modelRegistry.getApiKeyAndHeaders(seatModel);              // pi resolves it
```

`getApiKeyAndHeaders(model)` resolves by `model.provider` (`ModelRuntime.getAuth(providerOrModel)`), so
it works for an id pi has never heard of, and this extension still never reads a secret. Consequences:
an alias may name any id its provider accepts; a vendor release is one `model` field; and no
`models.json` entry is needed to make a model usable. The `pick` of template is by preference order
(catalogued model of that provider, else the provider's first) and recorded in `details.seats[].template`
so an odd template choice is visible rather than mysterious.

Provider *existence* is still checked at use, not at load: a provider id that pi does not know, or one
with no configured credential, records a substitution with `reason: "missing provider"` and advances.
Config-level correctness — that a provider id is one pi has, and that its credential resolves — is the
doctor's job (Step 7), not the loader's.

**The stage interpreter.** `runFusion` reads `config.modes[fusion.mode].stages` and walks them in
order, building a `vars` map as it goes:

| Stage | Execution |
|---|---|
| `parallel` | one `runSeat` per listed persona, concurrently; results become `panel`, labelled by persona. With `rounds: n`, the first round uses `input` and every later round re-runs the same seats with `roundInput` (`peers`), each seat receiving every *other* seat's previous-round output as `## <persona> — previous opinion`. A seat that failed is labelled and dropped from later rounds, and rounds stop early if fewer than two seats survive. |
| `single` | one `runSeat` for the named persona. `alsoSynthesize: true` may appear only on the last stage: that stage is told to produce the final answer after its own analysis, so a merged-judge shape costs one call fewer than a separate synthesis. |
| `decide` | one backend request for the stage's `criteria`; contributes `option: probability` lines to later stages. With `sufficientWhen`: a sufficient answer **skips the stage it gates** (the next one) and the run reports what it skipped; an insufficient one runs it and hands the answer forward as a prior line, so the escalated stage addresses the ambiguity instead of rediscovering it. |
| `score` | one question per item of `over` (`panel`), batched into a single backend request; contributes per-seat weights to `panel+weights`. |
| `render` | no model call: assembles already-produced text (`panel`) into the assistant message. This is how a shape ends without generating — an opinion grid is assembled, not authored. |

**A mode must end in `single` or `render`.** A stage list ending on `parallel`, `decide`, or `score`
produces no assistant message and is a load error, not a run that returns nothing.

Connectors resolve per stage: `prompt`, `panel`, `panel+judge`, `panel+weights`, `peers`, `previous`,
and `{{name}}` for any earlier stage that declared `name`. An unresolved connector fails at load — the
validator walks the stage list as dataflow — so a shape that reads something nobody produced never
reaches a run.

`run.ts` exports `runFusion(model, context, options)` and:

```ts
type Substitution = { seat: string; from: string; to: string; reason: string };
type SeatResult = {
  text: string; label: string; usage: Usage; substitutions: Substitution[];
  error?: string; degraded: boolean;
};
async function runSeat(
  persona: string, candidates: SlotCandidate[], ctx: SeatContext,
): Promise<SeatResult>;
```

`runSeat` algorithm — two fallback layers, each independently configured and reported:
1. `prompt` = first message of the trailing run of `role === "user"` messages — the injected-prelude
   fix, copied from `<vendored-fork>/index.js:485-506` (`extractPrompt`).
2. Expand the candidate list with `resolveCandidates` per entry, keeping entry order. Each entry
   contributes its own ordered provider list. The expansion is the execution plan; log it once per run
   in the banner as `<persona>: <alias>@<provider>` sequences.
3. Walk the expansion in order, capped at `fusion.maxAdvance ?? 3` advances per seat:
   - decide entry → `decide(...)` per Step 4; failure records a substitution `reason: "decision"` and
     moves to the next entry. A decision's text contribution to the judge/synthesis context is
     `option: probability` lines (`<id>: <p>` sorted descending), and the winner is marked.
   - Otherwise build the seat's model through the credential seam above and stream it:
     ```ts
     const template = ctx.modelRegistry.find(resolved.provider, anyCataloguedIdOf(resolved.provider));
     if (!template) return advance("missing provider");
     const seatModel = { ...template, id: resolved.model, ...(auth.baseUrl ? { baseUrl: auth.baseUrl } : {}) };
     const auth = await ctx.modelRegistry.getApiKeyAndHeaders(seatModel);
     if (!auth.ok) return advance("credential");
     const message = await streamSimple(seatModel, { messages }, {
       apiKey: auth.apiKey, headers: auth.headers, signal: options.signal, temperature, reasoning,
     }).result();
     ```
     `streamSimple` is imported from `@earendil-works/pi-ai/compat` (Step 6). The api id, baseUrl,
     `compat` flags, and credential all come from pi; only the vendor id is ours. Seat text =
     concatenated `text` blocks of `message.content`; usage = `message.usage`; failure =
     `message.stopReason === "error"` with `message.errorMessage`.
4. Failure classification (the contract; `same name` = advancing inside one alias's provider list,
   `new name` = moving to the next candidate entry):
   | Signal | Action | reason string | layer |
   |---|---|---|---|
   | no template model for the provider — pi does not know it or it is unconfigured | advance | `"missing provider"` | both |
   | `stopReason === "error"`, text matches `/\b429\b|usage limit|quota|balance/i` | advance at once | `"quota"` | both |
   | text matches `/\b40[13]\b|unauthorized|invalid api key/i` | advance | `"credential"` | both |
   | text matches `/not found|unknown model|\b404\b/i` | advance | `"missing model"` | both |
   | transport failure, 5xx, or a 429 without quota semantics | retry same candidate once after 2000 ms, then advance | `"transient"` | both |
   | a decision candidate answered, but `sufficientWhen` did not hold | advance at once, keeping the answer | `"insufficient"` | seat cascade |
   | the caller stopped the run, or the seat's own deadline passed | advance at once, no retry | `"aborted"` / `"timeout"` | seat cascade |
   | any delta already streamed to the caller | do not advance; end with emitted text, `degraded: true` | — | — |

   `"insufficient"` is not a failure and must not be reported as one. Its line names the answer and
   the condition it missed:
   ` ├─ ↳ judge decision insufficient (agrees, conf 0.62 < 0.80) → deepseek-pro\n`
   A sufficient decision candidate skips the rest of the chain and reports what it skipped:
   ` ├─ ️ judge via decision (agrees, conf 0.91) — skipping deepseek-pro\n`
   When a decision is insufficient, its answers are handed to the next candidate as a prior, inserted
   as one line before the prompt:
   `A fast classifier read this as choice=agrees (confidence 0.62); treat the ambiguity explicitly.`
   The exact prior string is recorded in `details.cascades[].prior` so prompt assembly is inspectable
   without network capture.
5. Substitution lines differ per layer so the reader can tell a billing swap from a model change:
   - inside an alias: ` ├─ ↩ judge deepseek-pro@opencode-go → deepseek-pro@qwen-cloud-token-plan (quota)\n`
   - across entries:   ` ├─ ↩ judge qwen-max@opencode-go → glm@opencode-go (quota)\n`
   A same-alias line is quality-preserving (one vendor model, another account); a cross-entry line
   means a different alias answered, and must be visible in both the transcript and
   `details.substitutions`.
6. Everything exhausted → `error = "all candidates failed: deepseek-pro@opencode-go (quota), deepseek-pro@qwen-cloud-token-plan (credential)"`,
   `degraded: true`; the pipeline continues with that seat marked unavailable. A seat dying never aborts
   the run, even in the two-seat shapes where the reference implementation's 3x would have thrown —
   that asymmetry is a deliberate change.

Sampling belongs to the persona: `temperature` (default 0.7) and `thinking` (passed to pi as the
request's `reasoning` level). `fusions.<id>.thinking` overrides one persona for one fusion, which is
how `best` runs its judge and synthesis at `high` while its panel is held at `low`. The reference
implementation's temperatures survive as persona defaults (`technical` 0.5, `skeptic` 0.8, `systems`
0.6, `judge` 0.2, `synth` 0.5). The `kimi` special case stays: `temperature: 1.0` when the vendor id
contains `kimi`, because that family rejects other values. Keep the models-reject-temperature memory
from `<vendored-fork>/lib/api.js` (patch 6): a module-level `Set` of provider/model keys; on an error
whose text matches `/temperature/i`, add the key, omit `temperature` on the retry (same candidate, not
an advance), and emit one `⚠️ <provider>/<model> rejects a temperature override; retrying without it.`
delta. Prevention belongs in `models.json`: a model that always rejects it gets
`"samplingParams": { "temperature": 1 }`, which pi merges into the request body.

A thinking level can be refused the same way, except that a harness may refuse it *before* the request
rather than the provider after it. Measured 2026-09-18, the same config and the same vendor model:
pi sends `reasoning: "medium"` and the provider ignores what it does not support, while omp answers
`Thinking effort medium is not supported by opencode-go/glm-5.3. Supported efforts: low, high, max` —
a seat-killing error where pi ran. So the same rule applies one level down: remember the refusal per
provider/model *and* level, retry that seat once with no reasoning level (never at a level the config
did not ask for — a silent substitution of a sampling parameter is the thing this spec forbids), emit
one `⚠️ <provider>/<model> does not support thinking "<level>"; retrying that seat without a reasoning
level.` delta, and keep requesting levels that *are* supported, because the memory is keyed by level.

Tool path: the `matrix` tool and the `/matrix` command cannot emit a pi stream, so they execute the file
agent's writes themselves (`mkdir -p`, then write; per-file failures reported) and return the run record
in `details` — substitutions, cascades, routing, verification, seats, usage, notes. Reporting "N files
saved" without writing them would be a false claim, which is why the writes happen there.

File agent: when `fusion.fileAgent` is `{ alias }`, resolve that alias through the same
`resolveCandidates` path (so it also inherits the provider chain, e.g. `deepseek-flash` on Go then
the token plan) and run it with the `WRITE_TOOL` schema copied from `<vendored-fork>/index.js`,
emitting `toolcall_start`/`toolcall_end` blocks exactly as `index.js:718-730` does, so pi performs the
writes. When `false`, skip and end with `stopReason: "stop"`.

Registration of tool and commands:

```ts
pi.registerTool({
  name: "matrix", label: "Matrix",
  description: "Run a named fusion — a configured pipeline of models deliberating on one question.",
  promptSnippet: "Run a multi-model deliberation on a design question",
  parameters: Type.Object({
    prompt: Type.String({ description: "The query or design task to analyze." }),
    fusion: Type.Optional(Type.String({ description: 'Fusion id from matrix.json (e.g. "best"). Omit for "default".' })),
  }),
  execute: async (_toolCallId, params) => { /* content: synthesis text,
    details: { fusion, models, substitutions, slotErrors, panelResponses, judgeAnalysis, usage } */ },
});
pi.registerCommand("matrix", { description: "Run a named fusion: /matrix <id> <prompt>", handler: async (args, ctx) => {} });
pi.registerCommand("matrix-info", { description: "List modes, fusions, seats, and provider routes", handler: async (_args, ctx) => {} });
pi.registerCommand("matrix-doctor", { description: "Validate the config, check connectivity, report drift", handler: async (args, ctx) => {} });
```

Every run records the shape it actually ran, not the one it was configured for:

```ts
type RunDetails = {
  fusion: string; mode: string;
  stages: { index: number; kind: "parallel" | "single" | "decide" | "score" | "render";
            seats?: string[]; calls: number }[];
  seats: { persona: string; alias: string; provider: string; model: string; template?: string;
           thinking?: string; usage: Usage; degraded?: boolean; error?: string; reason?: string }[];
  seatErrors: { persona: string; error?: string; reason?: string }[];
  rounds?: { round: number; seats: string[]; inputs: Record<string, string> }[];
  substitutions: Substitution[];
  cascades: Cascade[];               // answer, sufficiency, prior, next candidate
  routing?: { answer: DecideAnswer; routedTo?: string; declined?: string; threshold: number };
  verification?: { check: string; result: unknown; gate?: { exit: number; timedOut?: boolean; durationMs: number; output: string } }[];
  usage: Usage;
};
```

`details.substitutions` and `details.seatErrors` are always present, empty arrays included: a silently
degraded run is a wrong answer and must be visible. `seats[].model` is the vendor id that actually
answered, so a provider-level substitution stays auditable after the fact, and `stages[].calls` is what
makes a shape's cost contract checkable.

`/matrix` parses the first whitespace-delimited token as a fusion id when it matches a key in
`fusions`; otherwise the whole argument string is the prompt and `defaultFusion` is used. Unknown id →
`ctx.ui.notify('unknown fusion "x"; known: cheap, quick, ...', "error")` and no run.
A decision entry reports as before; a `gate` entry runs a command and records its exit status.

**`route` runs before the first stage** (Step 3 step 1). The clause is one choice question built from
`route.instructions` and the option ids of `route.criteria` (descriptions only — `then` is this
extension's vocabulary and is never sent). `state` defaults to `{{prompt}}`. A `then` on the winning
option names the fusion to run instead of this one; an option without `then`, an option id the map
does not contain, or a `sufficientWhen` that does not hold (`{ minConfidence: 0.5 }` by default) all
mean the run proceeds as this fusion — the same "unsure means spend" rule as a slot cascade, one level
up. The decision and the routing are reported
(` ├─ ↪ routed to flash (complexity=trivial, confidence 0.91)\n`) and recorded in `details.routing`,
including when the confidence gate declines to route.
Routing may target a more expensive fusion — escalation on `"architectural"` is a normal use — so
there is no cost-direction rule. The guardrails are structural: one hop (a target may not declare
`route`), no self-route, and full reporting of the answer, its probabilities, and its confidence.

**`verify` runs after synthesis** and is report-only. Two kinds, evaluated in order, with
`vars = { prompt, panel, judge, synthesis, cwd }`:

- a `DecideSpec` entry, as a decision; and
- a `gate` entry — `{ "gate": { "command": ["just", "test"], "expectExit": 0, "timeoutMs": 120000 } }` —
  which runs the command in the session cwd and records exit status, duration, and a bounded tail of
  output. A gate never loops, never feeds back into a stage, and never blocks: iteration-until-green
  is a different feature this plan does not include.

Results are recorded in `details.verification`. Any `noul < 0.5`, any `choice` whose winner is the
pessimistic option, any `confidence < 0.5`, or a gate whose exit does not match `expectExit` emits one
delta, for example
` ⚠️ verify: grounded_in_panel=0.31 (low) — synthesis may contain unsupported claims` or
` ⚠️ verify: gate "just test" exited 1 (expected 0) — 24 lines of output in details`.
A verification never edits or blocks the answer, and a verification backend failure is reported as
skipped, not as a run failure.

### Step 4 — Decision backends (TypeSafe default, SemIf local)

`decide.ts` is the client for both kinds; `decide.models` and `scripts/*` belong to the SemIf server.
Nothing here is optional or deferred behind a flag — `review-check`'s stage cascade and `default-smrt`'s
`route` in Step 2 both use it.

```ts
export type DecideAnswer =
  | { type: "noul"; noul: number }
  | { type: "choice"; choice: string; probabilities: Record<string, number>; confidence: number }
  | { type: "score"; score: number; legend: Record<string, string>; probabilities: Record<string, number>; confidence: number }
  | { type: "probabilities"; probabilities: Record<string, number> };   // SemIf: no confidence exists

export type DecideResult = {
  backend: string; model: string; answers: Record<string, DecideAnswer>;
  usage: { inputTokens: number; outputTokens: number };
  raw?: unknown;
};

export async function decide(
  config: MatrixConfig, spec: DecideSpec, vars: Record<string, string>, signal?: AbortSignal,
): Promise<DecideResult>;
```

**TypeSafe kind** — one request per `DecideSpec`, all questions batched:

```http
POST https://api.typesafe.ai/v1/systemone
Authorization: Bearer $TYPESAFE_API_KEY
{ "state": "...", "model": "jev-1.13.0", "questions": { "<id>": { "type": "noul" | "choice" | "score", "instructions": "...", "criteria": ... } } }
```

Response: `{ model, answers: { <id>: {...} }, usage: { input_tokens, output_tokens } }`. The option form
maps to a single `choice` question keyed `"choice"`, with `criteria` built from `options`
(`{ optionId: description }`); its `probabilities` is thus `Record<optionId, number>` and its `choice`
is the winning option id — the same shape SemIf returns, which is why slot code treats both alike.

Constraints that shape the request builder:
- **64k per request; 32k for `state` plus the longest question.** Before sending, if
  `state.length / 4` (a rough token estimate) plus the longest question exceeds 32k, truncate `state`
  from the middle and emit one `⚠️ decision state truncated for <backend>` delta — never fail the run
  for an oversized state, and never silently send a payload that will 4xx.
- **Text only.** `state` is a string or JSON; no images.
- **Rate limits**: 250k tokens/s, 1,200 req/min; a breach returns `429` with optional `retry-after`.
  Treat as transient (retry once after the header, else after 2 s), then record the answer as
  unavailable and continue — a decision never fails a run.
- **Output tokens are free; input is $42/Btok.** Cost = input only; there is no price table here, so
  report `usage` and let pi's own accounting do the rest.
- **Pin `model` to a version id** (`jev-1.13.0`), not `jev-latest`: a confidence threshold tuned
  against one version must not move under an alias bump. The response's `model` field is recorded in
  `DecideResult.model` and surfaced in tool details.

**SemIf kind** — one question per request (upstream's row schema, verified in
`src/semif_phase1/core.py: validate_row` and `cli.py`):

```json
POST <url>  { "id": "<uuid>", "state": "...", "question": "...", "options": [{"id","description"}, ...], "model": "qwen3.5-4b", "max_tokens": 4096 }
```

Response carries `option_ids`, `probabilities` (aligned to request option order), `option_logits`,
`model.{source,revision}`, `total_seconds`, `prompt_sha256`. Use `AbortSignal.timeout(backend.timeoutMs)`
and `Authorization: Bearer <process.env[apiKeyEnv]>` when `apiKeyEnv` is set. Answers normalize to
`type: "probabilities"` — SemIf has **no confidence**, and its own output says
`"probability_status": "uncalibrated as decision confidence"`, which is exactly why no gate may
threshold a SemIf answer (Step 3 routing requires a backend that returns `confidence`; the loader
rejects a `route` resolving to a SemIf backend with
`routing requires a backend that reports confidence; "semif" does not`).

`tools/semif-server/` is the operator-run scoring service, unchanged in role: `POST /score`,
`GET /health`, one `load_causal_model(source, revision)` per model at startup, then
`encode_prompt` + one forward pass + `softmax` per request. It imports `semif_phase1` from a SemIf
checkout (`pip install -e /path/to/SemIf`) and does not reimplement the logit readout.

Placement differs by backend and needs no code change (`backends` entry only):
- **TypeSafe** — no local component; works from this machine and from containers. This is the
  configured default.
- **SemIf local** — `python tools/semif-server/server.py --host 127.0.0.1 --port 8791` on a CUDA host.
  Upstream requires exactly one visible CUDA device with BF16 on `cuda:0`
  (`src/semif_phase1/core.py:82-83`, `load_causal_model`), which an M4 Max cannot satisfy without a
  patch (below). Do not modify SemIf in-tree.
- **SemIf self-hosted / cloud** — the same container behind `semif-hosted`; identical wiring.
- **GPU-less containers** — point at `semif-hosted` or the TypeSafe backend.

**Running SemIf on Apple silicon (operator path, not this repo's code).** Two facts decide it:
PyTorch's MPS backend does not support `bfloat16` (`pytorch/pytorch#141864`, closed not planned;
surfaces as `huggingface/accelerate#2226`), and `load_causal_model` hardcodes both the CUDA guard and
`dtype=torch.bfloat16, device_map={"": "cuda:0"}`. The readout itself is already portable —
`direct.py` takes the device from `next(model.parameters()).device` and gates
`torch.cuda.synchronize` on `device.type == "cuda"`; `serial.py` and `shared.py` contain no CUDA
references. So supporting this machine is a device/dtype seam in `core.py` (~30-40 lines):

1. accept `--device {cuda,mps,cpu}`, defaulting to cuda when available else mps else cpu, keeping the
   one-CUDA-device rule when cuda is chosen so the published baseline is untouched;
2. `torch.bfloat16` on cuda, `torch.float32` on mps/cpu (not fp16 — known MPS 16-bit correctness
   problems, `pytorch/pytorch#78168`); a 4B in fp32 is ~16 GB, within this machine's 64 GB;
3. `device_map={"": device}` and the resolved device + dtype recorded in the per-row `metadata`;
4. `torch.mps.synchronize()` alongside the existing cuda sync for accurate `forward_seconds`;
5. thread the flag through `cli.py`.

Their `REPRODUCE.md` permits this framing explicitly — "treat timings and model outputs as
measurements to compare with the committed row-level evidence, not byte-identical golden outputs" —
and notes BF16/kernel differences already shift borderline argmaxes. Expect MPS-fp32 to be slower than
the README's 3090-bf16 figures; measure before investing further. If throughput is unacceptable, the
follow-on is an MLX port (`mlx-community/Qwen3.5-4B-4bit` exists; ollama ships `qwen3.5:4b-mlx-bf16`)
with the same readout in `mlx` — a port, not a patch, and a separate measurement baseline. Ollama
itself is a dead end for this: it does not expose raw per-token logits.

Failures (non-2xx, timeout, malformed JSON, `probabilities` length ≠ option count, missing `answers`
key) throw `decision backend <url> failed: <detail>`; an unavailable decision is a normal chain
advance or a skipped verification (Step 3), never a run failure.

**Contract probes** — one per kind, both no-deps node scripts against upstream's own three-row fixture
`examples/decisions.jsonl` (shipped by SemIf): `scripts/semif-probe.mjs --backend <url>` asserts HTTP
200, `probabilities.length === options.length`, every probability in `[0,1]`, `|sum - 1| < 1e-6`;
`scripts/typesafe-probe.mjs --backend <url>` asserts the same for the option form, plus that a batched
`{noul, choice, score}` request returns one correctly typed answer per question id and that
`confidence` is present on `choice`/`score`. Both exit 1 with the failing row's id and response body.

**Stub backends** — `scripts/semif-stub.mjs` (port 8792) answers `/score` with fixed probabilities
(first option 0.6, remainder even) and `/health`; `scripts/typesafe-stub.mjs` (port 8793) mirrors the
TypeSafe envelope including `confidence` and typed answers. They exist so the extension contract, the
`decide` element, `verify`, and `route` are all verifiable with no GPU, no network, and no API key.

### Step 5 — Billing selection without a profile system

There is no profile command, no active-profile state, and no credential handling in this extension:
pi's `/login`, `models.json` `apiKey` values, and the provider ids are the billing story. A project
that must bill to another account:

1. adds that account as its own provider in `~/.pi/agent/models.json` (for example `tp-work`, whose
   `apiKey` is that organization's secret reference), and
2. lists it in the project layer — `.pi/pi-fusion-matrix.json` under pi, `.omp/pi-fusion-matrix.json`
   under omp, e.g.
   `{"aliases": {"deepseek-flash": {"providers": ["go", "tp-work", "tp"]}}}` — layers deep-merge, and
   arrays replace, so this one alias is the whole project override.

`pi.registerCommand("matrix-info", ...)` therefore only lists what is currently resolvable: every
alias with its provider chain, the fusion ids, the `backends` kinds, and which config layers were
loaded. It never writes configuration and never switches a profile.

### Step 6 — Deliberation pipeline, written here

`run.ts` owns the pipeline outright. `@quarkos/pi-fusion` is not imported, installed, or required
anywhere: it is a *reference implementation* for behaviors this repo re-derives, not a dependency.
Absolute and sibling-checkout path imports are forbidden in this package — it must run from a container
with no developer checkout present.

The interpreter (Step 3) executes whatever a mode declares; this section fixes the behavior *inside* a
seat and the assembly rules, all re-derived from `<vendored-fork>/lib/deliberation.js`:

1. **A seat is one model call.** Persona prompt as the system message, the stage's resolved input as the
   user message, `temperature` and `thinking` from the persona (or the fusion's override). No tools, no
   session, no subprocess.
2. **Panel labelling.** Seats are concatenated in stage order, each under a heading that names both the
   persona and the model that answered: `## technical — openai/gpt-5.6-sol`. The heading is what later
   stages cite, and what substitutes make visible: a seat answered by its second provider keeps the
   same heading, because the *persona* is unchanged and only the route moved.
3. **JSON personas** (`output: "json"`) append "Output only a valid JSON object with keys …" to the
   persona prompt and parse with the two-stage recovery: strip a leading ```` ```json ```` fence, else
   extract from the first `{` to the last `}`. On total parse failure keep the raw text under
   `unique_insights` so the next stage still receives something (the reference implementation's
   fallback object is the model).
4. **`alsoSynthesize`** appends one instruction to the final stage: produce the answer to the original
   request after the analysis, in the same message. The stage's output is then both analysis and answer,
   and `details` records it as such rather than pretending a separate synthesis ran.
5. **`score` and weights.** One `score` question per panel seat, batched into a single backend request,
   producing a number and a confidence per seat. `panel+weights` renders them as a sorted
   `persona: score (confidence)` list above the panel, so a judge can weigh rather than guess.
6. **Streaming** — hand-emit pi's event stream to the contract below, because the factory cannot be used
   here: `streamSimple` must *return* a stream synchronously while `@earendil-works/pi-ai` is resolved
   asynchronously (the peer module is loaded lazily, so that a pi whose installation cannot be walked —
   a compiled single-file build — registers its models and reports the failure per seat instead of
   failing the whole extension at load). The stream is the same shape the library's
   `AssistantMessageEventStream` implements — queue-or-waiter delivery, `end`, async iteration, `result`
   — so the two agree on every semantic that matters; if the peer ever becomes available synchronously,
   substituting the library factory is the change to make. Emit `start` with the empty partial, `text_start`, `text_delta` per progress/
   substitution/verification/synthesis chunk, `text_end`, then `toolcall_start`/`toolcall_end` pairs per
   file-agent write, then `done` or `error`. Contract verified against pi's consumer at
   `node_modules/@earendil-works/pi-agent-core/dist/agent-loop.js:201-243`: it replaces
   `context.messages[last]` with each `partial`, so every partial must be a complete
   `AssistantMessage`, and it reads tool calls from the final message's `content`, so `done.message`
   must carry the `toolCall` blocks. Only the seat that produces the answer streams token-by-token;
   every other seat reports its status line, because a five-call pipeline streaming five interleaved
   answers is unreadable. **Verified live 2026-09-18** on pi 0.84.2 and 0.85.1: token-by-token text, the
   file agent's `write` executed by pi from the emitted `toolCall` blocks, and the tool path returning a
   rendered panel.
7. **Usage** — sum `message.usage` over every delegated call and shape it as `{ input, output,
   cacheRead, cacheWrite, totalTokens, reasoning?, cost: { input, output, cacheRead, cacheWrite,
   total } }` (`Usage` in `pi-ai/dist/types.d.ts:255-278`). Zero-fill cost; no `calculateCost` call and
   no price table. Decision stages add their backend's reported `usage` separately, since those tokens
   are billed by a different account.

Persona prompts are files: `prompts/*.md`, referenced by path from `matrix.json` and read at load.
Editing what a seat is told is a text edit, not a code edit, and an operator can point a persona at
their own file without touching this repository. The packaged prompts were transcribed verbatim from
`<vendored-fork>/pi-harness.config.json` before that checkout is removed; `merge.md` and
`synth-lean.md` are the two written here.

### Step 7 — The doctor

`matrix-doctor` is how config drift surfaces as a report instead of a mid-run surprise. It is a command
(`/matrix-doctor`) and a standalone script (`node scripts/doctor.mjs`), and it never mutates config.

| Check | Catches | Needs network |
|---|---|---|
| `config` | schema, stage dataflow, roster/shape agreement, prompt paths — the Step 1 rules, re-run outside a session | no |
| `connect` | an alias routing through a provider pi does not know, or one with no configured credential (`hasConfiguredAuth`), and an alias with only one route (no fallback to fall back to) | no |
| `metadata` | a fusion whose executor alias declares no `contextWindow`/`maxTokens`, so its registered model advertises the package default rather than the executor's numbers (Step 9) — informational, and never a repair | no |
| `reach` | a vendor id the provider **no longer serves** (retired or renamed) as distinct from one it serves but pi does not catalogue — the latter is expected and fine | yes, one `GET /models` per provider |
| `drift` | an id that disappeared upstream while `matrix.json` still names it, and a catalogued id that is newer than what an alias pins | yes |

Exit status: `0` clean, `1` config errors, `2` connectivity problems, `3` reachability or drift
findings — so CI and a pre-run hook can distinguish "broken" from "out of date".

Rules, all following from the no-silent-degradation invariant:

- **Additive repairs only.** `--repair` may print (and with `--write`, apply) the `models.json` upsert
  snippet for an id you asked to see in pi's picker. It must never rewrite an alias's `model`, never
  substitute a different id, and never choose a "close enough" model — a repaired config is a config the
  operator chose, plus ids.
- **Offline by default.** `config` and `connect` need no egress; `reach` and `drift` are opt-in
  (`--online`) because containers and CI often have none.
- **Loud when it cannot fix.** Every finding names the alias, the provider, the id, and the exact
  snippet or command that would resolve it; an unfixable finding exits non-zero rather than passing.
- **The doctor never guesses intent.** The alias table is a curated decision about what to run. The
  doctor's job is to say when reality has moved, not to pick a replacement for you.

### Step 8 — The run record, and the report that reads it back

A run record is worth exactly what it survives. Both entry points write the same `details` into the
session, on the two carriers the harness persists:

| Path | Carrier | Why it survives |
|---|---|---|
| the `matrix` tool | the tool result's `details` | `execute` returns it, and tool results keep `details` |
| `/matrix` | a `custom_message` answer's `details` | `pi.sendMessage` keeps `details` (`appendCustomMessageEntry`) |
| a proxying fusion's turn | the assistant message's `details.proxied` | the record rides the terminal event's message |

The command path was the one that hid the record: it sent the answer text and dropped `result.details`,
so measured 2026-09-19 over the 46 sessions on the implementing machine there were **zero** deliberation
records — the deliberate face was unobservable once a turn ended. Both paths now persist the record, and
a failed run records its failure rather than only raising a notification: a run whose seats all failed
keeps its degraded seats, `seatErrors` and substitutions, and a run that threw records `{ fusion, error }`.

`scripts/session-report.mjs` is the reader, and the reason the record stays honest:

- it reads both harnesses' session JSONL (`~/.pi/agent/sessions`, `~/.omp/agent/sessions`), with no
  network, no keys, no model calls, and no writes;
- per run it also reads the clocks we record ourselves, because neither harness times a call we make: a
  seat's `durationMs` (the sum of its calls, so a retry is included) with each failed attempt's own time,
  the run's `durationMs`, and — on a proxied turn — the `usage` a route spent before it failed;
- per fusion and per model it totals turns, tokens, cost, tool calls and tool errors; for deliberation
  runs, seats, degraded seats, seat errors, cascades split sufficient/advanced, substitutions, decision
  tokens, routes, verification and saved files; for proxied turns, the alias that answered, the level the
  turn ran at, the levels it had to drop, and every route it tried, by reason;
- **it refuses to read an absence as a zero.** A message whose harness records no duration, and one whose
  provider reports no price, are counted as *unrecorded*, not as `0` — pi records no duration at all, omp
  records `duration`/`ttft`, and a subscription provider reports no cost. "We did not record it" and "it
  cost nothing" are different facts, and only one of them is true. Money is therefore printed as
  `$X reported` with its unpriced messages counted beside it, never as one total that absorbed both;
- **it names what it does not recognise.** A `details` shape carrying a record key but no fusion id is
  printed with its full path, carrier and keys — and never counted as a run; a line that does not parse is
  counted *and* named with its file, line number and reason, and the first ten of every diagnostic list are
  followed by an omitted-count marker. A reader that silently skipped any of these would make a missing
  record look like a clean run;
- **the outcome is a label, and the work item is not.** Two halves, and only one of them needs a human.
  **The work item travels on the run**: the `matrix` tool takes an optional `workItem`, and `MATRIX_WORK_ITEM`
  supplies one for a whole process — the shape a review runner has, launched for a known piece of work in a
  session nobody can type a command into. It lands in `details.workItem`, and the report attributes a run from
  the *record* first, falling back to the session's label. That is what makes a review run's cost land on the
  issue it reviewed without anyone remembering anything.
  **The outcome is written by two front doors over one implementation**: `/matrix-label <work-item> <outcome>
  [evidence]` for a person, and a `matrix-label` **tool** for an agent, so the agent records the outcome at the
  moment it knows one instead of a human being asked to type it afterwards. Either writes a `matrix-label`
  custom message — an append-only label whose latest entry is the current outcome, so a session that was in
  review and then landed carries both — and the vocabulary is closed (`landed`, `review`, `findings`, `ci-red`,
  `blocked`, `abandoned`) because a free-text outcome cannot be counted. An unrecognised one is refused without
  writing anything, by both doors. The label is the one fact a run cannot know about itself: the report joins
  it to the runs, their fusion turns and their cost, counts a session that produced runs without a label as
  **unlabelled** rather than assuming it went well, and shows a work item that has runs and no outcome as `?` —
  counted and visible, never dropped and never a success. A hand-written label missing either half is named as
  an unrecognised shape, not counted. A run's cost is attributed **once**: a streamed run's record repeats the
  usage its message carries, so the message of a self-attributed record is excluded by the `at` the two share;
- **it reads what omp recorded, rather than what omp's record looks like.** omp invokes an extension tool
  through its `xd://` device protocol: the call is stored as `write` (or `read`, for reading a tool's docs)
  with `arguments.path = "xd://<tool>"`, and the result's record is wrapped one level in, as
  `details.xdev.inner`. A reader that looked only at the outer object dropped every such run — measured
  2026-09-20: one plain deliberation record in the store against two wrapped and invisible, with a session
  that ran two fusions reporting none. The reader unwraps it, attributes the invocation to the tool it
  invoked (`read` of `xd://<tool>` stays a `read`: reading docs is not calling, and the rewrite is gated on
  the harness, so a pi session saving a file whose relative path happens to be `xd://matrix` stays a write),
  names the result by the tool that ran — paired to its call through a session-level index by `toolCallId`,
  because a device call that *fails* is stored with empty `details` and a result row is not guaranteed to follow
  its calling turn — and **counts the invocations** from the calls rather than from the results, so a device
  call whose result never reached the store still counts and the line agrees with the tools table. It also
  knows which harness a file came from, derived from where the file lives, so `--session <file>` does not lose
  the device protocol: the same omp session reports its `matrix` runs as such whether it was found through the
  store root or handed over by path;
- **it reads the harness's plan ledger, and says what it read.** omp keeps every quota reading in its own
  `agent.db` (`usage_history`: provider, limit, label, used fraction, status, resets, recorded at); the reader
  opens it **read-only** with `node:sqlite`, takes the latest reading per `(provider, limit)` for display, and
  prints the windows with **the age of each reading** — a stale row is not the current state, and one older than
  six hours is marked. `resets_at = 0` (the provider stated none) prints as "no reset stated", never as 1970. The
  join to our own runs is deliberately narrow: a `quota` refusal is only *explained* by a reading taken **before**
  it whose reset has not passed, so a window read afterwards cannot turn a coincidence into a cause. That rule
  needs the ledger's **history**, not the display's latest row: a reading taken after a refusal would otherwise
  stand for the window and report a covered refusal as uncovered. Five further facts the join owes a reader,
  each found by an automated review of the first version:
  - a refusal belongs to the **route that was refused**, so each attempt records its own `provider` and `model`;
    the record's `proxied.provider` is the route that *survived*, and attributing every attempt to it asks the
    ledger about the wrong plan whenever a first choice is refused and the fallback answers;
  - **only omp keeps this ledger**, so only a refusal from an omp session is joined to it. A pi session's
    refusal is named as one with no ledger rather than counted as unexplained — and a pi provider is never
    reported as missing from a ledger it was never meant to be in;
  - every covering reading keeps the **status it actually had**: `warning` is not `ok`, and collapsing them
    says a refusal happened while the window read fine, which is a different claim from the one the ledger made;
  - a refusal with **no placeable time** is counted as undated rather than as uncovered: a record's missing
    clock is not the ledger's failure to cover the moment;
  - a provider we used with **no window in the ledger is named whether or not any refusal was recorded**,
    because that absence is a fact about the ledger, and printing only "nothing to join" presents it as
    completeness.
  Every other absence is named too — no ledger, no `node:sqlite`, a schema this build does not know,
  `--no-plans` — because "no windows" and "no readings" mean different things to a reader judging whether a
  failure was the plan or the model.
  (*Persisting* these facts — `plan`, `plan_window`, `quota_event`, the `list_equivalent` costing basis — belongs
  to the metrics store, #14; this is the reader's view of them.)
- **a run's tokens are counted once.** `details.usage` already sums the run's seats — verified against the
  store, where a one-seat run's `details.usage.input` equals that seat's — so the seats are not added again.
  They *were*, which doubled every deliberation's tokens and cost from the reader's first version;
- **it prints seats by model, because that is the view that accumulates.** Per model, across every session in
  the store: seats, tokens, cost, seat-time, degradations, and the reasons its routes were substituted — plus,
  where a seat answered findings as data, how many it raised, how many the run's own disposition **kept**, and
  how many of those name a *located* path. A single run cannot rate a model: a seat's answer is judged by a
  peer, not by ground truth, and the synthesis merges the panel's opinions into findings that belong to the
  fusion. Days of runs can, which is why the view is over the whole store rather than over a run. Survival and
  location are matched the same way: a kept finding is one the disposition carries at the same `path` and `line`
  (a synthesis keeps a finding's trigger and may reword its claim, so comparing claims would report every
  finding dropped), and a located one is a path that resolves inside the session's tree. That is the difference
  between a review's numbers meaning something and a rung winning a count by inventing its locations;
- **filters select rows, never the accounting.** `--cwd`/`--since` decide which sessions are totalled; the
  files read, the unparsed lines and any session a filter could not attribute (a truncated header has no
  `cwd` to compare, and a malformed timestamp cannot be placed) are reported either way, and the exit
  status is non-zero whenever something could not be accounted for — so a filtered report cannot present a
  short total as a fact about the fusions, and a file that cannot be read is never a quiet omission.

Exit status: `0` report produced, `1` the store could not be accounted for (missing or empty `--dir`,
unreadable `--session`, an unreadable file or directory, a line that did not parse, or a session a filter
could not attribute). **The reader's own accounting is a unit test, not a `--check` branch**: it lives in
`test/session-report.test.mjs`, is run by `npm test` like every other module's behaviour, and is counted by
that run's own output — a module whose checks can only be exercised by running its script is a module whose
units nobody can test, and the reader is thirty-eight hundred lines of units. Its checks are verified the same
way they are written, as for the interpreter contracts: by mutating the reader and watching a named check fail.
The CLI path is covered too, by the checks that spawn the script itself: argument handling
(an unknown flag is a named usage error) and the report it prints (`--json` against a fixture store). Nothing
about this reader needs a separate smoke test, and a run on a machine with no session stores exits 1 by design —
"no sessions directory at …" is not a clean report.

### Step 9 — Proxy mode: a fusion that answers agent turns

A fusion otherwise happens *beside* a coding session: `matrix`, `/matrix`, and a pinned rung deliberate
and hand back prose. A pinned rung cannot be the session's model, because the provider path drops the
tools and all but the trailing user message — measured 2026-09-18: a session pinned at a rung, asked
for its own `package.json`'s name, answered *"run `node -p "require('./package.json').name"` … if you can
grant file-read access"*. Proxy mode is the other face of the same fusion definition: the harness's own
turn goes to one model, and its events come back.

**Branch selection is by invocation, never by guessing.** A fusion that declares an executor, reached
through the provider with `context.tools` present, proxies; every other path behaves exactly as it does
today. No classifier means nothing can be misclassified: `/matrix` and the `matrix` tool call the
pipeline directly (`runOnce`) and never proxy; a rung whose mode writes nothing (`opinions`, `debate`)
declares no executor and still deliberates with tools present; `--thinking`, temperature, and the
prompt's shape never decide the branch. An empty tool list is not a tool-bearing turn — there is no
agent loop to serve — so it deliberates too; measured 2026-09-19, that means a pinned rung proxies in
practice, because the extension's own `matrix` tool is in the list even under `--no-tools`
(`--no-extensions -e <this extension> --no-tools` hands the turn `tools: ["matrix"]`), while a
tool-less side-channel call — a title, a compaction — keeps today's pipeline. Phase 2's verdict is
where that changes, not a heuristic here.

**The writer defines the executor.** One definition declares both faces:

- deliberate face — `mode` + roster: what runs when deliberation is asked for;
- execute face — the writing seat (a pipeline's synthesis, or the single seat) and the thinking the
  fusion declares for it.

To change which model codes under a rung, re-point one seat: `best`'s `synth` at `qwen-max` makes every
`best` execution turn run on that model while its panel stays cheap at `low`. `proxy: { alias }`
re-points *which model the writing seat acts as*, for the case where the writer is a fine merge and a
thin coder. It is not a way to give a mode that writes nothing (`render`, a bare `decide`) an executor:
such a fusion has no persona, so the thinking rule would have no row to read and a configured level
would be dropped in silence — the loader rejects it instead.

The proxied turn walks that seat's **candidate**, not merely the alias's own route: the object form
carries a per-seat provider order, a `modelOverride`, and a thinking level, and the two faces have to
walk the same candidates, or the coding turn can run on an account the seat deliberately excluded. When
`proxy.alias` is set, that alias's *own* provider chain is what answers — its providers are its own, not
the writer's — while the writing seat's declared thinking level still governs the turn, because which
model acts and how hard it thinks are two different declarations.

The consequences are worth keeping in view: re-pointing a writer also upgrades that rung's
*deliberation* synthesis (usually wanted, one call), and a rung whose writer is a flash model is a cheap
executor — `good` means "cheap models, cheap writing", which is correct, visible, and fixed by
re-pointing its writer.

**What a proxied turn forwards.** `context.messages`, `context.tools`, and `context.systemPrompt` reach
the target byte-identical, as does `options` with the credential resolved for the target: `signal`,
`temperature`, `reasoning`, `sessionId`, `metadata`, `thinkingBudgets`, and `providerSessionState` —
prompt caching, request attribution, and response chaining are built on them, and re-inventing any of
them pays full input price on every turn. What is *not* forwarded: any persona prompt (a tool-bearing
turn needs the harness's coding instructions, not a deliberation seat's), the file agent's `write` tool,
and every form of pipeline decoration.

**Nothing of ours is added to the message.** No banner, no seat line, no substitution line, no route
decision, no file agent, no verify: in a coding turn that text lands in the conversation and corrupts
the agent loop. Progress belongs on the harness's status line, which owns it. The one rewrite is
identity — a forwarded event is re-labelled as the fusion's registered model, which is what the harness
matches on before it will treat a proxied turn's overflow or truncation as its own to recover from
(`pi` 0.85.1 `dist/core/agent-session.js`, `_checkCompaction`'s `sameModel`). Everything else — content
blocks, signed thinking, `responseId`, usage, provider session state — passes through.

**A failed target is reported, never substituted.** The alias's providers are walked in order as a
seat's are, but with no line in the message: every attempt lands in `details.proxied.attempts`, and a
turn whose every route failed ends as an error message naming the alias, the reasons, and their details.
Falling back to the pipeline would answer a coding turn with a deliberation and status lines, which is
the failure this mode exists to prevent.

Three shapes of failure, and each is handled where its facts are known:

- **Nothing forwarded yet** — the alias's next provider gets the turn, exactly as a seat's next route
  would. A provider that is not configured, has no credential, whose stream throws before its first
  event, or whose first event *is* a terminal `error` all land here: an error with nothing before it
  never reached the harness's conversation, so it is a route that never began rather than a turn that
  failed. A terminal event after a partial is forwarded verbatim instead — the harness owns the turn from
  there, and its own retry and auth-recovery machinery is what acts on it.
- **The level was refused** — a level the target does not support is our request rather than its failure,
  so the route is retried once without one. It can surface where the stream is created, where it is first
  pulled, or as a first-event `error`, and the attempt is recorded either way: measured 2026-09-19, omp's
  `alibaba-token-plan/deepseek-v4.1-flash` answers *"Thinking effort low is not supported … Supported
  efforts: high, max"* — five words of config, one refused route, and a turn that would otherwise die. The
  retry is the proxy's own and is *not* recorded in the seat path's per-model memory, because that memory
  is a seat's reason to skip its own no-level retry: sharing it turned one recovered proxied turn into a
  degraded `/matrix` on the same rung.
- **Something already reached the caller** — the turn is the harness's from then on, because pi pushes
  the partial into its conversation on `start`; a second provider's `start` would append a second
  assistant message. The turn ends with the failure.

**Thinking precedence is decided here, because the harness resolves `auto` before we see it.** A
`--thinking auto` turn arrives as `reasoning: "low"`, indistinguishable from a user-chosen `low`, and
the extension API exposes `zod`, `typebox`, `arktype`, and `flagValues` but no settings accessor. Per
fusion, for the writing seat only:

| declared | a proxied turn runs at |
|---|---|
| a concrete level (`"high"`) | exactly that level |
| `"harness"` | whatever level the harness sent |
| absent | the writing seat's persona thinking if it declares one, else the harness's level |

That is total and deterministic, and it needs no signal we cannot see. The literal is the execute face's
alone: the pipeline strips it where a seat's level is resolved (`pipeline.js`), because a seat is called
at a level we choose and would otherwise ask its provider for a level named "harness". A harness that
ever exposes its settings can reinstate the "was this auto?" distinction without changing the config
surface.

**Registered metadata is the facade's.** A fusion with an execute face registers its executor's
`contextWindow`, `maxTokens`, and thinking capability, taken from that alias's declared values —
registration runs before any session exists, so there is no catalogue to consult. The harness sizes its
context budget from `contextWindow` and reads `maxTokens` to tell a truncated answer from a finished one,
so an 8192 default in front of a 384K-output model either clips an edit or sends the loop recovering
from a truncation that never happened. The doctor reports a writer alias that declares neither, so
re-pointing a writer at an alias whose numbers nobody wrote down is visible before a turn pays for it.

**Reporting.** `details.proxied = { alias, provider, model, template, thinking, attempts }` on a proxied
turn, readable in the transcript's assistant message.

**One provider, two behaviours** is the real conceptual cost, and it is deliberate: the same id answers a
question one way and an agent turn another. `matrix-info` prints each fusion's execute face beside its
roster so the two faces are legible together. Phase 2 — a per-task verdict with a `code` criterion, plus
a session ledger of decisions that carries no content — is designed in #9 and deferred; the fallback
when a classifier is unreachable, and whether route observations influence a verdict, stay open there.

### Step 10 — The review route: a class decides which models review

Reviews are a second kind of traffic, not a fusion of a task. A review does not act on a repository and its
input is a *packet* — a diff, the acceptance criteria it was written against, and the validation evidence — so
its rungs are configured for judging rather than doing, and the class of the change decides which rung runs.

| class | what it means | rung |
|---|---|---|
| `mechanical` | docs, comments, formatting, a config value with no behaviour change — nothing a test could catch instead | `review-quick` (one adversarial seat, then the disposition) |
| `standard` | an ordinary behaviour change, contained within one component | `review-check` (committee, cascaded, disposition) |
| `high` | a boundary: auth, authorization, tenancy, payments, schema or data migration, a public API contract, release tooling, anything irreversible, or a blast radius the packet cannot bound | `smrt-review`'s own mode — the deep committee, with the boundary question in its verification |

`smrt-review` is a `route` fusion in the shape of `default-smrt`, with two deliberate differences:

- **its own mode is the deep review.** A route that declines runs the fusion's own stages, so an unsure class
  escalates to the deepest review instead of quietly taking the cheap one — and a route option that matches but
  declares no `then` is recorded as `routing.escalated`, not as a decline, because a deliberate escalation that
  reads as a decline is a lie in the audit trail;
- **an option may carry no target on purpose.** The `high` class is that option: it means "run this fusion".

**`execute: false` — a rung that is never a session model.** Pinning a reviewer is the whole point (a `task`
agent whose model is `fusion-matrix/smrt-review`), and an execute face breaks it: a tool-bearing turn to a
fusion with an executor *proxies to its writing seat*, so the panel never runs and the review silently becomes
one model's opinion. A rung that declares `execute: false` runs its pipeline instead, whatever tools the turn
carries. Load errors, because each one is a silent degradation waiting to happen:

- `execute: false` together with a `proxy` block (a proxy is answered by the writing seat the fusion has
  declared it never uses);
- `review: true` with `execute` anything but `false` (the reviewer runs the rung as its model);
- `review: true` without a `route` (the class is what selects the rung);
- a `review: true` route whose target does not itself declare `execute: false` (a pinned reviewer would proxy);
- a fusion whose writing seat answers in JSON (`output: "json"`) without `execute: false`. A disposition is not
  an agent turn, and the failure this prevents is silent: a proxy to a JSON seat answers perfectly well — with a
  review where work was asked for. Every packaged rung declares `execute: false` by hand; the rule is what keeps
  the next one from having to remember.
- a `disposition` that names no seat, a seat its mode does not run, a seat whose answer is not JSON, or a list
  that leaves out the mode's last stage seat — that last answer is the one the run records, so a declaration
  without it would judge seats whose answers nobody reads. A mode ending in no single seat declares none.
- `review: true` without a `disposition`, and a `review: true` route to a rung that declares none: the class
  selects the rung, and a verdict nobody declared is a review recorded as having found nothing.

**The disposition is data.** A review rung's last seat is the `review-synth` persona (`output: "json"`), and its
answer is recorded on the run as `details.dispositionBy` (the persona whose answer stands), `details.verdict`,
`details.findings` (`{severity, path, line, criterion, claim}` each) and `details.severityCounts`.

**The rung declares which of its seats answer a disposition**, and only those are judged. `disposition.personas`
is a non-empty list of the fusion's own seats — every one of them run by its mode, every one `output: "json"`, and
the mode's last stage seat among them because that answer is the one the run records. The schema belongs to the
rung rather than to the shape of an answer, and both failures that follow from that are the reason for the rule: a
classifier's `{"verdict":"clean"}` is a valid label for *its* contract and must not be failed by this one, while
the seat that promised findings and answered `{"summary":"…"}` fails a contract nothing in its answer mentions.
Whatever the verdict, the answer is still recovered as data for the next stage. A `review: true` router declares
one, and so does every rung it routes to: a review whose verdict is nobody's contract is not recorded.

Every field of a declared seat's answer is checked, and a flaw — a verdict outside `clean | findings`, a `findings`
that is not a list, a finding without a `severity` from `blocking | major | minor | editorial`, without a `path`,
with a `line` that is neither an integer nor `null`, without a `criterion` or without a `claim`, a `clean`
verdict with findings, or a `findings` verdict with none — is recorded as `details.malformedAnswers` with the
reason, and records *no* verdict and *no* findings. So is an answer that is not a JSON object at all: a JSON seat
was asked for an object, and prose (or a top-level array) is a broken contract however readable it is.
`{"verdict":"clean"}` is not a clean review; it is a declared seat answering without the findings it promised, and
it reads as exactly that.

**One writer, in order, and nothing is overwritten.** `details.malformedAnswers` is a chain: one entry per answer
that failed its contract, in the order they arrived, each naming the seat that superseded it. A valid disposition
supersedes an earlier malformed answer; a malformed answer supersedes either kind, and takes the standing position
outright — that ordering is the one that must never read as clean. Superseding is not deleting, and it is not
overwriting either: a run that produced three bad answers before a good one produced three, and a record that kept
only the last would have lost two failures. The answer that stands is the one `dispositionBy` names; when no valid
answer landed, it is the last entry in the chain. A finding's `line` keeps an explicit `null` — the persona prompt
allows a null line for a finding about the change as a whole, and dropping the key would lose a field the contract
says is always present.

Severity is what decides whether another review is bought: an `editorial` finding never does, and a run whose
findings are all `editorial` is visible as such.

A finding's `path` is the reviewer's claim, not a fact: the cheap rung names files in a diff it has only read as
text, and a run whose findings all name a path that does not exist is a hallucination the *report* has to be able
to show. `session-report.mjs` checks each recorded path against the session's working directory and prints
`[path not found]` beside it — as of *that run of the report*, so a file a later commit deleted is not presented
as a hallucination — and marks a path that does not resolve inside that tree `[path outside the session]` rather
than resolving it, since resolving one would let a hallucinated `/etc/passwd` read as found on any machine that has
one, and a relative `../../etc/passwd` do the same while looking innocent.

Two limits, stated rather than discovered later: the *class decision* sees the packet truncated to the decision
backend's state budget (its head and tail — the panel gets it whole), and a review rung has no tools, so a packet
that does not contain the diff is not a review.

**The panels answer findings as data.** The three review personas (`review-skeptic`, `review-technical`,
`review-systems`) are `output: "json"` and answer the same schema the disposition validates, so each seat's
findings ride *its own* seat record (`details.seats[].findings`) beside the model that raised them. That is what
makes a model and what it found a single lookup, accumulated over every session the store holds — see the
report's seats-by-model section — instead of something only a reader of the transcript can know. What the run
*itself* concludes is still the synthesis's: a panel seat's findings are evidence, not the disposition.

**The verify bar is per question, and the review rungs are calibrated.** `question.warnBelow` (default 0.5) is
the value below which a `noul` answer raises a warning, and it has to be per question because one backend scores
different traffic differently: measured across eight review runs (2026-09-21), a `clean` verdict sat at 0.23
while real reviews sat at 0.44–0.76. At 0.5 every review warned and none of the warnings corresponded to a
defect — six warnings, no true positives — so the review rungs warn below **0.35**, which separates the one
suspicious case (a clean verdict its own check could not confirm) instead of flagging all of them.

**The committee's decision bar stays at 0.85, and that is a measurement rather than an oversight.** Across those
same runs every stage decision came back `insufficient` at 0.79–0.84, so the cheap path was never taken. On
inspection the gate is *right*: those answers read `disagrees` — the panels genuinely differed, which is exactly
when the judge earns its call — and a converged panel skipping the judge was never what those runs were. One
sample of "always insufficient" is not evidence to move a threshold; the point of recording `details.cascades` is
that the data will say so when it is. The same holds for cost-per-finding, which flatters whichever rung invents
its locations: what a review's numbers are read against is *located* findings, which the report counts.

## Critical files & anchors

Reference-only — read from the vendored copy of upstream `@quarkos/pi-fusion` (referred to below as
`<vendored-fork>`, the checkout of that project on the implementer's machine) to re-derive behavior.
It is never imported, and that copy may be deleted once this plan's verification passes:

- `<vendored-fork>/lib/deliberation.js` — the pipeline order, judge JSON recovery, and the
  prompt-assembly headers to reproduce (Step 6).
- `<vendored-fork>/index.js:478-745` — the verified `streamSimple` event sequence and the
  `toolcall_start`/`toolcall_end` emission that makes pi execute file-agent writes.
- `<vendored-fork>/lib/api.js` — the quota/credential/missing-model/transient taxonomy and the
  temperature-rejection memory that Step 3's table encodes.
- `<vendored-fork>/pi-harness.config.json` — source of the persona prompts now in `prompts/*.md`
  (transcribed verbatim; keep the checkout until verification passes). Upstream
  [`@quarkos/pi-fusion`](https://github.com/QuarkOS/Pi-Fusion) by **Antigravity Pair** is **MIT, © 2026
  Quark**, so the transcribed prompt files carry its notice: see
  [`THIRD-PARTY-NOTICES.md`](../THIRD-PARTY-NOTICES.md).
- `<vendored-fork>/index.js:485-506` — `extractPrompt`: the trailing-user-run prompt selection to
  reuse verbatim.

pi-side references:

- `node_modules/@earendil-works/pi-agent-core/dist/agent-loop.js:201-243` — the only consumer of the
  stream this extension returns; defines what `partial` and `done.message` must contain.
- `dist/core/agent-session.js` (`_checkCompaction`, pi 0.85.1) — the `sameModel` comparison of
  `provider`/`model` against the session's own model, which is why a proxied turn's forwarded events are
  re-labelled as the fusion's registered model (Step 9).
- `node_modules/@earendil-works/pi-ai/dist/types.d.ts:382-440` (event union), `:255-278` (`Usage`) —
  the exact event and usage shapes to emit.
- `docs/custom-provider.md`, `docs/packages.md`, `docs/extensions.md` in
  `~/.npm-global/lib/node_modules/@earendil-works/pi-coding-agent/` — provider registration rules
  (`apiKey` required with `models`), local-path package rules, and the async-factory note.
- SemIf upstream (cloned for reference only, never vendored into this repo):
  `src/semif_phase1/core.py` (`validate_row`, `load_causal_model`), `direct.py` (the logit readout the
  server wraps), `manifests/models.json` (pinned sources + revisions).

## Verification

Prerequisites: the providers the packaged aliases name must be configured in pi — `opencode-go`, `zai`
and `kimi-coding` from pi's credential store, `openai` from `OPENAI_API_KEY`, and the operator's own
`qwen-cloud-token-plan` entry. No `models.json` change is required for the packaged config (Step 2).
`TYPESAFE_API_KEY` for the live decision checks. `/tmp/fusion-matrix-check/` as `cwd` for scratch runs
(create, remove at the end), and the pi config repo symlink from Step 1 in place.

1. **Credential seam (do this first)** — with `opencode-go` connected, run
   `pi -p "Reply with exactly: ZQX1" --model fusion-matrix/quick --no-session`. `quick` is one seat on
   the `deepseek-flash` alias, so the seat is `deepseek-v4.1-flash`, which pi does not catalogue; success
   is the ` technical: opencode-go/deepseek-v4.1-flash` line with no substitution after it, which proves
   the seat built a model object for an uncatalogued id and pi resolved the provider credential.
   (`--model fusion-matrix/<alias-id>` is not a thing: an alias id is never registered as a pi model, so
   the id to pass is always a fusion. The final text is not the signal — one bare token is a degenerate
   run, not a deliberation.) Confirm `details.seats[0]` shows `model: deepseek-v4.1-flash`,
   `provider: opencode-go`, and a `template` id that pi *does* catalogue. Then point the same alias at a
   provider pi does not know (`{"aliases": {"deepseek-flash": {"providers":
   ["nope", "opencode-go"]}}}`) and confirm the `missing provider` substitution appears and the run
   still answers. **Verified live 2026-09-18**, driven then through the `glm-flash` alias (the seat is
   `deepseek-flash` now): both halves pass against `opencode-go`, with the
   substitution reading `technical glm-flash@nope → glm-flash@opencode-go (missing provider)`. Earlier the
   same day, **probed** with a synthesized model against `opencode-go`: `ctx.modelRegistry`
   is present in the extension context; `find("opencode-go", "glm-5.3")` returns a template with
   `api=openai-completions`; `find(…, "glm-5.3-flash")` is absent as expected;
   `getApiKeyAndHeaders(seatModel)` returns `ok` with a 67-character key; `import("@earendil-works/pi-ai/compat")`
   resolves from an extension; and the call succeeds **only** with an explicit `x-opencode-session` header
   (`sessionId` in options returned the same `400 MissingSessionID`). If this item fails, every later
   check is built on sand: the fallback would be catalogued-ids-only, the aliases would have to change,
   and E1 must know before it writes the resolver.

2. **Model registration** — `cd /tmp/fusion-matrix-check && pi --list-models fusion` prints all
   eight: `cheap`, `quick`, `good`, `best`, `default-smrt`, `opinions`, `debate`, `review-check`,
   each under the `fusion-matrix` provider. Failure here means the api id, manifest, or symlink is
   wrong.
3. **Config validation** — three separate project files, each run expected to fail at load with the
   named message: an unknown alias in a candidate list
   (`{"fusions": {"best": {"candidates": {"judge": ["no-such-alias"]}}}}` →
   `unknown alias "no-such-alias"; known: …`); a mode whose roster does not match its shape (`best`'s
   own `{"modes": {"pair-judged": {"stages": [{"parallel": ["technical"], "input": "prompt"},
   {"render": "panel"}]}}}` → names the missing candidate key); and a stage reading something nobody
   produced (`{"modes": {"lean": {"stages": [{"single": "synth-lean", "input": "panel+judge"}]}}}` →
   `stage 0 input "panel+judge" has no preceding single stage`). Remove each file afterwards.
4. **Provider-layer fallback (same alias, new billing route)** — in
   `/tmp/fusion-matrix-check/.pi/pi-fusion-matrix.json` set
   `{"aliases": {"deepseek-pro": {"providers": ["nope", "tp"]}}}`. A `review-check` run must print
   ` ├─ ↩ skeptic deepseek-pro@nope → deepseek-pro@tp (missing provider)`, complete, and —
   driven through the `matrix` tool with `fusion: "review-check"` — report exactly one substitution
   whose `from` and `to` share the same alias name. Remove the override afterwards. This verifies both
   the native-provider lookup and that a stale provider name degrades per seat instead of aborting.
   **Verified live 2026-09-18** on the five-seat committee shipped then (`deep`; `review-check` ships
   the same roster now), with `["nope", "opencode-go"]` (the operator's second route had no credential
   that day): the run printed ` ├─ ↩ skeptic deepseek-pro@nope → deepseek-pro@opencode-go
   (missing provider)`, plus the same per-seat line for the judge, and every seat then answered on
   `opencode-go`.
5. **Slot-layer fallback (new alias)** — in the same project file set
   `{"fusions": {"review-check": {"candidates": {"systems": ["kimi", "glm"]}}},
   "aliases": {"kimi": {"providers": ["nope"]}}}`. The run must print
   ` ├─ ↩ systems kimi@nope → glm@go (missing provider)` and
   `details.substitutions[0].from`/`.to` must carry the two different alias names. This is the check
   that distinguishes the two layers; identical `from`/`to` text means the reporting is wrong.
   **Verified live 2026-09-18**: ` ├─ ↩ systems kimi@nope → glm@opencode-go (missing provider)`, and the
   seat then answered on `opencode-go/glm-5.3`.
6. **Empirical quota advance** — with the Go 5-hour window exhausted (observed 2026-09-18:
   HTTP 429 `5-hour usage limit reached`), `/matrix review-check "Reply with exactly: ZQX1"` must fall
   through to each alias's next provider and still answer, instead of the 121 s retry loop the
   reference implementation exhibits. **Observed 2026-09-18** while the Go weekly window was exhausted:
   every seat advanced through its provider list on `quota` and the run still completed, with no retry
   loop. The account is healthy again as of this writing, so the item cannot be re-triggered on demand.
7. **Prompt correctness under injected preludes** — with the full extension set loaded (context-mode
   active), `pi -p "Reply with exactly: ZQX1" --model fusion-matrix/good --no-session` must return `ZQX1`, not a
   deliberation about context-mode's tool hierarchy. **Verified live 2026-09-18** with the full
   extension set loaded: the seats deliberated on the user's own question. The bare-token prompt is a
   degenerate deliberation, though — a panel of two identical `ZQX1` answers is reported as unprocessable
   by the synthesis, which is the fusion behaving correctly rather than this item failing.
8. **Decision contract offline** — `node scripts/typesafe-stub.mjs &` and
   `node scripts/semif-stub.mjs &`, then
   `node scripts/typesafe-probe.mjs --backend http://127.0.0.1:8793/v1/systemone` and
   `node scripts/semif-probe.mjs --backend http://127.0.0.1:8792/score` must both exit 0. Point
   `decide.defaultBackend` at `typesafe-stub` and run
   `/matrix review-check "Summarize the tradeoffs of optimistic locking"`: the judge element must
   resolve in place and `details.cascades[].answer` must carry the winner (`choice`) and the full
   `probabilities` map. Kill the stubs afterwards.
9. **TypeSafe live** — export `TYPESAFE_API_KEY`, set `decide.defaultBackend` to `typesafe`, and run
   `node scripts/typesafe-probe.mjs --backend https://api.typesafe.ai/v1/systemone`; it must exit 0 and
   print the answering `model` (`jev-1.13.0`). Then run `review-check` live
   (`/matrix review-check "…"`) and confirm
   `details.verification[].result` carries three typed answers (`noul`, `noul`, `choice`) and that each
   `choice`/`score` answer has `confidence`. A `401` here means the key is absent or wrong, not that
   the wiring is broken. **Verified live 2026-09-18**: the probe exits 0 printing `jev-1.13.0`, and a
   live `review-check` run cascaded (`decision insufficient (agrees, conf 0.81, needs >= 0.85)` → the
   judge ran → the synthesis answered), with verify reporting `grounded_in_panel=0.22` and
   `contradiction_handling=ignores` as two warnings that changed nothing.
10. **Conservative invariants** — (a) temporarily set `verify[0]` to a question the synthesis cannot
   satisfy (for example `noul` "the answer contains the exact phrase BANANA") and confirm the run
   still completes with one `⚠️ verify:` delta and an unchanged synthesis — verification must never
   rewrite or block; (b) point `route` at a `semif` backend and confirm the load error
   `routing requires a backend that reports confidence; "semif" does not`; (c) run `default-smrt` on a
   genuinely complex prompt and confirm it does *not* route away (the decision reports a non-trivial
   option), then on `"Reply with exactly: ZQX1"` and confirm it does, with the ` routed` line and
   `details.routing` both present; (d) set `route.sufficientWhen.minConfidence` to 1.0 and confirm the
   run proceeds as `default-smrt` with `details.routing` recording the declined route — the gate must
   be able to decline, and must say so. **Verified live 2026-09-18** on the router shipped then
   (`review-routed`; `default-smrt` has since replaced it): (a) the live cascade run warned twice and
   kept its synthesis; (b) is a load error, asserted by the validator; (c) `"Reply with exactly: ZQX1"`
   printed ` ├─ ↪ routed to quick (trivial, conf 1.00)` and `quick`'s roster ran, while an
   architectural prompt printed ` ├─ ↪ route declined (architectural); running review-routed`; (d) with
   `minConfidence: 1.0` the same trivial answer declined — `conf 0.51 < 1` — and the run proceeded as
   `default-smrt` rather than routing away.
11. **Judge cascade** — with the decision stub returning a decisive high-confidence answer, a
    `review-check` run (`/matrix review-check …`) must report ` ├─ ️ judge via decision (agrees,
    conf 0.9x) — skipping deepseek-pro`, must *not* call the generative judge, and must record
    `details.cascades[0].sufficient === true`. With the stub returning `unclear` at 0.51, the same run
    must emit ` ├─ ↳ judge decision insufficient (…) → deepseek-pro`, call the generative judge, and
    record `details.cascades[0].sufficient === false` plus a `prior` string containing the decision's
    answer. Then set `sufficientWhen.choiceIs` to an option the stub never returns and confirm every
    run escalates — a cascade whose cheap path can never win is measurable dead weight, which is what
    `details.cascades` exists to reveal. **Verified live 2026-09-18** through pi with the stub as the
    backend: decisive printed ` ✅ decision sufficient (agrees, conf 0.91, needs >= 0.85) — skipping stage
    2` with no judge line at all, and ambiguous printed ` decision insufficient (agrees, conf 0.51, needs
    >= 0.85) — running stage 2` followed by the judge's own ` ├─ ⏳ judge: opencode-go/deepseek-v4-pro` line. The recorded
    `sufficient`/prior fields are asserted offline by `scripts/interp-check.mjs`.
12. **Oversized state** — put a ~150 KB `{{panel}}` through `review-check` (`/matrix review-check …`)
    against the live backend: the run must emit one `⚠️ decision state truncated` delta, still
    complete, and report the decision. A `4xx` from the backend instead means truncation did not
    engage. The truncation path is
    verified offline against the real client — `truncateState` emits one `⚠️ decision state truncated for
    the backend (N tokens > 32768)` notice and the call still returns an answer, and a small state emits
    none. The live half needs a panel above the 32k budget, which no packaged fusion produces from a short
    prompt; the live cascade, verify, and route calls above all ran against the real backend inside it.
13. **Per-project billing selection** — add a second provider block to `~/.pi/agent/models.json` (copy
    the built-in `opencode-go` shape as `opencode-go-work`, with that account's key) and set
    `/tmp/fusion-matrix-check/.pi/pi-fusion-matrix.json` to
    `{"aliases": {"glm": {"providers": ["opencode-go-work", "opencode-go", "zai"]}}}`. A
    `--model fusion-matrix/best` run must execute on `opencode-go-work` (banner and
    `details.seats[].provider` show it) with no edit to any fusion and no credential in the project
    file. Remove the override afterwards. This is the check that per-repo billing needs no profile
    system — only a provider id, which is pi's vocabulary, not ours. The second-account half needs a
    credential this machine does not have; the mechanism it tests was exercised live 2026-09-18 with the
    providers that do exist: a project file re-pointed `glm-flash` and `deepseek-pro` (the aliases
    items 1 and 4 named then) and re-ordered a slot (items 5 and 10), each time with no edit to any
    fusion and no credential in the project file, and the banner plus the seat line named the route
    that answered.
14. **Independence from the fork** — `grep -rn "pi-fusion\|/Users/\|~/" extensions/ scripts/ matrix.json
    package.json` must return no import or path reference (only doc/comment mentions of the reference
    directory are allowed). `scripts/` is included because a harness importing by absolute path publishes
    the developer's layout. Then move the vendored reference fork out of the pi extensions directory, run
    `pi -p "Reply with exactly: ZQX1" --model fusion-matrix/best --no-session`, and confirm it still works —
    this is the check that the package runs with no developer checkout present. Restore the directory
    afterwards. **Verified live 2026-09-18** by disabling extension discovery outright and loading this
    package by path — `pi -ne -e <repo>/extensions/pi-fusion-matrix -p "Reply with exactly: ZQX1"` against
    the one-seat fusion shipped then (`solo`, since replaced by `cheap` and `quick`) — it answered `ZQX1`,
    so nothing outside this repository is needed.
15. **Alias is version-free** — `grep -rn "glm-5\|qwen3\.8\|deepseek-v4\|kimi-k3"` across
    `extensions/pi-fusion-matrix/` and `matrix.json` must match only `aliases.*.model`, fixtures, and
    comments — never `fusions`, `candidates`, or code. A `models.json` version bump (for example `deepseek-v4.1-flash` →
    `deepseek-v4-flash` on `go`) must change behavior with no edit to this repo; confirm by bumping it
    and running `pi -p "Reply with exactly: ZQX1" --model fusion-matrix/quick`: the run succeeds and
    `details.models` shows the new vendor id behind the unchanged alias.

16. **Mode shapes are cost contracts** — run each fusion in Step 2 and count the calls. `cheap` and
    `quick` are one seat and no judge (1 call each); `good` is two seats plus a merge (3 calls), and
    the merged text must differ from both seat texts (a merge that echoes a panel response is not a
    merge); `best` is that pair plus a judge and a synthesis (4 calls), the judge's message carrying
    its analysis and the synthesis answering from `panel+judge`; `default-smrt` is one seat plus its
    route decision (1 + 1); `opinions` makes three calls, ends with labelled sections and no
    generation, and records `render` in `details.stages`; `debate` makes nine (3 seats x 3 rounds);
    and `review-check` makes five plus one stage decision (5 + 1), where a sufficient decision skips
    the judge it gates, so both counts must appear in `details.stages`. A shape that quietly adds or
    drops a call is a bug: the call count is the feature.
17. **Debate envelopes** — in `fusion-matrix/debate`, every round after the first carries each *other*
    seat's previous-round output and never its own; `details.rounds[].inputs` records the envelope per
    seat per round. Then point one seat's only provider at `nope`: that seat is labelled and dropped,
    the remaining two continue, and if only one survives the rounds stop early rather than running alone.
    **Verified live 2026-09-18**: with two of the three seats pointed at `nope`, the run printed
    ` ⚠️ skeptic unavailable …` and ` ⚠️ systems unavailable …`, kept the surviving seat, and stopped with
    ` ├─ debate: fewer than two seats survive; stopping after round 1`.
18. **Decision stages** — with a temporary mode in the project file,
    `{ "score": { "instructions": "How well does this response address the question?",
                  "criteria": ["off-topic", "partial", "solid", "thorough"] }, "over": "panel" }` must
    issue **one** backend request for the three seats (the stub records request count), and the stage
    that follows must render sorted `persona: score (confidence)` lines from `panel+weights`. Separately,
    a persona with `thinking: "off"` must show as omitted or off in `details.seats[].thinking`, while
    `best`'s judge and synthesis show `high` (their fusion override) and `cheap`'s `technical` seat
    shows `low` against its persona default `medium` — sampling is configuration, and the run record
    must show what was actually requested.

19. **Doctor** — `node scripts/doctor.mjs` and `/matrix-doctor` over the packaged config: exit 0 clean
    (offline), exit 1 with a named alias when a `model` is removed from `matrix.json` (config error),
    exit 2 naming the provider when an alias routes through one pi does not know or has no credential
    for, and exit 3 with `--online` when an alias names an id the provider no longer serves. `--repair`
    must print the `models.json` upsert snippet and, without `--write`, leave both `matrix.json` and
    `models.json` byte-identical (assert by hash before and after); with `--write` it may add ids but
    must not change any alias's `model` field. A single-route alias must be reported as having no
    fallback rather than passing silently. **Verified live 2026-09-18**: `node scripts/doctor.mjs` exits
    0 offline and lists the seven single-route aliases rather than passing them silently, and `--repair`
    leaves `matrix.json` and `models.json` byte-identical (md5 compared before and after; there is no
    `--write` in this repo). The exit 1/2/3 cases and `--online` drift are covered by an injected-registry
    proof: the standalone script has no model registry, so `--online` there exits 3 by design — the silent
    0 it used to print is the finding this item is about.

20. **Offline interpreter contracts** — `node scripts/typesafe-stub.mjs &` then
    `node scripts/interp-check.mjs` must pass 33/33. The original nine: a decisive stage decision skips
    the stage it gates with no judge call; an ambiguous one calls the judge and records a prior containing
    the cheap read's answer; debate makes 3 seats × 3 rounds with peers' opinions; a `score` stage issues
    **one** batched request for three seats; `verify` warns without blocking; a confident route redirects
    and an unconfident one declines. The twenty-six added with Step 9: the proxy contracts of item 23, the
    seat's half of the shared thinking-refusal rule, the registration/`matrix-info` surfaces of item 25, the
    loader rules of item 26, and the two contracts for a rejecting `result()`. This is the check that must run when a provider's quota blocks the live items — and it caught a
    real gap on first use: stage-level `sufficientWhen` was unimplemented, so a converged panel still paid
    for the judge.
21. **Doctor exit codes and non-mutation** — with an injected registry and catalogue: clean config exits
    0; a bad alias exits 1; an unknown provider and an unauthenticated provider each exit 2; a retired id
    with `--online` exits 3; a single-route alias is reported rather than passed silently; and `--repair`
    prints its snippet while leaving every tracked file byte-identical (asserted by hash).

22. **The run record survives, and the report reads it** — `test/session-report.test.mjs` is green under
    `npm test` (its count is that run's own output; this item names the checks it added, not the total), each
    check having been shown to fail under a temporary mutation of the reader, then in a scratch `cwd`
    (Step 8's prerequisites):
    `node scripts/session-report.mjs --cwd <scratch> --json` on the store *before* a `/matrix` run shows
    zero deliberation records, and after `/matrix quick "…"` in **both** pi and omp it shows one, with the
    answer message carrying `details.fusion` — then `--verbose` names that run. A failed run records itself:
    an alias pointed at a provider nobody knows (`{"providers": ["nope"]}`) records the degraded seat, a
    named `seatErrors` entry and the substitution, which the report counts as `1 failed` — where before the
    run left no record at all (the thrown-failure shape `{ fusion, error }` is covered by the fixtures).
    Change one stored `usage.cost.total` to `0` in a copy of a session file and the
    report moves that message from priced to unpriced without changing its token totals. Delete the
    `details` from a copy of the answer entry and the run disappears from the totals *and* the record is
    reported as missing rather than as a clean run.

23. **Proxy: offline contracts** — the same `node scripts/interp-check.mjs` run. The proxy cases are
    the ones that matter here: a stub peer records `context.messages`/`tools`/`systemPrompt`
    byte-identical and the target's `toolcall_end` reaching the caller; the message holds the model's
    output and no ` ├─ ` line; no seat call happens; the `done` event's message — not just `result()` —
    carries `details.proxied`, because that is the copy the harness keeps; `"harness"` and an absent
    level resolve per Step 9's table; a rung with no writing seat (`opinions`) still deliberates with
    tools present; an unresolvable route advances to the next with the attempt recorded and no
    decoration; a level the target refuses is dropped once and the turn continues; a route that fails
    before any event advances while one that fails after `start` ends the turn; and an unreachable
    executor ends as an error message with no deliberation. The two faces read `thinking` the same way
    too: the writing seat's candidate object pins the proxied turn's route and level, and the execute
    face's `"harness"` literal never reaches a seat, and an `error` event with nothing before it recovers
    like a throw (retry without a refused level, else the next provider, both recorded); and a target whose
    `result()` rejects past the first event ends the turn with the message the caller already holds — the
    failure added to that record's `attempts`, never a second terminal event pi would append as another
    assistant message (before the first event the same rejection retries the level or walks the route, like a
    stream that failed at its first pull). Each must *fail*
    when the branch is mutated
    — dropping `tools` from the forwarded context, writing a status line into the stream, falling through
    to the pipeline after the proxy returns, or attaching `details` only to `result()` — which is the
    check's own acceptance.

24. **Proxy: a rung codes (live, both harnesses)** — pin a rung and give the turn real work:

    ```bash
    cd /tmp/fusion-matrix-check
    pi -ne -e <repo>/extensions/pi-fusion-matrix -p "Read package.json. Add a key \"proxy-check\" with \
      value \"ok\" to it. Then run node -e 'console.log(6*7)'. Tell me the package name, the key you \
      added, and the command's output." --model fusion-matrix/quick --no-session
    ```

    and the same prompt through `omp` (`--no-extensions -e …/extensions/pi-fusion-matrix/index.js
    --auto-approve`), with the second half run under a pinned role instead of `--model`
    (`modelRoles.default: fusion-matrix/quick`, applied with omp's `--config`). Success is a real loop
    across turns: `read` → `edit`/`bash` tool calls in the transcript, `package.json` on disk gaining the
    key, the command's output in the answer, no ` ├─ ` line in any message, `provider`/`model` reading
    `fusion-matrix/quick` on every stored assistant message, and `details.proxied` naming
    `deepseek-flash@opencode-go`. **Verified live 2026-09-19** on pi 0.85.1 and omp 18.2.6: both harnesses
    ran read → edit → bash → answer, the file changed on disk, and every turn's stored message carried
    `details.proxied` with `thinking: "low"`. A `"harness"` thinking override in the project layer,
    `--thinking high`, forwarded `"high"` verbatim. Then, same binary and same config: `/matrix quick …`
    and `--model fusion-matrix/opinions` must still deliberate with their status lines (verified live —
    the panel printed `## technical — opencode-go/kimi-k3` and its three sections), and a target whose
    level is refused must recover (verified live: with `deepseek-flash` re-pointed at
    `alibaba-token-plan`, which supports only `high, max`, the turn dropped the level and answered).

25. **Proxy: registered metadata** — `pi --list-models fusion` (and omp's equivalent) must show the
    executor's numbers for a proxying rung: `quick` and `default-smrt` at `1M / 384K`, `best`, `cheap`,
    and `good` at `1M / 131.1K`, `review-check` at `1.0M / 131.1K` — not `128000`/`8192`, which the two
    render-only rungs keep because they have no execute face. **Verified live 2026-09-19** on pi 0.85.1.
    Then re-point `best`'s writer (`{"fusions": {"best": {"candidates": {"synth": ["muse"]}}}}` in the
    project layer) and confirm the doctor reports the missing alias metadata rather than letting the
    default stand unannounced — `node scripts/doctor.mjs` from that directory prints
    `[metadata] fusion "best" executes as "muse", which declares no contextWindow and no maxTokens …` and
    still exits 0, because it is a decision, not a fault.

26. **Proxy: config validation** — three project-layer files, each expected to fail at load with the
    named message: `{"fusions": {"best": {"proxy": {"alias": "no-such-alias"}}}}` →
    `proxy alias "no-such-alias" is not an alias`; `{"fusions": {"default-smrt": {"proxy": {"alias":
    "qwen-flash"}}}}` → `proxy and route cannot both be declared`; `{"fusions": {"best": {"thinking":
    {"judge": "harness"}}}}` → `thinking "harness" is only legal for the writing seat "synth"`; and
    `{"fusions": {"opinions": {"proxy": {"alias": "kimi"}}}}` → `proxy needs a writing seat`. **Verified
    live 2026-09-19**: the first three fail `pi -ne -e <repo>/extensions/pi-fusion-matrix` at load with
    those messages and exit non-zero, and an empty `proxy: {}` reports `proxy needs an alias`; all seven
    rules (that one, `proxy: null`, and the five above) are asserted offline in `scripts/interp-check.mjs`. Remove each file afterwards, and confirm the
    packaged config alone validates clean (`node scripts/doctor.mjs` exits 0).

27. **The outcome label, and the clocks we record ourselves** — `node scripts/interp-check.mjs` must pass
    42/42, the new ones being: a seat's `durationMs` and the run's are present and finite while a failed
    call's time rides its attempt record, and `/matrix-label` writes a `matrix-label` custom message with
    the work item, the outcome and its evidence — refusing an outcome outside the vocabulary, a work item
    with no outcome, and writing nothing in either case. Then live in a scratch `cwd`: `/matrix quick "…"`
    followed by `/matrix-label <work-item> landed <evidence>` in **both** harnesses, after which
    `node scripts/session-report.mjs --cwd <scratch>` prints an `outcomes` section naming the work item, the
    latest outcome and the evidence, with the fusion turns and the reported cost beside them; a second
    label in the same session supersedes the first and the report says `2 labels, latest wins`; and a
    session with runs but no label appears under `(unlabelled)` with its cost and the line that no
    `/matrix-label` was recorded. Each of those must fail when the reader, the command or the seat clock is
    mutated (the label not read, the first label kept instead of the latest, a half-written label counted,
    unlabelled runs uncounted, a sums object merged as a usage, a seat clock dropped).

28. **The device protocol and the run's own token count** — `test/session-report.test.mjs` covers: a record omp wrapped as `details.xdev.inner` is read as a deliberation run
    with its fusion, seats and usage; a `write` to `xd://matrix` counts as a `matrix` call while `read` of the
    same path stays a `read`; the result row names the tool that ran; the unwrapped count is reported; and a
    run's tokens equal its own `usage`, not that plus its seats. Then live: the two `matrix` runs made through
    omp's device protocol on 2026-09-20 (the `cline-pass` wiring probes) appear in the report as
    `omp/cline-glm 1 runs (toolResult×1)` and `omp/cline-muse …`, with `omp/matrix 2 calls · 2 results` in the
    tools table and `2 call(s) made through omp's xd:// device` in the accounting — where before the fix the
    same store reported no deliberation records at all. Each must fail when the unwrap, the attribution, the
    result naming, the unwrapped count or the single-count rule is mutated.

29. **Plan windows, and the join to our refusals** — `test/session-report.test.mjs` covers: the ledger read read-only with the *latest* reading standing for each window; a reset the
    provider never stated printed as "no reset stated" and never as 1970; a missing ledger named as an absence;
    and the join counting a refusal as explained only by a reading that covers its moment (exhausted versus ok),
    with refusals no reading covers counted separately and a provider we used with no window named. Five more
    come from an automated review of this branch's first version, each now a check that fails when its rule is
    mutated: a refusal attributed to the **attempt's** provider rather than to the route that answered; a refusal
    from a **pi** session reported as having no ledger rather than as unexplained; the reading taken **before**
    the refusal, so a later reading cannot shadow the one that covered the moment (mutated: the coverage rule
    loses its time clause and four checks go red); a covering reading keeping its **own status** (mutated:
    `warning` is filed as `ok`); and a provider with no window **named even with no refusals to join**. Live, on
    the implementing machine: the section prints `~/.omp/agent/agent.db · 638 reading(s) · 14 window(s)`, marking
    `kimi-code`'s August readings stale, showing `opencode-go Weekly limit exhausted 100% used` and
    `zai ZAI Weekly Token Quota exhausted`, and `no reset stated` for the windows whose provider reports none.
    **No live quota refusal exists in the fusion store yet**, so the join's live evidence is pending its first
    real refusal — the fixtures above verify it until then, and the report says "nothing to join" rather than
    implying otherwise. Each of those must fail when the latest-reading rule, the reset rendering, the
    time-coverage rule or the named absence is mutated.

30. **The review route** — `npm test` passes 7/7 unit tests (`test/seat-deadline.test.mjs`,
    `test/disposition.test.mjs`: the seat deadline with its advance and its abort cases, and the disposition
    schema judged only where it applies). `node scripts/interp-check.mjs` passes 60/60 at that revision, the new ones covering:
    a mechanical class routing to `review-quick`, a standard one to `review-check`, the boundary class
    escalating to `smrt-review`'s own mode with `routing.escalated` (not `declined`), an unsure answer
    escalating rather than routing cheap; an `execute: false` rung deliberating on a *tool-bearing* turn with
    no `details.proxied`; a run whose seats never answer ending with every seat reported as a `timeout`; a
    review run recording `dispositionBy`, `verdict`, `findings`, their `severityCounts` and a `null` line kept;
    seven schema-violating answers each recorded as malformed rather than as a clean review; a malformed final
    answer leaving no earlier verdict standing; a valid answer after a malformed one naming what it superseded;
    a second bad answer not erasing the first; and a JSON answer outside the fusion's declaration being left
    unjudged. Six are mutation-proven — the seat deadline disabled, the declaration ignored, `supersededBy`
    dropped, the chain collapsed to a slot, the path guard bypassed, and the schema check removed — and each red
    names the check it fails. A seventh covers the path guard's escape case: with containment dropped,
    `../outside/secret.ts` is reported as `[path not found]` instead of `[path outside the session]`, which is how
    an automated reviewer found it. The five load errors are the `config` rules: `execute: false` with `proxy`,
    `review` without `execute: false`, `review` without `route`, a review route target that is an executor, and a
    JSON-writing seat without `execute: false`. `test/session-report.test.mjs` reads a disposition in six of its
    checks out of a session: its verdict, the persona that stands, its severities, and its
    finding paths — one under the session's cwd, one that does not exist (so `[path not found]`), one absolute
    (so `[path outside the session]`, never resolved) — a malformed answer a later one superseded, and a chain
    of two bad answers counted entry by entry. Then live: a packet reviewed through
    `omp -p --model fusion-matrix/smrt-review`, which chose the `high` class, ran its own committee mode,
    reported three substitutions as they happened, and returned a disposition with severities.

31. **The disposition contract is declared** (`disposition.personas` on the rung) — the schema belongs to a rung,
    not to the shape of an answer. `npm test` passes 157/157, with seven new `config` rules (a declaration that
    names no seat, a seat its mode does not run, a seat whose answer is not JSON, a list that leaves out the last
    stage seat, a mode ending in no single seat, `review: true` without a declaration, and a review route to a
    rung that declares none) and two reshaped unit tests of the exported `dispositionOf`: judged only when its
    caller passes the declaration, recovering an undeclared seat's answer verbatim whatever keys it uses.
    `node scripts/interp-check.mjs` passes 67/67, the new two proving the wiring rather than the unit: a *declared*
    seat answering `{"summary":"…"}` is recorded malformed (`verdict is not one of clean|findings`, and no verdict
    stands), and an *undeclared* seat answering `{"verdict":"banana","findings":"oops"}` cannot make the run
    malformed — the declared seat's clean verdict stands and `malformedAnswers` is absent. Both are mutation-proven
    on the wiring, not just the unit: with the declaration dropped from the `runSeatInner` call site nine checks go
    red (the whole declared machinery collapses), and with it hard-coded to `true` — the old, shape-inferred
    behaviour — exactly the two new checks go red and each names what it caught. The three packaged review rungs
    declare their seats — each exactly the seats its own mode runs, whose last stage seat is the synthesis — and
    `review-quick` declares the two its single-seat mode runs rather than the committee's four.

## Assumptions & contingencies

- **This extension's names are its own.** The vendored `@quarkos/pi-fusion` copy was archived out of the
  pi extensions directory — it also registered a `deliberate` tool and a `/fusion` command, and pi keeps
  the first registration per name — so this package owns the `fusion-matrix/*` models, the `matrix` tool,
  and `/matrix`, `/matrix-info`, `/matrix-doctor`.
- **Providers, endpoints, and credentials are pi's, and no `models.json` block ships.** Provider ids are
  pi's own built-ins resolved from its credential store and env; this repo never resolves a secret or
  builds an endpoint. Only two cases touch that file, both optional: adding an account or a gateway, and
  wanting an id in pi's own picker (the doctor prints that snippet; it never writes it silently).

- **Delegation runs pi's resolver and transport.** `streamSimple` from `@earendil-works/pi-ai/compat`
  is the documented streaming entry point and is still exported (verified in
  `node_modules/@earendil-works/pi-ai/dist/compat.d.ts`, read this session); it is marked deprecated in
  favour of `createModels()`. The plan passes a `Model` object obtained from pi's own registry, which
  is what carries api id, baseUrl, headers, apiKey, and `compat` flags into the request. If the call
  fails at runtime, fall back to `getApiProvider(model.api).streamSimple(model, context, options)` from
  the same module — same `Model` input, so no resolution logic changes.
- **Model resolution API.** The plan assumes the extension can read pi's resolved model list from the
  extension context (`modelRegistry.find(provider, model)`). If that accessor does not exist in
  0.84.2, resolve the same way `pi --list-models` does — the `ModelRuntime.getAvailable()` path in
  `dist/core/model-runtime.js` — via the registry object the context exposes; if neither is reachable
  from an extension, treat every candidate as `"missing provider"`-unchecked and let `streamSimple`
  surface the failure, then classify it by error text (the taxonomy in Step 3 still applies).
- **Login requirements are pi's.** Because credentials come from `models.json`/`/login`, a provider
  whose key is missing appears in `/model` as unavailable and the run's failure text will be pi's own
  auth error, not a custom message. No credential parsing exists in this extension, so there is
  nothing to keep in sync.
- **`x-opencode-session` on OpenCode providers.** OpenCode Go/Zen require a client identity plus a
  stable per-conversation session id (observed 2026-09-18: `400 Request is missing x-opencode-session`,
  and the reference implementation needed the header to work). With native providers this is a `models.json`
  concern: add `"headers": {"x-opencode-session": "<stable-id>"}` to each OpenCode provider entry when
  the header is required. If a rotating id is needed instead, that is the one place a small change is
  warranted — set it per session from `session_start`.
- **Decisions never replace a pipeline call.** The conservative contract: `verify` is report-only and
  `route` only selects a whole fusion (never a judge or synthesis model). Do not add a fusion that
  delegates the judge or synthesis to a decision backend without a separate, measured decision — that
  is the aggressive shape and it trades answer quality for quota.
- **TypeSafe key and model pinning.** `TYPESAFE_API_KEY` is not present in this environment as of
  2026-09-18; the operator exports it (or adds an `authJson`-style reference later). `backends.typesafe.model`
  pins `jev-1.13.0` rather than `jev-latest`, because a `confidence` threshold tuned against one
  version must not move when an alias advances; the response's `model` field is recorded per call.
- **TypeSafe request budget.** Input-only pricing ($42/Btok, output free) and a 64k context with a
  32k cap on `state` + longest question mean the request builder must estimate size before sending
  (Step 4) — an unestimated oversized payload is a 4xx, not a graceful degrade.
- **SemIf on Apple silicon is not supported upstream.** `load_causal_model` requires exactly one CUDA
  device and BF16 (`src/semif_phase1/core.py:82-83`), and PyTorch's MPS backend has no BF16
  (`pytorch/pytorch#141864`). This machine (M4 Max/64 GB) therefore uses TypeSafe by default; the
  local SemIf path is for a CUDA host, a self-hosted container, or a patched/ported SemIf per the
  operator path in Step 4. No SemIf changes are made by this repo.
- **`decide.models` is a server-side table.** It pins `source` + a 40-character `revision` because
  upstream refuses remote models without a pinned commit. Unlike aliases, that table names versions
  and its bumps are deliberate reviewed edits; the probe asserts the returned `model.revision` matches.
- **Confidence thresholds start conservative.** TypeSafe's own guidance is to start conservative and
  tune against your data; the packaged `verify`/`route` specs use defaults (noul < 0.5, confidence <
  0.5) and are expected to be tuned, not trusted as-is. A SemIf answer never gates anything because it
  carries no confidence.
- **No fork dependency at runtime.** The pipeline, stream, and error taxonomy are re-derived here
  from the reference implementations named in Critical files. If a re-derived behavior turns out to
  differ from the reference in a way that breaks a verification item, fix it in `run.ts`; do not
  reintroduce a cross-repo import. The reference directory can be archived at that point.
- **Repos and remotes.** The new repo is created locally without a remote. Do not push anywhere; if a
  remote is later wanted, the operator names it.
- **Alias names are version-free by design** (`deepseek-flash`, `glm`, `qwen-max`); the vendor id lives
  in `aliases.<name>.model`. Naming an alias after a version (`glm-5.3`) is the anti-pattern this
  avoids: it forces a config sweep on every vendor release and leaves stale names pointing at new ids.
  The vendor id cannot live in `models.json` instead — pi sends a model's `id` upstream verbatim and
  keys the registry by `provider` + `id`, so a name that is not the vendor id cannot resolve.
- **Alias ids are never registered as pi models**, so a version-free alias cannot collide with a
  vendor id in `/model`/`--list-models`; only `fusion*` ids are registered by this extension. The
  drill-down also lets a model id exist in `matrix.json` that pi's own catalogue never lists.
- **Same alias across providers means the same slot, not necessarily the same vendor id.** Where two
  providers name one model differently, use the object form:
  `{"id": "tp", "modelOverride": "qwen3.8-max-preview"}`.
- **A vendor id need not be in pi's catalogue, and that is the point.** pi's curated model list lags
  the live catalogues; seats resolve by provider + id through the credential seam, so an alias names
  what the provider actually serves. Nothing in this repository copies a catalogue, and nothing
  silently substitutes a model to make a list line up: a `model` field is exactly what runs, and a
  finding about drift is a report (the doctor), never a rewrite.
- **Shapes and seats are configuration; the interpreter is code.** `modes` are stage lists and `personas`
  are seats, so adding a shape or re-pointing a seat is an edit to `matrix.json`. What stays code is the
  stage *kinds* (`parallel`, `single`, `decide`, `score`, `render`), the connector set, and the assembly
  rules. That line is deliberate: a config language expressive enough to need interpreter branches of its
  own is a language whose validity nobody can check.
- **Two faces, one definition, and the branch that picks between them is invocation.** Proxy mode
  (Step 9) adds no classifier: a fusion with an executor answers a tool-bearing turn, and everything
  else behaves as it always has. The conceptual cost is stated rather than hidden — the same id answers a
  question one way and an agent turn another, and `matrix-info` prints the execute face beside the roster
  — and the deliberate part is total: `proxy` and `route` on one fusion is a load error, a proxied turn
  whose target cannot be reached is an error rather than a deliberation, and its thinking rule is fixed
  in config because the harness resolves `auto` before the extension sees it.
- **A proxied turn carries the harness's own context.** `messages`, `tools`, and `systemPrompt` are
  forwarded byte-identical, and `options` with the credential resolved for the target, so prompt caching,
  request attribution, and session chaining stay the harness's rather than re-invented. Nothing of ours
  is added to the message: a status line in a coding turn lands in the conversation and corrupts the
  loop, which is why a proxied turn's substitutions live in `details.proxied.attempts`. The one rewrite
  is identity — a forwarded event carries the fusion's registered model, because that is what the harness
  compares before it will recover a proxied turn from context overflow or truncation
  (`_checkCompaction`'s `sameModel`).
- **A fusion with an executor advertises the executor's numbers.** Registration happens before any
  session exists, so no catalogue can be consulted: `aliases.<writer>.contextWindow` and `.maxTokens`
  are declared first, then `fusion.model`, then the package default. The harness sizes a context budget
  from one and decides whether a `length` stop is recoverable from the other, so the default in front of
  a 384K-output model is the facade that silently truncates an edit; the doctor reports it when a
  re-pointed writer lands there.
- **Three shapes from [`disler/fusion-harness`](https://github.com/disler/fusion-harness) are out of
  scope, and that absence is a boundary rather than a gap.** Its sole-writer FUSION agent
  (`/fh-fusion`) writes to disk through a subprocess with tools: that is not a deliberation stage, and
  it is served instead by proxy mode (Step 9), where one model holds the harness's tools and the
  harness keeps the loop, the approval gates, and the writes. Its gate-first loop
  (`/fh-auto-validate`) iterates until green and needs loop constructs and a feedback channel; and its
  plan-then-DAG-then-execute collaboration (`/fh-collaborate`) is a task scheduler, not a deliberation
  pipeline. What *is* taken from it is the deliberation surface — N-way independent opinions, and debate
  rounds where every seat receives each other seat's labelled prior opinion while a failed seat is
  dropped and no judge arbitrates. The `gate` entry under `verify` stays deliberately report-only: it
  runs a command once and records the result, and never feeds back into a stage.
- **pi-ai's `Context.systemPrompt` is the only place a system instruction goes.** Measured 2026-09-18: a
  system-*role message* alongside `tools` makes the call fail with
  `Cannot read properties of undefined (reading 'length')` on the same model that works without it. Seats
  and the file agent pass the persona prompt through `systemPrompt`.
- **Tool schemas must be Typebox, not plain JSON schema.** The same request over curl in the OpenAI wire
  shape returned 200 with a `tool_calls` finish reason, while pi-ai given a plain JSON-schema object
  produced that gateway-side error. The two peers (`@earendil-works/pi-ai/compat`, `typebox`) are
  resolved by walking up from the *real* entry script, because a bare specifier does not resolve from a
  symlinked extension directory and `process.argv[1]` is the bin shim.
- **One extension, two harnesses.** omp is a fork of this stack under its own scope (`@oh-my-pi/*`) and
  exposes the same extension API — `registerProvider` with a `streamSimple`, `registerTool` with the
  same `execute(toolCallId, params, signal, onUpdate, ctx)`, `registerCommand`, `on("session_start")`,
  and a `modelRegistry` with `getApiKeyAndHeaders` — so nothing in the pipeline changes. Two things do,
  and both live where the harness API object is: the streaming peer (`@oh-my-pi/pi-ai` exports
  `streamSimple` from its TypeScript source entry, which Bun runs directly) and the tool schema builder
  (omp injects `pi.zod`; pi expects the extension to bring `typebox`). Peers are tried in order and each
  candidate is held to the same rule — realpath-verified to live inside the directory it was found in,
  with the ancestor walk bounded so a planted `$HOME/node_modules/…` is unreachable. **Verified
  2026-09-18 on omp 18.2.6**, against the set shipped then (the one-seat rung `solo`, now `cheap` and
  `quick`): `omp --no-extensions -e …/index.js -p …` answers `ZQX1` for that fusion, and the fusion
  that enabled the file agent then (`standard`; replaced in the trimmed set, and no shipped fusion
  enables it now) wrote a file through omp's own `pi.zod` tool call.
- **A provider can mix api flavours, so the template for an uncatalogued id decides the wire protocol.**
  pi's `opencode-go` serves glm-* over `openai-completions`, minimax/qwen3.8-max over
  `anthropic-messages`, and luna/grok over `openai-responses`; picking "the first sibling" sent a tool
  call through the wrong one. Template choice prefers the nearest id prefix, then the most compatible
  api, and is reported as `details.seats[].template`.
- **Thresholds live in `sufficientWhen`, in one place.** A decision is actionable when its answer
  matches and its confidence clears the bar; nothing else in the config carries a probability
  threshold. A cascade is only worth its extra call when the cheap path usually decides, which is why
  every run records `details.cascades` — tune thresholds and delete useless cascades from that data
  rather than from intuition.