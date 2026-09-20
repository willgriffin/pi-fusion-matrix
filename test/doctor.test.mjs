/**
 * The doctor: it reconciles configuration against the registry, and its exit status separates "broken" from
 * "out of date" so a hook can tell the difference — 0 clean, 1 config errors, 2 connectivity, 3 reachability or
 * drift. The properties that matter: offline by default, never rewriting a decision someone made, and loud when
 * it learned nothing.
 *
 * Driven through the exported `runDoctor` with a registry built from the config under test, so these need no
 * keys and no network.
 *
 *   node --test test/
 */
import test from "node:test";
import assert from "node:assert/strict";
import { EXIT, runDoctor, repairSnippet, formatFindings } from "../extensions/pi-fusion-matrix/doctor.js";
import { loadMatrixConfig } from "../extensions/pi-fusion-matrix/config.js";

const { config: packaged, sources } = loadMatrixConfig({ cwd: process.cwd(), layers: ["packaged"] });
const deep = (value) => JSON.parse(JSON.stringify(value));
/**
 * A config that is valid and has one alias: a fusion already existed or the validator says "no fusions defined",
 * and `defaultFusion` has to point at one. Spread from the packaged config so the parts a test is not about —
 * backends, personas, modes — stay real.
 */
const configWith = (aliases) => ({
  ...deep(packaged),
  aliases,
  fusions: { one: { mode: "single", candidates: { technical: [Object.keys(aliases)[0]] } } },
  defaultFusion: "one",
});

const model = (provider, id) => ({
  id,
  name: id,
  api: "openai-completions",
  provider,
  baseUrl: `https://${provider}.test/v1`,
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 1000,
  maxTokens: 100,
});

/**
 * A registry that knows exactly the providers the *config under test* names, except where a test says
 * otherwise: `catalogue` is pi's own curated list, which decides whether an id counts as a miss.
 */
const registryFor = (config, { credentialed = true, catalogue } = {}) => {
  const named = [
    ...new Set(
      Object.values(config.aliases ?? {}).flatMap((alias) =>
        (alias.providers ?? []).map((ref) => (ref && typeof ref === "object" ? ref.id : ref)),
      ),
    ),
  ];
  const catalogueIds = catalogue ?? named.map((name) => `some-model-for-${name}`);
  return {
    // `find` answers for a provider it knows; `getAll` is the catalogue the doctor compares against, and
    // an explicit `catalogue` list is how a test says "pi lists these, and not what the alias names".
    find: (name, id) => (named.includes(name) ? model(name, id) : undefined),
    getAll: () => named.flatMap((name) => catalogueIds.map((id) => model(name, id))),
    getApiKeyAndHeaders: async () =>
      credentialed ? { ok: true, apiKey: "fixture-key", headers: {} } : { ok: false, error: "no credential" },
    getProviderAuthStatus: () => ({ authenticated: credentialed }),
  };
};

test("the packaged config, against a registry that knows every provider it names, is clean and offline", async () => {
  const result = await runDoctor({ config: packaged, sources, registry: registryFor(packaged) });
  assert.equal(result.exit, EXIT.clean);
  assert.deepEqual(
    result.findings.filter((f) => f.level === "error"),
    [],
  );
});

test("a config error is exit 1, and it is the validator's own words", async () => {
  const broken = deep(packaged);
  // A `review: true` router without a route: a silent degradation the loader refuses.
  broken.fusions["smrt-review"] = { ...broken.fusions["smrt-review"], route: undefined };
  const result = await runDoctor({ config: broken, sources, registry: registryFor(broken) });
  assert.equal(result.exit, EXIT.config);
  assert.ok(
    result.findings.some((f) => f.check === "config" && /review requires route/.test(f.message)),
    JSON.stringify(result.findings),
  );
});

test("a provider the registry does not know is a connectivity finding, and it exits 2", async () => {
  const patched = deep(packaged);
  patched.aliases["glm"] = { ...patched.aliases["glm"], providers: [...(patched.aliases["glm"].providers ?? []), "nope"] };
  // The registry is built from the *pristine* config: `nope` is the provider pi does not have.
  const result = await runDoctor({ config: patched, sources, registry: registryFor(packaged) });
  const finding = result.findings.find((f) => /nope/.test(f.message));
  assert.ok(finding, `no finding named the provider: ${JSON.stringify(result.findings)}`);
  assert.equal(finding.check, "connect");
  assert.equal(finding.level, "error");
  assert.match(finding.repair ?? "", /login|models\.json/, "a finding says what to do about it");
  assert.equal(result.exit, EXIT.connect);
});

test("a provider with no credential is reported, and the alias is never rewritten", async () => {
  const patched = deep(packaged);
  const before = JSON.stringify(patched.aliases);
  const result = await runDoctor({ config: patched, sources, registry: registryFor(patched, { credentialed: false }) });
  assert.ok(
    result.findings.some((f) => /credential/i.test(f.message)),
    JSON.stringify(result.findings),
  );
  // The alias table is a decision about what to run: the doctor reports, it never edits.
  assert.equal(JSON.stringify(patched.aliases), before);
  assert.equal(result.exit, EXIT.connect);
});

test("a single-route alias is noted as information, and does not fail a hook", async () => {
  const result = await runDoctor({ config: packaged, sources, registry: registryFor(packaged) });
  const single = result.findings.filter((f) => /single route/.test(f.message));
  assert.ok(single.length > 0, "the packaged aliases have single-route cases to note");
  assert.ok(
    single.every((f) => f.level === "info"),
    JSON.stringify(single),
  );
  assert.equal(result.exit, EXIT.clean);
});

test("offline is the default: asking for online with no registry says it learned nothing", async () => {
  const result = await runDoctor({ config: packaged, sources, registry: undefined, online: true });
  assert.ok(
    result.findings.some((f) => f.check === "reach" && /not a clean bill/.test(f.message)),
    JSON.stringify(result.findings),
  );
  assert.equal(result.exit, EXIT.drift, "an online check that could not run must not pass");
});

test("a provider that no longer lists the model an alias names is drift, exit 3, with no repair offered", async () => {
  const patched = configWith({ one: { model: "retired-id", providers: ["opencode-go"] } });
  const result = await runDoctor({
    config: patched,
    sources,
    // pi's own catalogue knows the id, so the only finding left is the provider no longer serving it.
    registry: registryFor(patched, { catalogue: ["retired-id"] }),
    online: true,
    fetchImpl: async () => ({ ok: true, json: async () => ({ data: [{ id: "replacement-id" }] }) }),
  });
  const drift = result.findings.find((f) => f.check === "drift");
  assert.ok(drift, JSON.stringify(result.findings));
  assert.match(drift.message, /retired-id/);
  assert.match(drift.repair ?? "", /decision, not a repair/);
  // A drift finding carries its own advice, but `--repair` writes only the additive catalogue snippet.
  assert.doesNotMatch(repairSnippet(result.findings), /decision, not a repair/);
  assert.equal(result.exit, EXIT.drift);
});

test("an id pi's catalogue does not have is expected, and the snippet offers it additively", async () => {
  const patched = configWith({ one: { model: "uncatalogued-id", providers: ["opencode-go"] } });
  const result = await runDoctor({
    config: patched,
    sources,
    // pi's catalogue lists a different id for this provider, while the provider itself serves the alias's.
    registry: registryFor(patched, { catalogue: ["another-id"] }),
    online: true,
    fetchImpl: async () => ({ ok: true, json: async () => ({ data: [{ id: "uncatalogued-id" }] }) }),
  });
  const snippet = repairSnippet(result.findings);
  assert.match(snippet, /uncatalogued-id/);
  assert.match(snippet, /opencode-go/);
  const reach = result.findings.find((f) => f.check === "reach" && f.repair);
  assert.equal(reach.level, "info", "a catalogue miss is information, not a fault");
  assert.equal(result.exit, EXIT.clean);
});

test("findings print with their check, and a clean run says so", () => {
  const text = formatFindings([
    { level: "error", check: "config", message: "a broken thing", repair: "fix it" },
    { level: "info", check: "connect", message: "a note" },
  ]);
  assert.match(text, /\[config\] a broken thing/);
  assert.match(text, /→ fix it/);
  assert.match(text, /\[connect\] a note/);
  assert.equal(formatFindings([]), "matrix doctor: clean");
});
