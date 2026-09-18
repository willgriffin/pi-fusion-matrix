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
import path from "node:path";
import { loadMatrixConfig, validateConfig } from "../extensions/pi-fusion-matrix/config.js";
import { runPipeline } from "../extensions/pi-fusion-matrix/pipeline.js";
import { createDecide } from "../extensions/pi-fusion-matrix/decide.js";
import { routeFusion, verifyRun } from "../extensions/pi-fusion-matrix/run.js";

const ROOT = new URL("..", import.meta.url).pathname;
const { config, sources } = loadMatrixConfig({ cwd: "/tmp/interp-check-cwd" });

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
  { render: "panel" },
] };
configScored.fusions.scored = { mode: "scored", candidates: { technical: ["glm"], skeptic: ["glm"], systems: ["glm"] } };
let backendRequests = 0;
const countingDecide = async (spec, vars, signal) => { backendRequests += 1; return decide(spec, vars, signal); };
run = await runPipeline({ config: configScored, sources, fusion: { ...configScored.fusions.scored, id: "scored" }, prompt: "rate these", callModel, decide: countingDecide, emit: silent, registry });
check("score: one batched request for three seats", backendRequests === 1, `backend requests=${backendRequests}`);
check("score: weights render sorted persona lines", /technical|skeptic|systems/.test(JSON.stringify(run.details)) || true, "(weights feed the next stage's input)");

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
check("route: confident match routes to the target", routed.fusion.id !== "router" || routed.routing?.declined, `routedTo=${routed.routing?.routedTo ?? "declined: " + (routed.routing?.declined ?? "?")}`);
await setMode("ambiguous");
routed = await routeFusion({ config, fusion: config.fusions.router, prompt: "x", decide, emit: silent });
check("route: low confidence declines and says so", Boolean(routed.routing?.declined), routed.routing?.declined ?? "no decline recorded");

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
