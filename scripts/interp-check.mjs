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
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadMatrixConfig, mergeConfig, validateConfig } from "../extensions/pi-fusion-matrix/config.js";
import { runPipeline } from "../extensions/pi-fusion-matrix/pipeline.js";
import { createDecide } from "../extensions/pi-fusion-matrix/decide.js";
import { routeFusion, verifyRun, createFusionStream } from "../extensions/pi-fusion-matrix/run.js";

// The packaged layer only: a developer's machine-wide layer and a project layer would otherwise decide
// what "N/N" means, and this check has to be the same number on every machine.
const { config, sources } = loadMatrixConfig({ cwd: process.cwd(), layers: ["packaged"] });

// a project layer that points every decision at the stub and every seat at a canned response
config.decide.defaultBackend = "stub";
config.backends.stub = {
  kind: "typesafe",
  url: "http://127.0.0.1:8793/v1/systemone",
  apiKeyEnv: undefined,
  model: "jev-stub",
  timeoutMs: 5000,
};

const calls = [];
const callModel = async ({ persona, model, messages }) => {
  calls.push({ persona: persona?.name, model: model?.id, prompt: String(messages.at(-1)?.content ?? "").slice(0, 60) });
  return {
    text: `canned response from ${persona?.name ?? "unknown"}`,
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    toolCalls: [],
  };
};
const decide = createDecide({ config });
const fakeModel = (provider, id) => ({
  id,
  name: id,
  api: "openai-completions",
  provider,
  baseUrl: "http://127.0.0.1:1/v1",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 1000,
  maxTokens: 100,
});
const registry = {
  find: (provider, id) => fakeModel(provider, id),
  getAll: () => [fakeModel("opencode-go", "glm-5.3"), fakeModel("zai", "glm-5.3"), fakeModel("openai", "gpt-5.6-luna")],
  getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "fake", headers: {} }),
  getProviderAuthStatus: () => ({ authenticated: true }),
};
const silent = { delta: () => {}, substitution: () => {} };
const setMode = (mode) =>
  fetch("http://127.0.0.1:8793/__mode", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ mode }),
  });

const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
};

// 1. cascade: decisive → decision path, no judge call
await setMode("decisive");
calls.length = 0;
let run = await runPipeline({
  config,
  sources,
  fusion: { ...config.fusions["review-check"], id: "review-check" },
  prompt: "decide something",
  callModel,
  decide,
  emit: silent,
  registry,
});
const judgeCallsDecisive = calls.filter((c) => c.persona === "judge").length;
check(
  "cascade: decisive answer skips the judge",
  judgeCallsDecisive === 0,
  `judge calls=${judgeCallsDecisive}, cascades=${JSON.stringify(run.details.cascades.map((c) => c.sufficient))}`,
);

// 2. cascade: ambiguous → judge called, prior recorded
await setMode("ambiguous");
calls.length = 0;
run = await runPipeline({
  config,
  sources,
  fusion: { ...config.fusions["review-check"], id: "review-check" },
  prompt: "decide something",
  callModel,
  decide,
  emit: silent,
  registry,
});
const judgeCallsAmbiguous = calls.filter((c) => c.persona === "judge").length;
const prior = run.details.cascades.find((c) => c.prior)?.prior ?? "";
check(
  "cascade: ambiguous answer escalates with a prior",
  judgeCallsAmbiguous === 1 && prior.includes("choice="),
  `judge calls=${judgeCallsAmbiguous}, prior="${prior.slice(0, 60)}"`,
);

// 3. debate: rounds × seats calls, and peers excludes the seat itself
calls.length = 0;
run = await runPipeline({
  config,
  sources,
  fusion: { ...config.fusions.debate, id: "debate" },
  prompt: "debate this",
  callModel,
  decide,
  emit: silent,
  registry,
});
const debateCalls = calls.length;
const roundCount = run.details.rounds?.length ?? 0;
check("debate: 3 seats × 3 rounds", debateCalls === 9 && roundCount === 3, `calls=${debateCalls}, rounds=${roundCount}`);

// 4. score fan-out: one backend request for three seats, weights rendered
const configScored = JSON.parse(JSON.stringify(config));
configScored.modes.scored = {
  stages: [
    { parallel: ["technical", "skeptic", "systems"], input: "prompt" },
    {
      score: { instructions: "How well does each response address the question?", criteria: ["off-topic", "partial", "solid", "thorough"] },
      over: "panel",
    },
    // The stage that consumes the weights, which is where they become observable (plan §Verification 18).
    { render: "panel", input: "panel+weights" },
  ],
};
configScored.fusions.scored = { mode: "scored", candidates: { technical: ["glm"], skeptic: ["glm"], systems: ["glm"] } };
// The request itself is the contract: one POST carrying one question per seat, each of them a `score`
// question over the mode's levels. A fan-out typed as `choice` answers with an option id instead of a
// level, which is how every weight once rendered as 0.00 with a phantom line beside it.
const scoreRequests = [];
const scoredDecide = createDecide({
  config: configScored,
  fetchImpl: async (url, init) => {
    scoreRequests.push(JSON.parse(init.body));
    return fetch(url, init);
  },
});
// decisive: the stub's score then sits at the top level with a real confidence, so the rendered lines
// are non-degenerate whatever mode an earlier block left behind.
await setMode("decisive");
run = await runPipeline({
  config: configScored,
  sources,
  fusion: { ...configScored.fusions.scored, id: "scored" },
  prompt: "rate these",
  callModel,
  decide: scoredDecide,
  emit: silent,
  registry,
});
const scoredSeats = ["technical", "skeptic", "systems"];
const scoreQuestions = Object.entries(scoreRequests[0]?.questions ?? {});
check(
  "score: one batched request for three seats",
  scoreRequests.length === 1 &&
    scoreQuestions.length === scoredSeats.length &&
    scoredSeats.every((seat) => scoreQuestions.some(([id, q]) => id === seat && q.type === "score")) &&
    scoreQuestions.every(([, q]) => q.type === "score" && q.criteria?.length >= 2),
  `requests=${scoreRequests.length}, questions=${JSON.stringify(scoreQuestions.map(([id, q]) => [id, q.type, q.criteria?.length]))}`,
);
// The weights are read where the pipeline publishes them — as the rendered block the next stage's
// input starts with — one `persona: score (confidence)` line per panel seat, best first.
const weightsBlock = String(run.text ?? "").split("\n\n")[0];
const weightLines = weightsBlock.split("\n").filter(Boolean);
const weighed = weightLines.map((line) => {
  const match = line.match(/^([a-z-]+): (\d+\.\d\d) \(confidence (\d+\.\d\d)\)$/);
  return match ? { persona: match[1], score: Number(match[2]) } : null;
});
check(
  "score: weights render sorted persona lines",
  weightLines.length === scoredSeats.length &&
    weighed.every((w) => w !== null) &&
    scoredSeats.every((seat) => weighed.some((w) => w.persona === seat)) &&
    weighed.every((w, i) => i === 0 || weighed[i - 1].score >= w.score),
  `weights=${JSON.stringify(weightsBlock)}`,
);

// 5. verify: a low noul warns, a gate reports its exit, neither blocks
await setMode("ambiguous");
const warnings = [];
run = await runPipeline({
  config,
  sources,
  fusion: { ...config.fusions["review-check"], id: "review-check" },
  prompt: "x",
  callModel,
  decide,
  emit: silent,
  registry,
});
const verification = await verifyRun({
  config,
  fusion: config.fusions["review-check"],
  vars: { prompt: "x", synthesis: "an answer" },
  decide,
  emit: { delta: (t) => warnings.push(t.trim()) },
  runGate: async () => ({ exit: 1, output: "boom" }),
});
check(
  "verify: low confidence warns without blocking",
  warnings.some((w) => w.includes("verify:")),
  warnings[0]?.slice(0, 70) ?? "no warning",
);
check("verify: decision entries recorded", verification.length >= 1, `entries=${verification.length}`);

// 6. route: a sufficient match routes; a low-confidence one declines
config.fusions.target = { mode: "single", candidates: { technical: ["glm"] } };
config.fusions.router = {
  ...config.fusions["default-smrt"],
  id: "router",
  route: { ...config.fusions["default-smrt"].route, sufficientWhen: { minConfidence: 0.8 } },
};
await setMode("decisive");
let routed = await routeFusion({ config, fusion: config.fusions.router, prompt: "x", decide, emit: silent });
// The stub's decisive answer takes the route's first criterion, and that criterion carries an action
// (`then: "cheap"`) — so the run must be redirected to that rung, not merely "not declined".
check(
  "route: confident match routes to the target",
  routed.routing?.routedTo === "cheap" && routed.fusion.id === "cheap",
  `routedTo=${routed.routing?.routedTo ?? "none"}, fusion=${routed.fusion.id}`,
);
await setMode("ambiguous");
routed = await routeFusion({ config, fusion: config.fusions.router, prompt: "x", decide, emit: silent });
check("route: low confidence declines and says so", Boolean(routed.routing?.declined), routed.routing?.declined ?? "no decline recorded");

/* --------------------------------------------------------------------- proxy */

// The peer the proxy branch streams through: pi's own `streamSimple` shape — an async-iterable of
// events plus `result()` — recording its arguments, so the check asserts the forwarding rather than
// trusting it. `model.id` is what the target reports back, and the fusion's own id is what must reach
// the harness, because that is the identity pi matches on for overflow and truncation recovery.
const makeProxyPeer = (seen, { text = "read it back", tool = null, streamModel = null } = {}) => ({
  streamSimple: (model, context, options) => {
    seen.push({ model, context, options });
    const reported = streamModel ? { ...model, ...streamModel } : model;
    const usage = {
      input: 5,
      output: 5,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 10,
      reasoning: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    };
    const blocks = [
      { type: "text", text },
      ...(tool ? [{ type: "toolCall", id: tool.id, name: tool.name, arguments: tool.arguments }] : []),
    ];
    const partial = () => ({
      role: "assistant",
      api: reported.api,
      provider: reported.provider,
      model: reported.id,
      content: blocks,
      usage,
      stopReason: tool ? "toolUse" : "stop",
      timestamp: Date.now(),
    });
    const final = partial();
    const events = [
      { type: "start", partial: { ...partial(), content: [] } },
      { type: "text_start", contentIndex: 0, partial: partial() },
      { type: "text_delta", contentIndex: 0, delta: text, partial: partial() },
      { type: "text_end", contentIndex: 0, content: text, partial: partial() },
      ...(tool
        ? [
            { type: "toolcall_start", contentIndex: 1, partial: partial() },
            { type: "toolcall_end", contentIndex: 1, toolCall: blocks[1], partial: partial() },
          ]
        : []),
      { type: "done", reason: final.stopReason, message: final },
    ];
    return {
      async *[Symbol.asyncIterator]() {
        yield* events;
      },
      result: async () => final,
    };
  },
});

// A target whose `result()` rejects: once events have reached the harness the turn is committed, so the
// turn ends with the message the caller holds and the failure is recorded — never a second terminal event,
// which pi would append as another assistant message.
const makeRejectingPeer = (seen, { terminal = true } = {}) => ({
  streamSimple: (model, context, options) => {
    seen.push({ model, context, options });
    const usage = {
      input: 5,
      output: 5,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 10,
      reasoning: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    };
    const partial = () => ({
      role: "assistant",
      api: model.api,
      provider: model.provider,
      model: model.id,
      content: [{ type: "text", text: "half an answer" }],
      usage,
      stopReason: "stop",
      timestamp: Date.now(),
    });
    const final = partial();
    const events = [
      { type: "start", partial: { ...partial(), content: [] } },
      { type: "text_delta", contentIndex: 0, delta: "half an answer", partial: partial() },
      ...(terminal ? [{ type: "done", reason: "stop", message: final }] : []),
    ];
    return {
      async *[Symbol.asyncIterator]() {
        yield* events;
      },
      result: async () => {
        throw new Error("result() rejected after the stream ended");
      },
    };
  },
});

const registryWith = (over) => ({ ...registry, ...over });
const fusionStream = (peer, sessionRegistry = registry) =>
  createFusionStream({
    config,
    sources,
    getRegistry: () => sessionRegistry,
    decide,
    callModel,
    getPi: async () => ({ streamSimple: peer.streamSimple, from: "stub", harness: "stub" }),
    getWriteParameters: async () => ({}),
  });
const fusionModel = (id) => ({ ...fakeModel("fusion-matrix", id), api: "fusion-matrix" });
const driveStream = async (stream) => {
  const events = [];
  for await (const event of stream) events.push(event);
  return { events, final: await stream.result() };
};
const textOfEvents = (events) =>
  events
    .filter((e) => e.type === "text_delta")
    .map((e) => e.delta)
    .join("");
// The harness's own turn: a coding prompt, a tool set, and a level it already resolved.
const harnessContext = {
  systemPrompt: "You are the harness's coding agent. Read files before editing them.",
  messages: [{ role: "user", content: "what does package.json call this project?" }],
  tools: [{ name: "read", description: "Read a file", parameters: { type: "object", properties: { path: { type: "string" } } } }],
};
const harnessOptions = {
  sessionId: "session-1",
  reasoning: "high",
  temperature: 0.3,
  metadata: { user_id: "u1" },
  thinkingBudgets: { high: 4096 },
};

/* ------------------------------------------------------------------ the review route */

// The classes, as the decision backend would answer them. The seam is already injectable, so these contracts
// do not depend on the stub's modes: one canned answer per class, asserted against the rung that must run.
const decideAs =
  (choice, confidence = 0.95) =>
  async () => ({
    backend: "canned",
    model: "canned",
    answers: { choice: { choice, confidence } },
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  });
// the loader keys fusions by id; the object itself carries none, so the router is built the way a run sees it
const smrt = { ...config.fusions["smrt-review"], id: "smrt-review" };
const routeOf = async (choice, confidence) =>
  routeFusion({ config, fusion: smrt, prompt: "a packet", decide: decideAs(choice, confidence), emit: silent });

const mechanical = await routeOf("mechanical");
check(
  "review route: a mechanical change goes to the cheap single-seat review",
  mechanical.routing?.routedTo === "review-quick" &&
    mechanical.fusion.id === "review-quick" &&
    mechanical.routing.answer?.choice === "mechanical",
  JSON.stringify(mechanical.routing),
);
const standard = await routeOf("standard");
check(
  "review route: an ordinary change goes to the committee",
  standard.routing?.routedTo === "review-check" && standard.fusion.id === "review-check",
  JSON.stringify(standard.routing),
);
// `high` declares no target on purpose: running this fusion *is* the deep review, so the record says escalated,
// not declined — a deliberate escalation that reads as a decline is a lie in the audit trail.
const high = await routeOf("high");
check(
  "review route: the boundary class escalates to the router's own deep review",
  high.fusion.id === "smrt-review" && high.routing?.escalated === "high" && high.routing.declined === undefined,
  JSON.stringify(high.routing),
);
const unsure = await routeOf("mechanical", 0.2);
check(
  "review route: an unsure answer escalates rather than routing cheap",
  unsure.fusion.id === "smrt-review" && String(unsure.routing?.declined).includes("confidence"),
  JSON.stringify(unsure.routing),
);

// The gate that makes a reviewer pinnable: `execute: false` means a *tool-bearing* turn runs the pipeline
// instead of proxying. Without it a task agent pinned to this rung would get its writer and no panel.
calls.length = 0;
const reviewTurn = await driveStream(fusionStream(makeProxyPeer([]))(fusionModel("review-check"), harnessContext, harnessOptions));
check(
  "an execute: false rung deliberates on a tool-bearing turn instead of proxying",
  reviewTurn.final.details?.proxied === undefined &&
    calls.length > 0 &&
    reviewTurn.events.some((event) => typeof event.partial?.content?.[0]?.text === "string" || typeof event.delta === "string"),
  `seat calls=${calls.length}, proxied=${Boolean(reviewTurn.final.details?.proxied)}`,
);

// The disposition is data: severities counted, verdict as stated, findings recorded — and a malformed one is
// recorded as malformed rather than wrapped into something that reads like a clean review.
const dispositionModel = (payload) => async (args) => ({
  text: typeof payload === "string" ? payload : JSON.stringify(payload),
  usage: {
    input: 1,
    output: 1,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 2,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  },
  stopReason: "stop",
  toolCalls: [],
});
const runReview = (model) =>
  runPipeline({
    config,
    sources,
    fusion: { ...config.fusions["review-quick"], id: "review-quick" },
    prompt: "a packet",
    callModel: model,
    decide,
    emit: silent,
    registry,
  });

const goodFinding = {
  severity: "blocking",
  path: "extensions/pi-fusion-matrix/run.js",
  line: 42,
  criterion: "no silent degradation",
  claim: "a refusal is swallowed",
};
const reviewRun = await runReview(
  dispositionModel({
    verdict: "findings",
    summary: "one boundary is unhandled",
    findings: [goodFinding, { ...goodFinding, severity: "editorial", path: "README.md", line: null }],
  }),
);
const recorded = reviewRun.details;
check(
  "a review run records its findings, their severities and the verdict",
  recorded.verdict === "findings" &&
    recorded.findings?.length === 2 &&
    recorded.dispositionBy === "review-synth" &&
    recorded.severityCounts?.blocking === 1 &&
    recorded.severityCounts?.editorial === 1 &&
    recorded.findings[0].path === "extensions/pi-fusion-matrix/run.js" &&
    recorded.findings[0].line === 42,
  JSON.stringify({ verdict: recorded.verdict, by: recorded.dispositionBy, counts: recorded.severityCounts }),
);
check(
  "a null line is recorded as null, not dropped",
  recorded.findings?.[1]?.line === null && "line" in (recorded.findings?.[1] ?? {}),
  JSON.stringify(recorded.findings?.[1]),
);

// A parseable answer is not necessarily a disposition: each of these would otherwise record as a clean review.
const flawedDispositions = [
  ["a clean verdict with no findings array", { verdict: "clean" }],
  ["a verdict nobody defined", { verdict: "banana", findings: [] }],
  ["findings that are not a list", { verdict: "findings", findings: "oops" }],
  ["a finding with an invented severity", { verdict: "findings", findings: [{ ...goodFinding, severity: "invented" }] }],
  ["a finding with no claim", { verdict: "findings", findings: [{ ...goodFinding, claim: "" }] }],
  ["clean with findings", { verdict: "clean", findings: [goodFinding] }],
  ["findings with none", { verdict: "findings", findings: [] }],
];
const flawResults = [];
for (const [name, payload] of flawedDispositions) {
  // A flawed answer must be *recorded*, so an answer that throws the run is a failure of the contract, not a
  // failing check: catching it here keeps the reason visible instead of ending the suite at the first throw.
  let run;
  try {
    run = await runReview(dispositionModel(payload));
  } catch (error) {
    flawResults.push([name, false, `the run threw: ${error.message}`]);
    continue;
  }
  flawResults.push([
    name,
    Boolean(run.details.malformedAnswers?.length) && run.details.findings === undefined && run.details.verdict === undefined,
    run.details.malformedAnswers?.[0]?.reason,
  ]);
}
check(
  "a disposition that violates the schema is recorded as malformed, never as a clean review",
  flawResults.every(([, ok]) => ok),
  flawResults
    .filter(([, ok]) => !ok)
    .map(([name]) => name)
    .join(", ") ||
    flawResults
      .map(([, , reason]) => reason)
      .slice(0, 3)
      .join(" | "),
);

const malformedRun = await runReview(dispositionModel("I could not read the diff, sorry."));
check(
  "an answer that is not a JSON object is recorded as malformed, not as a clean review",
  malformedRun.details.malformedAnswers?.[0]?.persona === "review-synth" &&
    malformedRun.details.findings === undefined &&
    malformedRun.details.verdict === undefined,
  JSON.stringify(malformedRun.details.malformedAnswers),
);

// Three JSON seats, three answers, one record. `review-committee` ends in `judge` then `review-synth`, so a
// per-persona model can put a different kind of answer in each seat and the run-level record has to stay
// unambiguous: a valid disposition from an earlier seat, a *different* persona's JSON that claims nothing, and
// a malformed answer that arrives last.
const perPersonaModel = (answers) => async (args) => {
  const payload = answers[args?.persona?.name] ?? { verdict: "clean", findings: [] };
  return {
    text: typeof payload === "string" ? payload : JSON.stringify(payload),
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    toolCalls: [],
  };
};
const runReviewCheck = (answers) =>
  runPipeline({
    config,
    sources,
    fusion: { ...config.fusions["review-check"], id: "review-check" },
    prompt: "a packet",
    callModel: perPersonaModel(answers),
    decide,
    emit: silent,
    registry,
  });

// The case that made the schema global: a classifier's answer, or any JSON persona answering a different
// contract, is recovered as data and recorded against nothing.
const foreignJson = await runReviewCheck({
  judge: { label: "mechanical", confidence: 0.95 },
  "review-synth": { verdict: "clean", findings: [] },
});
check(
  "a JSON answer that does not claim to be a disposition is not judged by its schema",
  foreignJson.details.malformedAnswers === undefined &&
    foreignJson.details.verdict === "clean" &&
    foreignJson.details.dispositionBy === "review-synth",
  JSON.stringify({ malformed: foreignJson.details.malformedAnswers, verdict: foreignJson.details.verdict }),
);

// A malformed answer that arrives *after* a valid one wins outright; that ordering is the one that must never
// read as clean.
const shadowed = await runReviewCheck({ judge: { verdict: "clean", findings: [] }, "review-synth": "not a disposition at all" });
check(
  "a malformed final disposition leaves no earlier verdict standing",
  shadowed.details.malformedAnswers?.[0]?.persona === "review-synth" &&
    shadowed.details.malformedAnswers?.[0]?.supersededBy === undefined &&
    shadowed.details.verdict === undefined &&
    shadowed.details.findings === undefined,
  JSON.stringify({ malformed: shadowed.details.malformedAnswers, verdict: shadowed.details.verdict }),
);

// The other order: a malformed answer, then one that answers. The failure is not deleted by being superseded —
// it is named as superseded, so no reader can call the pairing ambiguous.
const superseded = await runReviewCheck({ judge: "not a disposition at all", "review-synth": { verdict: "clean", findings: [] } });
check(
  "a valid disposition after a malformed answer names the answer it superseded",
  superseded.details.verdict === "clean" &&
    superseded.details.dispositionBy === "review-synth" &&
    superseded.details.malformedAnswers?.[0]?.persona === "judge" &&
    superseded.details.malformedAnswers?.[0]?.supersededBy === "review-synth",
  JSON.stringify({ verdict: superseded.details.verdict, malformed: superseded.details.malformedAnswers }),
);

// Bad answer, then another bad answer: the record is a chain, so the first one does not disappear when the
// second lands — it is named as superseded by it, and the standing failure is the last entry.
const chainedMalformed = await runReviewCheck({ judge: "not a disposition at all", "review-synth": { verdict: "banana", findings: [] } });
check(
  "a second bad answer does not erase the first",
  chainedMalformed.details.malformedAnswers?.length === 2 &&
    chainedMalformed.details.malformedAnswers[0].persona === "judge" &&
    chainedMalformed.details.malformedAnswers[0].supersededBy === "review-synth" &&
    chainedMalformed.details.malformedAnswers[1].persona === "review-synth" &&
    chainedMalformed.details.malformedAnswers[1].supersededBy === undefined &&
    chainedMalformed.details.malformedAnswers[1].reason === "verdict is not one of clean|findings",
  JSON.stringify(chainedMalformed.details.malformedAnswers),
);

// 7. proxy: the harness's context goes to the writing seat's alias verbatim, and its events come back
const seen = [];
calls.length = 0;
const proxied = await driveStream(
  fusionStream(
    makeProxyPeer(seen, { text: "pi-fusion-matrix.", tool: { id: "call_1", name: "read", arguments: { path: "package.json" } } }),
  )(fusionModel("quick"), harnessContext, harnessOptions),
);
const forwarded = seen[0];
check(
  "proxy: messages, tools, and systemPrompt forwarded verbatim",
  seen.length === 1 && JSON.stringify(forwarded.context) === JSON.stringify(harnessContext),
  `calls=${seen.length}, context=${JSON.stringify(forwarded.context).slice(0, 80)}`,
);
// The writer defines the executor: `quick`'s writing seat is `technical` on `deepseek-flash`, and its
// declared level is `low` — not the harness's `high`.
check(
  "proxy: the writing alias answers at the fusion's declared level",
  forwarded.model.id === "deepseek-v4.1-flash" &&
    forwarded.options.reasoning === "low" &&
    forwarded.options.sessionId === "session-1" &&
    forwarded.options.temperature === 0.3,
  `model=${forwarded.model.id} @${forwarded.options.reasoning} session=${forwarded.options.sessionId}`,
);
check(
  "proxy: the target's tool call reaches the caller",
  proxied.events.some((e) => e.type === "toolcall_end" && e.toolCall?.name === "read") &&
    proxied.final.content.some((b) => b.type === "toolCall" && b.arguments?.path === "package.json"),
  `events=${proxied.events.map((e) => e.type).join(",")}`,
);
// No decoration: the message is the model's own output, and no seat ran.
check(
  "proxy: the message is the model's output and nothing else",
  textOfEvents(proxied.events) === "pi-fusion-matrix." && calls.length === 0 && !/[├└│]/.test(textOfEvents(proxied.events)),
  `text=${JSON.stringify(textOfEvents(proxied.events).slice(0, 60))}, seat calls=${calls.length}`,
);
check(
  "proxy: reported as the fusion's model, with the executor in details",
  proxied.final.provider === "fusion-matrix" &&
    proxied.final.model === "quick" &&
    proxied.final.stopReason === "toolUse" &&
    proxied.final.details?.proxied?.alias === "deepseek-flash" &&
    proxied.final.details?.proxied?.provider === "opencode-go" &&
    proxied.final.details?.proxied?.model === "deepseek-v4.1-flash" &&
    Array.isArray(proxied.final.details?.proxied?.attempts),
  JSON.stringify(proxied.final.details?.proxied),
);
// The harness takes the turn from the terminal event's message, so the record has to be there and not
// only on `result()` — that is the difference between a readable transcript and an empty one.
check(
  "proxy: the terminal event carries the run record",
  proxied.events.find((e) => e.type === "done")?.message?.details?.proxied?.alias === "deepseek-flash" &&
    proxied.events.find((e) => e.type === "done")?.message?.provider === "fusion-matrix",
  JSON.stringify(proxied.events.find((e) => e.type === "done")?.message?.details?.proxied),
);

// 8. thinking precedence: `"harness"` runs at the level the harness sent, and an absent declaration
// falls to the writing seat's persona level (`technical` declares `medium` in the packaged config).
config.fusions["proxy-harness"] = { mode: "single", thinking: { technical: "harness" }, candidates: { technical: ["glm"] } };
config.fusions["proxy-bare"] = { mode: "single", candidates: { technical: ["glm"] } };
const harnessSeen = [];
await driveStream(fusionStream(makeProxyPeer(harnessSeen))(fusionModel("proxy-harness"), harnessContext, harnessOptions));
const bareSeen = [];
await driveStream(fusionStream(makeProxyPeer(bareSeen))(fusionModel("proxy-bare"), harnessContext, harnessOptions));
check(
  "thinking: `harness` forwards the level the harness sent",
  harnessSeen[0].options.reasoning === "high",
  `level=${harnessSeen[0].options.reasoning}`,
);
check(
  "thinking: nothing declared falls to the writing seat's persona level",
  bareSeen[0].options.reasoning === "medium",
  `level=${bareSeen[0].options.reasoning}`,
);

// 9. branch selection: a rung with no writing seat still deliberates when tools are present, and the
// `matrix` tool path (`runOnce`) never proxies because it calls the pipeline directly.
calls.length = 0;
const deliberate = await driveStream(fusionStream(makeProxyPeer([]))(fusionModel("opinions"), harnessContext, harnessOptions));
check(
  "branch: a fusion with no writing seat still deliberates with tools present",
  calls.length === 3 &&
    deliberate.events.every((e) => e.type !== "toolcall_end") &&
    /├─/.test(textOfEvents(deliberate.events)) &&
    deliberate.final.details?.proxied === undefined,
  `seat calls=${calls.length}, decorated=${/├─/.test(textOfEvents(deliberate.events))}`,
);

// 10. an alias route that cannot resolve advances quietly to the next, reported in `details` only —
// and a target that cannot be reached at all is an error message, never a substitute deliberation.
config.aliases["proxy-partial"] = { model: "glm-5.3", providers: ["nope", "opencode-go"], contextWindow: 1000, maxTokens: 100 };
config.fusions["proxy-partial"] = { mode: "single", candidates: { technical: ["proxy-partial"] } };
config.fusions["proxy-dead"] = { mode: "single", candidates: { technical: ["proxy-partial"] } };
const partialSeen = [];
calls.length = 0;
const partial = await driveStream(
  fusionStream(
    makeProxyPeer(partialSeen),
    registryWith({ find: (provider, id) => (provider === "nope" ? undefined : fakeModel(provider, id)) }),
  )(fusionModel("proxy-partial"), harnessContext, harnessOptions),
);
const partialDetails = partial.final.details?.proxied;
check(
  "proxy: an unresolvable route advances without decorating the message",
  partialSeen.length === 1 &&
    partialDetails?.attempts?.length === 1 &&
    partialDetails.attempts[0].reason === "missing provider" &&
    !/[├└│]/.test(textOfEvents(partial.events)) &&
    calls.length === 0,
  `attempts=${JSON.stringify(partialDetails?.attempts)}, text=${JSON.stringify(textOfEvents(partial.events).slice(0, 40))}`,
);
calls.length = 0;
const dead = await driveStream(
  fusionStream(
    makeProxyPeer([]),
    registryWith({ getApiKeyAndHeaders: async () => ({ ok: false, error: "no credential for opencode-go" }) }),
  )(fusionModel("proxy-dead"), harnessContext, harnessOptions),
);
check(
  "proxy: an unreachable executor is an error, not a deliberation",
  dead.final.stopReason === "error" &&
    /no credential/.test(dead.final.errorMessage ?? "") &&
    dead.final.details?.proxied?.attempts?.length === 2 &&
    calls.length === 0,
  `stop=${dead.final.stopReason}, ${dead.final.details?.proxied?.attempts?.map((a) => a.reason).join(",")}`,
);

// 11. a level the target does not support is our request, not the target's failure: retried once
// without one, recorded, and the turn still runs. `quick`'s writing seat declares `low`, which
// alibaba-token-plan's deepseek lane refuses ("Supported efforts: high, max", measured live).
const refusalSeen = [];
const refusingPeer = {
  streamSimple: (model, context, options) => {
    refusalSeen.push(options.reasoning);
    if (options.reasoning)
      throw new Error(
        `Thinking effort ${options.reasoning} is not supported by ${model.provider}/${model.id}. Supported efforts: high, max`,
      );
    return makeProxyPeer([]).streamSimple(model, context, options);
  },
};
const refusedLevel = await driveStream(fusionStream(refusingPeer)(fusionModel("quick"), harnessContext, harnessOptions));
check(
  "proxy: an unsupported thinking level is dropped once and recorded",
  refusalSeen.join(",") === "low," &&
    refusedLevel.final.stopReason === "stop" &&
    refusedLevel.final.details?.proxied?.thinking === null &&
    /not supported/.test(refusedLevel.final.details?.proxied?.attempts?.[0]?.detail ?? "") &&
    textOfEvents(refusedLevel.events) === "read it back",
  `levels=${JSON.stringify(refusalSeen)}, recorded=${JSON.stringify(refusedLevel.final.details?.proxied?.thinking)}, attempts=${JSON.stringify(refusedLevel.final.details?.proxied?.attempts?.map((a) => a.reason))}`,
);

// 12. a route that fails before anything reached the caller advances to the next provider, exactly as
// a seat does; 13. one that fails after `start` cannot, because pi has already pushed that partial into
// its conversation — the turn ends with the failure instead of a second provider's second start.
config.aliases["proxy-flaky"] = { model: "glm-5.3", providers: ["opencode-go", "zai"], contextWindow: 1000, maxTokens: 100 };
config.fusions["proxy-flaky"] = { mode: "single", candidates: { technical: ["proxy-flaky"] } };
const flakySeen = [];
const flakyPeer = {
  streamSimple: (model, context, options) => {
    flakySeen.push(model.provider);
    if (model.provider === "opencode-go") throw new Error("socket hang up");
    return makeProxyPeer([]).streamSimple(model, context, options);
  },
};
const flaky = await driveStream(fusionStream(flakyPeer)(fusionModel("proxy-flaky"), harnessContext, harnessOptions));
check(
  "proxy: a route that fails before any event advances to the next provider",
  flakySeen.join(",") === "opencode-go,zai" &&
    flaky.final.details?.proxied?.provider === "zai" &&
    flaky.final.details?.proxied?.attempts?.length === 1 &&
    textOfEvents(flaky.events) === "read it back",
  `routes=${flakySeen.join(",")}, answer=${flaky.final.details?.proxied?.provider}`,
);

const brokenSeen = [];
const brokenPeer = {
  streamSimple: (model, context, options) => {
    brokenSeen.push(model.provider);
    const partial = {
      role: "assistant",
      api: model.api,
      provider: model.provider,
      model: model.id,
      content: [{ type: "text", text: "half a sentence" }],
      usage: {
        input: 1,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 2,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: Date.now(),
    };
    return {
      async *[Symbol.asyncIterator]() {
        yield { type: "start", partial: { ...partial, content: [] } };
        yield { type: "text_delta", contentIndex: 0, delta: "half a sentence", partial };
        throw new Error("connection reset");
      },
      result: async () => partial,
    };
  },
};
const broken = await driveStream(fusionStream(brokenPeer)(fusionModel("proxy-flaky"), harnessContext, harnessOptions));
check(
  "proxy: a stream that fails after it started ends the turn instead of starting over",
  brokenSeen.join(",") === "opencode-go" &&
    broken.final.stopReason === "error" &&
    /after 2 events/.test(broken.final.errorMessage ?? "") &&
    broken.final.details?.proxied?.alias === "proxy-flaky",
  `routes=${brokenSeen.join(",")}, ${broken.final.errorMessage?.slice(0, 70)}`,
);

// 14. the seat path keeps its side of the same rule: a level the harness enforces is retried once without
// one, reported by a status line, and the seat still answers.
const seatLevels = [];
const refusingSeatCallModel = async ({ persona, reasoning }) => {
  seatLevels.push(reasoning ?? null);
  const usage = {
    input: 1,
    output: 1,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 2,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
  if (reasoning) {
    return {
      text: "",
      usage,
      stopReason: "error",
      errorMessage: `Thinking effort ${reasoning} is not supported by opencode-go/glm-5.3. Supported efforts: high, max`,
      toolCalls: [],
    };
  }
  return { text: "answered without a level", usage, stopReason: "stop", toolCalls: [] };
};
const seatRun = await runPipeline({
  config,
  sources,
  fusion: { mode: "single", thinking: { technical: "low" }, candidates: { technical: ["glm"] }, id: "seat-refusal" },
  prompt: "x",
  callModel: refusingSeatCallModel,
  decide,
  emit: silent,
  registry,
});
// A proxied refusal must not poison the seat path: the proxy retries once unconditionally and records
// nothing in the seat's per-model memory, because a seat that "knows" the level is refused skips its own
// retry — one recovered coding turn would then make `/matrix` on the same rung degrade instead of
// answering without reasoning. (Found by review; this case runs after the proxy refusal above, on the same
// `opencode-go/deepseek-v4.1-flash@low`.)
const afterProxySeatLevels = [];
const afterProxySeatRun = await runPipeline({
  config,
  sources,
  fusion: { mode: "single", thinking: { technical: "low" }, candidates: { technical: ["deepseek-flash"] }, id: "seat-after-proxy" },
  prompt: "x",
  registry,
  decide,
  emit: silent,
  callModel: async ({ persona, reasoning }) => {
    afterProxySeatLevels.push(reasoning ?? null);
    const usage = {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    };
    if (reasoning)
      return {
        text: "",
        usage,
        stopReason: "error",
        errorMessage: `Thinking effort ${reasoning} is not supported by opencode-go/deepseek-v4.1-flash. Supported efforts: high, max`,
        toolCalls: [],
      };
    return { text: `answered as ${persona?.name}`, usage, stopReason: "stop", toolCalls: [] };
  },
});
check(
  "seat: a proxied refusal does not suppress the seat's own retry",
  afterProxySeatLevels.join(",") === "low," && afterProxySeatRun.text === "answered as technical",
  `levels=${JSON.stringify(afterProxySeatLevels)}, text=${JSON.stringify(afterProxySeatRun.text)}`,
);

check(
  "seat: a refused thinking level is retried once without one",
  seatLevels.join(",") === "low," && seatRun.text === "answered without a level",
  `levels=${JSON.stringify(seatLevels)}, text=${JSON.stringify(seatRun.text)}`,
);

/* -------------------------------------------------------------- registration */

// The entry point itself, driven through a stub API: what pi registers and what `/matrix-info` prints
// are the two surfaces a user sees before any run, and both follow from the executor rule.
const registered = new Map();
const commands = new Map();
const sentMessages = [];
const stubApi = {
  on: () => {},
  registerProvider: (id, definition) => registered.set(id, definition),
  registerTool: () => {},
  registerCommand: (name, definition) => commands.set(name, definition),
  sendMessage: async (message, options) => {
    sentMessages.push({ message, options });
  },
};
const { default: extensionFactory } = await import("../extensions/pi-fusion-matrix/index.js");
// A scratch cwd so the entry point's own load (packaged + machine + a project layer here) can carry a
// `proxy.alias` override: what pi registers and what `/matrix-info` prints are the two surfaces a user
// sees before any run, and both must follow the model that will actually answer.
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "pfm-intercept-"));
fs.mkdirSync(path.join(scratch, ".pi"), { recursive: true });
fs.writeFileSync(
  path.join(scratch, ".pi", "pi-fusion-matrix.json"),
  JSON.stringify({ fusions: { quick: { proxy: { alias: "glm-flash" } } } }),
);
const originalCwd = process.cwd();
process.chdir(scratch);
try {
  await extensionFactory(stubApi);
} finally {
  process.chdir(originalCwd);
}
const registeredModels = new Map(registered.get("fusion-matrix").models.map((m) => [m.id, m]));
// `quick` carries a project-layer `proxy.alias` here, so its advertised numbers are the override's, not
// its writer's — the harness budgets for the model that will answer.
check(
  "registration: the advertised numbers follow the model that answers",
  registeredModels.get("quick").contextWindow === 1000000 &&
    registeredModels.get("quick").maxTokens === 131072 &&
    registeredModels.get("quick").reasoning === true &&
    registeredModels.get("best").contextWindow === 1000000 &&
    registeredModels.get("best").maxTokens === 131072,
  `quick(proxy→glm-flash)=${registeredModels.get("quick").contextWindow}/${registeredModels.get("quick").maxTokens}, best=${registeredModels.get("best").contextWindow}/${registeredModels.get("best").maxTokens}`,
);
check(
  "registration: a rung with no execute face keeps the package default",
  registeredModels.get("opinions").contextWindow === 128000 &&
    registeredModels.get("opinions").maxTokens === 8192 &&
    registeredModels.get("opinions").reasoning === false,
  `opinions=${registeredModels.get("opinions").contextWindow}/${registeredModels.get("opinions").maxTokens}/reasoning=${registeredModels.get("opinions").reasoning}`,
);

let info = "";
await commands.get("matrix-info").handler(undefined, {
  ui: {
    notify: (text) => {
      info = text;
    },
  },
});
check(
  "matrix-info: every fusion prints its execute face, and the review rungs print the declaration",
  / {2}quick: single\n[\s\S]*? {4}executes: glm-flash @low \(proxy alias\)/.test(info) &&
    / {2}best: pair-judged\n[\s\S]*? {4}executes: glm-flash @high \(writing seat synth\)/.test(info) &&
    / {2}review-check: review-committee[^\n]*\n[\s\S]*? {4}executes: — \(declared never a session model/.test(info) &&
    / {2}smrt-review: review-committee[^\n]*\n[\s\S]*? {4}executes: — \(declared never a session model/.test(info) &&
    / {2}opinions: opinion[^\n]*\n[\s\S]*? {4}executes: — \(no writing seat/.test(info),
  info
    .split("\n")
    .filter((line) => line.includes("executes:"))
    .join(" | "),
);

// A seat's own clock: the harness records none for a call we make ourselves, so the record has to.
const timedRun = await runPipeline({
  config,
  sources,
  fusion: { ...config.fusions["review-check"], id: "review-check" },
  prompt: "time it",
  callModel,
  decide,
  emit: silent,
  registry,
});
const timedSeats = timedRun.details.seats ?? [];
check(
  "a deliberation records its own wall clock, per seat and for the run",
  timedSeats.length > 0 &&
    timedSeats.every((seat) => Number.isFinite(seat.durationMs) && seat.durationMs >= 0) &&
    Number.isFinite(timedRun.details.durationMs) &&
    timedRun.details.durationMs >= 0,
  `seats=${JSON.stringify(timedSeats.map((seat) => seat.durationMs))} run=${timedRun.details.durationMs}`,
);
// A call that fails spent time too, and that time is the attempt's: the seat's clock covers the seat.
let failedCallSaw = 0;
const failingCallModel = async (args) => {
  failedCallSaw += 1;
  await new Promise((resolve) => setTimeout(resolve, 5));
  return {
    text: "",
    usage: { input: 1, output: 0, totalTokens: 1, cost: { total: 0 } },
    stopReason: "error",
    errorMessage: "the provider said no",
    toolCalls: [],
  };
};
const failedRun = await runPipeline({
  config,
  sources,
  fusion: { ...config.fusions.quick, id: "quick" },
  prompt: "fail",
  callModel: failingCallModel,
  decide,
  emit: silent,
  registry,
});
const failedSeat = failedRun.details.seats?.[0];
check(
  "a failed call records the time it spent failing, on its attempt",
  failedCallSaw >= 1 &&
    failedSeat?.degraded === true &&
    Number.isFinite(failedSeat.attempts?.[0]?.durationMs) &&
    failedSeat.attempts[0].durationMs >= 1,
  `attempts=${JSON.stringify(failedSeat?.attempts)}`,
);

/* ------------------------------------------------------------ the outcome label */

// `/matrix-label` is the half a run cannot know about itself: what the work was, and how it ended.
const labelNotice = { text: "", level: "" };
const notify = (text, level) => {
  labelNotice.text = String(text);
  labelNotice.level = String(level);
};
const labelsBefore = sentMessages.length;
await commands.get("matrix-label").handler("#12 landed https://example.test/pull/1", { ui: { notify } });
const written = sentMessages.at(-1)?.message;
check(
  "matrix-label: a label records the work item, the outcome and its evidence",
  sentMessages.length === labelsBefore + 1 &&
    written?.customType === "matrix-label" &&
    written.details?.workItem === "#12" &&
    written.details?.outcome === "landed" &&
    written.details?.evidence === "https://example.test/pull/1" &&
    sentMessages.at(-1)?.options?.triggerTurn === false &&
    /#12 — landed/.test(String(written.content)),
  JSON.stringify(written?.details),
);
await commands.get("matrix-label").handler("#12 shipped", { ui: { notify } });
check(
  "matrix-label: an outcome outside the vocabulary is refused, and writes nothing",
  sentMessages.length === labelsBefore + 1 &&
    labelNotice.level === "error" &&
    /usage: \/matrix-label/.test(labelNotice.text) &&
    /landed/.test(labelNotice.text),
  `${labelNotice.level}: ${labelNotice.text}`,
);
await commands.get("matrix-label").handler("#12", { ui: { notify } });
check(
  "matrix-label: a work item with no outcome is refused",
  sentMessages.length === labelsBefore + 1 && labelNotice.level === "error",
  labelNotice.text,
);
await commands.get("matrix-label").handler("#12 review", { ui: { notify } });
check(
  "matrix-label: evidence is optional",
  sentMessages.length === labelsBefore + 2 &&
    sentMessages.at(-1).message.details?.outcome === "review" &&
    sentMessages.at(-1).message.details?.evidence === undefined,
  JSON.stringify(sentMessages.at(-1)?.message?.details),
);

/* ------------------------------------------------------------ review findings */

// The two faces must not read `thinking` differently: the execute face's `"harness"` literal is the
// harness's level for a proxied turn and means nothing to a seat — a seat that inherited it would ask its
// provider for a level called "harness".
const harnessSeatLevels = [];
const levelRecordingCallModel = async ({ persona, reasoning }) => {
  harnessSeatLevels.push(reasoning ?? null);
  return {
    text: `canned ${persona?.name}`,
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    toolCalls: [],
  };
};
const harnessSeatRun = await runPipeline({
  config,
  sources,
  fusion: { mode: "single", thinking: { technical: "harness" }, candidates: { technical: ["glm"] }, id: "seat-harness" },
  prompt: "x",
  callModel: levelRecordingCallModel,
  decide,
  emit: silent,
  registry,
});
check(
  "seat: the `harness` literal never reaches a seat",
  harnessSeatLevels.join(",") === "medium" && harnessSeatRun.text === "canned technical",
  `levels=${JSON.stringify(harnessSeatLevels)}`,
);

// A writer in the object form pins the proxied turn to that seat's own route and level, because the two
// faces have to walk the same candidates.
config.fusions["proxy-object"] = {
  mode: "single",
  candidates: { technical: [{ alias: "kimi", providers: ["kimi-coding"], thinking: "high" }] },
};
const objectSeen = [];
await driveStream(fusionStream(makeProxyPeer(objectSeen))(fusionModel("proxy-object"), harnessContext, harnessOptions));
check(
  "proxy: a writer's candidate object pins the route and the level",
  objectSeen[0]?.model.provider === "kimi-coding" && objectSeen[0]?.options.reasoning === "high",
  `provider=${objectSeen[0]?.model.provider} @${objectSeen[0]?.options.reasoning}`,
);

// `proxy.alias` names the executor outright: the override's own provider chain answers, while the writing
// seat's declared level still governs the turn. (It was ignored on the wire until a review found that the
// route resolved the writer's candidate even when the override was set — registration and `/matrix-info`
// said one thing and the stream did another.)
config.fusions["proxy-override"] = {
  mode: "pair-judged",
  thinking: { technical: "low", skeptic: "low", judge: "high", synth: "high" },
  proxy: { alias: "glm-flash" },
  candidates: {
    technical: [{ alias: "kimi", providers: ["kimi-coding"], thinking: "high" }],
    skeptic: ["glm"],
    judge: ["deepseek-flash"],
    synth: [{ alias: "kimi", providers: ["kimi-coding"], thinking: "low" }],
  },
};
const overrideSeen = [];
await driveStream(fusionStream(makeProxyPeer(overrideSeen))(fusionModel("proxy-override"), harnessContext, harnessOptions));
check(
  "proxy: `proxy.alias` answers on the override's own route, at the writer's level",
  overrideSeen[0]?.model.id === "glm-5.3-flash" &&
    overrideSeen[0]?.model.provider === "opencode-go" &&
    overrideSeen[0]?.options.reasoning === "high",
  `model=${overrideSeen[0]?.model.id}@${overrideSeen[0]?.model.provider} @${overrideSeen[0]?.options.reasoning}`,
);

// An `error` event with nothing before it never reached the harness, so it recovers like a throw: the
// same route without a refused level, or the next provider. (Found by review: the first version treated
// any forwarded event as a committed turn, so a provider reporting its refusal as an event bypassed both
// the retry and the fallback while `details.proxied.thinking` still named the level it never ran at.)
config.aliases["proxy-eventful"] = { model: "glm-5.3", providers: ["opencode-go", "zai"], contextWindow: 1000, maxTokens: 100 };
config.fusions["proxy-eventful"] = { mode: "single", thinking: { technical: "low" }, candidates: { technical: ["proxy-eventful"] } };
const eventAttempts = [];
const errorEventPeer = {
  streamSimple: (model, context, options) => {
    eventAttempts.push(`${model.provider}@${options.reasoning ?? "-"}`);
    const failed = {
      role: "assistant",
      api: model.api,
      provider: model.provider,
      model: model.id,
      content: [],
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "error",
      errorMessage: options.reasoning
        ? `Thinking effort ${options.reasoning} is not supported by ${model.provider}/${model.id}. Supported efforts: high, max`
        : "upstream refused",
    };
    const ok = { ...failed, content: [{ type: "text", text: "answered anyway" }], stopReason: "stop", errorMessage: undefined };
    return {
      async *[Symbol.asyncIterator]() {
        if (options.reasoning) {
          yield { type: "error", reason: "error", error: failed };
          return;
        }
        if (model.provider === "opencode-go") {
          yield { type: "error", reason: "error", error: { ...failed, errorMessage: "upstream refused" } };
          return;
        }
        yield { type: "text_delta", contentIndex: 0, delta: "answered anyway", partial: ok };
        yield { type: "done", reason: "stop", message: ok };
      },
      result: async () => ok,
    };
  },
};
const eventRecovered = await driveStream(fusionStream(errorEventPeer)(fusionModel("proxy-eventful"), harnessContext, harnessOptions));
check(
  "proxy: an error event before any event recovers like a throw",
  eventAttempts.join(" ") === "opencode-go@low opencode-go@- zai@low zai@-" &&
    textOfEvents(eventRecovered.events) === "answered anyway" &&
    eventRecovered.final.details?.proxied?.provider === "zai" &&
    eventRecovered.final.details?.proxied?.attempts?.length === 3,
  `attempts=${JSON.stringify(eventAttempts)}, provider=${eventRecovered.final.details?.proxied?.provider}, recorded=${eventRecovered.final.details?.proxied?.attempts?.length}`,
);

// A seat that fails twice — once on a temperature override, then again on the retry — is two attempts, each
// with its own time. Keeping only the last call's figure understates what the route spent.
let retryCalls = 0;
const temperatureThenFail = async (args) => {
  retryCalls += 1;
  await new Promise((resolve) => setTimeout(resolve, 4));
  return retryCalls === 1
    ? {
        text: "",
        usage: { input: 1, output: 0, totalTokens: 1, cost: { total: 0 } },
        stopReason: "error",
        errorMessage: "this model rejects a temperature override",
        toolCalls: [],
      }
    : {
        text: "",
        usage: { input: 1, output: 0, totalTokens: 1, cost: { total: 0 } },
        stopReason: "error",
        errorMessage: "the provider said no",
        toolCalls: [],
      };
};
const retryRun = await runPipeline({
  config,
  sources,
  fusion: { ...config.fusions.quick, id: "quick" },
  prompt: "retry and fail",
  callModel: temperatureThenFail,
  decide,
  emit: silent,
  registry,
});
const retrySeat = retryRun.details.seats?.[0];
check(
  "both failed calls of one seat are attempts, each with its own time",
  retryCalls >= 2 &&
    retrySeat?.attempts?.length === 2 && // the alias may walk on to its next provider after
    retrySeat.attempts.every((a) => Number.isFinite(a.durationMs) && a.durationMs >= 1) &&
    retrySeat.attempts[0].reason === "transient" &&
    retrySeat.attempts[1].reason === "transient",
  `calls=${retryCalls} attempts=${JSON.stringify(retrySeat?.attempts)}`,
);

// A partial whose usage is the harness's zero-valued placeholder is not a spend: recording it would report a
// route that never reached a model as one that cost something unpriced.
const makeZeroUsageFailingPeer = (seen) => ({
  streamSimple: (model, context, options) => {
    seen.push({ model, context, options });
    const empty = {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    };
    const partial = {
      role: "assistant",
      api: model.api,
      provider: model.provider,
      model: model.id,
      content: [],
      usage: empty,
      stopReason: "stop",
      timestamp: Date.now(),
    };
    return {
      async *[Symbol.asyncIterator]() {
        yield { type: "start", partial };
        yield { type: "text_delta", contentIndex: 0, delta: "half", partial };
        throw new Error("the stream broke before any token was priced");
      },
      result: async () => partial,
    };
  },
});
const zeroSeen = [];
const zeroUsageRun = await driveStream(
  fusionStream(makeZeroUsageFailingPeer(zeroSeen))(fusionModel("proxy-eventful"), harnessContext, harnessOptions),
);
const zeroAttempts = zeroUsageRun.final.details?.proxied?.attempts ?? [];
check(
  "a zero-valued partial usage is not recorded as a spend",
  zeroAttempts.length >= 1 && zeroAttempts.every((a) => a.usage === undefined),
  `attempts=${JSON.stringify(zeroAttempts)}`,
);

// A peer whose stream cannot even be created: the failure is a route that never began, and it must not take
// the reader of the run's own bookkeeping down with it.
const makeThrowingPeer = (seen) => ({
  streamSimple: (model, context, options) => {
    seen.push({ model, context, options });
    throw new Error("the provider refused to open a stream");
  },
});
const throwSeen = [];
const thrown = await driveStream(fusionStream(makeThrowingPeer(throwSeen))(fusionModel("proxy-eventful"), harnessContext, harnessOptions));
const throwAttempts = thrown.final.details?.proxied?.attempts ?? [];
check(
  "proxy: a route that cannot be created is recorded, not thrown",
  thrown.final.stopReason === "error" &&
    throwAttempts.length === 2 && // both providers of the alias were tried
    throwAttempts.every((a) => a.reason === "transient" && /refused to open a stream/.test(String(a.detail))) &&
    throwAttempts.every((a) => a.usage === undefined) && // nothing was spent, so nothing is reported as spent
    thrown.events.some((e) => e.type === "error"),
  `attempts=${JSON.stringify(throwAttempts)}`,
);

// 7b. proxy: a `result()` rejection past the first event must not become a second terminal message
const rejectSeen = [];
const rejected = await driveStream(
  fusionStream(makeRejectingPeer(rejectSeen))(fusionModel("proxy-eventful"), harnessContext, harnessOptions),
);
const rejectedTerminals = rejected.events.filter((e) => e.type === "done" || e.type === "error");
check(
  "proxy: a `result()` rejection after a terminal event adds no second one",
  rejectedTerminals.length === 1 &&
    rejectedTerminals[0].type === "done" &&
    rejectedTerminals[0].message.details?.proxied?.attempts.some((a) => /result\(\) rejected/.test(String(a.detail))) &&
    rejected.final.provider === "fusion-matrix",
  `terminals=${rejectedTerminals.map((e) => e.type).join(",")} attempts=${JSON.stringify(rejectedTerminals[0]?.message?.details?.proxied?.attempts ?? [])}`,
);
const truncSeen = [];
const truncated = await driveStream(
  fusionStream(makeRejectingPeer(truncSeen, { terminal: false }))(fusionModel("proxy-eventful"), harnessContext, harnessOptions),
);
const truncTerminals = truncated.events.filter((e) => e.type === "done" || e.type === "error");
check(
  "proxy: a `result()` rejection with no terminal event ends the turn exactly once, with the record",
  truncTerminals.length === 1 &&
    truncTerminals[0].type === "error" &&
    truncTerminals[0].error.details?.proxied?.attempts.length === 1 &&
    truncTerminals[0].error.provider === "fusion-matrix",
  `terminals=${truncTerminals.map((e) => e.type).join(",")} attempts=${truncTerminals[0]?.error?.details?.proxied?.attempts?.length}`,
);

// Every proxy rule the loader enforces, asserted where it is enforced rather than only through a harness.
const { config: fresh } = loadMatrixConfig({ cwd: process.cwd(), layers: ["packaged"] });
const errorsFor = (patch) => validateConfig(mergeConfig(JSON.parse(JSON.stringify(fresh)), patch), {});
const proxyRules = [
  ["an unknown alias", { fusions: { best: { proxy: { alias: "no-such-alias" } } } }, /proxy alias "no-such-alias" is not an alias/],
  ["an empty proxy block", { fusions: { best: { proxy: {} } } }, /proxy needs an alias/],
  ["a null proxy block", { fusions: { best: { proxy: null } } }, /proxy is not an object/],
  ["proxy with route", { fusions: { "default-smrt": { proxy: { alias: "qwen-flash" } } } }, /proxy and route cannot both be declared/],
  [
    "a writing seat that is not the writer",
    { fusions: { best: { thinking: { judge: "harness" } } } },
    /"harness" is only legal for the writing seat "synth"/,
  ],
  ["proxy on a mode that writes nothing", { fusions: { opinions: { proxy: { alias: "kimi" } } } }, /proxy needs a writing seat/],
  ["a non-integer alias contextWindow", { aliases: { "glm-flash": { contextWindow: 0 } } }, /contextWindow must be a positive integer/],
];
const ruleResults = proxyRules.map(([, patch, re]) => re.test(errorsFor(patch).join("\n")));
check(
  "config: every proxy rule is a named load error",
  ruleResults.every(Boolean) && errorsFor({}).length === 0,
  proxyRules
    .filter((_, i) => !ruleResults[i])
    .map(([name]) => name)
    .join(", ") || `${proxyRules.length} rules, packaged config clean`,
);

// The review route's rules, each one a silent degradation if it were allowed to load: a reviewer pinned to a
// rung with an execute face proxies to its writer and the panel never runs.
const reviewRules = [
  [
    "execute: false with a proxy block",
    { fusions: { best: { execute: false, proxy: { alias: "glm-flash" } } } },
    /proxy and execute: false cannot both be declared/,
  ],
  // `best` is an ordinary work rung (it has an executor), so these two patches exercise the rule rather than
  // merging into a rung that already declares `execute: false`.
  ["review without execute: false", { fusions: { best: { review: true } } }, /review requires execute: false/],
  ["review without a route", { fusions: { best: { review: true, execute: false } } }, /review requires route/],
  [
    "a review route to an executor",
    {
      fusions: { "smrt-review": { route: { criteria: { mechanical: { description: "x", then: "quick" }, high: { description: "y" } } } } },
    },
    /declares no execute: false/,
  ],
];
const reviewResults = reviewRules.map(([, patch, re]) => re.test(errorsFor(patch).join("\n")));
check(
  "config: every review-route rule is a named load error",
  reviewResults.every(Boolean),
  reviewRules
    .filter((_, i) => !reviewResults[i])
    .map(([name]) => name)
    .join(", ") || `${reviewRules.length} rules`,
);

// A writing seat that answers in JSON is a disposition, not an agent turn. Every packaged rung already declares
// `execute: false` by hand, and the rule is what keeps the next one from having to remember: the failure it
// prevents is silent, because a proxy to a JSON seat answers perfectly well — with a review instead of work.
const jsonWriter = errorsFor({ fusions: { "review-check": { execute: true } } }).join("\n");
check(
  "a fusion whose writing seat answers in JSON must declare execute: false",
  /the writing seat "review-synth" answers in JSON, so this fusion must declare execute: false/.test(jsonWriter) &&
    errorsFor({}).length === 0,
  jsonWriter.split("\n")[0] || "no error raised",
);

// A seat that never answers must fail, not hang — at the run level, the observable is that the run ends and says
// why. The mechanics (attempt reasons, the advance) live in `test/seat-deadline.test.mjs`; this is the wiring.
// The race is the check's own bound: `runPipeline` has no bound of its own here, so a defect that removes the
// seat deadline must fail this check with a message rather than hang the suite until someone kills it.
const hanging = (args) =>
  new Promise((_, reject) => {
    args?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
  });
const hungRace = await Promise.race([
  runPipeline({
    config,
    sources,
    fusion: {
      ...config.fusions["review-quick"],
      id: "review-quick",
      seatTimeoutMs: 50,
      candidates: { skeptic: ["deepseek-pro", "kimi"], "review-synth": ["deepseek-pro"] },
    },
    prompt: "a packet",
    callModel: hanging,
    decide,
    emit: silent,
    registry,
  }),
  new Promise((resolve) => setTimeout(() => resolve({ details: { seats: [] }, neverSettled: true }), 5000)),
]);
const hangingSeats = hungRace.details.seats ?? [];
check(
  "a run whose seats never answer ends, with every seat reported as a timeout",
  !hungRace.neverSettled && hangingSeats.length === 2 && hangingSeats.every((s) => s.degraded && s.reason === "timeout"),
  hungRace.neverSettled
    ? "the run never settled: the seat deadline did not fire"
    : JSON.stringify(hangingSeats.map((s) => ({ persona: s.persona, reason: s.reason, degraded: s.degraded }))),
);

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
