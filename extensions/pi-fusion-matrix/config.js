/**
 * config.js — layered configuration for pi-fusion-matrix.
 *
 * Plain ESM, node builtins only, no build step: pi loads it as an extension module and
 * `scripts/doctor.mjs` imports the same validator from a bare node process, so the rules that gate a
 * run are the rules the doctor reports on. One implementation, two callers.
 *
 * Layers, lowest priority first:
 *   1. <repo>/matrix.json                     (packaged defaults; always present)
 *   2. ~/.config/pi-fusion-matrix/matrix.json (machine-wide)
 *   3. <session cwd>/.pi-fusion-matrix.json   (per project, uncommitted)
 *
 * Objects merge field by field; arrays and scalars replace. A persona's `prompt` may be inline text or
 * a path, resolved relative to the file that declared the persona — so the loader remembers each
 * layer's directory rather than assuming one.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

export const HERE = path.dirname(fileURLToPath(import.meta.url));
/** `…/pi-fusion-matrix/extensions/pi-fusion-matrix/config.js` → the repository root. */
export const REPO_ROOT = path.resolve(HERE, "..", "..");
export const AGENT_DIR = process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent");

export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
export const STAGE_KINDS = ["parallel", "single", "decide", "score", "render"];
const SLOT_KINDS = ["alias", "decide"];

const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

/** Objects merge field by field; arrays and scalars replace. */
export function mergeConfig(base, override) {
  if (override === undefined) return base;
  if (!isObject(override)) return override;
  const merged = isObject(base) ? { ...base } : {};
  for (const [key, value] of Object.entries(override)) merged[key] = mergeConfig(merged[key], value);
  return merged;
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw new Error(`${file}: ${error.message}`);
  }
}

/** Every layer that exists, lowest priority first, each with the directory it was declared in. */
export function configLayers({ cwd = process.cwd() } = {}) {
  const files = [
    path.join(REPO_ROOT, "matrix.json"),
    path.join(os.homedir(), ".config", "pi-fusion-matrix", "matrix.json"),
    path.join(cwd, ".pi-fusion-matrix.json"),
  ];
  const layers = [];
  for (const file of files) {
    const config = readJson(file);
    if (config) layers.push({ file, dir: path.dirname(file), config });
  }
  return layers;
}

/**
 * Load the effective config. `sources.personas[name]` records the directory the winning persona
 * declaration came from, so its prompt path resolves against the file that owns it.
 */
export function loadMatrixConfig({ cwd = process.cwd() } = {}) {
  const layers = configLayers({ cwd });
  if (layers.length === 0) throw new Error("no matrix.json found; the packaged config is missing");
  let config = {};
  const sources = { personas: {}, aliases: {}, modes: {}, fusions: {} };
  for (const layer of layers) {
    config = mergeConfig(config, layer.config);
    for (const section of Object.keys(sources)) {
      for (const name of Object.keys(layer.config[section] ?? {})) sources[section][name] = layer.dir;
    }
  }
  return { config, layers, sources };
}

/** Inline text, or a path relative to the declaring config file's directory. */
export function resolvePrompt(prompt, dir) {
  if (typeof prompt !== "string") return null;
  if (prompt.includes("\n")) return prompt;
  const file = path.isAbsolute(prompt) ? prompt : path.resolve(dir ?? REPO_ROOT, prompt);
  try {
    return fs.readFileSync(file, "utf8").trimEnd();
  } catch {
    return null;
  }
}

/** `{{name}}` substitution; an unknown name is an error rather than an empty string. */
export function interpolate(value, vars, where) {
  if (typeof value === "string") {
    return value.replace(/\{\{([a-zA-Z0-9_.-]+)\}\}/g, (_, name) => {
      if (!(name in vars)) throw new Error(`${where}: unknown template variable "{{${name}}}"`);
      return vars[name];
    });
  }
  if (Array.isArray(value)) return value.map((v) => interpolate(v, vars, where));
  if (isObject(value)) {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = interpolate(v, vars, where);
    return out;
  }
  return value;
}

/* ------------------------------------------------------------------ validation */

/**
 * Every rule from the spec's Step 1 list, as a list of human-readable errors. Empty means valid.
 * `sources` may be omitted (the doctor passes it; a bare config still validates structurally).
 */
export function validateConfig(config, { sources } = {}) {
  const errors = [];
  const err = (m) => errors.push(m);

  if (!config || typeof config !== "object") return ["config is not an object"];

  // ---- aliases ----
  const aliases = config.aliases ?? {};
  if (Object.keys(aliases).length === 0) err("no aliases defined");
  for (const [name, alias] of Object.entries(aliases)) {
    if (!isObject(alias)) { err(`alias "${name}" is not an object`); continue; }
    if (!alias.model) err(`alias "${name}" has no model; set the vendor id sent upstream`);
    if (!Array.isArray(alias.providers) || alias.providers.length === 0) err(`alias "${name}" has no providers`);
    for (const ref of alias.providers ?? []) {
      const id = isObject(ref) ? ref.id : ref;
      if (typeof id !== "string" || !id) err(`alias "${name}" has a provider ref with no id`);
      if (isObject(ref) && ref.modelOverride !== undefined && typeof ref.modelOverride !== "string") {
        err(`alias "${name}" provider "${id}" has a non-string modelOverride`);
      }
    }
    if (alias.temperature !== undefined && (alias.temperature < 0 || alias.temperature > 2)) {
      err(`alias "${name}" temperature ${alias.temperature} outside 0..2`);
    }
  }

  // ---- personas ----
  const personas = config.personas ?? {};
  if (Object.keys(personas).length === 0) err("no personas defined");
  for (const [name, persona] of Object.entries(personas)) {
    if (!isObject(persona)) { err(`persona "${name}" is not an object`); continue; }
    if (!persona.prompt) { err(`persona "${name}" has no prompt`); continue; }
    if (sources) {
      const text = resolvePrompt(persona.prompt, sources.personas[name]);
      if (text === null) err(`persona "${name}" prompt path does not exist: ${persona.prompt}`);
    }
    if (persona.temperature !== undefined && (persona.temperature < 0 || persona.temperature > 2)) {
      err(`persona "${name}" temperature ${persona.temperature} outside 0..2`);
    }
    if (persona.thinking !== undefined && !THINKING_LEVELS.includes(persona.thinking)) {
      err(`persona "${name}" thinking "${persona.thinking}" unknown`);
    }
    if (persona.output !== undefined && !["text", "json"].includes(persona.output)) {
      err(`persona "${name}" output "${persona.output}" unknown`);
    }
  }
  const personaNames = new Set(Object.keys(personas));

  // ---- modes: stage shape and dataflow ----
  const modes = config.modes ?? {};
  if (Object.keys(modes).length === 0) err("no modes defined");
  for (const [modeName, mode] of Object.entries(modes)) {
    const stages = mode?.stages;
    if (!Array.isArray(stages) || stages.length === 0) { err(`mode "${modeName}": no stages`); continue; }
    let panel = false, single = false, score = false, produced = 0;
    const named = new Set();

    stages.forEach((stage, i) => {
      const where = `mode "${modeName}" stage ${i}`;
      if (!isObject(stage)) { err(`${where}: not an object`); return; }
      const kinds = STAGE_KINDS.filter((k) => stage[k] !== undefined);
      if (kinds.length !== 1) { err(`${where}: must set exactly one of ${STAGE_KINDS.join("/")}`); return; }

      for (const persona of stage.parallel ?? []) {
        if (!personaNames.has(persona)) err(`${where}: unknown persona "${persona}"`);
      }
      if (stage.single !== undefined && !personaNames.has(stage.single)) err(`${where}: unknown persona "${stage.single}"`);

      if (stage.parallel !== undefined && (!Array.isArray(stage.parallel) || stage.parallel.length === 0)) {
        err(`${where}: empty parallel list`);
      }
      if (stage.rounds !== undefined) {
        if (stage.rounds < 2) err(`${where}: rounds must be >= 2`);
        if (stage.rounds > 10) err(`${where}: rounds ${stage.rounds} above the cost ceiling of 10`);
        if (!stage.roundInput) err(`${where}: rounds requires roundInput`);
      }
      if (stage.alsoSynthesize && i !== stages.length - 1) err(`${where}: alsoSynthesize is only legal on the final stage`);
      if (stage.score !== undefined && stage.over !== "panel") err(`${where}: score requires over: "panel"`);
      if (stage.decide !== undefined) validateDecision(stage.decide, where, config, err);
      if (stage.score !== undefined) validateDecision(stage.score, where, config, err);
      if (stage.sufficientWhen !== undefined) validateSufficientWhen(stage.sufficientWhen, where, stage.decide, err);

      // dataflow
      const connectorOk = (input) => {
        if (input === undefined) return true;
        if (input === "prompt") return true;
        if (input === "panel") return panel;
        if (input === "panel+judge") return single;
        if (input === "panel+weights") return score;
        if (input === "peers") return stage.rounds !== undefined;
        if (input === "previous") return produced > 0;
        if (/^\{\{.*\}\}$/.test(input)) return named.has(input.slice(2, -2));
        return false;
      };
      if (!connectorOk(stage.input)) err(`${where}: input "${stage.input}" has no preceding stage that produces it`);
      if (!connectorOk(stage.roundInput)) err(`${where}: roundInput "${stage.roundInput}" has no preceding stage that produces it`);
      if (stage.roundInput === "peers" && stage.rounds === undefined) err(`${where}: roundInput "peers" requires rounds`);

      if (stage.name) named.add(stage.name);
      if (stage.parallel !== undefined) panel = true;
      if (stage.single !== undefined || stage.decide !== undefined) single = true;
      if (stage.score !== undefined) score = true;
      produced += 1;
    });

    const last = stages[stages.length - 1];
    if (last?.single === undefined && last?.render === undefined) {
      err(`mode "${modeName}": last stage must be single or render or it produces no assistant message`);
    }
  }

  // ---- fusions ----
  const fusions = config.fusions ?? {};
  if (Object.keys(fusions).length === 0) err("no fusions defined");
  for (const [id, fusion] of Object.entries(fusions)) {
    if (/[:/]/.test(id)) err(`fusion id "${id}" may not contain ":" or "/"`);
    if (!isObject(fusion)) { err(`fusion "${id}" is not an object`); continue; }
    const mode = modes[fusion.mode];
    if (!mode) { err(`fusion "${id}": unknown mode "${fusion.mode}"`); continue; }

    const used = new Set();
    for (const stage of mode.stages ?? []) {
      for (const p of stage.parallel ?? []) used.add(p);
      if (stage.single !== undefined) used.add(stage.single);
    }
    const given = new Set(Object.keys(fusion.candidates ?? {}));
    const missing = [...used].filter((p) => !given.has(p));
    const extra = [...given].filter((p) => !used.has(p));
    if (missing.length) err(`fusion "${id}" is missing candidates for: ${missing.join(", ")}`);
    if (extra.length) err(`fusion "${id}" has candidates its mode does not use: ${extra.join(", ")}`);

    for (const [persona, list] of Object.entries(fusion.candidates ?? {})) {
      if (!Array.isArray(list) || list.length === 0) { err(`fusion "${id}" candidate list for "${persona}" is empty`); continue; }
      list.forEach((candidate, i) => {
        const where = `fusion "${id}" candidate for "${persona}" [${i}]`;
        if (typeof candidate === "string") {
          if (!aliases[candidate]) err(`${where}: unknown alias "${candidate}"`);
          return;
        }
        if (!isObject(candidate)) { err(`${where}: not a string, alias object, or decision`); return; }
        const kind = SLOT_KINDS.filter((k) => candidate[k] !== undefined);
        if (kind.length !== 1) { err(`${where}: must set exactly one of ${SLOT_KINDS.join("/")}`); return; }
        if (kind[0] === "alias") {
          if (!aliases[candidate.alias]) err(`${where}: unknown alias "${candidate.alias}"`);
          if (candidate.sufficientWhen !== undefined) err(`${where}: models produce no answer to test; sufficientWhen applies to decisions`);
        } else {
          validateDecision(candidate.decide, where, config, err);
          validateSufficientWhen(candidate.sufficientWhen, where, candidate.decide, err);
        }
      });
    }

    for (const [persona, level] of Object.entries(fusion.thinking ?? {})) {
      if (!used.has(persona)) err(`fusion "${id}": thinking override for unused persona "${persona}"`);
      if (!THINKING_LEVELS.includes(level)) err(`fusion "${id}": thinking "${level}" unknown`);
    }
    for (const persona of Object.keys(fusion.prompts ?? {})) {
      if (!used.has(persona)) err(`fusion "${id}": prompt override for unused persona "${persona}"`);
    }
    if (fusion.fileAgent && fusion.fileAgent !== false) {
      if (!fusion.fileAgent.alias || !aliases[fusion.fileAgent.alias]) err(`fusion "${id}": fileAgent alias "${fusion.fileAgent?.alias}" is not an alias`);
    }
    if (fusion.maxAdvance !== undefined && (!Number.isInteger(fusion.maxAdvance) || fusion.maxAdvance < 1)) {
      err(`fusion "${id}": maxAdvance must be a positive integer`);
    }

    for (const entry of fusion.verify ?? []) {
      const where = `fusion "${id}" verify`;
      if (entry?.gate) {
        if (!Array.isArray(entry.gate.command) || entry.gate.command.length === 0) err(`${where}: gate command is empty`);
        if (entry.gate.timeoutMs !== undefined && entry.gate.timeoutMs > 600000) err(`${where}: gate timeoutMs above 600000`);
        continue;
      }
      if (!isObject(entry)) { err(`${where}: entry is not an object`); continue; }
      validateDecision(entry, where, config, err);
    }

    if (fusion.route) validateRoute(fusion.route, id, config, err);
  }

  // ---- decide + backends ----
  const backends = config.backends ?? {};
  const decide = config.decide ?? {};
  if (!decide.defaultBackend) err("decide.defaultBackend is not set");
  else if (!backends[decide.defaultBackend]) err(`decide.defaultBackend "${decide.defaultBackend}" is not a backend`);
  for (const [name, backend] of Object.entries(backends)) {
    if (!isObject(backend)) { err(`backend "${name}" is not an object`); continue; }
    if (!["typesafe", "semif"].includes(backend.kind)) err(`backend "${name}": unknown kind "${backend.kind}"`);
    if (!backend.url) err(`backend "${name}": no url`);
    if (backend.kind === "typesafe" && (!backend.apiKeyEnv || !backend.model)) {
      err(`backend "${name}": a typesafe backend needs apiKeyEnv and a pinned model id`);
    }
    if (backend.kind === "semif" && !backend.model) {
      err(`backend "${name}": a semif backend needs the model key its server loaded`);
    }
    if (backend.timeoutMs !== undefined && (backend.timeoutMs < 1000 || backend.timeoutMs > 600000)) {
      err(`backend "${name}": timeoutMs ${backend.timeoutMs} outside 1000..600000`);
    }
    if (backend.kind === "semif" && backend.model && decide.models?.[backend.model] === undefined) {
      err(`backend "${name}": model "${backend.model}" is not in decide.models`);
    }
  }
  for (const [name, model] of Object.entries(decide.models ?? {})) {
    if (!model.source) err(`decide.models.${name}: missing source`);
    if (model.revision && !/^[0-9a-f]{40}$/.test(model.revision)) {
      err(`decide.models.${name}: revision is not a 40-character commit id`);
    }
  }

  if (config.defaultFusion && !fusions[config.defaultFusion]) {
    err(`defaultFusion "${config.defaultFusion}" is not a fusion`);
  }
  if (config.providerId !== undefined && (typeof config.providerId !== "string" || !config.providerId)) {
    err("providerId must be a non-empty string");
  }
  if (config.providerId && /[:/]/.test(config.providerId)) err(`providerId "${config.providerId}" may not contain ":" or "/"`);

  return errors;
}

/**
 * One choice vocabulary across every surface (slot candidate, pipeline stage, verify, route): an
 * `instructions` string and a `criteria` map. A route may attach an action to a criterion with
 * `then`; nothing else may, because nothing else has an action to take. The batched `questions` form
 * (noul/choice/score) stays for typed questions a backend can answer several of at once.
 */
function validateDecision(spec, where, config, err, { allowActions = false } = {}) {
  if (!isObject(spec)) { err(`${where}: decision is not an object`); return; }
  const hasCriteria = isObject(spec.criteria);
  const hasQuestions = isObject(spec.questions);
  if (hasCriteria === hasQuestions) {
    err(`${where}: decision must declare exactly one of criteria/questions`);
    return;
  }

  if (hasCriteria) {
    if (!spec.instructions) err(`${where}: a choice decision needs instructions`);
    const entries = Object.entries(spec.criteria);
    if (entries.length < 2) err(`${where}: criteria needs at least two options`);
    if (entries.length > 16) err(`${where}: criteria has ${entries.length} options, above the 16 backends accept`);
    for (const [id, value] of entries) {
      if (value === null || typeof value === "string") continue;
      if (!isObject(value)) { err(`${where}: criteria "${id}" must be a description string, null, or an action object`); continue; }
      if (value.description !== undefined && typeof value.description !== "string") {
        err(`${where}: criteria "${id}" description must be a string`);
      }
      if (value.then !== undefined && !allowActions) {
        err(`${where}: criteria "${id}" attaches an action, which only a route may do`);
      }
    }
  } else {
    const entries = Object.entries(spec.questions);
    if (entries.length === 0) err(`${where}: questions is empty`);
    for (const [id, question] of entries) {
      if (!isObject(question)) { err(`${where}: question "${id}" is not an object`); continue; }
      if (!["noul", "choice", "score"].includes(question.type)) { err(`${where}: question "${id}" type "${question.type}" unknown`); continue; }
      if (!question.instructions) err(`${where}: question "${id}" has no instructions`);
      if (question.type === "score" && (!Array.isArray(question.criteria) || question.criteria.length < 2)) {
        err(`${where}: score question "${id}" needs at least two levels`);
      }
      if (question.type === "choice" && (!isObject(question.criteria) || Object.keys(question.criteria).length < 2)) {
        err(`${where}: choice question "${id}" needs at least two options`);
      }
    }
  }

  if (spec.state !== undefined && typeof spec.state !== "string") err(`${where}: state must be a string`);
  if (spec.backend !== undefined && !config.backends?.[spec.backend]) err(`${where}: unknown backend "${spec.backend}"`);
}

export function validateSufficientWhen(sufficientWhen, where, decision, err) {
  if (sufficientWhen === undefined) return;
  if (!isObject(sufficientWhen)) { err(`${where}: sufficientWhen is not an object`); return; }
  const conditions = ["choiceIs", "noulAbove", "scoreAbove", "scoreBelow", "minConfidence"].filter((k) => sufficientWhen[k] !== undefined);
  if (conditions.length === 0) err(`${where}: sufficientWhen has no condition, so it would always pass`);
  for (const key of ["noulAbove", "scoreAbove", "scoreBelow", "minConfidence"]) {
    const v = sufficientWhen[key];
    if (v !== undefined && (typeof v !== "number" || v < 0 || v > 1)) err(`${where}: sufficientWhen.${key} must be a number in 0..1`);
  }
  if (sufficientWhen.choiceIs !== undefined) {
    const wanted = [].concat(sufficientWhen.choiceIs);
    if (wanted.some((w) => typeof w !== "string")) err(`${where}: sufficientWhen.choiceIs must be a string or an array of strings`);
    const ids = new Set(Object.keys(decision?.criteria ?? {}));
    for (const want of wanted) {
      if (typeof want === "string" && ids.size > 0 && !ids.has(want)) {
        err(`${where}: sufficientWhen.choiceIs "${want}" is not one of the options (${[...ids].join(", ")})`);
      }
    }
  }
}

export function validateRoute(route, fusionId, config, err) {
  const where = `fusion "${fusionId}" route`;
  if (!isObject(route)) { err(`${where}: not an object`); return; }
  validateDecision(route, where, config, err, { allowActions: true });
  const entries = Object.entries(route.criteria ?? {});
  let targets = 0;
  for (const [option, value] of entries) {
    if (!isObject(value) || value.then === undefined) continue;
    targets += 1;
    if (!config.fusions?.[value.then]) err(`${where}: option "${option}" routes to unknown fusion "${value.then}"`);
    else {
      if (value.then === fusionId) err(`${where}: option "${option}" routes to this fusion`);
      if (config.fusions[value.then].route) err(`${where}: option "${option}" routes to "${value.then}", which declares its own route (two hops)`);
    }
  }
  if (targets === 0) err(`${where}: no option carries then, so the route can never fire`);
  const backendName = route.backend ?? config.decide?.defaultBackend;
  if (backendName && config.backends?.[backendName]?.kind === "semif") {
    err(`${where}: routing requires a backend that reports confidence; "${backendName}" does not`);
  }
  if (route.sufficientWhen !== undefined) {
    validateSufficientWhen(route.sufficientWhen, where, undefined, err);
  }
}