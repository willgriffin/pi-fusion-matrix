/**
 * index.js — the extension entry point.
 *
 * Registers one provider (one model per fusion), a `matrix` tool, and three commands. Nothing here
 * resolves a credential or constructs a base URL: seats go through pi's registry (resolve.js).
 *
 * Config loads once at startup and fails loudly — a config that cannot run should not register models
 * that pretend it can. The registry arrives on `session_start`, so the stream reads it through a getter
 * rather than capturing a null at load time.
 */

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { loadMatrixConfig, validateConfig, REPO_ROOT } from "./config.js";
import { loadPi, makeCallModel, createFusionStream } from "./run.js";
import { createDecide } from "./decide.js";
import { runDoctor, formatFindings, repairSnippet, EXIT } from "./doctor.js";

export default async function (pi) {
  const { config, layers, sources } = loadMatrixConfig({ cwd: process.cwd() });

  const configErrors = validateConfig(config, { sources });
  if (configErrors.length > 0) {
    const [first, ...rest] = configErrors;
    throw new Error(`pi-fusion-matrix: ${first}${rest.length ? ` (and ${rest.length} more; run /matrix-doctor)` : ""}`);
  }

  let registry = null;
  pi.on("session_start", (_event, ctx) => { registry = ctx.modelRegistry; });

  let piAi = null;
  const getPi = async () => (piAi ??= await loadPi());
  const callModel = makeCallModel(getPi);
  const decide = createDecide({ config });

  const providerId = config.providerId ?? "fusion-matrix";
  const fusionIds = Object.keys(config.fusions);

  pi.registerProvider(providerId, {
    name: config.providerName ?? "Fusion Matrix",
    baseUrl: "http://127.0.0.1:1/unused",   // never used: only our own api id matches these models
    apiKey: "unused",                       // provider-composer requires apiKey or oauth
    api: "fusion-matrix",
    models: fusionIds.map((id) => ({
      id,
      name: config.fusions[id].name ?? `Fusion · ${id}`,
      api: "fusion-matrix",
      provider: providerId,
      reasoning: false,
      input: ["text"],
      contextWindow: config.fusions[id].model?.contextWindow ?? 128000,
      maxTokens: config.fusions[id].model?.maxTokens ?? 8192,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    })),
    streamSimple: createFusionStream({
      config,
      sources,
      getRegistry: () => registry,
      decide,
      callModel,
      getPi,
    }),
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
    execute: async (_toolCallId, params) => {
      const fusion = params.fusion ?? config.defaultFusion ?? fusionIds[0];
      if (!config.fusions[fusion]) {
        return { content: [{ type: "text", text: `unknown fusion "${fusion}"; known: ${fusionIds.join(", ")}` }], details: { fusion } };
      }
      try {
        const result = await runOnce({ config, sources, fusion, prompt: params.prompt, getRegistry: () => registry, decide, callModel });
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
      try {
        const result = await runOnce({ config, sources, fusion, prompt, getRegistry: () => registry, decide, callModel, onProgress: (line) => ctx.ui.setStatus("matrix", line) });
        pi.sendMessage({ customType: "matrix-answer", content: result.text, display: true }, { triggerTurn: false });
      } catch (error) {
        ctx.ui.notify(`fusion failed: ${error?.message ?? String(error)}`, "error");
      } finally {
        ctx.ui.setStatus("matrix", undefined);
      }
    },
  });

  pi.registerCommand("matrix-info", {
    description: "List the configured modes, fusions, seats, and provider routes",
    handler: async (_args, ctx) => {
      const lines = [];
      lines.push(`provider: ${providerId}${config.providerName ? ` (${config.providerName})` : ""} · default fusion: ${config.defaultFusion ?? fusionIds[0]}`);
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
        lines.push(`  ${id}: ${fusion.mode}${fusion.fileAgent ? " +fileAgent" : ""}${fusion.route ? " +route" : ""}${fusion.verify ? " +verify" : ""}\n    ${roster}`);
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
      const { findings, exit } = await runDoctor({ config, sources, registry, online: /\bonline\b/.test(String(args ?? "")) });
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
async function runOnce({ config, sources, fusion, prompt, getRegistry, decide, callModel, onProgress }) {
  const { runPipeline } = await import("./pipeline.js");
  const { routeFusion, verifyRun, fileAgentStep, makeRunGate } = await import("./run.js");
  const notes = [];
  const emit = { delta: (text) => { notes.push(text.trim()); onProgress?.(text.trim().slice(0, 120)); }, substitution: () => {} };

  const routed = await routeFusion({ config, fusion: { ...config.fusions[fusion], id: fusion }, prompt, decide, emit });
  const run = await runPipeline({ config, sources, fusion: routed.fusion, prompt, registry: getRegistry(), callModel, decide, emit });
  const vars = { prompt, panel: "", judge: run.text, synthesis: run.text, cwd: process.cwd() };
  const verification = await verifyRun({ config, fusion: routed.fusion, vars, decide, emit, runGate: makeRunGate() });
  const files = await fileAgentStep({ config, fusion: routed.fusion, prompt, synthesis: run.text, registry: getRegistry(), callModel, emit });

  const saved = [];
  const failedWrites = [];
  for (const call of files.toolCalls ?? []) {
    const target = call?.arguments?.path;
    const content = call?.arguments?.content;
    if (!target || typeof content !== "string") { failedWrites.push(`${target ?? "(no path)"}: no content`); continue; }
    try {
      const absolute = path.resolve(process.cwd(), target);
      fs.mkdirSync(path.dirname(absolute), { recursive: true });
      fs.writeFileSync(absolute, content, "utf8");
      saved.push(target);
    } catch (error) {
      failedWrites.push(`${target}: ${error?.message ?? String(error)}`);
    }
  }

  const summary = [
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