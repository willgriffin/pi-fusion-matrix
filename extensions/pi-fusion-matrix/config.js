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

/**
 * Which harness is running us.
 *
 * pi and omp are forks of one stack with **separate agent directories and separate project
 * conventions**, and everything that names a provider is harness-specific: one account is
 * `kimi-coding` in pi and `kimi-code` in omp, one harness's key can be stale while the other's works,
 * and omp enforces a model's supported thinking levels where pi passes them through. So the machine and
 * project layers belong to the harness, not to this extension.
 *
 * Decided synchronously from the entry script the harness was launched with — the same evidence peer
 * resolution uses later, read here because config loads before any peer does. Anything that is not
 * recognisably omp counts as pi, which is the harness this was written for.
 */
export function harnessName() {
  const entry = String(process.argv[1] ?? "").toLowerCase();
  if (entry.includes("oh-my-pi") || /(^|[/\\])omp([/\\]|$)/.test(entry)) return "omp";
  return "pi";
}

/**
 * Each harness's own agent directory (machine-wide) and project directory — the ones it already reads,
 * so our config sits where every other harness-specific setting does. Both honour
 * `PI_CODING_AGENT_DIR`, which is what makes isolated test runs isolate their config too.
 */
export const HARNESS = {
  pi: { agentDir: () => process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent"), projectDir: ".pi" },
  omp: { agentDir: () => process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".omp", "agent"), projectDir: ".omp" },
};

/** Our file name inside those directories. */
export const CONFIG_FILE = "pi-fusion-matrix.json";

/** The paths this process would load, for the doctor and the layer report. */
export function configPaths({ cwd = process.cwd() } = {}) {
  const { agentDir, projectDir } = HARNESS[harnessName()];
  return {
    harness: harnessName(),
    packaged: path.join(REPO_ROOT, "matrix.json"),
    machine: path.join(agentDir(), CONFIG_FILE),
    project: path.join(cwd, projectDir, CONFIG_FILE),
  };
}

export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
export const STAGE_KINDS = ["parallel", "single", "decide", "score", "render"];
const SLOT_KINDS = ["alias", "decide"];

const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

/**
 * A backend URL on this machine. Loopback needs no credential, and that rule is the same for the
 * loader and the client, so both read it from here rather than each carrying their own copy.
 */
export const LOOPBACK_URL = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])([:/]|$)/;

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

/**
 * Every layer that exists, lowest priority first, each labelled with what it is.
 *
 * Packaged → this harness's machine directory → this harness's project directory. The machine and
 * project paths are per harness (`~/.pi/agent` and `<cwd>/.pi` for pi, `~/.omp/agent` and `<cwd>/.omp`
 * for omp), because a provider id and a credential are harness facts: the same account answers in one
 * and 401s in the other.
 *
 * The three surfaces that can leave the machine or run code — decision backends, `verify` gates, and
 * persona prompt paths — are trusted only from the packaged config and the machine directory. The
 * project layer is *a repository*: cloning a project must never be enough to point a credential at
 * someone else's endpoint, execute a command, or read a file into a prompt. Aliases, personas, modes,
 * and fusions may still come from anywhere.
 */
export function configLayers({ cwd = process.cwd() } = {}) {
  const paths = configPaths({ cwd });
  const files = [
    { file: paths.packaged, kind: "packaged" },
    { file: paths.machine, kind: "machine" },
    { file: paths.project, kind: "cwd" },
  ];
  const layers = [];
  for (const { file, kind } of files) {
    const config = readJson(file);
    if (config) layers.push({ file, kind, dir: path.dirname(file), config });
  }
  return layers;
}

/**
 * Load the effective config. `sources.personas[name]` records the directory the winning persona
 * declaration came from, so its prompt path resolves against the file that owns it.
 *
 * `layers` optionally names the layer kinds to load (`["packaged"]` is the ship-shape config alone).
 * An offline contract harness must be able to say that: the machine and session layers are the
 * operator's, and inheriting them makes the thing under test depend on whose laptop it runs on. The
 * default stays every layer that exists.
 */
export function loadMatrixConfig({ cwd = process.cwd(), layers: wanted } = {}) {
  const layers = wanted === undefined
    ? configLayers({ cwd })
    : configLayers({ cwd }).filter((layer) => wanted.includes(layer.kind));
  if (layers.length === 0) {
    throw new Error(wanted === undefined
      ? "no matrix.json found; the packaged config is missing"
      : `no matrix.json found in layer(s) ${JSON.stringify(wanted)}`);
  }
  let config = {};
  const sources = { personas: {}, aliases: {}, modes: {}, fusions: {}, backends: {} };
  for (const layer of layers) {
    config = mergeConfig(config, layer.config);
    for (const section of Object.keys(sources)) {
      for (const name of Object.keys(layer.config[section] ?? {})) {
        sources[section][name] = { dir: layer.dir, kind: layer.kind, file: layer.file, trusted: layer.kind !== "cwd" };
      }
    }
  }
  return { config, layers, sources };
}

/**
 * Inline text, or a path relative to the declaring config file's directory.
 *
 * A persona prompt is sent to a model provider, so it is a read exfiltration surface: from an untrusted
 * layer the path must stay inside that layer's directory, and an absolute path is refused. The packaged
 * and machine layers may point anywhere, because the operator wrote them.
 */
export function promptPath(prompt, source) {
  if (typeof prompt !== "string") return null;
  if (prompt.includes("\n")) return null;                       // inline text, not a path
  const dir = source?.dir ?? REPO_ROOT;
  if (path.isAbsolute(prompt)) return source?.trusted === false ? null : prompt;
  const resolved = path.resolve(dir, prompt);
  const relative = path.relative(dir, resolved);
  // An untrusted layer may only point at a file beneath itself.
  if (source?.trusted === false && (relative.startsWith("..") || path.isAbsolute(relative))) return null;
  return resolved;
}

export function resolvePrompt(prompt, source) {
  if (typeof prompt !== "string") return null;
  if (prompt.includes("\n")) return prompt;
  const file = promptPath(prompt, source);
  if (!file) return null;
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
      const source = sources.personas[name];
      if (promptPath(persona.prompt, source) === null && !persona.prompt.includes("\n")) {
        err(source?.trusted === false
          ? `persona "${name}" prompt path must be relative and inside ${source.dir} when it comes from the session directory`
          : `persona "${name}" prompt path does not exist: ${persona.prompt}`);
      } else if (resolvePrompt(persona.prompt, source) === null) {
        err(`persona "${name}" prompt path does not exist: ${persona.prompt}`);
      }
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
      if (stage.score !== undefined) validateDecision(stage.score, where, config, err, { scoreLevels: true });
      if (stage.sufficientWhen !== undefined) {
        // The gate skips the stage after this one (`pipeline.js` skips `index + 1`). If that stage is
        // the mode's last, a sufficient answer leaves the run with no assistant message at all.
        if (i + 1 === stages.length - 1) {
          err(`${where}: a sufficient decision would skip the final stage, leaving no answer`);
        }
        validateSufficientWhen(stage.sufficientWhen, where, stage.decide, err, effectiveBackend(stage.decide, config));
      }

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
          validateSufficientWhen(candidate.sufficientWhen, where, candidate.decide, err, effectiveBackend(candidate.decide, config));
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
        // A gate executes argv. Only the packaged and machine layers may ask for that; a repository
        // must never make a fusion run arbitrary commands.
        const origin = sources?.fusions?.[id];
        if (origin && origin.kind === "cwd") {
          err(`${where}: a gate command may only be declared by the packaged or machine-wide config, not by the session directory`);
        }
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
    // A decision backend sends the deliberation state, and its credential, to `url`. Only the packaged
    // and machine layers may define one; a repository may not.
    const origin = sources?.backends?.[name];
    if (origin && origin.kind === "cwd") {
      err(`backend "${name}" is declared by the session directory; decision backends may only come from the packaged or machine-wide config`);
    }
    // The canonical env var per kind, so config can never name an arbitrary variable to read, and a
    // non-loopback backend must name one at all.
    const env = backend.kind === "typesafe" ? "TYPESAFE_API_KEY" : backend.kind === "semif" ? "SEMIF_API_KEY" : null;
    const loopbackUrl = LOOPBACK_URL.test(backend.url ?? "");
    if (env && backend.apiKeyEnv !== undefined && backend.apiKeyEnv !== env) {
      err(`backend "${name}": apiKeyEnv must be ${env} for a ${backend.kind} backend, not "${backend.apiKeyEnv}"`);
    }
    if (backend.url && !loopbackUrl && backend.apiKeyEnv === undefined) {
      err(`backend "${name}": a non-loopback backend must name its apiKeyEnv (${env})`);
    }
    if (backend.url) {
      if (!/^https:\/\//.test(backend.url) && !loopbackUrl) {
        err(`backend "${name}": url must be https, or http on loopback, not "${backend.url}"`);
      }
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
 * The backend a decision resolves to: its own `backend`, else the configured default. Every rule that
 * depends on what a backend can report (SemIf reports probabilities and nothing else) reads the
 * answer from here, so a caller cannot pass `undefined` and silently exempt a decision.
 */
function effectiveBackend(spec, config) {
  const name = spec?.backend ?? config.decide?.defaultBackend;
  return name ? { name, kind: config.backends?.[name]?.kind } : undefined;
}

/**
 * One choice vocabulary across every surface (slot candidate, pipeline stage, verify, route): an
 * `instructions` string and a `criteria` map. A route may attach an action to a criterion with
 * `then`; nothing else may, because nothing else has an action to take. The batched `questions` form
 * (noul/choice/score) stays for typed questions a backend can answer several of at once.
 */
function validateDecision(spec, where, config, err, { allowActions = false, scoreLevels = false } = {}) {
  if (!isObject(spec)) { err(`${where}: decision is not an object`); return; }
  // A `score` stage rates each item of `over` against a list of levels rather than choosing between
  // named options, so it is the one surface where `criteria` is an array. Nothing else may use that
  // form: an array elsewhere is a config mistake, not a second spelling of an option map.
  const levels = Array.isArray(spec.criteria) ? spec.criteria : undefined;
  const hasCriteria = isObject(spec.criteria);
  const hasQuestions = isObject(spec.questions);
  if (levels) {
    if (!scoreLevels) { err(`${where}: criteria must be an option map; rating levels belong to a score stage`); return; }
    if (spec.questions !== undefined) err(`${where}: a score stage declares criteria or questions, not both`);
    if (!spec.instructions) err(`${where}: a score stage needs instructions`);
    if (levels.length < 2) err(`${where}: score criteria needs at least two levels`);
    if (levels.length > 16) err(`${where}: score criteria has ${levels.length} levels, above the 16 backends accept`);
    if (levels.some((level) => typeof level !== "string")) err(`${where}: score criteria levels must be strings`);
  } else if (hasCriteria === hasQuestions) {
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
  } else if (hasQuestions) {
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
  // SemIf's row schema is one question per request, so the batched `questions` form cannot be sent to
  // it at all. The client keeps its runtime guard (defence in depth); the loader is what makes this a
  // config error instead of a mid-run substitution.
  const backend = effectiveBackend(spec, config);
  if (hasQuestions && backend?.kind === "semif") {
    err(`${where}: backend "${backend.name}" is SemIf and takes one question per request; use a criteria decision or the questions form on a typesafe backend`);
  }
}

/**
 * `backend` is the resolved `{ name, kind }` of the decision this gate belongs to, or omitted when a
 * caller has only the rule set (the doctor reports through `validateConfig`, which passes it).
 */
export function validateSufficientWhen(sufficientWhen, where, decision, err, backend) {
  if (sufficientWhen === undefined) return;
  if (!isObject(sufficientWhen)) { err(`${where}: sufficientWhen is not an object`); return; }
  const conditions = ["choiceIs", "noulAbove", "scoreAbove", "scoreBelow", "minConfidence"].filter((k) => sufficientWhen[k] !== undefined);
  if (conditions.length === 0) err(`${where}: sufficientWhen has no condition, so it would always pass`);
  // SemIf reports probabilities and nothing else: no confidence, no score. A gate over either would
  // threshold a value the backend never sends — the runtime reads it as 0 and the gate can never
  // pass — so it is a load error on every surface, not just a route.
  if (backend?.kind === "semif" && ["minConfidence", "scoreAbove", "scoreBelow"].some((k) => sufficientWhen[k] !== undefined)) {
    err(`${where}: routing requires a backend that reports confidence; "${backend.name}" does not`);
  }
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
  const backend = effectiveBackend(route, config);
  // A route always needs a confidence to decide with (its default gate is `{ minConfidence: 0.5 }`),
  // so a SemIf backend is a load error here even when no `sufficientWhen` is written.
  if (backend?.kind === "semif") {
    err(`${where}: routing requires a backend that reports confidence; "${backend.name}" does not`);
  }
  if (route.sufficientWhen !== undefined) {
    validateSufficientWhen(route.sufficientWhen, where, undefined, err);
  }
}