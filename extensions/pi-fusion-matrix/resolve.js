/**
 * resolve.js — from a configured candidate to something a seat can call.
 *
 * Two layers, both reported by the caller:
 *   1. inside an alias: its `providers` list, in order — one vendor model, another account;
 *   2. across a candidate list: the next alias, which is a different model and therefore a
 *      substitution rather than a re-route.
 *
 * The vendor id is the alias's `model` (or a provider's `modelOverride`). It does **not** have to
 * appear in pi's catalogue: pi's curated list lags the live catalogues, so a seat takes a
 * same-provider model as the shape template and asks pi for the credential. That keeps this package
 * out of credential handling entirely while letting an alias name what the provider actually serves.
 *
 * Measured 2026-09-18 against `opencode-go`: `find(provider, cataloguedId)` returns a template,
 * `find(provider, "glm-5.3-flash")` is absent as expected, `getApiKeyAndHeaders(templateWithOurId)`
 * resolves the key, and the call succeeds only when the request carries `x-opencode-session`
 * (`options.sessionId` does not map to it).
 */

import { randomUUID } from "node:crypto";

/** Stable for the process, which is what OpenCode's routing wants: one id per conversation. */
const PROCESS_SESSION_ID = randomUUID();

export const OPENCODE_HOSTS = ["opencode.ai"];

export function isObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/** A candidate is an alias id, an alias object with a per-seat provider override, or a decision. */
export function normalizeCandidate(candidate) {
  if (typeof candidate === "string") return { kind: "alias", alias: candidate };
  if (isObject(candidate) && candidate.decide !== undefined) return { kind: "decide", spec: candidate.decide, sufficientWhen: candidate.sufficientWhen };
  if (isObject(candidate) && candidate.alias !== undefined) {
    return { kind: "alias", alias: candidate.alias, providers: candidate.providers, thinking: candidate.thinking };
  }
  return { kind: "invalid", candidate };
}

/**
 * Expand one candidate into ordered { alias, provider, model, maxTokens, reasoning } entries.
 * Throws on a config error — the loader has already validated, so this is a contract violation.
 */
export function resolveCandidates(config, candidate) {
  const normalized = normalizeCandidate(candidate);
  if (normalized.kind === "decide") return [];
  if (normalized.kind === "invalid") throw new Error(`candidate is neither an alias nor a decision: ${JSON.stringify(candidate)}`);

  const alias = config.aliases?.[normalized.alias];
  if (!alias) {
    const known = Object.keys(config.aliases ?? {}).join(", ");
    throw new Error(`unknown alias "${normalized.alias}"; known: ${known}`);
  }
  const refs = normalized.providers ?? alias.providers;
  if (!Array.isArray(refs) || refs.length === 0) throw new Error(`alias "${normalized.alias}" has no providers`);

  return refs.map((ref) => {
    const provider = isObject(ref) ? ref.id : ref;
    const model = (isObject(ref) ? ref.modelOverride : undefined) ?? alias.model;
    return {
      alias: normalized.alias,
      provider,
      model,
      maxTokens: alias.maxTokens ?? 4096,
      // `reasoning` marks a thinking-capable model for pi's Model object; the level is the
      // persona's, and the fusion's `thinking` map may override it.
      reasoning: alias.reasoning ?? false,
      thinking: normalized.thinking,
    };
  });
}

/** `dereference` → "deepseek-pro@opencode-go"; used in every substitution line. */
export function label(resolved) {
  return `${resolved.alias}@${resolved.provider}`;
}

/** Headers for one request: OpenCode's routing id is required, and nothing else is added. */
export function requestHeaders(resolved, baseHeaders) {
  const headers = { ...(baseHeaders ?? {}) };
  if (OPENCODE_HOSTS.some((host) => (resolved.baseUrl ?? "").includes(host))) {
    headers["x-opencode-session"] ??= PROCESS_SESSION_ID;
  }
  return headers;
}

/**
 * Build the model pi will be asked about, and get the credential pi holds for its provider.
 * Returns `{ ok: false, reason }` instead of throwing: a seat failure is a substitution, not a crash.
 */
export async function seatRequest(registry, resolved) {
  if (!registry) return { ok: false, reason: "missing provider", detail: "no model registry on the extension context" };

  // A same-provider model as the shape template: api, baseUrl, compat flags, cost metadata.
  // When the id is not catalogued the template choice decides the *wire protocol*, because a provider
  // can mix api flavours — measured 2026-09-18: pi's `opencode-go` serves glm-* over
  // `openai-completions`, minimax/qwen3.8-max over `anthropic-messages`, and luna/grok over
  // `openai-responses`. Picking "the first sibling" therefore sent a tool call through the Anthropic
  // wire format and the gateway answered `Cannot read properties of undefined (reading 'length')`.
  // Preference order is by compatibility, and the chosen template is reported so an odd pick is visible.
  const template = pickTemplate(registry, resolved.provider, resolved.model);
  const templateId = template?.id;
  if (!template) {
    return {
      ok: false,
      reason: "missing provider",
      detail: `provider "${resolved.provider}" is not configured in pi (or has no models)`,
      template: templateId,
    };
  }

  const model = { ...template, id: resolved.model };
  let auth;
  try {
    auth = await registry.getApiKeyAndHeaders(model);
  } catch (error) {
    return { ok: false, reason: "credential", detail: error?.message ?? String(error), template: templateId };
  }
  if (!auth?.ok) {
    return { ok: false, reason: "credential", detail: auth?.error ?? `no credential for "${resolved.provider}"`, template: templateId };
  }

  const withBaseUrl = auth.baseUrl ? { ...model, baseUrl: auth.baseUrl } : model;
  return {
    ok: true,
    model: withBaseUrl,
    api: withBaseUrl.api,
    apiKey: auth.apiKey,
    headers: requestHeaders({ baseUrl: withBaseUrl.baseUrl }, auth.headers),
    template: templateId,
  };
}

const API_PREFERENCE = ["openai-completions", "openai-responses", "anthropic-messages"];

const commonPrefix = (a, b) => {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i += 1;
  return i;
};

/**
 * The catalogued model that supplies api/baseUrl/compat for an id we name. When the id is not
 * catalogued, the choice matters: it decides the wire protocol, because a provider can mix api
 * flavours — measured 2026-09-18, pi's `opencode-go` serves glm-* over `openai-completions`,
 * minimax/qwen3.8-max over `anthropic-messages`, and luna/grok over `openai-responses`, so "the first
 * sibling" sent a tool call through the Anthropic wire format and the gateway answered
 * `Cannot read properties of undefined (reading 'length')`.
 *
 * So: prefer the sibling that shares the most id prefix (`glm-5.3-flash` → `glm-5.3`,
 * `deepseek-v4.1-flash` → `deepseek-v4-flash`), then the most compatible api. Reported as
 * `details.seats[].template` so an odd pick is visible.
 */
export function pickTemplate(registry, provider, modelId) {
  const direct = registry.find?.(provider, modelId);
  if (direct) return { ...direct, id: modelId };
  const siblings = (registry?.getAll?.() ?? []).filter((m) => m.provider === provider);
  if (siblings.length === 0) return undefined;
  return [...siblings].sort((a, b) => {
    const prefix = commonPrefix(b.id, modelId) - commonPrefix(a.id, modelId);
    if (prefix !== 0) return prefix;
    return API_PREFERENCE.indexOf(a.api) - API_PREFERENCE.indexOf(b.api);
  })[0];
}

/** Non-network connectivity check for the doctor: is the provider known and credentialed? */
export function providerStatus(registry, provider) {
  const models = (registry.getAll?.() ?? []).filter((m) => m.provider === provider);
  if (models.length === 0) return { known: false, authenticated: false, models: 0 };
  const status = registry.getProviderAuthStatus?.(provider);
  const authed = status?.authenticated ?? registry.hasConfiguredAuth?.(models[0]) ?? false;
  return { known: true, authenticated: Boolean(authed), models: models.length, status };
}