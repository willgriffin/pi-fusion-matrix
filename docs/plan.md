# pi-fusion-matrix — fusions with per-slot fallback, native providers, and a SemIf decision backend

## Context

`@quarkos/pi-fusion` ([upstream](https://github.com/QuarkOS/Pi-Fusion); a local vendored copy serves
as the reference implementation) hardcodes one
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
as personas and filled by ordered candidate chains — including the two-model pair heart of one
reference harness and the committee shape of the other; (2) version-free aliases so a vendor model
bump edits one field and no fusion; (3) a pluggable decision backend usable as a pipeline stage (a
question, a scored fan-out, a cascade that escalates when its answer is not actionable), a
post-synthesis check, or a routing gate — TypeSafe (`https://api.typesafe.ai/v1/systemone`, calibrated
`confidence`, no local service) as the default here, SemIf as the local zero-marginal-cost
alternative; (4) every substitution, decision, and cascade observable in the transcript and in tool
details; (5) credentials and endpoints remain entirely pi-owned.

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
  run.js                # pi's stream protocol, route, verify, file agent, peer resolution
  decide.js             # TypeSafe and SemIf clients
  doctor.js             # config, connect, reach, drift
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
export type AliasSpec = { model: string; providers: (string | ProviderRef)[]; maxTokens?: number; reasoning?: boolean };

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
  | { alias: string; providers?: (string | ProviderRef)[] }
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
  | { score: DecideSpec; over: "panel"; input?: StageInput; name?: string }
  | { render: "panel"; input?: StageInput };

/** A named pipeline shape. `3x`-style and `5x`-style delibitation are stage lists, not code branches. */
export type Mode = { stages: Stage[] };

export type FusionSpec = {
  /** Picker label for the registered model. Default `Fusion · <id>`. */
  name?: string;
  /** Metadata for the registered model; the pipeline itself is unaffected. */
  model?: { contextWindow?: number; maxTokens?: number };
  /** Which named shape this fusion runs. */
  mode: string;
  /** Model chains per persona seat. Every persona the mode uses must appear here, and vice versa. */
  candidates: Record<string, SlotCandidate[]>;
  /** Per-fusion thinking-level override by persona. */
  thinking?: Record<string, Persona["thinking"]>;
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
  /** Fusion used by `/fusion` with no id and by the `deliberate` tool with no `fusion` argument. */
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
2. `~/.config/pi-fusion-matrix/matrix.json`
3. `<session cwd>/.pi-fusion-matrix.json`

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
  be unaddressable (`fusion id "deep:cheap" may not contain ":" or "/"`).
- `defaultFusion` naming an unknown fusion → error.
- `fusions.<id>.mode` naming an unknown mode → error, listing the known modes.
- a fusion's `candidates` keys not matching the personas its mode uses → error naming both sides
  (`fusion "deep" is missing candidates for: synth; unknown: synthesis`). The roster and the shape must
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
duplicate it. Only the vocabulary is illustrated here; read the file for the twelve fusions it ships.

```jsonc
{
  "providerId": "fusion-matrix",
  "defaultFusion": "standard",

  "personas": {                                   // seats: told once, reused everywhere
    "technical": { "prompt": "prompts/technical.md", "temperature": 0.5, "thinking": "medium" },
    "judge":     { "prompt": "prompts/judge.md", "temperature": 0.2, "output": "json" },
    "synth":     { "prompt": "prompts/synth.md", "temperature": 0.5 },
    "merge":     { "prompt": "prompts/merge.md", "temperature": 0.4 }
  },

  "modes": {                                      // shapes: stage lists, no code
    "pair": { "stages": [
      { "parallel": ["technical", "skeptic"], "input": "prompt" },
      { "single": "merge", "input": "panel" }
    ] },
    "committee": { "stages": [
      { "parallel": ["technical", "skeptic", "systems"], "input": "prompt" },
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
    "workhorse": { "mode": "pair", "fileAgent": { "alias": "deepseek-flash" },
      "candidates": { "technical": ["deepseek-flash"], "skeptic": ["glm-flash"], "merge": ["glm"] } },
    "deep": { "mode": "committee", "thinking": { "judge": "high" },
      "candidates": { "technical": ["kimi", "qwen-max"], "skeptic": ["deepseek-pro"],
                      "systems": ["glm"], "judge": ["deepseek-pro"], "synth": ["kimi", "qwen-max"] } }
  }
}
```

Twelve fusions ship: `standard`, `quick` and `solo` (lean and single-seat shapes), `workhorse` and
`sota` (a cheap pair and a frontier pair on one shape), `deep`, `brief` and `opinions` (the committee,
its merged-judge variant, and the panel-only grid), `debate` (three rounds against peers' opinions),
`review` (the committee with a critique synthesis prompt), `review-check` (the cascaded committee plus
a three-question verification), and `review-routed` (the committee behind a complexity route).

Persona prompts live in `prompts/*.md` and are referenced by path, so editing what a seat is told is
an edit to a text file, not to code. A `prompt` may also be inline, and `fusions.<id>.prompts` overrides
one persona for one fusion only.

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
  // The fusion key is the model id, verbatim: no prefixing, no reserved "default" id.
  models: Object.entries(config.fusions).map(([id, fusion]) => ({
    id,
    name: fusion.name ?? `Fusion · ${id}`,
    api: "fusion-matrix",
    provider: providerId,
    reasoning: false,
    input: ["text"],
    contextWindow: fusion.model?.contextWindow ?? 128000,
    maxTokens: fusion.model?.maxTokens ?? 4096,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  })),
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
export type Resolved = { alias: string; provider: string; model: string; maxTokens: number; reasoning: boolean };
/** Every (provider, model) pair an alias or slot entry can produce, in order. */
export function resolveCandidates(config: MatrixConfig, candidate: SlotCandidate): Resolved[];
```

`resolveCandidates` expands one candidate entry into an ordered list — this is the whole resolution
model, and it consults only the alias table (provider ids are pi's; nothing here reads a key or a URL):

1. A `{ semif }` entry returns `[]`; the caller handles SemIf separately (Step 4).
2. Normalize the entry: a bare string is `{ alias: string }`; an object carries `alias` plus an
   optional per-slot `providers` override.
3. `alias = config.aliases[aliasId]`; missing → throw `unknown alias "x"; known: ...`.
4. `refs = providers ?? alias.providers`; empty after the override → throw `alias "x" has no providers`.
5. For each ref in order, push `{ alias: aliasId, provider: ref.id ?? ref, model:
   ref.modelOverride ?? alias.model, maxTokens: alias.maxTokens ?? 4096, reasoning: alias.reasoning ?? false }`.
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
  decisions?: DecideAnswer[]; error?: string; degraded: boolean;
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
how `deep` runs its judge at `high` while its panel stays at the persona default. The reference
implementation's temperatures survive as persona defaults (`technical` 0.5, `skeptic` 0.8, `systems`
0.6, `judge` 0.2, `synth` 0.5). The `kimi` special case stays: `temperature: 1.0` when the vendor id
contains `kimi`, because that family rejects other values. Keep the models-reject-temperature memory
from `<vendored-fork>/lib/api.js` (patch 6): a module-level `Set` of provider/model keys; on an error
whose text matches `/temperature/i`, add the key, omit `temperature` on the retry (same candidate, not
an advance), and emit one `⚠️ <provider>/<model> rejects a temperature override; retrying without it.`
delta. Prevention belongs in `models.json`: a model that always rejects it gets
`"samplingParams": { "temperature": 1 }`, which pi merges into the request body.

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
    fusion: Type.Optional(Type.String({ description: 'Fusion id from matrix.json (e.g. "deep"). Omit for "default".' })),
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
  seats: { persona: string; alias: string; provider: string; model: string;
           thinking?: string; usage: Usage; degraded?: boolean; error?: string }[];
  rounds?: { round: number; seats: string[]; inputs: Record<string, string> }[];
  substitutions: Substitution[];
  cascades: Cascade[];               // answer, sufficiency, prior, next candidate
  routing?: { answer: DecideAnswer; routedTo?: string; declined?: string };
  verification?: { check: string; result: unknown; gate?: { exit: number; output: string } }[];
  usage: Usage;
};
```

`details.substitutions` and `details.seatErrors` are always present, empty arrays included: a silently
degraded run is a wrong answer and must be visible. `seats[].model` is the vendor id that actually
answered, so a provider-level substitution stays auditable after the fact, and `stages[].calls` is what
makes a shape's cost contract checkable.

`/matrix` parses the first whitespace-delimited token as a fusion id when it matches a key in
`fusions`; otherwise the whole argument string is the prompt and `defaultFusion` is used. Unknown id →
`ctx.ui.notify('unknown fusion "x"; known: standard, deep, ...', "error")` and no run.
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
Nothing here is optional or deferred behind a flag — `review-check` and `review-routed` in Step 2 use it.

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
2. lists it in the repo-local `.pi-fusion-matrix.json`, e.g.
   `{"aliases": {"deepseek-flash": {"providers": ["go", "tp-work", "tp"]}}}` — layers deep-merge, and
   arrays replace, so this one alias is the whole project override.

`pi.registerCommand("fusion-matrix", ...)` therefore only lists what is currently resolvable: every
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
6. **Streaming** — `createAssistantMessageEventStream` from `@earendil-works/pi-ai` (pi bundles it; no
   hand-rolled stream). Emit `start` with the empty partial, `text_start`, `text_delta` per progress/
   substitution/verification/synthesis chunk, `text_end`, then `toolcall_start`/`toolcall_end` pairs per
   file-agent write, then `done` or `error`. Contract verified against pi's consumer at
   `node_modules/@earendil-works/pi-agent-core/dist/agent-loop.js:201-243`: it replaces
   `context.messages[last]` with each `partial`, so every partial must be a complete
   `AssistantMessage`, and it reads tool calls from the final message's `content`, so `done.message`
   must carry the `toolCall` blocks. Only the seat that produces the answer streams token-by-token;
   every other seat reports its status line, because a five-call pipeline streaming five interleaved
   answers is unreadable.
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
  (transcribed already; keep the checkout until verification passes).
- `<vendored-fork>/index.js:485-506` — `extractPrompt`: the trailing-user-run prompt selection to
  reuse verbatim.

pi-side references:

- `node_modules/@earendil-works/pi-agent-core/dist/agent-loop.js:201-243` — the only consumer of the
  stream this extension returns; defines what `partial` and `done.message` must contain.
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
   `pi -p "Reply with exactly: ZQX1" --model fusion-matrix/glm-flash --no-session`. `glm-flash` is
   `glm-5.3-flash`, which pi does not catalogue, so success proves the seat built a model object for an
   uncatalogued id and pi resolved the provider credential. Confirm `details.seats[0]` shows
   `model: glm-5.3-flash`, `provider: opencode-go`, and a `template` id that pi *does* catalogue. Then
   point the same alias at a provider pi does not know (`{"aliases": {"glm-flash": {"providers":
   ["nope", "opencode-go"]}}}`) and confirm the `missing provider` substitution appears and the run
   still answers. **Probed 2026-09-18** with a synthesized model against `opencode-go`: `ctx.modelRegistry`
   is present in the extension context; `find("opencode-go", "glm-5.3")` returns a template with
   `api=openai-completions`; `find(…, "glm-5.3-flash")` is absent as expected;
   `getApiKeyAndHeaders(seatModel)` returns `ok` with a 67-character key; `import("@earendil-works/pi-ai/compat")`
   resolves from an extension; and the call succeeds **only** with an explicit `x-opencode-session` header
   (`sessionId` in options returned the same `400 MissingSessionID`). If this item fails, every later
   check is built on sand: the fallback would be catalogued-ids-only, the aliases would have to change,
   and E1 must know before it writes the resolver.

2. **Model registration** — `cd /tmp/fusion-matrix-check && pi --list-models fusion` prints all
   twelve: `standard`, `quick`, `solo`, `workhorse`, `sota`, `deep`, `brief`, `opinions`, `debate`,
   `review`, `review-check`, `review-routed`, each under the `fusion-matrix` provider. Failure here
   means the api id, manifest, or symlink is wrong.
3. **Config validation** — three separate project files, each run expected to fail at load with the
   named message: an unknown alias in a candidate list
   (`{"fusions": {"deep": {"candidates": {"judge": ["no-such-alias"]}}}}` →
   `unknown alias "no-such-alias"; known: …`); a mode whose roster does not match its shape
   (`{"modes": {"committee": {"stages": [{"parallel": ["technical"], "input": "prompt"},
   {"render": "panel"}]}}}` → names the missing candidate key); and a stage reading something nobody
   produced (`{"modes": {"lean": {"stages": [{"single": "synth-lean", "input": "panel+judge"}]}}}` →
   `stage 0 input "panel+judge" has no preceding single stage`). Remove each file afterwards.
4. **Provider-layer fallback (same alias, new billing route)** — in
   `/tmp/fusion-matrix-check/.pi-fusion-matrix.json` set
   `{"aliases": {"deepseek-pro": {"providers": ["nope", "tp"]}}}`. A `fusion-matrix/deep` run must print
   ` ├─ ↩ skeptic deepseek-pro@nope → deepseek-pro@tp (missing provider)`, complete, and —
   driven through the `deliberate` tool — report exactly one substitution whose `from` and `to` share
   the same alias name. Remove the override afterwards. This verifies both the native-provider lookup
   and that a stale provider name degrades per seat instead of aborting.
5. **Slot-layer fallback (new alias)** — in the same project file set
   `{"fusions": {"deep": {"candidates": {"systems": ["kimi", "glm"]}}},
   "aliases": {"kimi": {"providers": ["nope"]}}}`. The run must print
   ` ├─ ↩ systems kimi@nope → glm@go (missing provider)` and
   `details.substitutions[0].from`/`.to` must carry the two different alias names. This is the check
   that distinguishes the two layers; identical `from`/`to` text means the reporting is wrong.
6. **Empirical quota advance** — with the Go 5-hour window exhausted (observed 2026-09-18:
   HTTP 429 `5-hour usage limit reached`), `pi -p "Reply with exactly: ZQX1" --model fusion-matrix/deep
   --no-session` must fall through to each alias's next provider and still answer, instead of the
   121 s retry loop the reference implementation exhibits.
7. **Prompt correctness under injected preludes** — with the full extension set loaded (context-mode
   active), `pi -p "Reply with exactly: ZQX1" --model fusion-matrix/standard --no-session` must return `ZQX1`, not a
   deliberation about context-mode's tool hierarchy.
8. **Decision contract offline** — `node scripts/typesafe-stub.mjs &` and
   `node scripts/semif-stub.mjs &`, then
   `node scripts/typesafe-probe.mjs --backend http://127.0.0.1:8793/v1/systemone` and
   `node scripts/semif-probe.mjs --backend http://127.0.0.1:8792/score` must both exit 0. Point
   `decide.defaultBackend` at `typesafe-stub` and run
   `pi -p "Summarize the tradeoffs of optimistic locking" --model fusion-matrix/review-check --no-session`:
   the judge element must resolve in place and `details.decisions` must carry the winner and the full
   probability map. Kill the stubs afterwards.
9. **TypeSafe live** — export `TYPESAFE_API_KEY`, set `decide.defaultBackend` to `typesafe`, and run
   `node scripts/typesafe-probe.mjs --backend https://api.typesafe.ai/v1/systemone`; it must exit 0 and
   print the answering `model` (`jev-1.13.0`). Then run `fusion-matrix/review-check` live and confirm
   `details.decisions[].verify` carries three typed answers (`noul`, `noul`, `choice`) and that each
   `choice`/`score` answer has `confidence`. A `401` here means the key is absent or wrong, not that
   the wiring is broken.
10. **Conservative invariants** — (a) temporarily set `verify[0]` to a question the synthesis cannot
   satisfy (for example `noul` "the answer contains the exact phrase BANANA") and confirm the run
   still completes with one `⚠️ verify:` delta and an unchanged synthesis — verification must never
   rewrite or block; (b) point `route` at a `semif` backend and confirm the load error
   `routing requires a backend that reports confidence; "semif" does not`; (c) run
   `fusion-matrix/review-routed` on a genuinely complex prompt and confirm it does *not* route away (the
   decision reports a non-trivial option), then on `"Reply with exactly: ZQX1"` and confirm it does,
   with the ` routed` line and `details.routing` both present; (d) set `route.sufficientWhen.minConfidence`
   to 1.0 and confirm the run proceeds as `fusion-matrix/review-routed` with `details.routing` recording
   the declined route — the gate must be able to decline, and must say so.
11. **Judge cascade** — with the decision stub returning a decisive high-confidence answer,
    `fusion-matrix/review-check` must report ` ├─ ️ judge via decision (agrees, conf 0.9x) — skipping
    deepseek-pro`, must *not* call the generative judge, and must record
    `details.cascades[0].sufficient === true`. With the stub returning `unclear` at 0.51, the same run
    must emit ` ├─ ↳ judge decision insufficient (…) → deepseek-pro`, call the generative judge, and
    record `details.cascades[0].sufficient === false` plus a `prior` string containing the decision's
    answer. Then set `sufficientWhen.choiceIs` to an option the stub never returns and confirm every
    run escalates — a cascade whose cheap path can never win is measurable dead weight, which is what
    `details.cascades` exists to reveal.
12. **Oversized state** — put a ~150 KB `{{panel}}` through `fusion-matrix/review-check` against the live
    backend: the run must emit one `⚠️ decision state truncated` delta, still complete, and report the
    decision. A `4xx` from the backend instead means truncation did not engage.
13. **Per-project billing selection** — add a second provider block to `~/.pi/agent/models.json` (copy
    the built-in `opencode-go` shape as `opencode-go-work`, with that account's key) and set
    `/tmp/fusion-matrix-check/.pi-fusion-matrix.json` to
    `{"aliases": {"glm": {"providers": ["opencode-go-work", "opencode-go", "zai"]}}}`. A
    `--model fusion-matrix/standard` run must execute on `opencode-go-work` (banner and
    `details.seats[].provider` show it) with no edit to any fusion and no credential in the project
    file. Remove the override afterwards. This is the check that per-repo billing needs no profile
    system — only a provider id, which is pi's vocabulary, not ours.
14. **Independence from the fork** — `grep -rn "pi-fusion\|/Users/\|~/" extensions/ scripts/ matrix.json
    package.json` must return no import or path reference (only doc/comment mentions of the reference
    directory are allowed). `scripts/` is included because a harness importing by absolute path publishes
    the developer's layout. Then move the vendored reference fork out of the pi extensions directory, run
    `pi -p "Reply with exactly: ZQX1" --model fusion-matrix/deep --no-session`, and confirm it still works —
    this is the check that the package runs with no developer checkout present. Restore the directory
    afterwards.
15. **Alias is version-free** — `grep -rn "glm-5\|qwen3\.8\|deepseek-v4\|kimi-k3"` across
    `extensions/pi-fusion-matrix/` and `matrix.json` must match only `aliases.*.model`, fixtures, and
    comments — never `fusions`, `candidates`, or code. A `models.json` version bump (for example `deepseek-v4.1-flash` →
    `deepseek-v4-flash` on `go`) must change behavior with no edit to this repo; confirm by bumping it
    and running `pi -p "Reply with exactly: ZQX1" --model fusion-matrix/standard`: the run succeeds and
    `details.models` shows the new vendor id behind the unchanged alias.

16. **Mode shapes are cost contracts** — run each and count the calls. `fusion-matrix/solo` is one
    seat and no judge; `fusion-matrix/workhorse` is two seats plus a merge, and the merged text must
    differ from both seat texts (a merge that echoes a panel response is not a merge);
    `fusion-matrix/sota` is the same shape with its frontier roster named in the banner;
    `fusion-matrix/brief` is four calls instead of five, with the judge's single message carrying both
    its analysis and the answer; `fusion-matrix/opinions` makes three calls, ends with labelled sections
    and no generation, and records `render` in `details.stages`; `fusion-matrix/debate` makes nine
    (3 seats x 3 rounds). A shape that quietly adds or drops a call is a bug: the call count is the
    feature.
17. **Debate envelopes** — in `fusion-matrix/debate`, every round after the first carries each *other*
    seat's previous-round output and never its own; `details.rounds[].inputs` records the envelope per
    seat per round. Then point one seat's only provider at `nope`: that seat is labelled and dropped,
    the remaining two continue, and if only one survives the rounds stop early rather than running alone.
18. **Decision stages** — with a temporary mode in the project file,
    `{ "score": { "instructions": "How well does this response address the question?",
                  "criteria": ["off-topic", "partial", "solid", "thorough"] }, "over": "panel" }` must
    issue **one** backend request for the three seats (the stub records request count), and the stage
    that follows must render sorted `persona: score (confidence)` lines from `panel+weights`. Separately,
    a persona with `thinking: "off"` must show as omitted or off in `details.seats[].thinking`, while
    `deep`'s judge (persona default `medium`, fusion override `high`) shows `high` — sampling is
    configuration, and the run record must show what was actually requested.

19. **Doctor** — `node scripts/doctor.mjs` and `/matrix-doctor` over the packaged config: exit 0 clean
    (offline), exit 1 with a named alias when a `model` is removed from `matrix.json` (config error),
    exit 2 naming the provider when an alias routes through one pi does not know or has no credential
    for, and exit 3 with `--online` when an alias names an id the provider no longer serves. `--repair`
    must print the `models.json` upsert snippet and, without `--write`, leave both `matrix.json` and
    `models.json` byte-identical (assert by hash before and after); with `--write` it may add ids but
    must not change any alias's `model` field. A single-route alias must be reported as having no
    fallback rather than passing silently.

20. **Offline interpreter contracts** — `node scripts/typesafe-stub.mjs &` then
    `node scripts/interp-check.mjs` must pass 9/9: a decisive stage decision skips the stage it gates
    with no judge call; an ambiguous one calls the judge and records a prior containing the cheap read's
    answer; debate makes 3 seats × 3 rounds with peers' opinions; a `score` stage issues **one** batched
    request for three seats; `verify` warns without blocking; a confident route redirects and an
    unconfident one declines. This is the check that must run when a provider's quota blocks the live
    items — and it caught a real gap on first use: stage-level `sufficientWhen` was unimplemented, so a
    converged panel still paid for the judge.
21. **Doctor exit codes and non-mutation** — with an injected registry and catalogue: clean config exits
    0; a bad alias exits 1; an unknown provider and an unauthenticated provider each exit 2; a retired id
    with `--online` exits 3; a single-route alias is reported rather than passed silently; and `--repair`
    prints its snippet while leaving every tracked file byte-identical (asserted by hash).

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
- **Shapes and seats are configuration; the executor is code.** `modes` are stage lists and `personas`
  are seats, so adding a shape or re-pointing a seat is an edit to `matrix.json`. What stays code is the
  stage *kinds* (`parallel`, `single`, `decide`, `score`, `render`), the connector set, and the assembly
  rules. That line is deliberate: a config language expressive enough to need interpreter branches of its
  own is a language whose validity nobody can check.
- **Three shapes from the reference harness are out of scope, and that absence is a boundary rather than
  a gap.** A stage that writes to disk needs a subprocess with tools, which is a different execution
  model from a seat that is one model call; a gate *loop* that iterates until green needs loop constructs
  and a feedback channel; and their plan-then-DAG-then-execute collaboration is a task scheduler, not a
  deliberation pipeline. The `gate` entry under `verify` is deliberately report-only — it runs a command
  once and records the result, and never feeds back into a stage.
- **pi-ai's `Context.systemPrompt` is the only place a system instruction goes.** Measured 2026-09-18: a
  system-*role message* alongside `tools` makes the call fail with
  `Cannot read properties of undefined (reading 'length')` on the same model that works without it. Seats
  and the file agent pass the persona prompt through `systemPrompt`.
- **Tool schemas must be Typebox, not plain JSON schema.** The same request over curl in the OpenAI wire
  shape returned 200 with a `tool_calls` finish reason, while pi-ai given a plain JSON-schema object
  produced that gateway-side error. The two peers (`@earendil-works/pi-ai/compat`, `typebox`) are
  resolved by walking up from the *real* entry script, because a bare specifier does not resolve from a
  symlinked extension directory and `process.argv[1]` is the bin shim.
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