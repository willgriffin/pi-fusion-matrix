/**
 * doctor.js — reconcile configuration against reality.
 *
 * Four checks, and the exit status separates "broken" from "out of date" so CI and a pre-run hook can
 * tell the difference: 0 clean, 1 config errors, 2 connectivity, 3 reachability or drift.
 *
 * Rules this file obeys, from the spec's no-silent-degradation invariant:
 *   - repairs are additive only: an id may be offered for pi's own picker, an alias's `model` never
 *     changes, and nothing is ever substituted for something else;
 *   - offline by default — `config` and `connect` need no egress, `reach` and `drift` are opt-in;
 *   - loud when it cannot fix: every finding names the alias, provider, and id, plus the exact snippet
 *     or command, and an unfixable finding exits non-zero;
 *   - it never guesses intent: the alias table is a decision about what to run, so drift is reported,
 *     not repaired.
 */

import { validateConfig } from "./config.js";
import { providerStatus } from "./resolve.js";

export const EXIT = { clean: 0, config: 1, connect: 2, drift: 3 };

const refId = (ref) => (ref && typeof ref === "object" ? ref.id : ref);
const refModel = (ref, alias) => (ref && typeof ref === "object" ? ref.modelOverride ?? alias.model : alias.model);

/** One GET /models per provider, for ids pi does not catalogue. Absent or unparseable is "unknown". */
async function liveModels(provider, { registry, fetchImpl, signal }) {
  const models = (registry?.getAll?.() ?? []).filter((m) => m.provider === provider);
  const template = models[0];
  if (!template) return { ok: false, reason: "provider not configured in pi" };
  let auth;
  try {
    auth = await registry.getApiKeyAndHeaders(template);
  } catch (error) {
    return { ok: false, reason: error?.message ?? String(error) };
  }
  if (!auth?.ok) return { ok: false, reason: auth?.error ?? "no credential" };
  const baseUrl = (auth.baseUrl ?? template.baseUrl ?? "").replace(/\/$/, "");
  if (!baseUrl) return { ok: false, reason: "no baseUrl" };
  try {
    const response = await fetchImpl(`${baseUrl}/models`, {
      headers: { ...(auth.headers ?? {}), ...(auth.apiKey ? { authorization: `Bearer ${auth.apiKey}` } : {}) },
      signal,
    });
    if (!response.ok) return { ok: false, reason: `HTTP ${response.status}` };
    const payload = await response.json();
    const ids = (payload?.data ?? payload?.models ?? []).map((m) => m?.id ?? m?.name).filter(Boolean);
    if (ids.length === 0) return { ok: false, reason: "no ids in the response" };
    return { ok: true, ids: new Set(ids) };
  } catch (error) {
    return { ok: false, reason: error?.message ?? String(error) };
  }
}

/**
 * @returns {Promise<{ findings: Array<{level:string, check:string, message:string, repair?:string}>, exit:number }>}
 */
export async function runDoctor({ config, sources, registry, online = false, fetchImpl = globalThis.fetch, signal } = {}) {
  const findings = [];
  const add = (level, check, message, repair) => findings.push({ level, check, message, ...(repair ? { repair } : {}) });

  // ---- config ----
  const errors = validateConfig(config, { sources });
  for (const message of errors) add("error", "config", message);

  const aliases = config.aliases ?? {};
  const providers = new Set();
  const routesPerAlias = {};
  for (const [name, alias] of Object.entries(aliases)) {
    const refs = alias.providers ?? [];
    routesPerAlias[name] = refs.length;
    for (const ref of refs) providers.add(refId(ref));
  }

  // ---- connect (offline) ----
  if (!registry) add("info", "connect", "no model registry available (running outside pi); connectivity not checked");
  for (const provider of registry ? providers : []) {
    const status = providerStatus(registry, provider);
    if (!status.known) {
      add("error", "connect", `provider "${provider}" is not configured in pi, so aliases routing through it cannot resolve`,
        `connect it in pi (\`/login\`, or a models.json provider entry) or remove it from the alias's providers`);
    } else if (!status.authenticated) {
      add("error", "connect", `provider "${provider}" is configured but has no credential`,
        `authenticate it (\`/login\` ${provider}) or set its env var`);
    }
  }
  for (const [name, count] of Object.entries(routesPerAlias)) {
    if (count === 1) {
      add("info", "connect", `alias "${name}" has a single route, so a quota or outage on ${refId((aliases[name].providers ?? [])[0])} has no fallback`);
    }
  }

  // ---- reach + drift (online) ----
  const live = new Map();
  if (online && !registry) add("info", "reach", "online checks need a model registry; skipped");
  if (online && registry) {
    for (const provider of providers) {
      const result = await liveModels(provider, { registry, fetchImpl, signal });
      live.set(provider, result);
      if (!result.ok) add("info", "reach", `could not list models for "${provider}" (${result.reason}); reachability unknown for it`);
    }
    for (const [name, alias] of Object.entries(aliases)) {
      const catalogued = new Set((registry?.getAll?.() ?? []).filter((m) => m.provider && alias.providers?.some((r) => refId(r) === m.provider)).map((m) => m.id));
      for (const ref of alias.providers ?? []) {
        const provider = refId(ref);
        const model = refModel(ref, alias);
        const result = live.get(provider);
        if (result?.ok && !result.ids.has(model)) {
          add("warn", "drift", `alias "${name}" names ${provider}/${model}, which that provider no longer lists`,
            `update \`aliases.${name}.model\` (or that route's modelOverride) to an id the provider serves; this is a decision, not a repair`);
        }
        if (catalogued.size > 0 && !catalogued.has(model)) {
          add("info", "reach", `${provider}/${model} is not in pi's catalogue — expected, seats resolve by provider + id`,
            `optional: to have it selectable in pi's own picker, upsert it:\n  {"providers": {"${provider}": {"models": [{"id": "${model}"}]}}}`);
        }
      }
    }
  }

  const exit = errors.length > 0
    ? EXIT.config
    : findings.some((f) => f.check === "connect" && f.level === "error") ? EXIT.connect
      : findings.some((f) => f.level === "warn") ? EXIT.drift
        : EXIT.clean;

  return { findings, exit };
}

/** The one additive repair: an id you asked to see in pi's own picker. Returns the snippet, never writes. */
export function repairSnippet(findings) {
  return findings.filter((f) => f.check === "reach" && f.repair).map((f) => f.repair).join("\n");
}

export function formatFindings(findings) {
  if (findings.length === 0) return "matrix doctor: clean";
  const glyph = { error: "", warn: "⚠", info: "·" };
  return findings.map((f) => `${glyph[f.level] ?? "·"} [${f.check}] ${f.message}${f.repair ? `\n    → ${f.repair}` : ""}`).join("\n");
}