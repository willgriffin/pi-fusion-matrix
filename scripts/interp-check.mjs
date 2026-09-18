#!/usr/bin/env node
/**
 * interp-check.mjs — the stage interpreter's contracts, checked offline.
 *
 * Cascades (seat and stage), route decline, debate rounds and peer envelopes, the batched score
 * fan-out, and report-only verify. `callModel` is canned and the decision backend is the local stub, so
 * this needs no keys, no network, and no quota — which is why it exists: the live checks can be blocked
 * by a provider's weekly limit, and these contracts must still be verifiable.
 *
 *   node scripts/semif-stub.mjs &          # not needed
 *   node scripts/typesafe-stub.mjs &       # required (decisions)
 *   node scripts/interp-check.mjs
 *
 * It caught a real gap on first run: stage-level `sufficientWhen` was unimplemented, so a converged
 * panel still paid for the judge.
 */
import { loadMatrixConfig } from "../extensions/pi-fusion-matrix/config.js";
import { runPipeline } from "../extensions/pi-fusion-matrix/pipeline.js";
import { createDecide } from "../extensions/pi-fusion-matrix/decide.js";
import { routeFusion, verifyRun } from "../extensions/pi-fusion-matrix/run.js";

// The packaged layer only: a developer's machine-wide layer and a project layer would otherwise decide
// what "N/N" means, and this check has to be the same number on every machine.
const { config, sources } = loadMatrixConfig({ cwd: process.cwd(), layers: ["packaged"] });

// a project layer that points every decision at the stub and every seat at a canned response
config.decide.defaultBackend = "stub";
config.backends.stub = { kind: "typesafe", url: "http://127.0.0.1:8793/v1/systemone", apiKeyEnv: undefined, model: "jev-stub", timeoutMs: 5000 };

const calls = [];
const callModel = async ({ persona, model, messages }) => {
  calls.push({ persona: persona?.name, model: model?.id, prompt: String(messages.at(-1)?.content ?? "").slice(0, 60) });
  return { text: `canned response from ${persona?.name ?? "unknown"}`, usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", toolCalls: [] };
};
const decide = createDecide({ config });
const fakeModel = (provider, id) => ({ id, name: id, api: "openai-completions", provider, baseUrl: "http://127.0.0.1:1/v1",
  reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1000, maxTokens: 100 });
const registry = {
  find: (provider, id) => fakeModel(provider, id),
  getAll: () => [fakeModel("opencode-go", "glm-5.3"), fakeModel("zai", "glm-5.3"), fakeModel("openai", "gpt-5.6-luna")],
  getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "fake", headers: {} }),
  getProviderAuthStatus: () => ({ authenticated: true }),
};
const silent = { delta: () => {}, substitution: () => {} };
const setMode = (mode) => fetch("http://127.0.0.1:8793/__mode", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ mode }) });

const results = [];
const check = (name, ok, detail = "") => { results.push({ name, ok, detail }); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`); };

// 1. cascade: decisive → decision path, no judge call
await setMode("decisive");
calls.length = 0;
let run = await runPipeline({ config, sources, fusion: { ...config.fusions["review-check"], id: "review-check" }, prompt: "decide something", callModel, decide, emit: silent, registry });
const judgeCallsDecisive = calls.filter((c) => c.persona === "judge").length;
check("cascade: decisive answer skips the judge", judgeCallsDecisive === 0, `judge calls=${judgeCallsDecisive}, cascades=${JSON.stringify(run.details.cascades.map((c) => c.sufficient))}`);

// 2. cascade: ambiguous → judge called, prior recorded
await setMode("ambiguous");
calls.length = 0;
run = await runPipeline({ config, sources, fusion: { ...config.fusions["review-check"], id: "review-check" }, prompt: "decide something", callModel, decide, emit: silent, registry });
const judgeCallsAmbiguous = calls.filter((c) => c.persona === "judge").length;
const prior = run.details.cascades.find((c) => c.prior)?.prior ?? "";
check("cascade: ambiguous answer escalates with a prior", judgeCallsAmbiguous === 1 && prior.includes("choice="), `judge calls=${judgeCallsAmbiguous}, prior="${prior.slice(0, 60)}"`);

// 3. debate: rounds × seats calls, and peers excludes the seat itself
calls.length = 0;
run = await runPipeline({ config, sources, fusion: { ...config.fusions.debate, id: "debate" }, prompt: "debate this", callModel, decide, emit: silent, registry });
const debateCalls = calls.length;
const roundCount = run.details.rounds?.length ?? 0;
check("debate: 3 seats × 3 rounds", debateCalls === 9 && roundCount === 3, `calls=${debateCalls}, rounds=${roundCount}`);

// 4. score fan-out: one backend request for three seats, weights rendered
const configScored = JSON.parse(JSON.stringify(config));
configScored.modes.scored = { stages: [
  { parallel: ["technical", "skeptic", "systems"], input: "prompt" },
  { score: { instructions: "How well does each response address the question?", criteria: ["off-topic", "partial", "solid", "thorough"] }, over: "panel" },
  // The stage that consumes the weights, which is where they become observable (plan §Verification 18).
  { render: "panel", input: "panel+weights" },
] };
configScored.fusions.scored = { mode: "scored", candidates: { technical: ["glm"], skeptic: ["glm"], systems: ["glm"] } };
// The request itself is the contract: one POST carrying one question per seat, each of them a `score`
// question over the mode's levels. A fan-out typed as `choice` answers with an option id instead of a
// level, which is how every weight once rendered as 0.00 with a phantom line beside it.
const scoreRequests = [];
const scoredDecide = createDecide({
  config: configScored,
  fetchImpl: async (url, init) => { scoreRequests.push(JSON.parse(init.body)); return fetch(url, init); },
});
// decisive: the stub's score then sits at the top level with a real confidence, so the rendered lines
// are non-degenerate whatever mode an earlier block left behind.
await setMode("decisive");
run = await runPipeline({ config: configScored, sources, fusion: { ...configScored.fusions.scored, id: "scored" }, prompt: "rate these", callModel, decide: scoredDecide, emit: silent, registry });
const scoredSeats = ["technical", "skeptic", "systems"];
const scoreQuestions = Object.entries(scoreRequests[0]?.questions ?? {});
check("score: one batched request for three seats",
  scoreRequests.length === 1
    && scoreQuestions.length === scoredSeats.length
    && scoredSeats.every((seat) => scoreQuestions.some(([id, q]) => id === seat && q.type === "score"))
    && scoreQuestions.every(([, q]) => q.type === "score" && q.criteria?.length >= 2),
  `requests=${scoreRequests.length}, questions=${JSON.stringify(scoreQuestions.map(([id, q]) => [id, q.type, q.criteria?.length]))}`);
// The weights are read where the pipeline publishes them — as the rendered block the next stage's
// input starts with — one `persona: score (confidence)` line per panel seat, best first.
const weightsBlock = String(run.text ?? "").split("\n\n")[0];
const weightLines = weightsBlock.split("\n").filter(Boolean);
const weighed = weightLines.map((line) => {
  const match = line.match(/^([a-z-]+): (\d+\.\d\d) \(confidence (\d+\.\d\d)\)$/);
  return match ? { persona: match[1], score: Number(match[2]) } : null;
});
check("score: weights render sorted persona lines",
  weightLines.length === scoredSeats.length
    && weighed.every((w) => w !== null)
    && scoredSeats.every((seat) => weighed.some((w) => w.persona === seat))
    && weighed.every((w, i) => i === 0 || weighed[i - 1].score >= w.score),
  `weights=${JSON.stringify(weightsBlock)}`);

// 5. verify: a low noul warns, a gate reports its exit, neither blocks
await setMode("ambiguous");
const warnings = [];
run = await runPipeline({ config, sources, fusion: { ...config.fusions["review-check"], id: "review-check" }, prompt: "x", callModel, decide, emit: silent, registry });
const verification = await verifyRun({ config, fusion: config.fusions["review-check"], vars: { prompt: "x", synthesis: "an answer" }, decide, emit: { delta: (t) => warnings.push(t.trim()) }, runGate: async () => ({ exit: 1, output: "boom" }) });
check("verify: low confidence warns without blocking", warnings.some((w) => w.includes("verify:")), warnings[0]?.slice(0, 70) ?? "no warning");
check("verify: decision entries recorded", verification.length >= 1, `entries=${verification.length}`);

// 6. route: a sufficient match routes; a low-confidence one declines
config.fusions.target = { mode: "single", candidates: { technical: ["glm"] } };
config.fusions.router = { ...config.fusions["review-routed"], id: "router", route: { ...config.fusions["review-routed"].route, sufficientWhen: { minConfidence: 0.8 } } };
await setMode("decisive");
let routed = await routeFusion({ config, fusion: config.fusions.router, prompt: "x", decide, emit: silent });
// The stub's decisive answer takes the route's first criterion, and only that criterion carries an
// action (`then: "quick"`) — so the run must be redirected, not merely "not declined".
check("route: confident match routes to the target",
  routed.routing?.routedTo === "quick" && routed.fusion.id === "quick",
  `routedTo=${routed.routing?.routedTo ?? "none"}, fusion=${routed.fusion.id}`);
await setMode("ambiguous");
routed = await routeFusion({ config, fusion: config.fusions.router, prompt: "x", decide, emit: silent });
check("route: low confidence declines and says so", Boolean(routed.routing?.declined), routed.routing?.declined ?? "no decline recorded");

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
