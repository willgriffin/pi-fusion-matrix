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
import { routeFusion, verifyRun, createFusionStream } from "../extensions/pi-fusion-matrix/run.js";

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
config.fusions.router = { ...config.fusions["default-smrt"], id: "router", route: { ...config.fusions["default-smrt"].route, sufficientWhen: { minConfidence: 0.8 } } };
await setMode("decisive");
let routed = await routeFusion({ config, fusion: config.fusions.router, prompt: "x", decide, emit: silent });
// The stub's decisive answer takes the route's first criterion, and that criterion carries an action
// (`then: "cheap"`) — so the run must be redirected to that rung, not merely "not declined".
check("route: confident match routes to the target",
  routed.routing?.routedTo === "cheap" && routed.fusion.id === "cheap",
  `routedTo=${routed.routing?.routedTo ?? "none"}, fusion=${routed.fusion.id}`);
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
    const usage = { input: 5, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 10, reasoning: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
    const blocks = [{ type: "text", text }, ...(tool ? [{ type: "toolCall", id: tool.id, name: tool.name, arguments: tool.arguments }] : [])];
    const partial = () => ({ role: "assistant", api: reported.api, provider: reported.provider, model: reported.id,
      content: blocks, usage, stopReason: tool ? "toolUse" : "stop", timestamp: Date.now() });
    const final = partial();
    const events = [
      { type: "start", partial: { ...partial(), content: [] } },
      { type: "text_start", contentIndex: 0, partial: partial() },
      { type: "text_delta", contentIndex: 0, delta: text, partial: partial() },
      { type: "text_end", contentIndex: 0, content: text, partial: partial() },
      ...(tool ? [{ type: "toolcall_start", contentIndex: 1, partial: partial() }, { type: "toolcall_end", contentIndex: 1, toolCall: blocks[1], partial: partial() }] : []),
      { type: "done", reason: final.stopReason, message: final },
    ];
    return {
      async *[Symbol.asyncIterator]() { yield* events; },
      result: async () => final,
    };
  },
});

const registryWith = (over) => ({ ...registry, ...over });
const fusionStream = (peer, sessionRegistry = registry) => createFusionStream({
  config, sources, getRegistry: () => sessionRegistry, decide, callModel,
  getPi: async () => ({ streamSimple: peer.streamSimple, from: "stub", harness: "stub" }),
  getWriteParameters: async () => ({}),
});
const fusionModel = (id) => ({ ...fakeModel("fusion-matrix", id), api: "fusion-matrix" });
const driveStream = async (stream) => {
  const events = [];
  for await (const event of stream) events.push(event);
  return { events, final: await stream.result() };
};
const textOfEvents = (events) => events.filter((e) => e.type === "text_delta").map((e) => e.delta).join("");
// The harness's own turn: a coding prompt, a tool set, and a level it already resolved.
const harnessContext = {
  systemPrompt: "You are the harness's coding agent. Read files before editing them.",
  messages: [{ role: "user", content: "what does package.json call this project?" }],
  tools: [{ name: "read", description: "Read a file", parameters: { type: "object", properties: { path: { type: "string" } } } }],
};
const harnessOptions = { sessionId: "session-1", reasoning: "high", temperature: 0.3, metadata: { user_id: "u1" }, thinkingBudgets: { high: 4096 } };

// 7. proxy: the harness's context goes to the writing seat's alias verbatim, and its events come back
const seen = [];
calls.length = 0;
const proxied = await driveStream(fusionStream(makeProxyPeer(seen, { text: "pi-fusion-matrix.", tool: { id: "call_1", name: "read", arguments: { path: "package.json" } } }))(fusionModel("quick"), harnessContext, harnessOptions));
const forwarded = seen[0];
check("proxy: messages, tools, and systemPrompt forwarded verbatim",
  seen.length === 1 && JSON.stringify(forwarded.context) === JSON.stringify(harnessContext),
  `calls=${seen.length}, context=${JSON.stringify(forwarded.context).slice(0, 80)}`);
// The writer defines the executor: `quick`'s writing seat is `technical` on `deepseek-flash`, and its
// declared level is `low` — not the harness's `high`.
check("proxy: the writing alias answers at the fusion's declared level",
  forwarded.model.id === "deepseek-v4.1-flash" && forwarded.options.reasoning === "low" && forwarded.options.sessionId === "session-1" && forwarded.options.temperature === 0.3,
  `model=${forwarded.model.id} @${forwarded.options.reasoning} session=${forwarded.options.sessionId}`);
check("proxy: the target's tool call reaches the caller",
  proxied.events.some((e) => e.type === "toolcall_end" && e.toolCall?.name === "read")
    && proxied.final.content.some((b) => b.type === "toolCall" && b.arguments?.path === "package.json"),
  `events=${proxied.events.map((e) => e.type).join(",")}`);
// No decoration: the message is the model's own output, and no seat ran.
check("proxy: the message is the model's output and nothing else",
  textOfEvents(proxied.events) === "pi-fusion-matrix." && calls.length === 0 && !/[├└│]/.test(textOfEvents(proxied.events)),
  `text=${JSON.stringify(textOfEvents(proxied.events).slice(0, 60))}, seat calls=${calls.length}`);
check("proxy: reported as the fusion's model, with the executor in details",
  proxied.final.provider === "fusion-matrix" && proxied.final.model === "quick" && proxied.final.stopReason === "toolUse"
    && proxied.final.details?.proxied?.alias === "deepseek-flash" && proxied.final.details?.proxied?.provider === "opencode-go"
    && proxied.final.details?.proxied?.model === "deepseek-v4.1-flash" && Array.isArray(proxied.final.details?.proxied?.attempts),
  JSON.stringify(proxied.final.details?.proxied));
// The harness takes the turn from the terminal event's message, so the record has to be there and not
// only on `result()` — that is the difference between a readable transcript and an empty one.
check("proxy: the terminal event carries the run record",
  proxied.events.find((e) => e.type === "done")?.message?.details?.proxied?.alias === "deepseek-flash"
    && proxied.events.find((e) => e.type === "done")?.message?.provider === "fusion-matrix",
  JSON.stringify(proxied.events.find((e) => e.type === "done")?.message?.details?.proxied));

// 8. thinking precedence: `"harness"` runs at the level the harness sent, and an absent declaration
// falls to the writing seat's persona level (`technical` declares `medium` in the packaged config).
config.fusions["proxy-harness"] = { mode: "single", thinking: { technical: "harness" }, candidates: { technical: ["glm"] } };
config.fusions["proxy-bare"] = { mode: "single", candidates: { technical: ["glm"] } };
const harnessSeen = [];
await driveStream(fusionStream(makeProxyPeer(harnessSeen))(fusionModel("proxy-harness"), harnessContext, harnessOptions));
const bareSeen = [];
await driveStream(fusionStream(makeProxyPeer(bareSeen))(fusionModel("proxy-bare"), harnessContext, harnessOptions));
check("thinking: `harness` forwards the level the harness sent",
  harnessSeen[0].options.reasoning === "high", `level=${harnessSeen[0].options.reasoning}`);
check("thinking: nothing declared falls to the writing seat's persona level",
  bareSeen[0].options.reasoning === "medium", `level=${bareSeen[0].options.reasoning}`);

// 9. branch selection: a rung with no writing seat still deliberates when tools are present, and the
// `matrix` tool path (`runOnce`) never proxies because it calls the pipeline directly.
calls.length = 0;
const deliberate = await driveStream(fusionStream(makeProxyPeer([]))(fusionModel("opinions"), harnessContext, harnessOptions));
check("branch: a fusion with no writing seat still deliberates with tools present",
  calls.length === 3 && deliberate.events.every((e) => e.type !== "toolcall_end") && /├─/.test(textOfEvents(deliberate.events))
    && deliberate.final.details?.proxied === undefined,
  `seat calls=${calls.length}, decorated=${/├─/.test(textOfEvents(deliberate.events))}`);

// 10. an alias route that cannot resolve advances quietly to the next, reported in `details` only —
// and a target that cannot be reached at all is an error message, never a substitute deliberation.
config.aliases["proxy-partial"] = { model: "glm-5.3", providers: ["nope", "opencode-go"], contextWindow: 1000, maxTokens: 100 };
config.fusions["proxy-partial"] = { mode: "single", candidates: { technical: ["proxy-partial"] } };
config.fusions["proxy-dead"] = { mode: "single", candidates: { technical: ["proxy-partial"] } };
const partialSeen = [];
calls.length = 0;
const partial = await driveStream(fusionStream(makeProxyPeer(partialSeen), registryWith({ find: (provider, id) => (provider === "nope" ? undefined : fakeModel(provider, id)) }))(fusionModel("proxy-partial"), harnessContext, harnessOptions));
const partialDetails = partial.final.details?.proxied;
check("proxy: an unresolvable route advances without decorating the message",
  partialSeen.length === 1 && partialDetails?.attempts?.length === 1
    && partialDetails.attempts[0].reason === "missing provider" && !/[├└│]/.test(textOfEvents(partial.events))
    && calls.length === 0,
  `attempts=${JSON.stringify(partialDetails?.attempts)}, text=${JSON.stringify(textOfEvents(partial.events).slice(0, 40))}`);
calls.length = 0;
const dead = await driveStream(fusionStream(makeProxyPeer([]), registryWith({ getApiKeyAndHeaders: async () => ({ ok: false, error: "no credential for opencode-go" }) }))(fusionModel("proxy-dead"), harnessContext, harnessOptions));
check("proxy: an unreachable executor is an error, not a deliberation",
  dead.final.stopReason === "error" && /no credential/.test(dead.final.errorMessage ?? "")
    && dead.final.details?.proxied?.attempts?.length === 2 && calls.length === 0,
  `stop=${dead.final.stopReason}, ${dead.final.details?.proxied?.attempts?.map((a) => a.reason).join(",")}`);

// 11. a level the target does not support is our request, not the target's failure: retried once
// without one, recorded, and the turn still runs. `quick`'s writing seat declares `low`, which
// alibaba-token-plan's deepseek lane refuses ("Supported efforts: high, max", measured live).
const refusalSeen = [];
const refusingPeer = {
  streamSimple: (model, context, options) => {
    refusalSeen.push(options.reasoning);
    if (options.reasoning) throw new Error(`Thinking effort ${options.reasoning} is not supported by ${model.provider}/${model.id}. Supported efforts: high, max`);
    return makeProxyPeer([]).streamSimple(model, context, options);
  },
};
const refusedLevel = await driveStream(fusionStream(refusingPeer)(fusionModel("quick"), harnessContext, harnessOptions));
check("proxy: an unsupported thinking level is dropped once and recorded",
  refusalSeen.join(",") === "low," && refusedLevel.final.stopReason === "stop"
    && /not supported/.test(refusedLevel.final.details?.proxied?.attempts?.[0]?.detail ?? "")
    && textOfEvents(refusedLevel.events) === "read it back",
  `levels=${JSON.stringify(refusalSeen)}, attempts=${JSON.stringify(refusedLevel.final.details?.proxied?.attempts?.map((a) => a.reason))}`);

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
check("proxy: a route that fails before any event advances to the next provider",
  flakySeen.join(",") === "opencode-go,zai" && flaky.final.details?.proxied?.provider === "zai"
    && flaky.final.details?.proxied?.attempts?.length === 1 && textOfEvents(flaky.events) === "read it back",
  `routes=${flakySeen.join(",")}, answer=${flaky.final.details?.proxied?.provider}`);

const brokenSeen = [];
const brokenPeer = {
  streamSimple: (model, context, options) => {
    brokenSeen.push(model.provider);
    const partial = { role: "assistant", api: model.api, provider: model.provider, model: model.id, content: [{ type: "text", text: "half a sentence" }],
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: Date.now() };
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
check("proxy: a stream that fails after it started ends the turn instead of starting over",
  brokenSeen.join(",") === "opencode-go" && broken.final.stopReason === "error"
    && /after 2 events/.test(broken.final.errorMessage ?? "") && broken.final.details?.proxied?.alias === "proxy-flaky",
  `routes=${brokenSeen.join(",")}, ${broken.final.errorMessage?.slice(0, 70)}`);

// 14. the seat path keeps its side of the same rule: a level the harness enforces is retried once without
// one, reported by a status line, and the seat still answers.
const seatLevels = [];
const refusingSeatCallModel = async ({ persona, reasoning }) => {
  seatLevels.push(reasoning ?? null);
  const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
  if (reasoning) {
    return { text: "", usage, stopReason: "error", errorMessage: `Thinking effort ${reasoning} is not supported by opencode-go/glm-5.3. Supported efforts: high, max`, toolCalls: [] };
  }
  return { text: "answered without a level", usage, stopReason: "stop", toolCalls: [] };
};
const seatRun = await runPipeline({
  config, sources, fusion: { mode: "single", thinking: { technical: "low" }, candidates: { technical: ["glm"] }, id: "seat-refusal" },
  prompt: "x", callModel: refusingSeatCallModel, decide, emit: silent, registry,
});
check("seat: a refused thinking level is retried once without one",
  seatLevels.join(",") === "low," && seatRun.text === "answered without a level",
  `levels=${JSON.stringify(seatLevels)}, text=${JSON.stringify(seatRun.text)}`);

/* -------------------------------------------------------------- registration */

// The entry point itself, driven through a stub API: what pi registers and what `/matrix-info` prints
// are the two surfaces a user sees before any run, and both follow from the executor rule.
const registered = new Map();
const commands = new Map();
const stubApi = {
  on: () => {},
  registerProvider: (id, definition) => registered.set(id, definition),
  registerTool: () => {},
  registerCommand: (name, definition) => commands.set(name, definition),
};
const { default: extensionFactory } = await import("../extensions/pi-fusion-matrix/index.js");
await extensionFactory(stubApi);
const registeredModels = new Map(registered.get(config.providerId ?? "fusion-matrix").models.map((m) => [m.id, m]));
check("registration: a proxying rung advertises the executor's numbers and capability",
  registeredModels.get("quick").contextWindow === 1000000 && registeredModels.get("quick").maxTokens === 384000
    && registeredModels.get("quick").reasoning === true
    && registeredModels.get("best").contextWindow === 1000000 && registeredModels.get("best").maxTokens === 131072,
  `quick=${registeredModels.get("quick").contextWindow}/${registeredModels.get("quick").maxTokens}, best=${registeredModels.get("best").contextWindow}/${registeredModels.get("best").maxTokens}`);
check("registration: a rung with no execute face keeps the package default",
  registeredModels.get("opinions").contextWindow === 128000 && registeredModels.get("opinions").maxTokens === 8192
    && registeredModels.get("opinions").reasoning === false,
  `opinions=${registeredModels.get("opinions").contextWindow}/${registeredModels.get("opinions").maxTokens}/reasoning=${registeredModels.get("opinions").reasoning}`);

let info = "";
await commands.get("matrix-info").handler(undefined, { ui: { notify: (text) => { info = text; } } });
check("matrix-info: every fusion prints its execute face",
  / {2}quick: single\n[\s\S]*? {4}executes: deepseek-flash @low \(writing seat technical\)/.test(info)
    && / {2}best: pair-judged\n[\s\S]*? {4}executes: glm-flash @high \(writing seat synth\)/.test(info)
    && / {2}review-check: committee-cascaded[^\n]*\n[\s\S]*? {4}executes: kimi @harness \(writing seat synth\)/.test(info)
    && /executes: — \(no writing seat/.test(info),
  info.split("\n").filter((line) => line.includes("executes:")).slice(0, 3).join(" | "));

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
