/**
 * Resolution: an alias and its ordered providers become routes, a candidate may override the model id per
 * route, and a model pi's catalogue does not have still gets a template — because pi's curated list lags the
 * vendor's and the wire protocol has to be decided from whatever sibling is closest.
 *
 * These call the exported units with an injected registry: no keys, no network.
 *
 *   node --test test/
 */
import test from "node:test";
import assert from "node:assert/strict";
import { normalizeCandidate, resolveCandidates, label, pickTemplate, seatRequest } from "../extensions/pi-fusion-matrix/resolve.js";

const config = {
  aliases: {
    pro: {
      model: "deepseek-v4-pro",
      providers: ["opencode-go", "alibaba-token-plan"],
      contextWindow: 128000,
      maxTokens: 8192,
      reasoning: true,
    },
    solo: { model: "glm-5.3", providers: ["opencode-go"] },
    routed: { model: "qwen3.8-max", providers: [{ id: "tp", modelOverride: "qwen3.8-max-preview" }, "opencode-go"] },
    bare: { model: "x" },
  },
};

const model = (provider, id, api = "openai-completions") => ({
  id,
  name: id,
  api,
  provider,
  baseUrl: `https://${provider}.test/v1`,
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 1000,
  maxTokens: 100,
});
const registryOf = (models, { credentialed = true } = {}) => ({
  find: (provider, id) => models.find((m) => m.provider === provider && m.id === id),
  getAll: () => models,
  getApiKeyAndHeaders: async () =>
    credentialed
      ? { ok: true, apiKey: "fixture-key", headers: { "x-opencode-session": "s1" } }
      : { ok: false, error: "no credential for opencode-go" },
  getProviderAuthStatus: () => ({ authenticated: credentialed }),
});

test("an alias becomes one route per provider, in order, carrying the alias's own model", () => {
  const routes = resolveCandidates(config, "pro");
  assert.deepEqual(
    routes.map((r) => `${r.alias}@${r.provider}`),
    ["pro@opencode-go", "pro@alibaba-token-plan"],
  );
  assert.ok(routes.every((r) => r.model === "deepseek-v4-pro"));
  assert.equal(routes[0].maxTokens, 8192);
  assert.equal(routes[0].reasoning, true, "a reasoning alias keeps its capability; an absent one stays undefined for pi's template");
  assert.equal(resolveCandidates(config, "solo")[0].reasoning, undefined);
});

test("an object route overrides the model id for that provider only", () => {
  const routes = resolveCandidates(config, "routed");
  assert.deepEqual(
    routes.map((r) => [r.provider, r.model]),
    [
      ["tp", "qwen3.8-max-preview"],
      ["opencode-go", "qwen3.8-max"],
    ],
  );
});

test("a candidate may name a different alias with its own providers and thinking level", () => {
  const routes = resolveCandidates(config, { alias: "pro", providers: ["zai"], thinking: "high" });
  assert.deepEqual(
    routes.map((r) => r.provider),
    ["zai"],
  );
  assert.equal(routes[0].thinking, "high");
  assert.equal(routes[0].model, "deepseek-v4-pro", "an override names the route, not the model");
});

test("a decision candidate has no routes, and an unusable one is named rather than ignored", () => {
  assert.deepEqual(resolveCandidates(config, { decide: { instructions: "x" } }), []);
  assert.throws(() => resolveCandidates(config, 7), /neither an alias nor a decision/);
  assert.throws(() => resolveCandidates(config, "nope"), /unknown alias "nope"; known: /);
  assert.throws(() => resolveCandidates(config, "bare"), /has no providers/);
  assert.deepEqual(normalizeCandidate({ alias: "pro" }), { kind: "alias", alias: "pro", providers: undefined, thinking: undefined });
});

test("a route is labelled provider-first, and a seat request reports an unknown provider instead of throwing", async () => {
  const [first] = resolveCandidates(config, "pro");
  assert.equal(label(first), "pro@opencode-go");

  const known = await seatRequest(registryOf([model("opencode-go", "anything")]), first);
  assert.equal(known.ok, true);
  assert.equal(known.apiKey, "fixture-key");
  assert.deepEqual(known.headers, { "x-opencode-session": "s1" }, "the provider's own headers are passed through");

  const unknown = await seatRequest(registryOf([]), first);
  assert.equal(unknown.ok, false);
  assert.equal(unknown.reason, "missing provider");

  const uncredentialed = await seatRequest(registryOf([model("opencode-go", "anything")], { credentialed: false }), first);
  assert.equal(uncredentialed.ok, false);
  assert.match(uncredentialed.detail, /no credential/);
});

test("an uncatalogued id takes the nearest sibling's template, because the wire protocol has to be decided", () => {
  const registry = registryOf([
    model("opencode-go", "glm-5.3", "openai-completions"),
    model("opencode-go", "minimax-m2", "anthropic-messages"),
    model("opencode-go", "glm-5.3-flash", "openai-responses"),
  ]);
  // The longest shared prefix wins: `glm-5.3-flash` shares more of `glm-5.3-nope` than `minimax-m2` does.
  assert.equal(pickTemplate(registry, "opencode-go", "glm-5.3-nope").id, "glm-5.3-flash");
  // A provider with no siblings at all has no template to copy.
  assert.equal(pickTemplate(registry, "nope", "anything"), undefined);
  // A catalogued id is its own template, with the id under test rather than the catalogue's spelling.
  assert.equal(pickTemplate(registry, "opencode-go", "glm-5.3").id, "glm-5.3");
});
