/**
 * run.js — the pi-facing adapter: one assistant message per fusion run.
 *
 * Owns everything that speaks pi's protocol or pi-ai:
 *   - the AssistantMessageEvent stream (`start` before any delta, every partial a complete message,
 *     `toolcall_*` pairs so pi executes the file agent's writes, `done` carrying the tool blocks);
 *   - `route` before the pipeline and `verify` after it (both report-only);
 *   - the `callModel` seam the pipeline injects, so pipeline.js stays free of pi imports;
 *   - usage accumulation across every seat and decision.
 *
 * Seats are pi-ai calls made with a model object built from pi's registry (resolve.js). The pi-ai
 * stream is consumed directly, which is also how the final answer streams token-by-token.
 */

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { AGENT_DIR } from "./config.js";
import { resolveCandidates, seatRequest, label, isObject, normalizeCandidate } from "./resolve.js";
import { runPipeline, freshUsage, accumulateUsage } from "./pipeline.js";

/** pi-ai's `Tool` shape, with a Typebox schema because that is what its adapters expect. */
export function writeTool(Type) {
  return [{
    name: "write",
    description: "Write content to a file. Create one file per tool call. Use relative paths from the project root.",
    parameters: Type.Object({
      path: Type.String({ description: "Path to the file to write (relative or absolute)" }),
      content: Type.String({ description: "Full content to write to the file" }),
    }),
  }];
}

const textOf = (content) => (content ?? []).filter((part) => part?.type === "text").map((part) => part.text).join("");

/** The same taxonomy seats use, so a file-agent failure reads as `quota` rather than as noise. */
export function classifyFailure(text) {
  const message = String(text ?? "");
  if (/\b429\b|usage limit|quota|balance/i.test(message)) return "quota";
  if (/\b40[13]\b|unauthorized|invalid api key/i.test(message)) return "credential";
  if (/not found|unknown model|\b404\b/i.test(message)) return "missing model";
  return "transient";
}

/**
 * pi-ai resolution, in order, because a bare specifier is not enough here.
 *
 * Measured 2026-09-18: `import("@earendil-works/pi-ai/compat")` resolves from an extension loaded with
 * `-e`, but the same import from a *symlinked* extension directory fails at call time —
 * `Cannot find package '@earendil-works/pi-ai' imported from …/run.js` — because the module is imported
 * after load, from the file's real path, where no `node_modules` exists. So: try the specifier, then
 * pi's own installation (found by walking up from the script pi was launched with), then report every
 * attempt. A compiled single-file pi has no on-disk package to walk to, which the error says plainly.
 */
/**
 * Where a bundled peer can be found, in order, because a bare specifier is not enough here.
 *
 * Measured 2026-09-18: `import("@earendil-works/pi-ai/compat")` resolves from an extension loaded with
 * `-e`, but the same import from a *symlinked* extension directory fails at call time —
 * `Cannot find package '@earendil-works/pi-ai' imported from …/run.js` — because the import happens
 * after load, from the file's real path, where no `node_modules` exists. `process.argv[1]` is also the
 * bin shim (`…/bin/pi`), a symlink into the package, so it must be resolved before walking up.
 */
/**
 * Peer modules come from pi's own installation, and nothing else.
 *
 * The tempting alternative — walking ancestors of the entry script — was a supply-chain hole: a module
 * planted in any writable ancestor directory is *executed* by `import` before any check, and would then
 * receive pi's resolved credential for every seat. So the installation root is derived from the real
 * path of the script pi was launched with, each candidate is realpath-verified to live inside that
 * installation's `node_modules`, and a miss fails closed instead of continuing down a search path.
 *
 * (`process.argv[1]` is the bin shim, a symlink into the package, which is why it must be resolved
 * first. A compiled single-file pi has no on-disk package: this throws with that stated.)
 */
async function loadPeer(subpath, bare, check) {
  const entry = process.argv[1] ?? "";
  let real = null;
  try { real = fs.realpathSync(entry); } catch { /* compiled binary or missing shim */ }
  if (!real) throw new Error(`cannot locate pi's installation to load ${bare} from (entry ${entry || "unknown"})`);

  // Walk up from pi's own entry — bounded to a few levels, and each level must actually contain the
  // module — so the search cannot wander into a directory a repository can write to.
  let root = null;
  let dir = path.dirname(real);
  for (let i = 0; i < 4 && dir !== path.dirname(dir); i += 1) {
    if (fs.existsSync(path.join(dir, subpath))) { root = dir; break; }
    dir = path.dirname(dir);
  }
  if (!root) {
    throw new Error(`${bare} is not installed beside the running pi (looked up from ${path.dirname(real)}); this extension uses the copy pi ships, never a search path`);
  }

  const resolved = fs.realpathSync(path.join(root, subpath));
  const realRoot = fs.realpathSync(root);
  if (!resolved.startsWith(realRoot + path.sep)) {
    throw new Error(`${bare} resolved outside pi's installation (${resolved}); refusing to import it`);
  }
  const mod = await import(pathToFileURL(resolved).href);
  if (!check(mod)) throw new Error(`${bare} at ${resolved} did not export what this extension needs`);
  return { mod, from: resolved };
}

let piCache;
export async function loadPi() {
  if (!piCache) {
    piCache = loadPeer("node_modules/@earendil-works/pi-ai/dist/compat.js", "@earendil-works/pi-ai/compat",
      (m) => typeof m.streamSimple === "function")
      .then(({ mod, from }) => ({ streamSimple: mod.streamSimple, createAssistantMessageEventStream: mod.createAssistantMessageEventStream, from }));
  }
  return piCache;
}

let typeboxCache;
/**
 * typebox, because pi-ai's `Tool.parameters` is a TSchema and its adapters serialise it into the
 * provider's tool schema. A plain JSON-schema object looks equivalent but is not: with one, the
 * opencode-go gateway answered `Cannot read properties of undefined (reading 'length')`, while the same
 * request over curl in the OpenAI wire shape returned 200 — measured 2026-09-18. With a Typebox schema
 * the call returns `toolUse` and a toolCall.
 */
export async function loadTypebox() {
  if (!typeboxCache) {
    typeboxCache = loadPeer("node_modules/typebox/build/index.mjs", "typebox", (m) => typeof m.Type?.Object === "function").then(({ mod }) => mod);
  }
  return typeboxCache;
}

export function makeCallModel(getPi) {
  return async function callModel({ model, apiKey, headers, messages, temperature, reasoning, signal, persona, tools, onDelta }) {
    const { streamSimple } = await getPi();
    const context = {
      ...(persona?.prompt ? { systemPrompt: persona.prompt } : {}),
      messages,
      ...(tools ? { tools } : {}),
    };
    const options = { apiKey, headers, signal };
    if (temperature !== undefined) options.temperature = temperature;
    if (reasoning) options.reasoning = reasoning;

    const stream = streamSimple(model, context, options);
    let streamed = "";
    for await (const event of stream) {
      if (event.type === "text_delta" && event.delta) {
        streamed += event.delta;
        onDelta?.(event.delta);
      }
    }
    const message = await stream.result();
    return {
      text: textOf(message.content) || streamed,
      usage: message.usage ?? freshUsage(),
      stopReason: message.stopReason,
      errorMessage: message.errorMessage,
      toolCalls: (message.content ?? []).filter((part) => part?.type === "toolCall"),
    };
  };
}

/* ------------------------------------------------------------------- route */

/**
 * `route` runs before the first stage. Its sufficiency is the same predicate as a seat cascade: an
 * option carrying `then`, at or above the threshold. Not routing is the safe outcome — unsure means
 * spend, not gamble — and the decision is reported either way.
 */
export async function routeFusion({ config, fusion, prompt, decide, emit, signal }) {
  const route = fusion.route;
  if (!route) return { fusion, routing: undefined };

  const answer = await decideOverRoute({ config, route, prompt, decide, signal });
  const option = answer?.choice;
  const entry = route.criteria?.[option];
  const threshold = route.sufficientWhen?.minConfidence ?? 0.5;
  const target = isObject(entry) ? entry.then : undefined;

  if (!target) {
    const routing = { answer, declined: "no option matched" };
    emit.delta(` ├─ ↪ route declined (${option ?? "no answer"}); running ${fusion.id}\n`);
    return { fusion, routing };
  }
  if (route.sufficientWhen && !answerSufficient(answer, route.sufficientWhen)) {
    const routing = { answer, declined: `confidence ${(answer?.confidence ?? 0).toFixed(2)} below ${threshold}` };
    emit.delta(` ├─ ↪ route declined (${option}, conf ${(answer?.confidence ?? 0).toFixed(2)} < ${threshold}); running ${fusion.id}\n`);
    return { fusion, routing };
  }

  const target_ = config.fusions[target];
  emit.delta(` ├─ ↪ routed to ${target} (${option}, conf ${(answer?.confidence ?? 0).toFixed(2)})\n`);
  return { fusion: { ...target_, id: target }, routing: { answer, routedTo: target } };
}

function answerSufficient(answer, sufficientWhen) {
  if (sufficientWhen.choiceIs !== undefined && ![].concat(sufficientWhen.choiceIs).includes(answer?.choice)) return false;
  if (sufficientWhen.noulAbove !== undefined && !(answer?.noul >= sufficientWhen.noulAbove)) return false;
  if (sufficientWhen.scoreAbove !== undefined && !(answer?.score >= sufficientWhen.scoreAbove)) return false;
  if (sufficientWhen.scoreBelow !== undefined && !(answer?.score <= sufficientWhen.scoreBelow)) return false;
  if (sufficientWhen.minConfidence !== undefined && !((answer?.confidence ?? 0) >= sufficientWhen.minConfidence)) return false;
  return true;
}

async function decideOverRoute({ route, prompt, decide, signal }) {
  try {
    const result = await decide({ ...route, state: route.state ?? "{{prompt}}" }, { prompt }, signal);
    return Object.values(result.answers ?? {})[0] ?? null;
  } catch (error) {
    return null;
  }
}

/* ------------------------------------------------------------------ verify */

/**
 * `verify` runs after synthesis and is report-only: it never rewrites or blocks the answer, and a
 * backend failure is reported as skipped rather than as a run failure. A `gate` entry runs a command
 * once — no loop, no feedback into a stage.
 */
export async function verifyRun({ config, fusion, vars, decide, emit, signal, runGate }) {
  const results = [];
  for (const entry of fusion.verify ?? []) {
    if (entry?.gate) {
      try {
        const gate = await runGate(entry.gate, signal);
        const expected = entry.gate.expectExit ?? 0;
        const ok = gate.exit === expected;
        results.push({ check: `gate: ${entry.gate.command.join(" ")}`, result: { exit: gate.exit, expected }, gate });
        if (!ok) {
          emit.delta(` ⚠️ verify: gate "${entry.gate.command.join(" ")}" exited ${gate.exit} (expected ${expected}) — ${gate.output.split("\n").length} lines of output in details\n`);
        }
      } catch (error) {
        results.push({ check: `gate: ${entry.gate.command.join(" ")}`, result: { skipped: error?.message ?? String(error) } });
      }
      continue;
    }
    try {
      const result = await decide(entry, vars, signal);
      const answers = result.answers ?? {};
      results.push({ check: entry.instructions ?? "decision", result: answers });
      for (const [id, answer] of Object.entries(answers)) {
        const low = [];
        if (answer?.noul !== undefined && answer.noul < 0.5) low.push(`${id}=${answer.noul.toFixed(2)}`);
        if (answer?.confidence !== undefined && answer.confidence < 0.5) low.push(`${id} confidence ${answer.confidence.toFixed(2)}`);
        if (answer?.type === "choice" && answer.choice && /ignore|none|unclear|no$/i.test(answer.choice)) low.push(`${id}=${answer.choice}`);
        if (low.length) emit.delta(` ⚠️ verify: ${low.join(", ")} — see details.verification\n`);
      }
    } catch (error) {
      results.push({ check: entry.instructions ?? "decision", result: { skipped: error?.message ?? String(error) } });
    }
  }
  return results;
}

/* -------------------------------------------------------------- file agent */

/**
 * The file agent: one cheap seat decides whether the synthesis contains files worth saving, and pi
 * executes the writes. It is not a stage — it sits outside the pipeline, as the reference
 * implementation had it — and `fileAgent: false` skips it entirely.
 */
export async function fileAgentStep({ config, fusion, prompt, synthesis, registry, callModel, signal, emit, isBroken }) {
  if (!fusion.fileAgent) return { toolCalls: [], usage: freshUsage() };
  const candidates = [fusion.fileAgent.alias];
  for (const candidate of candidates) {
    for (const resolved of resolveCandidates(config, candidate)) {
      const seat = await seatRequest(registry, resolved);
      if (!seat.ok) { emit.delta(` ├─ ️ file agent skipped: ${seat.reason} — ${seat.detail}\n`); return { toolCalls: [], usage: freshUsage() }; }
      let message;
      try {
        message = await callModel({
          model: seat.model, apiKey: seat.apiKey, headers: seat.headers, signal,
          // The instruction goes in pi-ai's `systemPrompt`, not as a system *message*: measured
          // 2026-09-18, a system-role message alongside `tools` makes the call fail with
          // `Cannot read properties of undefined (reading 'length')` on the same model that works
          // without it.
          persona: { prompt: FIXED_SYSTEM },
          messages: [{
            role: "user",
            content: `Original user request: ${prompt}\n\nDeliberation synthesis:\n${synthesis}\n\nSave the file(s) now using the write tool, or confirm if nothing needs saving.`,
          }],
          tools: writeTool((await loadTypebox()).Type),
        });
      } catch (error) {
        emit.delta(` ├─ ️ file agent skipped: ${(error?.message ?? String(error)).slice(0, 160)}\n`);
        return { toolCalls: [], usage: freshUsage() };
      }
      if (message.stopReason === "error") {
        const text = message.errorMessage ?? "unknown error";
        emit.delta(` ├─ ️ file agent skipped (${classifyFailure(text)}): ${text.slice(0, 140)}\n`);
        return { toolCalls: [], usage: freshUsage() };
      }
      return { toolCalls: message.toolCalls ?? [], usage: message.usage ?? freshUsage() };
    }
  }
  return { toolCalls: [], usage: freshUsage() };
}

const FIXED_SYSTEM = "You are a file-saving agent. You receive a deliberation synthesis that may contain code, files, or project structure. Use the write tool to save every file the user would expect from the original request. Choose sensible filenames inferred from the request and the code's language. If the synthesis contains no files to save (e.g. it is a conceptual answer), do NOT call any tool — just reply with a brief one-line acknowledgment. Never explain at length; either call write tool(s) or give a one-line confirmation.";

/* ------------------------------------------------------------------ stream */

/**
 * The provider's `streamSimple`. Returns a stream synchronously; the pipeline runs in a microtask, as
 * pi requires.
 */
export function createFusionStream({ config, sources, getRegistry, decide, callModel, getPi }) {
  return function fusionStream(model, context, options) {
    let outer;
    const events = [];
    const pending = [];
    // Deliver to a waiting consumer OR queue for a later one — never both, or every event arrives
    // twice (which pi renders as each token duplicated).
    const push = (event) => {
      const waiter = pending.shift();
      if (waiter) waiter({ value: event, done: false });
      else events.push(event);
    };
    let finished = false;
    let result = undefined;
    const resultWaiters = [];

    const base = {
      role: "assistant", api: model.api, provider: model.provider, model: model.id,
      usage: freshUsage(), stopReason: "stop", timestamp: Date.now(),
    };
    const message = (text, extra = {}) => ({ ...base, content: [{ type: "text", text }], ...extra });

    outer = {
      push,
      end(finalResult) {
        finished = true;
        result = finalResult ?? result;
        while (pending.length) pending.shift()({ value: undefined, done: true });
        while (resultWaiters.length) resultWaiters.shift()(result);
      },
      [Symbol.asyncIterator]: () => ({ next: async () => (events.length ? { value: events.shift(), done: false } : finished ? { value: undefined, done: true } : new Promise((resolve) => pending.push(resolve))) }),
      result: () => (finished ? Promise.resolve(result) : new Promise((resolve) => resultWaiters.push(resolve))),
    };

    let streamed = "";
    const emit = {
      delta: (text) => {
        if (!text) return;
        streamed += text;
        push({ type: "text_delta", contentIndex: 0, delta: text, partial: message(streamed) });
      },
      substitution: (entry) => {
        const line = ` ├─ ↩ ${entry.seat} ${entry.from} → ${entry.to} (${entry.reason})\n`;
        streamed += line;
        push({ type: "text_delta", contentIndex: 0, delta: line, partial: message(streamed) });
      },
    };

    queueMicrotask(async () => {
      try {
        const registry = getRegistry?.() ?? null;
        const fusionId = model.id;
        let fusion = { ...config.fusions[fusionId], id: fusionId };
        if (!fusion.mode) throw new Error(`unknown fusion "${fusionId}"`);
        const prompt = extractPrompt(context.messages);

        push({ type: "start", partial: { ...base, content: [] } });
        push({ type: "text_start", contentIndex: 0, partial: message("") });

        let routing;
        const routed = await routeFusion({ config, fusion, prompt, decide, emit, signal: options?.signal });
        fusion = routed.fusion;
        routing = routed.routing;

        const run = await runPipeline({
          config, sources, fusion, prompt, registry, callModel, decide, emit, signal: options?.signal,
        });

        // A run whose every seat failed must say so instead of presenting progress lines as an answer.
        const seats = run.details.seats ?? [];
        const failed = seats.filter((s) => s.degraded);
        if (!run.text.trim() && failed.length > 0) {
          const reasons = [...new Set(failed.map((s) => s.reason).filter(Boolean))].join(", ") || "unknown";
          emit.delta(`\n⚠️ No deliberation happened: ${failed.length} of ${seats.length} seats were unavailable (${reasons}). Nothing was synthesized — this is not an answer.\n`);
        }

        const vars = run.vars ?? { prompt, panel: "", judge: run.text, synthesis: run.text, cwd: process.cwd() };
        const usage = run.usage;
        accumulateUsage(usage, run.decisionUsage);

        const verification = await verifyRun({ config, fusion, vars, decide, emit, signal: options?.signal, runGate: makeRunGate(options?.signal) });
        const files = await fileAgentStep({ config, fusion, prompt, synthesis: run.text, registry, callModel, signal: options?.signal, emit });

        const toolCalls = files.toolCalls ?? [];
        const content = [{ type: "text", text: streamed }];
        for (let i = 0; i < toolCalls.length; i += 1) {
          const block = { type: "toolCall", id: toolCalls[i].id || `call_${Date.now()}_${i}`, name: toolCalls[i].name, arguments: toolCalls[i].arguments };
          content.push(block);
          const partial = { ...base, content: [...content], usage, stopReason: "toolUse" };
          push({ type: "toolcall_start", contentIndex: 1 + i, partial });
          push({ type: "toolcall_end", contentIndex: 1 + i, toolCall: block, partial });
        }

        const details = { ...run.details, routing, verification, usage, decisionUsage: run.decisionUsage };
        const final = { ...base, content, usage, stopReason: toolCalls.length ? "toolUse" : "stop", details };
        push({ type: "text_end", contentIndex: 0, content: streamed, partial: message(streamed, { usage }) });
        push({ type: "done", reason: final.stopReason, message: final });
        outer.end(final);
      } catch (error) {
        const reason = error?.message ?? String(error);
        const failed = message(`Fusion error: ${reason}`, { stopReason: "error", errorMessage: reason });
        push({ type: "error", reason: "error", error: failed });
        outer.end(failed);
      }
    });

    return outer;
  };
}

const GATE_OUTPUT_BYTES = 64 * 1024;
const GATE_KILL_GRACE_MS = 5000;

/**
 * A gate runs once, in the session cwd, with bounded output. No loop, no feedback into a stage.
 *
 * Output is a ring buffer, not an unbounded string (a gate that prints forever must not exhaust the
 * process), and the timeout escalates SIGTERM → SIGKILL so a child that ignores the first signal cannot
 * hang the run. `gate.command` is argv, never a shell — and config validation allows a gate only from a
 * trusted layer, so a repository cannot ask for one.
 */
export function makeRunGate(parentSignal) {
  return async function runGate(gate, signal) {
    const { spawn } = await import("node:child_process");
    const [command, ...args] = gate.command;
    const child = spawn(command, args, { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    const collect = (chunk) => {
      output += chunk.toString();
      if (output.length > GATE_OUTPUT_BYTES) output = output.slice(-GATE_OUTPUT_BYTES);
    };
    child.stdout?.on("data", collect);
    child.stderr?.on("data", collect);

    let timedOut = false;
    let killTimer;
    const escalate = () => {
      timedOut = true;
      try { child.kill("SIGTERM"); } catch { /* already gone */ }
      killTimer = setTimeout(() => { try { child.kill("SIGKILL"); } catch { /* already gone */ } }, GATE_KILL_GRACE_MS);
    };
    const timer = setTimeout(escalate, gate.timeoutMs ?? 120000);
    const onAbort = () => escalate();
    (signal ?? parentSignal)?.addEventListener?.("abort", onAbort, { once: true });

    const exit = await new Promise((resolve) => {
      child.on("close", (code) => resolve(code ?? 0));
      child.on("error", () => resolve(-1));
    });
    clearTimeout(timer);
    if (killTimer) clearTimeout(killTimer);
    (signal ?? parentSignal)?.removeEventListener?.("abort", onAbort);
    return { exit: timedOut ? -1 : exit, timedOut, output: output.split("\n").slice(-40).join("\n") };
  };
}

/** The typed prompt is the first message of the trailing run of user messages (see the fork's fix). */
export function extractPrompt(messages) {
  const msgs = messages ?? [];
  let index = msgs.length - 1;
  let prompt = "";
  while (index >= 0 && msgs[index]?.role === "user") {
    prompt = typeof msgs[index].content === "string" ? msgs[index].content : textOf(msgs[index].content);
    index -= 1;
  }
  if (prompt.trim()) return prompt.trim();
  for (let i = msgs.length - 1; i >= 0; i -= 1) {
    if (msgs[i]?.role === "user") {
      const text = typeof msgs[i].content === "string" ? msgs[i].content : textOf(msgs[i].content);
      if (text.trim()) return text.trim();
    }
  }
  return "";
}