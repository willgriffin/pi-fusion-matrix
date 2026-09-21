/**
 * run.js — the pi-facing adapter: one assistant message per fusion run.
 *
 * Owns everything that speaks pi's protocol or pi-ai:
 *   - the AssistantMessageEvent stream (`start` before any delta, every partial a complete message,
 *     `toolcall_*` pairs so pi executes the file agent's writes, `done` carrying the tool blocks);
 *   - `route` before the pipeline and `verify` after it (both report-only);
 *   - the `callModel` seam the pipeline injects, so pipeline.js stays free of pi imports;
 *   - usage accumulation across every seat and decision;
 *   - the proxy branch: a tool-bearing turn on a fusion that declares an executor goes to that model
 *     with the harness's own context, and its events come back unaltered.
 *
 * Seats are pi-ai calls made with a model object built from pi's registry (resolve.js). The pi-ai
 * stream is consumed directly, which is also how the final answer streams token-by-token.
 */

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { resolveCandidates, seatRequest, label, isObject } from "./resolve.js";
import { runPipeline, freshUsage, accumulateUsage, isSufficient, isThinkingRefusal } from "./pipeline.js";
import { harnessName, executorOf, executorThinking } from "./config.js";

/**
 * pi-ai's `Tool` shape. `parameters` arrives ready-made from the caller, because the schema builder is
 * harness-specific and the two harnesses spell the very same two fields differently: omp injects
 * `pi.zod` (`z.object({ path: z.string() })`), while pi expects the extension to bring `typebox`
 * (`Type.Object({ path: Type.String() })`). Building it where the harness API object lives keeps that
 * one branch in one place instead of teaching this file two dialects.
 */
export function writeTool(parameters) {
  return [
    {
      name: "write",
      description:
        "Write content to a file: `path` (relative to the project root) and `content` (the full file body, not a diff). Create one file per tool call.",
      parameters,
    },
  ];
}

const textOf = (content) =>
  (content ?? [])
    .filter((part) => part?.type === "text")
    .map((part) => part.text)
    .join("");

/** The same taxonomy seats use, so a file-agent failure reads as `quota` rather than as noise. */
export function classifyFailure(text) {
  const message = String(text ?? "");
  if (/\b429\b|usage limit|quota|balance/i.test(message)) return "quota";
  if (/\b40[13]\b|unauthorized|invalid api key/i.test(message)) return "credential";
  if (/not found|unknown model|\b404\b/i.test(message)) return "missing model";
  return "transient";
}

/**
 * Peer modules come from the running harness's own installation, and nothing else.
 *
 * One extension, two harnesses: pi ships `@earendil-works/pi-ai` with a compiled `compat.js`, and omp —
 * a fork of the same stack under its own scope — ships `@oh-my-pi/pi-ai` with the same `streamSimple`
 * exported from its (TypeScript, Bun-run) source entry. Both are tried in order, and both are held to
 * the same rule.
 *
 * The tempting alternative — walking ancestors of the entry script freely — was a supply-chain hole: a
 * module planted in any writable ancestor directory is *executed* by `import` before any check, and
 * would then receive the harness's resolved credential for every seat. So the search starts from the
 * real path of the script the harness was launched with (`process.argv[1]` is the bin shim, a symlink
 * into the package), stops after {@link PEER_WALK_LEVELS} levels, requires each candidate to exist, and
 * realpath-verifies that it lives inside the directory it was found in. A miss fails closed instead of
 * continuing down a search path.
 *
 * The bound is what keeps a planted `$HOME/node_modules/…` unreachable: pi keeps its peers inside its
 * own package (one level up), and a hoisted install such as Bun's global root keeps them three to four
 * levels up — while the user's home is further up still. A compiled single-file harness has no on-disk
 * package to walk to, and this says so.
 */
const PEER_WALK_LEVELS = 6;

/** A usage that spent something: the tokens or the priced total, not the presence of the object. */
const spentSomething = (usage) =>
  (usage.input ?? 0) + (usage.output ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0) > 0 || (usage.cost?.total ?? 0) > 0;

const PEERS = [
  { harness: "pi", subpath: "node_modules/@earendil-works/pi-ai/dist/compat.js", bare: "@earendil-works/pi-ai/compat" },
  { harness: "omp", subpath: "node_modules/@oh-my-pi/pi-ai/src/index.ts", bare: "@oh-my-pi/pi-ai" },
];

/** The running harness's peer first, then the other one, so the usual case costs one lookup. */
const peersFor = (harness) => [...PEERS.filter((peer) => peer.harness === harness), ...PEERS.filter((peer) => peer.harness !== harness)];

async function loadPeer(peer, check) {
  const entry = process.argv[1] ?? "";
  let real = null;
  try {
    real = fs.realpathSync(entry);
  } catch {
    /* compiled binary or missing shim */
  }
  if (!real) throw new Error(`cannot locate the harness installation to load ${peer.bare} from (entry ${entry || "unknown"})`);

  let root = null;
  let dir = path.dirname(real);
  for (let i = 0; i < PEER_WALK_LEVELS && dir !== path.dirname(dir); i += 1) {
    if (fs.existsSync(path.join(dir, peer.subpath))) {
      root = dir;
      break;
    }
    dir = path.dirname(dir);
  }
  if (!root) {
    throw new Error(
      `no ${peer.bare} found beside the running harness (looked from ${path.dirname(real)} up ${PEER_WALK_LEVELS} levels); this extension uses the module the harness ships, never a search path outside its installation`,
    );
  }

  const resolved = fs.realpathSync(path.join(root, peer.subpath));
  const realRoot = fs.realpathSync(root);
  if (!resolved.startsWith(realRoot + path.sep)) {
    throw new Error(`${peer.bare} resolved outside its installation (${resolved}); refusing to import it`);
  }
  const mod = await import(pathToFileURL(resolved).href);
  if (!check(mod)) throw new Error(`${peer.bare} at ${resolved} did not export what this extension needs`);
  return { mod, from: resolved, harness: peer.harness };
}

let piCache;
/** The harness's streaming entry: `streamSimple`, resolved from whichever installation is running us. */
export async function loadPi() {
  if (!piCache) {
    piCache = (async () => {
      const failures = [];
      for (const peer of peersFor(harnessName())) {
        try {
          const { mod, from, harness } = await loadPeer(peer, (m) => typeof m.streamSimple === "function");
          return { streamSimple: mod.streamSimple, from, harness };
        } catch (error) {
          failures.push(`${peer.harness}: ${error.message}`);
        }
      }
      throw new Error(`no usable harness peer for streamSimple\n  ${failures.join("\n  ")}`);
    })();
  }
  return piCache;
}

const SCHEMA_PEER = { harness: "pi", subpath: "node_modules/typebox/build/index.mjs", bare: "typebox" };

let typeboxCache;
/**
 * The schema builder for a harness that does not inject one. pi expects an extension to bring
 * `typebox` (a bundled peer) because pi-ai's `Tool.parameters` is a TSchema and its adapters serialise
 * it into the provider's tool schema; omp injects `pi.zod` instead, so this path is pi's alone.
 *
 * A plain JSON-schema object is not a substitute: with one, the opencode-go gateway answered
 * `Cannot read properties of undefined (reading 'length')`, while the same request over curl in the
 * OpenAI wire shape returned 200 — measured 2026-09-18. With a real schema builder the call returns
 * `toolUse` and a toolCall.
 */
export async function loadTypebox() {
  if (!typeboxCache) {
    typeboxCache = loadPeer(SCHEMA_PEER, (m) => typeof m.Type?.Object === "function").then(({ mod }) => mod);
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

  const { answer, error } = await decideOverRoute({ route, prompt, decide, signal });
  const option = answer?.choice;
  const entry = route.criteria?.[option];
  // The default gate is `{ minConfidence: 0.5 }` — unsure means spend, not gamble — and it is recorded
  // in `details.routing` so the effective threshold is visible rather than implied.
  const sufficientWhen = route.sufficientWhen ?? { minConfidence: 0.5 };
  const threshold = sufficientWhen.minConfidence ?? 0.5;
  const target = isObject(entry) ? entry.then : undefined;

  if (error) {
    const routing = { answer, threshold, declined: `decision unavailable: ${error}` };
    emit.delta(` ├─ ↪ route declined (${error.slice(0, 120)}); running ${fusion.id}\n`);
    return { fusion, routing };
  }
  if (!target) {
    // An option that matches but carries no `then` is a *choice to run this fusion* — the review router's
    // `high` class, and the escalation a route takes when the strongest rung is its own. Calling that a decline
    // would misdescribe a deliberate decision in `details.routing`, which the report reads.
    const matched = option !== undefined && route.criteria?.[option] !== undefined;
    const routing = matched ? { answer, threshold, escalated: option } : { answer, threshold, declined: "no option matched" };
    emit.delta(
      matched
        ? ` ├─ ↪ "${option}" runs ${fusion.id} (the option declares no target)\n`
        : ` ├─ ↪ route declined (${option ?? "no answer"}); running ${fusion.id}\n`,
    );
    return { fusion, routing };
  }
  if (!isSufficient(answer, sufficientWhen)) {
    const routing = { answer, threshold, declined: `confidence ${(answer?.confidence ?? 0).toFixed(2)} below ${threshold}` };
    emit.delta(` ├─ ↪ route declined (${option}, conf ${(answer?.confidence ?? 0).toFixed(2)} < ${threshold}); running ${fusion.id}\n`);
    return { fusion, routing };
  }

  const target_ = config.fusions[target];
  emit.delta(` ├─ ↪ routed to ${target} (${option}, conf ${(answer?.confidence ?? 0).toFixed(2)})\n`);
  return { fusion: { ...target_, id: target }, routing: { answer, threshold, routedTo: target } };
}

async function decideOverRoute({ route, prompt, decide, signal }) {
  try {
    const result = await decide({ ...route, state: route.state ?? "{{prompt}}" }, { prompt }, signal);
    return { answer: Object.values(result.answers ?? {})[0] ?? null };
  } catch (error) {
    // An outage is not "no option matched": the routing record must say what happened.
    return { answer: null, error: error?.message ?? String(error) };
  }
}

/* ------------------------------------------------------------------ verify */

/**
 * `verify` runs after synthesis and is report-only: it never rewrites or blocks the answer, and a
 * backend failure is reported as skipped rather than as a run failure. A `gate` entry runs a command
 * once — no loop, no feedback into a stage.
 */
export async function verifyRun({ fusion, vars, decide, emit, signal, runGate }) {
  const results = [];
  for (const entry of fusion.verify ?? []) {
    if (entry?.gate) {
      try {
        const gate = await runGate(entry.gate, signal);
        const expected = entry.gate.expectExit ?? 0;
        const ok = gate.exit === expected;
        results.push({ check: `gate: ${entry.gate.command.join(" ")}`, result: { exit: gate.exit, expected }, gate });
        if (!ok) {
          emit.delta(
            ` ⚠️ verify: gate "${entry.gate.command.join(" ")}" exited ${gate.exit} (expected ${expected}) — ${gate.output.split("\n").length} lines of output in details\n`,
          );
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
        if (answer?.type === "choice" && answer.choice && /ignore|none|unclear|no$/i.test(answer.choice))
          low.push(`${id}=${answer.choice}`);
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
export async function fileAgentStep({ config, fusion, prompt, synthesis, registry, callModel, signal, emit, getWriteParameters }) {
  if (!fusion.fileAgent) return { toolCalls: [], usage: freshUsage() };
  const candidates = [fusion.fileAgent.alias];
  // The alias's provider chain is walked in order, exactly as a seat's is: a route that cannot resolve
  // (or cannot answer) advances instead of ending the file agent on its first provider.
  const failures = [];
  for (const candidate of candidates) {
    for (const resolved of resolveCandidates(config, candidate)) {
      const seat = await seatRequest(registry, resolved);
      if (!seat.ok) {
        failures.push(`${label(resolved)} (${seat.reason}: ${seat.detail})`);
        continue;
      }
      let message;
      try {
        message = await callModel({
          model: seat.model,
          apiKey: seat.apiKey,
          headers: seat.headers,
          signal,
          // The instruction goes in pi-ai's `systemPrompt`, not as a system *message*: measured
          // 2026-09-18, a system-role message alongside `tools` makes the call fail with
          // `Cannot read properties of undefined (reading 'length')` on the same model that works
          // without it.
          persona: { prompt: FIXED_SYSTEM },
          messages: [
            {
              role: "user",
              content: `Original user request: ${prompt}\n\nDeliberation synthesis:\n${synthesis}\n\nSave the file(s) now using the write tool, or confirm if nothing needs saving.`,
            },
          ],
          tools: writeTool(await getWriteParameters()),
        });
      } catch (error) {
        const detail = error?.message ?? String(error);
        failures.push(`${label(resolved)} (${classifyFailure(detail)}: ${detail.slice(0, 120)})`);
        continue;
      }
      if (message.stopReason === "error") {
        const text = message.errorMessage ?? "unknown error";
        failures.push(`${label(resolved)} (${classifyFailure(text)}: ${text.slice(0, 120)})`);
        continue;
      }
      return { toolCalls: message.toolCalls ?? [], usage: message.usage ?? freshUsage() };
    }
  }
  // Every route tried, named once: a file agent that could not start says where it looked.
  emit.delta(` ├─ ️ file agent skipped: ${failures.join("; ") || "no routes configured"}\n`);
  return { toolCalls: [], usage: freshUsage() };
}

const FIXED_SYSTEM =
  "You are a file-saving agent. You receive a deliberation synthesis that may contain code, files, or project structure. Use the write tool to save every file the user would expect from the original request. Choose sensible filenames inferred from the request and the code's language. If the synthesis contains no files to save (e.g. it is a conceptual answer), do NOT call any tool — just reply with a brief one-line acknowledgment. Never explain at length; either call write tool(s) or give a one-line confirmation.";

/* ------------------------------------------------------------------- proxy */

/**
 * The proxied turn: one model call that *is* the turn.
 *
 * `context.messages`, `context.tools`, and `context.systemPrompt` go to the writing alias's route
 * untouched, and its events — tool calls included — come straight back. Nothing of this extension is
 * added to the message: in a coding turn a status line lands in the conversation and corrupts the
 * agent loop, so an unreachable target is an error message rather than a substitute answer, and every
 * route the alias walked is recorded in `details.proxied.attempts` instead of written into the stream.
 *
 * The one rewrite is identity: a forwarded event is re-labelled as the fusion's registered model, which
 * is what the harness matches on to decide whether an overflow or a truncated response is its own to
 * recover from (`pi` 0.85.1 `dist/core/agent-session.js`, `_checkCompaction`'s `sameModel`). Everything
 * else — content blocks, signed thinking, `responseId`, usage, provider session state — passes through,
 * because prompt caching and response chaining are built on it.
 */
export async function proxyTurn({ config, fusion, executor, context, options, registry, getPi, model, push, end, message }) {
  const attempts = [];
  const fail = (reason, proxied = {}) => {
    const text = `Fusion proxy error: ${reason}`;
    const failed = message(text, {
      stopReason: "error",
      errorMessage: text,
      details: { proxied: { alias: executor.alias, ...proxied, attempts } },
    });
    push({ type: "error", reason: "error", error: failed });
    end(failed);
  };

  let streamSimple;
  try {
    ({ streamSimple } = await getPi());
  } catch (error) {
    return fail(error?.message ?? String(error));
  }

  // Per fusion, for the writing seat only. `undefined` means "whatever the harness sent", which is also
  // what an unset level means: the harness resolves `auto` before we see it, so there is nothing to read.
  const level = executorThinking(config, fusion);

  // `executor.route` is the writer's *candidate* — whose object form carries the seat's own provider
  // order and `modelOverride`, so the turn walks the route that seat's deliberation walks — unless
  // `proxy.alias` names a different model outright, whose providers are then its own.
  for (const resolved of resolveCandidates(config, executor.route)) {
    const seat = await seatRequest(registry, resolved);
    if (!seat.ok) {
      attempts.push({
        alias: resolved.alias,
        seat: label(resolved),
        provider: resolved.provider,
        model: resolved.model,
        reason: seat.reason,
        detail: seat.detail,
      });
      continue;
    }

    // The harness's own options, with the target's credential and headers: `signal`, `temperature`,
    // `sessionId`, `metadata`, `thinkingBudgets`, and `providerSessionState` are all cache and
    // attribution facts, and re-inventing them would pay full input price on every turn.
    const targetOptions = { ...options, apiKey: seat.apiKey, headers: seat.headers };
    if (level !== undefined) targetOptions.reasoning = level;

    const identified = (part) =>
      part && (part.provider !== model.provider || part.model !== model.id)
        ? { ...part, api: model.api, provider: model.provider, model: model.id }
        : part;
    const forwarded = (event) => {
      if (!event.partial && !event.message && !event.error) return event;
      const copy = { ...event };
      if (event.partial) copy.partial = identified(event.partial);
      if (event.message) copy.message = identified(event.message);
      if (event.error) copy.error = identified(event.error);
      return copy;
    };

    // The run record rides the terminal message, not `result()`: a consumer takes the turn from the
    // `done`/`error` event's message (`agent-loop.js` replaces `context.messages[last]` with each
    // partial and ends on the terminal event), so details attached only to the result would never be
    // seen — measured 2026-09-19: pi persisted the pipeline's `details` and nothing for a proxied turn.
    // `thinking` follows `targetOptions`, so a level this route had to drop is recorded as dropped
    // rather than as the level the turn did not run at; `attempts` carries the refusal itself.
    const proxied = {
      alias: resolved.alias,
      provider: resolved.provider,
      model: resolved.model,
      template: seat.template,
      thinking: targetOptions.reasoning ?? null,
      attempts,
      ...workItemDetail(),
    };
    const dressed = (part) => (part ? { ...identified(part), details: { ...(part.details ?? {}), proxied } } : part);

    // A thinking level the target refuses is our request rather than its failure, and it can surface
    // either where the stream is created or where it is first pulled — pi-ai providers open the request
    // lazily, measured 2026-09-19 on omp's `Thinking effort low is not supported by
    // alibaba-token-plan/deepseek-v4.1-flash`. Either way it is retried once without a level, on the
    // same memory the seat path uses, and recorded in `attempts` rather than dropped quietly.
    let retriedLevel = false;
    const dropLevel = (detail) => {
      if (retriedLevel || !targetOptions.reasoning || !isThinkingRefusal(detail)) return false;
      retriedLevel = true;
      // Deliberately *not* recorded in the seat path's per-model memory: that memory exists so a seat does
      // not retry a level twice, and a suppressed retry in a proxied turn is a failed turn. A refusal here
      // costs one extra call on the next turn rather than turning `/matrix` on the same rung into a
      // degradation.
      delete targetOptions.reasoning;
      proxied.thinking = null;
      return true;
    };

    // One route attempt is three things that can fail: creating the stream, pulling its first event, and
    // the rest of the stream. The first two are recoverable — nothing has reached the harness, so the next
    // provider, or this one without a refused level, still gets the turn — and the third is not, because pi
    // pushes the partial into its conversation on `start` and a second provider's `start` would append a
    // second assistant message.
    const record = (detail) => {
      // `usage` only when this route spent something before it failed: an attempt that never reached a model
      // has no tokens to report, and writing zeros there would read as "it cost nothing" rather than "nothing
      // was spent".
      attempts.push({
        alias: resolved.alias,
        seat: label(resolved),
        provider: resolved.provider,
        model: resolved.model,
        reason: classifyFailure(detail),
        detail,
        ...(lastUsage ? { usage: lastUsage } : {}),
      });
    };

    // The usage of the last partial the caller saw: a route that streamed then failed spent those tokens, and
    // without this the only thing visible about it is that it failed. Declared outside the attempt loop so the
    // create-throw path — which runs before anything inside the loop is initialised — can read it.
    let lastUsage = null;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      lastUsage = null;
      let target;
      try {
        target = streamSimple(seat.model, context, targetOptions);
      } catch (error) {
        const detail = error?.message ?? String(error);
        record(detail);
        if (dropLevel(detail)) continue;
        break;
      }

      let terminal = null;
      let terminalMessage = null;
      let sent = 0;
      // An `error` event *before* anything else is a route that never began rather than a turn that
      // failed: pi has not seen a partial, so the same recovery as a throw applies and the failure is
      // recorded. Past the first event nothing is recoverable, so it is forwarded verbatim.
      let beforeStart = null;
      try {
        for await (const event of target) {
          const copy = forwarded(event);
          if (copy.type === "error" && sent === 0) {
            beforeStart = copy.error?.errorMessage ?? "target reported an error before any event";
            break;
          }
          // A partial's usage starts as `freshUsage()` — a zero-valued object — so truthiness alone would record
          // a spend for a route that never reached a model. Only a usage that spent something counts.
          if (copy.partial?.usage && spentSomething(copy.partial.usage)) lastUsage = copy.partial.usage;
          if (copy.type === "done") {
            copy.message = dressed(copy.message);
            terminal = "done";
            terminalMessage = copy.message;
          }
          if (copy.type === "error") {
            copy.error = dressed(copy.error);
            terminal = "error";
            terminalMessage = copy.error;
          }
          push(copy);
          sent += 1;
        }
      } catch (error) {
        const detail = error?.message ?? String(error);
        record(detail);
        if (sent === 0 && dropLevel(detail)) continue;
        if (sent === 0) break;
        return fail(`target stream failed after ${sent} events: ${detail}`, {
          alias: resolved.alias,
          provider: resolved.provider,
          model: resolved.model,
          template: seat.template,
          thinking: proxied.thinking,
        });
      }
      if (beforeStart !== null) {
        record(beforeStart);
        if (dropLevel(beforeStart)) continue;
        break;
      }

      // `result()` can reject after the target has already emitted events, and that is not a second answer:
      // pi appends a second terminal message as another assistant message, so a committed turn has to end
      // with what the caller already holds. Before the first event the route is still free to retry the
      // level or walk on, exactly like a stream that failed at its first pull.
      let final;
      try {
        final = dressed(await target.result());
      } catch (error) {
        const detail = error?.message ?? String(error);
        // `record` appends to the very `attempts` array an already-dressed terminal message points at, so a
        // failure recorded here still reaches a record the caller has been handed.
        record(detail);
        if (sent === 0) {
          if (dropLevel(detail)) continue;
          break;
        }
        const ending = terminalMessage ?? dressed(message(`Fusion proxy error: ${detail}`, { stopReason: "error", errorMessage: detail }));
        if (terminal === null) push({ type: "error", reason: "error", error: ending });
        end(ending);
        return;
      }
      // A target that ended without a terminal event leaves the harness's loop waiting on a stream that
      // never completes. The result is the same message, so it becomes the terminal event itself.
      if (terminal === null) {
        push(
          final.stopReason === "stop" || final.stopReason === "length" || final.stopReason === "toolUse"
            ? { type: "done", reason: final.stopReason, message: final }
            : { type: "error", reason: final.stopReason === "aborted" ? "aborted" : "error", error: final },
        );
      }
      end(final);
      return;
    }
    // Every attempt on this route failed without reaching the caller, so the alias's next provider gets
    // the turn.
  }

  const detail =
    attempts.map((a) => `${a.seat} (${a.reason}: ${String(a.detail ?? "").slice(0, 140)})`).join("; ") ||
    `alias "${executor.alias}" has no providers`;
  fail(`no route for "${executor.alias}" could be reached — ${detail}`);
}

/**
 * The work item these runs were for, when the process was started for a known piece of work.
 *
 * A label is the half of the telemetry a run cannot know about itself (what the work was for, how it ended),
 * and it is written by whomever knows. The *work item* half is different: a review runner launched for issue
 * #21 knows what it is for at launch, and its session is one nobody can type a command into afterwards. So the
 * item travels in the environment, lands on the run record, and the report attributes the run from the record
 * rather than from a label that will never exist.
 */
export const workItemDetail = () => {
  const workItem = process.env.MATRIX_WORK_ITEM?.trim();
  return workItem ? { workItem } : {};
};

/* ------------------------------------------------------------------ stream */

/**
 * The provider's `streamSimple`. It must return a stream synchronously, while `@earendil-works/pi-ai`
 * is resolved asynchronously — the peer is loaded lazily so a pi whose installation cannot be walked
 * (a compiled single-file build) still registers its models and fails per seat rather than at load. So
 * the stream is emitted here, to the same shape the library's `AssistantMessageEventStream` implements
 * (plan §Step 6.6): queue-or-waiter delivery, `end`, async iteration, `result`.
 */
export function createFusionStream({ config, sources, getRegistry, decide, callModel, getPi, getWriteParameters }) {
  return function fusionStream(model, context, options) {
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
      role: "assistant",
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage: freshUsage(),
      stopReason: "stop",
      timestamp: Date.now(),
    };
    const message = (text, extra = {}) => ({ ...base, content: [{ type: "text", text }], ...extra });

    const outer = {
      push,
      end(finalResult) {
        finished = true;
        result = finalResult ?? result;
        while (pending.length) pending.shift()({ value: undefined, done: true });
        while (resultWaiters.length) resultWaiters.shift()(result);
      },
      [Symbol.asyncIterator]: () => ({
        next: async () =>
          events.length
            ? { value: events.shift(), done: false }
            : finished
              ? { value: undefined, done: true }
              : new Promise((resolve) => pending.push(resolve)),
      }),
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
        const messages = context.messages ?? [];
        const prompt = extractPrompt(messages);

        // The proxy branch, selected by invocation rather than by guessing: a fusion that declares an
        // executor, reached with the harness's tools in the context, answers the turn itself. A context
        // with no tools means no agent loop to serve, so the deliberation runs exactly as it always has.
        const executor = executorOf(config, fusion);
        if (executor && Array.isArray(context.tools) && context.tools.length > 0) {
          await proxyTurn({
            config,
            fusion,
            executor,
            context,
            options,
            registry,
            getPi,
            model,
            push,
            end: (final) => outer.end(final),
            message,
          });
          return;
        }

        push({ type: "start", partial: { ...base, content: [] } });
        push({ type: "text_start", contentIndex: 0, partial: message("") });

        // A write result is the end of the run, not the start of a new one.
        const writeResults = trailingWriteResults(messages);
        if (writeResults.length > 0) {
          const saved = savedPathsFor(messages, writeResults);
          const confirmation =
            saved.length > 0
              ? `✅ Saved ${saved.length} file${saved.length > 1 ? "s" : ""}:\n${saved.map((file) => `  • \`${file}\``).join("\n")}`
              : `✅ Saved ${writeResults.length} file${writeResults.length > 1 ? "s" : ""}.`;
          emit.delta(confirmation);
          const final = message(confirmation);
          push({ type: "text_end", contentIndex: 0, content: confirmation, partial: final });
          push({ type: "done", reason: "stop", message: final });
          outer.end(final);
          return;
        }

        const routed = await routeFusion({ config, fusion, prompt, decide, emit, signal: options?.signal });
        fusion = routed.fusion;
        const routing = routed.routing;

        const run = await runPipeline({
          config,
          sources,
          fusion,
          prompt,
          registry,
          callModel,
          decide,
          emit,
          signal: options?.signal,
        });

        // A run whose every seat failed must say so instead of presenting progress lines as an answer.
        const seats = run.details.seats ?? [];
        const failed = seats.filter((s) => s.degraded);
        if (!run.text.trim() && failed.length > 0) {
          const reasons = [...new Set(failed.map((s) => s.reason).filter(Boolean))].join(", ") || "unknown";
          emit.delta(
            `\n⚠️ No deliberation happened: ${failed.length} of ${seats.length} seats were unavailable (${reasons}). Nothing was synthesized — this is not an answer.\n`,
          );
        }

        // A mode that ends in `render`, in `decide`, or in a stage a sufficient decision skipped produces
        // its answer without a model call, so nothing carried it into the stream: send it here rather
        // than leaving the status lines as the whole message.
        if (!run.streamedAnswer && run.text.trim()) emit.delta(`\n${run.text}\n`);

        const vars = run.vars ?? { prompt, panel: "", judge: run.text, synthesis: run.text, cwd: process.cwd() };
        const usage = run.usage;
        accumulateUsage(usage, run.decisionUsage);

        const verification = await verifyRun({
          fusion,
          vars,
          decide,
          emit,
          signal: options?.signal,
          runGate: makeRunGate(options?.signal),
        });
        const files = await fileAgentStep({
          config,
          fusion,
          prompt,
          synthesis: run.text,
          registry,
          callModel,
          signal: options?.signal,
          emit,
          getWriteParameters,
        });

        const toolCalls = files.toolCalls ?? [];
        const content = [{ type: "text", text: streamed }];
        for (let i = 0; i < toolCalls.length; i += 1) {
          const block = {
            type: "toolCall",
            id: toolCalls[i].id || `call_${Date.now()}_${i}`,
            name: toolCalls[i].name,
            arguments: toolCalls[i].arguments,
          };
          content.push(block);
          const partial = { ...base, content: [...content], usage, stopReason: "toolUse" };
          push({ type: "toolcall_start", contentIndex: 1 + i, partial });
          push({ type: "toolcall_end", contentIndex: 1 + i, toolCall: block, partial });
        }

        const details = { ...run.details, routing, verification, usage, decisionUsage: run.decisionUsage, ...workItemDetail() };
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
      try {
        child.kill("SIGTERM");
      } catch {
        /* already gone */
      }
      killTimer = setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          /* already gone */
        }
      }, GATE_KILL_GRACE_MS);
    };
    const timer = setTimeout(escalate, gate.timeoutMs ?? 120000);
    const onAbort = () => escalate();
    (signal ?? parentSignal)?.addEventListener?.("abort", onAbort, { once: true });

    const started = Date.now();
    const exit = await new Promise((resolve) => {
      child.on("close", (code) => resolve(code ?? 0));
      child.on("error", () => resolve(-1));
    });
    clearTimeout(timer);
    clearTimeout(killTimer);
    (signal ?? parentSignal)?.removeEventListener?.("abort", onAbort);
    return { exit: timedOut ? -1 : exit, timedOut, durationMs: Date.now() - started, output: output.split("\n").slice(-40).join("\n") };
  };
}

/**
 * pi executes the file agent's `write` calls and calls the provider back with the tool results.
 * Deliberating again on that follow-up would start a second full pipeline — and a second file agent, and
 * another write, until the turn cap: measured 2026-09-18, one run produced 24 turns and 24 writes. So a
 * trailing run of write results is answered with a confirmation and nothing else.
 */
export function trailingWriteResults(messages) {
  const results = [];
  for (let i = (messages ?? []).length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message?.role === "toolResult" && message.toolName === "write") results.unshift(message);
    else break;
  }
  return results;
}

export function savedPathsFor(messages, writeResults) {
  const assistant = messages[messages.length - writeResults.length - 1];
  return writeResults
    .map(
      (result) => (assistant?.content ?? []).find((block) => block.type === "toolCall" && block.id === result.toolCallId)?.arguments?.path,
    )
    .filter(Boolean);
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
