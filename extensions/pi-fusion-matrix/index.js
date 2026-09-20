/**
 * index.js — the extension entry point.
 *
 * Registers one provider (one model per fusion), a `matrix` tool, and three commands. Nothing here
 * resolves a credential or constructs a base URL: seats go through pi's registry (resolve.js).
 *
 * Config loads once at startup and fails loudly — a config that cannot run should not register models
 * that pretend it can. The registry arrives on `session_start` — one per session — so the stream reads
 * it through a getter rather than capturing a null at load time.
 */

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { loadMatrixConfig, validateConfig, harnessName, executorOf, executorThinking, HARNESS_THINKING, REPO_ROOT } from "./config.js";
import { loadPi, loadTypebox, makeCallModel, createFusionStream } from "./run.js";
import { createDecide } from "./decide.js";
import { runDoctor, formatFindings, repairSnippet, EXIT } from "./doctor.js";

export default async function (pi) {
  const { config, layers, sources } = loadMatrixConfig({ cwd: process.cwd() });

  const configErrors = validateConfig(config, { sources });
  if (configErrors.length > 0) {
    const [first, ...rest] = configErrors;
    throw new Error(`pi-fusion-matrix: ${first}${rest.length ? ` (and ${rest.length} more; run /matrix-doctor)` : ""}`);
  }

  // One registry per session, looked up by id. pi rebinds the runtime and re-emits `session_start` on
  // reload, resume, and fork, so a single slot would re-point a run that belongs to another session —
  // and it read null before the first start. The stream knows its session (`options.sessionId`, what
  // pi's agent loop forwards), the tool and command paths read `ctx.sessionManager`; a caller with no
  // id to offer gets the newest capture, and a capture that had no id is stored under a fresh
  // monotonic key so it can never overwrite one that did.
  const registries = new Map();
  let latestRegistry = null;
  let captures = 0;
  const sessionIdOf = (ctx) => ctx?.sessionManager?.getSessionId?.();
  pi.on("session_start", (_event, ctx) => {
    latestRegistry = ctx?.modelRegistry ?? null;
    const sessionId = sessionIdOf(ctx);
    registries.set(sessionId ? `id:${sessionId}` : `capture:${++captures}`, latestRegistry);
  });

  /** The registry for a session id, or the newest capture when the caller cannot name its own. */
  const getRegistry = (sessionId) => (sessionId && registries.has(`id:${sessionId}`) ? registries.get(`id:${sessionId}`) : latestRegistry);

  let piAi = null;
  const getPi = async () => (piAi ??= await loadPi());
  const callModel = makeCallModel(getPi);
  const decide = createDecide({ config });

  // The file agent's `write` tool needs one schema, and the builder for it is harness-specific. omp
// injects one on the extension API (`pi.zod`, so `z.object({ path: z.string() })`); pi expects the
// extension to bring `typebox` (`Type.Object({ path: Type.String() })`) — a bundled peer resolved from
// pi's own installation. Memoized, and resolved at the first tool call rather than at load, so a
// harness whose peer cannot be found still registers its models and reports the failure per seat.
  let writeParametersCache = null;
  const getWriteParameters = () => (writeParametersCache ??= (async () => {
    if (pi.zod) return pi.zod.object({ path: pi.zod.string(), content: pi.zod.string() });
    const { Type } = await loadTypebox();
    return Type.Object({ path: Type.String(), content: Type.String() });
  })());

  // `createFusionStream` asks for its registry once, when a run starts, so the getter has to know the
  // session by then: one stream function per session (not per run, and not one shared between them).
  const streams = new Map();
  const streamForSession = (sessionId) => {
    const key = sessionId ?? "";
    let stream = streams.get(key);
    if (!stream) {
      stream = createFusionStream({ config, sources, getRegistry: () => getRegistry(sessionId), decide, callModel, getPi, getWriteParameters });
      streams.set(key, stream);
    }
    return stream;
  };

  const providerId = config.providerId ?? "fusion-matrix";
  const fusionIds = Object.keys(config.fusions);

  /**
   * The model pi registers for a fusion. A fusion with an execute face advertises the executor's
   * numbers and capability rather than a facade: the harness sizes its context budget from
   * `contextWindow` and reads `maxTokens` to tell a truncated answer from a finished one
   * (`_checkCompaction`'s `isRecoverableLength`), so an 8192 default in front of a 384K-output model
   * either clips an edit or sends the loop recovering from a truncation that never happened. The alias
   * declares them because registration runs before any session exists to resolve a catalogue template,
   * and its declared numbers win; `fusion.model` is the fallback, and all there is for a fusion that
   * only deliberates.
   */
  const registeredModel = (id) => {
    const fusion = config.fusions[id];
    const executor = executorOf(config, fusion);
    const alias = executor ? config.aliases?.[executor.alias] : undefined;
    return {
      id,
      name: fusion.name ?? `Fusion · ${id}`,
      api: "fusion-matrix",
      provider: providerId,
      // A deliberation seat's level comes from config per persona, so a fusion with no execute face
      // advertises none — the pre-Step-8 value. A proxying fusion has to let the harness pass
      // `--thinking` through, which pi and omp both gate on this flag, so it advertises the executor's
      // own capability unless that alias declares otherwise.
      reasoning: executor ? (alias?.reasoning ?? true) : false,
      input: ["text"],
      contextWindow: alias?.contextWindow ?? fusion.model?.contextWindow ?? 128000,
      maxTokens: alias?.maxTokens ?? fusion.model?.maxTokens ?? 8192,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    };
  };

  pi.registerProvider(providerId, {
    name: config.providerName ?? "Fusion Matrix",
    baseUrl: "http://127.0.0.1:1/unused",   // never used: only our own api id matches these models
    apiKey: "unused",                       // provider-composer requires apiKey or oauth
    api: "fusion-matrix",
    models: fusionIds.map(registeredModel),
    streamSimple: (model, context, options) => streamForSession(options?.sessionId)(model, context, options),
  });

  pi.registerTool({
    name: "matrix",
    label: "Matrix",
    description: "Run a named fusion — a configured pipeline of models deliberating on one question. Use it for design decisions, architectural choices, and reviews that benefit from independent expert analysis plus a synthesis.",
    promptSnippet: "Run a multi-model deliberation on a design question",
    parameters: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "The question or design task to analyze." },
        fusion: { type: "string", description: `Fusion id (${fusionIds.join(", ")}). Defaults to ${config.defaultFusion ?? fusionIds[0]}.` },
      },
      required: ["prompt"],
    },
    execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
      const fusion = params.fusion ?? config.defaultFusion ?? fusionIds[0];
      if (!config.fusions[fusion]) {
        return { content: [{ type: "text", text: `unknown fusion "${fusion}"; known: ${fusionIds.join(", ")}` }], details: { fusion } };
      }
      try {
        const result = await runOnce({ config, sources, fusion, prompt: params.prompt, getRegistry: () => getRegistry(sessionIdOf(ctx)), decide, callModel, getWriteParameters });
        return { content: [{ type: "text", text: result.text }], details: { fusion, ...result.details } };
      } catch (error) {
        const message = error?.message ?? String(error);
        return { content: [{ type: "text", text: `fusion failed: ${message}` }], details: { fusion, error: message } };
      }
    },
  });

  pi.registerCommand("matrix", {
    description: "Run a named fusion: /matrix <id> <prompt>",
    handler: async (args, ctx) => {
      const text = String(args ?? "").trim();
      if (!text) {
        ctx.ui.notify(`usage: /matrix <${fusionIds.join("|")}> <prompt>`, "error");
        return;
      }
      const [first, ...rest] = text.split(/\s+/);
      const fusion = config.fusions[first] ? first : (config.defaultFusion ?? fusionIds[0]);
      const prompt = config.fusions[first] ? rest.join(" ") : text;
      if (!prompt) { ctx.ui.notify("usage: /matrix <id> <prompt>", "error"); return; }

      ctx.ui.setStatus("matrix", `🧠 ${fusion}…`);

      // The run record rides the message, as it does on the tool path: a custom message entry keeps
      // `details` (pi's `session-manager.js` `appendCustomMessageEntry`), where before the command
      // recorded only the answer text, so the deliberate face was unobservable once the turn ended —
      // measured 2026-09-19: 46 stored sessions, zero deliberation records. `scripts/session-report.mjs`
      // is the reader: it counts what it recognises and names what it does not, so a missing record
      // cannot read as a clean run.
      //
      // Delivery is a separate fact from the run. A message the harness refuses to write is a delivery
      // failure and says so; folding it into the run's outcome would file a good deliberation as a failed
      // one, which is the one thing a run record must never do.
      const record = async (content, details) => {
        try {
          await pi.sendMessage({ customType: "matrix-answer", content, display: true, details }, { triggerTurn: false });
        } catch (error) {
          ctx.ui.notify(`the run record could not be written: ${error?.message ?? String(error)}`, "error");
        }
      };

      try {
        const result = await runOnce({ config, sources, fusion, prompt, getRegistry: () => getRegistry(sessionIdOf(ctx)), decide, callModel, onProgress: (line) => ctx.ui.setStatus("matrix", line), getWriteParameters });
        await record(result.text, { fusion, ...result.details });
      } catch (error) {
        const message = error?.message ?? String(error);
        ctx.ui.notify(`fusion failed: ${message}`, "error");
        // A failure is the record most worth keeping: without it the next day's report cannot tell a run
        // that failed from a fusion nobody asked.
        await record(`fusion failed: ${message}`, { fusion, error: message });
      } finally {
        ctx.ui.setStatus("matrix", undefined);
      }
    },
  });

  pi.registerCommand("matrix-info", {
    description: "List the configured modes, fusions, seats, and provider routes",
    handler: async (_args, ctx) => {
      const lines = [];
      lines.push(`provider: ${providerId}${config.providerName ? ` (${config.providerName})` : ""} · default fusion: ${config.defaultFusion ?? fusionIds[0]} · harness: ${harnessName()}`);
      lines.push(`layers: ${layers.map((l) => l.file.replace(process.env.HOME ?? "", "~")).join(" → ")}`);
      lines.push("");
      lines.push("modes:");
      for (const [name, mode] of Object.entries(config.modes)) {
        const shape = mode.stages.map((s) => ["parallel", "single", "decide", "score", "render"].find((k) => s[k] !== undefined)).join(" → ");
        lines.push(`  ${name}: ${shape}${mode.stages.some((s) => s.rounds) ? ` (${mode.stages.find((s) => s.rounds).rounds} rounds)` : ""}`);
      }
      lines.push("");
      lines.push("fusions:");
      for (const [id, fusion] of Object.entries(config.fusions)) {
        const roster = Object.entries(fusion.candidates ?? {}).map(([persona, list]) => `${persona}=${list.map((c) => (typeof c === "string" ? c : c.alias ?? "decision")).join("/")}`).join(" ");
        // The other face of the same definition: which alias answers a tool-bearing turn, and at what
        // level. A `—` is a fusion whose mode writes nothing, so every turn it gets deliberates.
        const executor = executorOf(config, fusion);
        const level = executorThinking(config, fusion);
        const executes = executor
          ? `${executor.alias} @${level ?? HARNESS_THINKING}${executor.declared ? " (proxy alias)" : ` (writing seat${executor.persona ? ` ${executor.persona}` : ""})`}`
          : "— (no writing seat; every turn deliberates)";
        lines.push(`  ${id}: ${fusion.mode}${fusion.fileAgent ? " +fileAgent" : ""}${fusion.route ? " +route" : ""}${fusion.verify ? " +verify" : ""}\n    ${roster}\n    executes: ${executes}`);
      }
      lines.push("");
      lines.push("aliases:");
      for (const [name, alias] of Object.entries(config.aliases)) {
        const routes = (alias.providers ?? []).map((r) => (typeof r === "object" ? `${r.id}:${r.modelOverride}` : r)).join(" → ");
        lines.push(`  ${name} = ${alias.model} @ ${routes}`);
      }
      lines.push("");
      lines.push(`decide: default=${config.decide.defaultBackend} · backends=${Object.keys(config.backends).join(", ")}`);
      ctx.ui.notify(lines.join("\n"), "info");
    },
  });

  pi.registerCommand("matrix-doctor", {
    description: "Validate the config, check provider connectivity, and report catalogue drift",
    handler: async (args, ctx) => {
      const { findings, exit } = await runDoctor({ config, sources, registry: getRegistry(sessionIdOf(ctx)), online: /\bonline\b/.test(String(args ?? "")) });
      const snippet = repairSnippet(findings);
      ctx.ui.notify(`${formatFindings(findings)}${snippet ? `\n\nsuggested models.json additions:\n${snippet}` : ""}\n\nexit ${exit}`, exit === EXIT.clean ? "info" : "error");
    },
  });
}

/**
 * One complete run for the tool and command paths, which cannot emit a pi stream.
 *
 * The file agent's writes are executed here rather than handed to pi: a tool result cannot carry
 * tool calls, so nothing else would write them and reporting "saved N files" without writing would be a
 * false claim. Failures are per file and reported as written-or-not.
 */
async function runOnce({ config, sources, fusion, prompt, getRegistry, decide, callModel, onProgress, getWriteParameters }) {
  const { runPipeline } = await import("./pipeline.js");
  const { routeFusion, verifyRun, fileAgentStep, makeRunGate } = await import("./run.js");
  const notes = [];
  const substitutionLines = [];
  const emit = {
    delta: (text) => { notes.push(text.trim()); onProgress?.(text.trim().slice(0, 120)); },
    // The provider path renders a substitution inline; a tool result has no stream to render into, so
    // the same ` ├─ ↩ …` line is kept here for `notes` and prepended to the text the caller returns.
    substitution: (entry) => {
      const line = ` ├─ ↩ ${entry.seat} ${entry.from} → ${entry.to} (${entry.reason})`;
      substitutionLines.push(line);
      notes.push(line.trim());
      onProgress?.(line.trim().slice(0, 120));
    },
  };

  const routed = await routeFusion({ config, fusion: { ...config.fusions[fusion], id: fusion }, prompt, decide, emit });
  const run = await runPipeline({ config, sources, fusion: routed.fusion, prompt, registry: getRegistry(), callModel, decide, emit });
  // `run.vars` is the panel as the panel saw it: `{{panel}}` in a verify question reads the seats'
  // answers and `{{judge}}` the judge's, which the final text cannot stand in for.
  const vars = run.vars ?? { prompt, panel: "", judge: run.text, synthesis: run.text, cwd: process.cwd() };
  const verification = await verifyRun({ config, fusion: routed.fusion, vars, decide, emit, runGate: makeRunGate() });
  const files = await fileAgentStep({ config, fusion: routed.fusion, prompt, synthesis: run.text, registry: getRegistry(), callModel, emit, getWriteParameters });

  // Confined to the project. The content is model output derived from panel responses, so a path that
  // escapes the workspace — absolute, or `..` — is refused and reported rather than written. (The
  // provider stream path hands writes to pi's own permission-gated `write` tool; this path has no such
  // gate, so it has to enforce its own.)
  const root = (() => { try { return fs.realpathSync(process.cwd()); } catch { return process.cwd(); } })();
  const saved = [];
  const failedWrites = [];
  for (const call of files.toolCalls ?? []) {
    const target = call?.arguments?.path;
    const content = call?.arguments?.content;
    if (!target || typeof content !== "string") { failedWrites.push(`${target ?? "(no path)"}: no content`); continue; }
    if (path.isAbsolute(target)) { failedWrites.push(`${target}: absolute paths are refused; use a path inside the project`); continue; }
    const absolute = path.resolve(root, target);
    const relative = path.relative(root, absolute);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      failedWrites.push(`${target}: outside the project directory, refused`);
      continue;
    }
    try {
      fs.mkdirSync(path.dirname(absolute), { recursive: true });
      fs.writeFileSync(absolute, content, "utf8");
      saved.push(relative);
    } catch (error) {
      failedWrites.push(`${target}: ${error?.message ?? String(error)}`);
    }
  }

  const summary = [
    substitutionLines.length ? `${substitutionLines.join("\n")}\n\n` : "",
    run.text,
    saved.length ? `\n\n---\nSaved ${saved.length} file(s): ${saved.map((f) => `\`${f}\``).join(", ")}` : "",
    failedWrites.length ? `\n\n⚠️ Could not write: ${failedWrites.join("; ")}` : "",
  ].join("");

  return {
    text: summary,
    details: {
      ...run.details,
      routing: routed.routing,
      verification,
      saved,
      failedWrites,
      notes,
      usage: run.usage,
      decisionUsage: run.decisionUsage,
    },
  };
}