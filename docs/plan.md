# pi-fusion-matrix — fusions with per-slot fallback, native providers, and a SemIf decision backend

## Context

`@quarkos/pi-fusion` ([upstream](https://github.com/QuarkOS/Pi-Fusion); a local vendored copy serves
as the reference implementation) hardcodes one
provider per fusion: `applyProfile` sets `config.provider` and a single
`providers[provider].defaultModels` map of five bare model ids, and `lib/api.js` builds one
`ApiClient` with one baseUrl and one key. That cannot express what is needed: a fusion whose five
slots each have ordered fallback candidates, aliases that survive vendor version bumps, and a local
decision oracle (SemIf) as a slot.

Build a new extension `pi-fusion-matrix` in its own repo that owns fusion resolution only. Providers,
endpoints, and credentials stay pi's job in `~/.pi/agent/models.json` (or an extension-registered
provider): the extension never resolves a secret, never owns a baseUrl, and leans on pi for auth,
caching, and telemetry. It resolves aliases to *native* provider/model pairs, executes each slot
through pi's own `streamSimple`, and falls back provider-by-provider inside an alias and
model-by-model across a slot's entries, with every substitution reported. The existing `pi-fusion`
fork stays installed and untouched, and is read as a *reference* for behaviors re-derived here (Step 6);
nothing imports it at runtime.

Required outcomes: (1) fusions of five slots, each an ordered candidate list, degraded only as
configured; (2) version-free aliases so a vendor model bump edits one line and no fusion; (3) a
pluggable decision backend used as a slot element, a post-synthesis check, or a routing gate —
TypeSafe (`https://api.typesafe.ai/v1/systemone`, calibrated `confidence`, no local service) as the
default on this machine, SemIf as the local zero-marginal-cost alternative; (4) every substitution
observable in the transcript and in tool details; (5) credentials and endpoints remain entirely
pi-owned.

Decisions run conservatively: they never replace a frontier pipeline call. They only (a) verify a
degraded or substituted slot's output and report it, and (b) select a cheaper fusion when confident.
Low confidence escalates to the expensive path rather than silently deciding.

## Approach

### Step 1 — New repo, package skeleton, config loading

Create the repository root with:

```
package.json            # private package declaring pi.extensions
matrix.json             # packaged default aliases + fusions (Step 2)
README.md
extensions/pi-fusion-matrix/
  index.ts              # entry: load config, register provider/tool/commands
  config.ts             # layered load, merge, validate, template interpolation
  resolve.ts            # alias → native provider/model pairs; slot expansion
  run.ts                # fusion pipeline, slot execution, fallback advance, reporting, verify, route
  decide.ts             # decision client: typesafe + semif kinds (stdlib HTTP only)
  prompts.ts            # packaged panel/judge/synthesis prompts (Step 6)
scripts/
  semif-probe.mjs       # SemIf contract probe over upstream's decisions.jsonl fixture
  typesafe-probe.mjs    # TypeSafe contract probe: option form + batched typed questions
  semif-stub.mjs        # offline /score stub, port 8792
  typesafe-stub.mjs     # offline /v1/systemone stub, port 8793
tools/semif-server/     # operator-run scoring service (Step 4)
  server.py
  requirements.txt
  Dockerfile
  README.md
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
 * An alias is a stable, version-free name for a model slot ("deepseek-flash"). `providers` is the
 * ordered native-provider list to try, which is the same-model fallback layer; `modelOverride` on a
 * provider is how the same slot is named differently on one provider's catalogue.
 */
export type AliasSpec = { providers: (string | ProviderRef)[]; maxTokens?: number; reasoning?: boolean };

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

export type SlotKey = "technical_expert" | "devils_advocate" | "systems_thinker" | "judge" | "synthesis";

export type FusionSpec = {
  /** Picker label for the registered model. Default `Fusion · <id>`. */
  name?: string;
  /** Metadata for the registered model; the pipeline itself is unaffected. */
  model?: { contextWindow?: number; maxTokens?: number };
  mode: "3x" | "5x";
  slots: Partial<Record<SlotKey, SlotCandidate[]>>;
  fileAgent?: false | { alias: string };
  prompts?: Partial<Record<SlotKey, string>>;
  maxAdvance?: number;                // default 3
  /** Post-synthesis checks. Report-only: a negative or low-confidence answer warns, never rewrites. */
  verify?: DecideSpec[];
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
  /** Key is the registered model id; the value is the pipeline it runs. */
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
- a fusion id containing `:` or `/` → error, because pi parses `provider/id:thinking` and the id would
  be unaddressable (`fusion id "deep:cheap" may not contain ":" or "/"`).
- `defaultFusion` naming an unknown fusion → error.
- fusion slot entry naming an unknown alias → name it and list `aliases` keys.
- fusion slot list empty → name the slot.
- `mode: "3x"` fusion declaring `systems_thinker` or `judge` → error, because 3x never calls them.
- `mode: "5x"` fusion missing any of the five slots → name the missing slots.
- `DecideSpec` declaring both `options` and `questions`, or neither → error.
- `options` (SemIf-shaped choice) with a length outside 2..16 → error.
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

### Step 2 — Packaged `matrix.json` and the matching `models.json`

`matrix.json` holds aliases and fusions only — no providers, no credentials, no baseUrls:

```json
{
  "providerId": "fusion-matrix",
  "providerName": "Fusion Matrix",
  "defaultFusion": "standard",
  "aliases": {
    "deepseek-flash": { "providers": ["go", "tp", "corp"] },
    "deepseek-pro": { "providers": ["go", "tp"] },
    "glm": { "providers": ["go", "tp"] },
    "glm-flash": { "providers": ["go", "tp"] },
    "qwen-max": { "providers": ["go", "tp"] },
    "qwen-flash": { "providers": ["go", "tp"] },
    "kimi": { "providers": ["go"] },
    "gpt": { "providers": ["oai"] },
    "grok": { "providers": ["zen", "go"], "reasoning": true },
    "luna": { "providers": ["zen", "go"], "reasoning": true }
  },
  "fusions": {
    "standard": {
      "mode": "3x",
      "slots": { "technical_expert": ["glm"], "devils_advocate": ["glm"],
                 "synthesis": ["glm"] },
      "fileAgent": { "alias": "deepseek-flash" }
    },
    "quick": {
      "mode": "3x",
      "slots": { "technical_expert": ["glm-flash"], "devils_advocate": ["glm-flash"],
                 "synthesis": ["glm"] },
      "fileAgent": { "alias": "deepseek-flash" }
    },
    "deep": {
      "mode": "5x",
      "slots": {
        "technical_expert": ["kimi", "qwen-max"],
        "devils_advocate": ["deepseek-pro"],
        "systems_thinker": ["glm"],
        "judge": ["deepseek-pro"],
        "synthesis": ["kimi", "qwen-max"]
      },
      "fileAgent": { "alias": "deepseek-flash" }
    },
    "review": {
      "mode": "5x",
      "slots": {
        "technical_expert": ["kimi", "qwen-max"],
        "devils_advocate": ["deepseek-pro"],
        "systems_thinker": ["glm"],
        "judge": ["deepseek-pro"],
        "synthesis": ["kimi", "qwen-max"]
      },
      "fileAgent": false,
      "prompts": { "synthesis": "You are reviewing a proposed change. Report defects with severity, file:line anchors, and reproduction steps. Do not emit revised code. Under 1,500 tokens." }
    },
    "openai": {
      "mode": "5x",
      "slots": {
        "technical_expert": ["gpt"], "devils_advocate": ["gpt"],
        "systems_thinker": ["gpt"], "judge": ["gpt"],
        "synthesis": ["gpt", { "alias": "kimi", "providers": ["go"] }]
      },
      "fileAgent": false
    },
    "review-check": {
      "mode": "5x",
      "slots": {
        "technical_expert": ["kimi", "qwen-max"],
        "devils_advocate": ["deepseek-pro"],
        "systems_thinker": ["glm"],
        "judge": [
          { "decide": {
              "state": "{{panel}}",
              "question": "Do the experts agree on a single core recommendation?",
              "options": [
                { "id": "agrees", "description": "They converge on the same recommendation." },
                { "id": "partial", "description": "They overlap but differ on a substantive point." },
                { "id": "disagrees", "description": "They recommend different things." }
              ] },
            "sufficientWhen": { "choiceIs": ["agrees"], "minConfidence": 0.85 } },
          "deepseek-pro"
        ],
        "synthesis": ["kimi", "qwen-max"]
      },
      "fileAgent": false,
      "verify": [
        { "state": "{{synthesis}}",
          "questions": {
            "addresses_question": {
              "type": "noul",
              "instructions": "The answer directly addresses the question that was asked.",
              "criteria": { "true": "Answers the actual question", "false": "Answers a different or narrower question" }
            },
            "grounded_in_panel": {
              "type": "noul",
              "instructions": "Every substantive claim traces to the expert responses or the judge analysis.",
              "criteria": { "true": "All claims traceable", "false": "Contains claims with no support in the deliberation" }
            },
            "contradiction_handling": {
              "type": "choice",
              "instructions": "How the answer handles the judge's contradictions.",
              "criteria": {
                "resolves": "Picks a side and says why",
                "acknowledges": "Notes the disagreement without choosing",
                "ignores": "Does not mention it"
              }
            }
          } }
      ]
    },
    "review-routed": {
      "mode": "5x",
      "route": {
        "instructions": "How much deliberation does this request need?",
        "criteria": {
          "trivial": { "description": "A direct factual or mechanical question", "then": "quick" },
          "single_concern": { "description": "One design decision with limited blast radius", "then": "quick" },
          "multi_concern": "Several interacting decisions or cross-cutting change",
          "architectural": "System-level tradeoffs with long-lived consequences"
        }
      },
      "slots": {
        "technical_expert": ["kimi", "qwen-max"],
        "devils_advocate": ["deepseek-pro"],
        "systems_thinker": ["glm"],
        "judge": ["deepseek-pro"],
        "synthesis": ["kimi", "qwen-max"]
      },
      "fileAgent": false
    }
  },
  "decide": {
    "defaultBackend": "typesafe",
    "models": {
      "qwen3.5-4b": { "source": "Qwen/Qwen3.5-4B",
                      "revision": "851bf6e806efd8d0a36b00ddf55e13ccb7b8cd0a" },
      "minicpm5-2b": { "source": "openbmb/MiniCPM5-2B",
                       "revision": "12a3808a956f869c767195e9266b59c4d21d92e2" },
      "qwen3-0.6b": { "source": "Qwen/Qwen3-0.6B",
                      "revision": "c1899de289a04d12100db370d81485cdf75e47ca" }
    }
  },
  "backends": {
    "typesafe": { "kind": "typesafe", "url": "https://api.typesafe.ai/v1/systemone",
                  "apiKeyEnv": "TYPESAFE_API_KEY", "model": "jev-1.13.0", "timeoutMs": 60000 },
    "semif": { "kind": "semif", "url": "http://127.0.0.1:8791/score", "timeoutMs": 30000 },
    "semif-hosted": { "kind": "semif", "url": "https://SET-THE-HOSTED-SEMIF-URL/score",
                      "apiKeyEnv": "SEMIF_API_KEY", "timeoutMs": 30000 },
    "semif-stub": { "kind": "semif", "url": "http://127.0.0.1:8792/score", "timeoutMs": 5000 }
  }
}
```

The provider names in `aliases.*.providers` are satisfied by pi's `models.json`. The implementer
writes this block into `~/.pi/agent/models.json` (merge into the existing `providers` object; never
replace the file's other providers), which is the entire billing story — one provider per account,
each with its own key reference and endpoint:

```json
{
  "providers": {
    "go": {
      "baseUrl": "https://opencode.ai/zen/go/v1",
      "api": "openai-completions",
      "apiKey": "$OC_GO_CC_API_KEY",
      "models": [
        { "id": "glm-5.3" }, { "id": "glm-5.3-flash" }, { "id": "kimi-k3" },
        { "id": "deepseek-v4.1-flash" }, { "id": "deepseek-v4-pro" },
        { "id": "qwen3.8-max" }, { "id": "qwen3.8-flash" }, { "id": "grok-4.6" },
        { "id": "gpt-5.6-luna", "reasoning": true }
      ]
    },
    "tp": {
      "baseUrl": "https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1",
      "api": "openai-completions",
      "apiKey": "$ALIBABA_TOKEN_PLAN_API_KEY",
      "models": [
        { "id": "glm-5.3" }, { "id": "qwen3.8-max" }, { "id": "qwen3.8-flash" },
        { "id": "deepseek-v4.1-flash" }, { "id": "deepseek-v4-pro" },
        { "id": "deepseek-v4-flash-0731" }
      ]
    },
    "zen": {
      "baseUrl": "https://opencode.ai/zen/v1",
      "api": "openai-completions",
      "apiKey": "$OPENCODE_API_KEY",
      "models": [ { "id": "grok-4.6" }, { "id": "gpt-5.6-luna", "reasoning": true } ]
    },
    "oai": {
      "baseUrl": "https://api.openai.com/v1",
      "api": "openai-completions",
      "apiKey": "$OPENAI_API_KEY",
      "models": [ { "id": "gpt-5.6-sol", "reasoning": true } ]
    },
    "corp": {
      "baseUrl": "https://gateway.example.com/v1",
      "api": "openai-completions",
      "apiKey": "!sops -d --extract '[\"data\"][\"api_key\"]' ./secrets/corp-gateway.enc.yaml",
      "models": [ { "id": "deepseek-v4.1-flash" } ]
    }
  }
}
```

`corp` is the shape for a private gateway: any provider whose `apiKey` is a `!command` (sops, a secret
manager CLI, `security find-generic-password`) rather than an environment variable. pi resolves that
command at request time and its output is never committed — which is why this repository can ship a
provider block as an example without carrying a credential.

Add `openai`/`google`/`anthropic` style models here only as needed: `models.json` may list an
arbitrary model id per provider, and this extension resolves the drill-down itself (Step 3), so no
entry in the client's own catalogue is required.

Per-organization billing is a second, keyed entry in the same file — a copy of the block above whose
`apiKey` points at another account's secret (for example `"tp-work": { "baseUrl": "...", "apiKey":
"!sops -d ./secrets/tp-work-key.enc.yaml", "models": [ ...same ids... ] }`), with the alias's
`providers` list edited in the repo-local `matrix.json` (`"providers": ["go", "tp-work", "tp"]`) when
that project must bill elsewhere first. Both files live outside the workspace, so every repo can carry
its own `matrix.json` while the secrets stay in pi's own store.

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

`resolveCandidates` expands one slot entry into an ordered list — this is the whole resolution model,
and it consults only the alias table (providers live in pi's store, so nothing here reads a key or a
URL):

1. A `{ semif }` entry returns `[]`; the caller handles SemIf separately (Step 4).
2. Normalize the entry: a bare string is `{ alias: string }`; an object carries `alias` plus an
   optional per-slot `providers` override.
3. `alias = config.aliases[aliasId]`; missing → throw `unknown alias "x"; known: ...`.
4. `refs = providers ?? alias.providers`; empty after the override → throw `alias "x" has no providers`.
5. For each ref in order, push `{ alias: aliasId, provider: ref.id ?? ref, model:
   ref.modelOverride ?? aliasId, maxTokens: alias.maxTokens ?? 4096, reasoning: alias.reasoning ?? false }`.
   The model id is the **alias name**, not a vendor version: `deepseek-flash` stays `deepseek-flash`
   on every provider and in every fusion, and the concrete vendor id is supplied by `models.json` (or
   by the provider's own catalogue), so a version bump edits that file alone.

Provider existence is verified in `run.ts` right before the call, not at load: the fallback executor
asks pi's runtime for the resolved model list and, when the provider id is absent, records a
substitution with `reason: "missing provider"` and moves on. This keeps the validation out of
startup and makes a stale provider name a per-slot degradation instead of a hard failure.

`run.ts` exports `runFusion(model, context, options)` and:

```ts
type Substitution = { slot: SlotKey; from: string; to: string; reason: string };
type SlotResult = {
  text: string; label: string; usage: Usage; substitutions: Substitution[];
  semif?: { probabilities: Record<string, number>; model: string }; error?: string; degraded: boolean;
};
async function runSlot(slot: SlotKey, candidates: SlotCandidate[], ctx: RunContext): Promise<SlotResult>;
```

`runSlot` algorithm — two fallback layers, each independently configured and reported:
1. `prompt` = first message of the trailing run of `role === "user"` messages — the injected-prelude
   fix, copied from `<vendored-fork>/index.js:485-506` (`extractPrompt`).
2. Expand the slot list with `resolveCandidates` per entry, keeping entry order. Each entry contributes
   its own ordered provider list. The expansion is the execution plan; log it once per run in the
   banner as `<slot>: <alias>@<provider>` sequences.
3. Walk the expansion in order, capped at `fusion.maxAdvance ?? 3` advances total:
   - decide entry → `decide(...)` per Step 4; failure records a substitution `reason: "decision"` and
     moves to the next entry. A decision's text contribution to the judge/synthesis context is
     `option: probability` lines (`<id>: <p>` sorted descending), and the winner is marked.
   - Otherwise resolve the model through pi's own runtime and stream it:
     ```ts
     // `session` and the extension context come from the surrounding run; `ctx.modelRegistry` is the
     // registry pi exposes to the extension, and `resolveModel`/`getAvailable` are its read APIs.
     const model = ctx.modelRegistry.find(resolved.provider, resolved.model); // undefined → missing
     const message = model
       ? await streamSimple(model, { messages }, { signal: options.signal, temperature }).result()
       : undefined;
     ```
     `streamSimple` is imported from `@earendil-works/pi-ai/compat` (Step 6). Passing pi's own `Model`
     object means the api id, baseUrl, headers, apiKey, and `compat` flags all come from pi's
     resolution — this extension never constructs them. Slot text = concatenated `text` blocks of
     `message.content`; usage = `message.usage`; failure = `message.stopReason === "error"` with
     `message.errorMessage`; `model === undefined` means the provider or model id is not registered.
4. Failure classification (the contract; `same name` = advancing inside one alias's provider list,
   `new name` = moving to the next slot entry):
   | Signal | Action | reason string | layer |
   |---|---|---|---|
   | `model` unresolved (`find` returned undefined) | advance | `"missing provider"` | both |
   | `stopReason === "error"`, text matches `/\b429\b|usage limit|quota|balance/i` | advance at once | `"quota"` | both |
   | text matches `/\b40[13]\b|unauthorized|invalid api key/i` | advance | `"credential"` | both |
   | text matches `/not found|unknown model|\b404\b/i` | advance | `"missing model"` | both |
   | transport failure, 5xx, or a 429 without quota semantics | retry same candidate once after 2000 ms, then advance | `"transient"` | both |
   | a decision candidate answered, but `sufficientWhen` did not hold | advance at once, keeping the answer | `"insufficient"` | slot cascade |
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
   - inside an alias: ` ├─ ↩ judge deepseek-pro@go → deepseek-pro@tp (quota)\n`
   - across entries:   ` ├─ ↩ judge qwen-max@go → glm@go (quota)\n`
   `deepseek-pro@go → deepseek-pro@tp` is quality-preserving (same alias name, same vendor model in
   both accounts); a cross-entry line means a different alias answered and must be visible in both
   the transcript and `details.substitutions`.
6. Everything exhausted → `error = "all candidates failed: deepseek-pro@go (quota), deepseek-pro@tp (credential)"`,
   `degraded: true`; the pipeline continues with the slot marked unavailable (3x no longer aborts a
   run when one panel slot dies — a deliberate change from the reference implementation's 3x
   `Promise.all`).

Temperature per slot: `0.5` for `technical_expert` and `synthesis`, `0.8` for `devils_advocate`,
`0.6` for `systems_thinker`, `0.2` for `judge` — the reference implementation's values. Keep the
`kimi` special case (`temperature: 1.0`
when the model id contains `kimi`), and the models-reject-temperature memory from
`<vendored-fork>/lib/api.js` (patch 6): a module-level `Set` of provider/model keys; on an error
whose text matches `/temperature/i`, add the key, omit `temperature` on the retry (same candidate,
not an advance), emit one `⚠️ <provider>/<model> rejects a temperature override; retrying without it.`
delta. The corresponding prevention lives in `models.json`: for a model that always rejects it, set
`"samplingParams": { "temperature": 1 }` on that entry, which pi merges into the request body, and
the memory above covers the case where it was not set.

Pipeline shape in `runFusion`: 3x = two panel slots concurrently, then synthesis (both streams
forwarded); 5x = three panel slots concurrently, then judge (JSON, parsed with the bracket-recovery
fallback from `<vendored-fork>/lib/deliberation.js`), then synthesis. Prompts come from
`fusion.prompts[slot]` when set, else `prompts.ts` literals. A SemIf element inside a slot's list is
executed in place, and its result enters the judge/synthesis context in that slot's position.

File agent: when `fusion.fileAgent` is `{ alias }`, resolve that alias through the same
`resolveCandidates` path (so it also inherits the provider chain, e.g. `deepseek-flash` on Go then
the token plan) and run it with the `WRITE_TOOL` schema copied from `<vendored-fork>/index.js`,
emitting `toolcall_start`/`toolcall_end` blocks exactly as `index.js:718-730` does, so pi performs the
writes. When `false`, skip and end with `stopReason: "stop"`.

Registration of tool and commands:

```ts
pi.registerTool({
  name: "deliberate", label: "Deliberate",
  description: "Run a multi-model deliberation on a design question or coding problem.",
  promptSnippet: "Run multi-model deliberation on complex design questions",
  parameters: Type.Object({
    prompt: Type.String({ description: "The query or design task to analyze." }),
    fusion: Type.Optional(Type.String({ description: 'Fusion id from matrix.json (e.g. "deep"). Omit for "default".' })),
  }),
  execute: async (_toolCallId, params) => { /* content: synthesis text,
    details: { fusion, models, substitutions, slotErrors, panelResponses, judgeAnalysis, usage } */ },
});
pi.registerCommand("fusion", { description: "Run a named fusion: /fusion <id> <prompt>", handler: async (args, ctx) => {} });
pi.registerCommand("fusion-matrix", { description: "List profiles, accounts, aliases, and fusions", handler: async (_args, ctx) => {} });
```

Every run records its cascades so the hit rate of the cheap path is measurable:

```ts
type Cascade = {
  slot: SlotKey;
  kind: "model" | "decision";
  answer?: { choice?: string; noul?: number; score?: number; confidence?: number };
  sufficient?: boolean;   // decision candidates only
  prior?: string;         // exact text handed to the next candidate when insufficient
  advancedTo?: string;    // label of the next candidate
};
// in tool details: details.cascades: Cascade[]
```

`/fusion` parses the first whitespace-delimited token as a fusion id when it matches a key in
`fusions`; otherwise the whole argument string is the prompt and `defaultFusion` is used. Unknown id →
`ctx.ui.notify('unknown fusion "x"; known: default, deep, ...', "error")` and no run.
Tool `details.substitutions` and `details.slotErrors` are always present (empty arrays included): a
silently degraded run is a wrong answer and must be visible.

**`route` runs before the first slot** (Step 3 step 1). The clause is one choice question built from
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

**`verify` runs after synthesis** (Step 3 step 6) and is report-only: each `DecideSpec` is evaluated
with `vars = { prompt, panel, judge, synthesis, cwd }`, and results are recorded in
`details.decisions[].verify`. Any `noul < 0.5`, any `choice` whose winner is the pessimistic option,
or any `confidence < 0.5` emits one delta:
` ⚠️ verify: grounded_in_panel=0.31 (low) — synthesis may contain unsupported claims\n`.
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

The pipeline, in order, mirroring the shape verified working in
`<vendored-fork>/lib/deliberation.js` (read as reference, not copied):

1. **3x** — `technical_expert` and `devils_advocate` concurrently via `runSlot`, then `synthesis`.
2. **5x** — `technical_expert`, `devils_advocate`, `systems_thinker` concurrently via `runSlot`, then
   `judge`, then `synthesis`.
3. **Judge output** — request JSON (`jsonMode: true` equivalent: append "Output only a valid JSON
   object with keys consensus, contradictions, partial_coverage, unique_insights, blind_spots" to the
   judge prompt), then parse with the two-stage recovery: strip a leading ```` ```json ```` fence, else
   extract from the first `{` to the last `}`. On total parse failure, keep the raw text under
   `unique_insights` so synthesis still receives something (the fallback object in
   `lib/deliberation.js` is the reference).
4. **Context assembly** — the judge prompt carries the original prompt plus all three panel responses
   under the exact headers `TECHNICAL EXPERT RESPONSE:` / `DEVIL'S ADVOCATE RESPONSE:` /
   `SYSTEMS THINKER RESPONSE:`; the synthesis prompt carries the prompt, the three responses, and
   `JSON.stringify(judgeAnalysis, null, 2)`. A SemIf element inside a slot's list occupies that slot's
   position and contributes its options-with-probabilities text in place of a model response.
5. **Streaming** — `createAssistantMessageEventStream` is imported from `@earendil-works/pi-ai` (pi
   bundles it; no hand-rolled stream, no `lib/event-stream.js` equivalent). The stream emits `start`
   with the empty partial, then `text_start`, then `text_delta` per progress/substitution/synthesis
   chunk, then `text_end`, then `toolcall_start`/`toolcall_end` pairs for each file-agent write (if
   any), then `done` or `error`. Contract verified against pi's consumer at
   `node_modules/@earendil-works/pi-agent-core/dist/agent-loop.js:201-243`: it replaces
   `context.messages[last]` with each `partial`, so every partial must be a complete
   `AssistantMessage`, and it reads tool calls from the final message's `content`, so `done.message`
   must carry the `toolCall` blocks.
6. **Usage** — sum `message.usage` over every delegated call and shape it as
   `{ input, output, cacheRead, cacheWrite, totalTokens, reasoning?, cost: { input, output, cacheRead,
   cacheWrite, total } }` (`Usage` in `pi-ai/dist/types.d.ts:255-278`). Zero-fill cost; do not call
   `calculateCost` (the fork's only pi-ai use, `index.js:704-712`) — this extension has no price table.

Prompts live in `prompts.ts` as literals, transcribed from
`<vendored-fork>/pi-harness.config.json` (`panel.*.systemPrompt`, `judge.systemPrompt`,
`synthesis.systemPrompt`) before that directory is removed. They are upstream's 1,500-token-concise
prompts and are the one thing worth copying verbatim.

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
- `<vendored-fork>/pi-harness.config.json` — source of the three prompt literals for `prompts.ts`
  (transcribe before deleting anything).
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

Prerequisites: the `models.json` block from Step 2 merged into `~/.pi/agent/models.json`, and the keys
it references available (`OC_GO_CC_API_KEY`, `ALIBABA_TOKEN_PLAN_API_KEY`, `OPENAI_API_KEY`; the `corp`
provider additionally needs whatever its `!command` reads); `/tmp/fusion-matrix-check/` as `cwd` for scratch runs (create, and remove at the end); the
pi config repo symlink from Step 1 in place.

1. **Model registration** — `cd /tmp/fusion-matrix-check && pi --list-models fusion` prints
   `fusion-matrix/standard`, `fusion-matrix/quick`, `fusion-matrix/deep`, `fusion-matrix/review`,
   `fusion-matrix/openai`, `fusion-matrix/review-check`, `fusion-matrix/review-routed`.
   Failure here means the api id, manifest, or symlink is wrong.
2. **Config validation** — write `/tmp/fusion-matrix-check/.pi-fusion-matrix.json` containing
   `{"fusions": {"deep": {"slots": {"judge": ["no-such-alias"]}}}}`; a `--model fusion-matrix/deep` run must
   fail with `pi-fusion-matrix: unknown alias "no-such-alias"; known: deepseek-flash, ...`. Remove the
   file afterwards.
3. **Provider-layer fallback (same alias, new billing route)** — in
   `/tmp/fusion-matrix-check/.pi-fusion-matrix.json` set
   `{"aliases": {"deepseek-pro": {"providers": ["nope", "tp"]}}}`. A `fusion-matrix/deep` run must print
   ` ├─ ↩ devils_advocate deepseek-pro@nope → deepseek-pro@tp (missing provider)`, complete, and —
   driven through the `deliberate` tool — report exactly one substitution whose `from` and `to` share
   the same alias name. Remove the override afterwards. This verifies both the native-provider lookup
   and that a stale provider name degrades per slot instead of aborting.
4. **Slot-layer fallback (new alias)** — in the same project file set
   `{"fusions": {"deep": {"slots": {"systems_thinker": ["kimi", "glm"]}}},
   "aliases": {"kimi": {"providers": ["nope"]}}}`. The run must print
   ` ├─ ↩ systems_thinker kimi@nope → glm@go (missing provider)` and
   `details.substitutions[0].from`/`.to` must carry the two different alias names. This is the check
   that distinguishes the two layers; identical `from`/`to` text means the reporting is wrong.
5. **Empirical quota advance** — with the Go 5-hour window exhausted (observed 2026-09-18:
   HTTP 429 `5-hour usage limit reached`), `pi -p "Reply with exactly: ZQX1" --model fusion-matrix/deep
   --no-session` must fall through to each alias's next provider and still answer, instead of the
   121 s retry loop the reference implementation exhibits.
6. **Prompt correctness under injected preludes** — with the full extension set loaded (context-mode
   active), `pi -p "Reply with exactly: ZQX1" --model fusion-matrix/standard --no-session` must return `ZQX1`, not a
   deliberation about context-mode's tool hierarchy.
7. **Decision contract offline** — `node scripts/typesafe-stub.mjs &` and
   `node scripts/semif-stub.mjs &`, then
   `node scripts/typesafe-probe.mjs --backend http://127.0.0.1:8793/v1/systemone` and
   `node scripts/semif-probe.mjs --backend http://127.0.0.1:8792/score` must both exit 0. Point
   `decide.defaultBackend` at `typesafe-stub` and run
   `pi -p "Summarize the tradeoffs of optimistic locking" --model fusion-matrix/review-check --no-session`:
   the judge element must resolve in place and `details.decisions` must carry the winner and the full
   probability map. Kill the stubs afterwards.
8. **TypeSafe live** — export `TYPESAFE_API_KEY`, set `decide.defaultBackend` to `typesafe`, and run
   `node scripts/typesafe-probe.mjs --backend https://api.typesafe.ai/v1/systemone`; it must exit 0 and
   print the answering `model` (`jev-1.13.0`). Then run `fusion-matrix/review-check` live and confirm
   `details.decisions[].verify` carries three typed answers (`noul`, `noul`, `choice`) and that each
   `choice`/`score` answer has `confidence`. A `401` here means the key is absent or wrong, not that
   the wiring is broken.
9. **Conservative invariants** — (a) temporarily set `verify[0]` to a question the synthesis cannot
   satisfy (for example `noul` "the answer contains the exact phrase BANANA") and confirm the run
   still completes with one `⚠️ verify:` delta and an unchanged synthesis — verification must never
   rewrite or block; (b) point `route` at a `semif` backend and confirm the load error
   `routing requires a backend that reports confidence; "semif" does not`; (c) run
   `fusion-matrix/review-routed` on a genuinely complex prompt and confirm it does *not* route away (the
   decision reports a non-trivial option), then on `"Reply with exactly: ZQX1"` and confirm it does,
   with the ` routed` line and `details.routing` both present; (d) set `route.sufficientWhen.minConfidence`
   to 1.0 and confirm the run proceeds as `fusion-matrix/review-routed` with `details.routing` recording
   the declined route — the gate must be able to decline, and must say so.
10. **Judge cascade** — with the decision stub returning a decisive high-confidence answer,
    `fusion-matrix/review-check` must report ` ├─ ️ judge via decision (agrees, conf 0.9x) — skipping
    deepseek-pro`, must *not* call the generative judge, and must record
    `details.cascades[0].sufficient === true`. With the stub returning `unclear` at 0.51, the same run
    must emit ` ├─ ↳ judge decision insufficient (…) → deepseek-pro`, call the generative judge, and
    record `details.cascades[0].sufficient === false` plus a `prior` string containing the decision's
    answer. Then set `sufficientWhen.choiceIs` to an option the stub never returns and confirm every
    run escalates — a cascade whose cheap path can never win is measurable dead weight, which is what
    `details.cascades` exists to reveal.
11. **Oversized state** — put a ~150 KB `{{panel}}` through `fusion-matrix/review-check` against the live
    backend: the run must emit one `⚠️ decision state truncated` delta, still complete, and report the
    decision. A `4xx` from the backend instead means truncation did not engage.
12. **Per-project billing selection** — add a second provider block to `~/.pi/agent/models.json` (copy
    `go` as `go-alt`, same key) and set
    `/tmp/fusion-matrix-check/.pi-fusion-matrix.json` to
    `{"aliases": {"glm": {"providers": ["go-alt", "go"]}}}`. A `--model fusion-matrix/standard` run must execute on
    `go-alt` (banner and `details.models` show it) with no edit to any fusion and no credential in the
    project file. Remove the override afterwards. This is the check that per-repo billing needs no
    profile system.
13. **Independence from the fork** — `grep -rn "pi-fusion\|/Users/\|~/" extensions/ matrix.json
    package.json` must return no import or path reference (only doc/comment mentions of the reference
    directory are allowed). Then move the vendored reference fork out of the pi extensions directory, run
    `pi -p "Reply with exactly: ZQX1" --model fusion-matrix/deep --no-session`, and confirm it still works —
    this is the check that the package runs with no developer checkout present. Restore the directory
    afterwards.
14. **Alias is version-free** — `grep -rn "glm-5\|qwen3\.8\|deepseek-v4\|kimi-k3"` across
    `extensions/pi-fusion-matrix/` and `matrix.json` must match only test fixtures or comments, never
    `fusions` or `slots`. A `models.json` version bump (for example `deepseek-v4.1-flash` →
    `deepseek-v4-flash` on `go`) must change behavior with no edit to this repo; confirm by bumping it
    and running `pi -p "Reply with exactly: ZQX1" --model fusion-matrix/standard`: the run succeeds and
    `details.models` shows the new vendor id behind the unchanged alias.

## Assumptions & contingencies

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
- **Alias names are version-free by design** (`deepseek-flash`, `glm`, `qwen-max`). Vendor ids live in
  `models.json`; this repo's aliases, fusions, and slots never mention one. Naming an alias after a
  version (`glm-5.3`) is the anti-pattern this avoids: it forces a config sweep on every vendor release
  and leaves stale names pointing at new ids.
- **Alias ids are never registered as pi models**, so a version-free alias cannot collide with a
  vendor id in `/model`/`--list-models`; only `fusion*` ids are registered by this extension. The
  drill-down also lets a model id exist in `matrix.json` that pi's own catalogue never lists.
- **Same alias across providers means the same slot, not necessarily the same vendor id.** Where two
  providers name one model differently, use the object form:
  `{"id": "tp", "modelOverride": "qwen3.8-max-preview"}`.
- **Thresholds live in `sufficientWhen`, in one place.** A decision is actionable when its answer
  matches and its confidence clears the bar; nothing else in the config carries a probability
  threshold. A cascade is only worth its extra call when the cheap path usually decides, which is why
  every run records `details.cascades` — tune thresholds and delete useless cascades from that data
  rather than from intuition.