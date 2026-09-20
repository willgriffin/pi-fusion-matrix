/**
 * Configuration: the loader is the repository's rule book, and every rule in it exists because breaking it
 * would degrade a run silently. These assert each rule is a *named* load error, plus the two derivations that
 * decide who answers — which model an executor resolves to, and what thinking level a proxied turn runs at.
 *
 * Moved here from `scripts/interp-check.mjs`, which keeps the cross-module contracts; the rules are this
 * module's own behaviour and belong to its own test.
 *
 *   node --test test/
 */
import test from "node:test";
import assert from "node:assert/strict";
import { loadMatrixConfig, mergeConfig, validateConfig, executorOf, executorThinking } from "../extensions/pi-fusion-matrix/config.js";

const { config: packaged } = loadMatrixConfig({ cwd: process.cwd(), layers: ["packaged"] });
const deep = (value) => JSON.parse(JSON.stringify(value));
/** The packaged config with a patch merged in: the way an operator's project layer changes it. */
const errorsFor = (patch) => validateConfig(mergeConfig(deep(packaged), patch), {});

test("the packaged config is valid as it ships", () => {
  assert.deepEqual(errorsFor({}), []);
});

test("every proxy rule is a named load error", () => {
  const rules = [
    ["an unknown alias", { fusions: { best: { proxy: { alias: "no-such-alias" } } } }, /proxy alias "no-such-alias" is not an alias/],
    ["an empty proxy block", { fusions: { best: { proxy: {} } } }, /proxy needs an alias/],
    ["a null proxy block", { fusions: { best: { proxy: null } } }, /proxy is not an object/],
    ["proxy with route", { fusions: { "default-smrt": { proxy: { alias: "qwen-flash" } } } }, /proxy and route cannot both be declared/],
    [
      "a thinking level declared for a seat that is not the writer",
      { fusions: { best: { thinking: { judge: "harness" } } } },
      /"harness" is only legal for the writing seat "synth"/,
    ],
    ["proxy on a mode that writes nothing", { fusions: { opinions: { proxy: { alias: "kimi" } } } }, /proxy needs a writing seat/],
    ["a non-positive alias contextWindow", { aliases: { "glm-flash": { contextWindow: 0 } } }, /contextWindow must be a positive integer/],
  ];
  const failed = rules.filter(([, patch, expected]) => !expected.test(errorsFor(patch).join("\n")));
  assert.deepEqual(
    failed.map(([name]) => name),
    [],
    `each rule must fire: ${rules.length} checked`,
  );
});

test("every review-route rule is a named load error", () => {
  const rules = [
    [
      "execute: false with a proxy block",
      { fusions: { best: { execute: false, proxy: { alias: "glm-flash" } } } },
      /proxy and execute: false cannot both be declared/,
    ],
    // `best` is an ordinary work rung — it has an executor — so these exercise the rule rather than merging
    // into a rung that already declares `execute: false`.
    ["review without execute: false", { fusions: { best: { review: true } } }, /review requires execute: false/],
    ["review without a route", { fusions: { best: { review: true, execute: false } } }, /review requires route/],
    [
      "a review route to an executor",
      {
        fusions: {
          "smrt-review": { route: { criteria: { mechanical: { description: "x", then: "quick" }, high: { description: "y" } } } },
        },
      },
      /declares no execute: false/,
    ],
    [
      "a JSON-writing seat that is not declared never a session model",
      { fusions: { "review-check": { execute: true } } },
      /the writing seat "review-synth" answers in JSON, so this fusion must declare execute: false/,
    ],
  ];
  const failed = rules.filter(([, patch, expected]) => !expected.test(errorsFor(patch).join("\n")));
  assert.deepEqual(
    failed.map(([name]) => name),
    [],
    `each rule must fire: ${rules.length} checked`,
  );
});

test("an executor is the writing seat's first candidate, and `proxy.alias` re-points what answers", () => {
  const fusion = deep(packaged.fusions.best);
  const writer = executorOf(packaged, fusion);
  assert.equal(writer.persona, "synth", "the last stage's single seat is the writer");
  assert.equal(writer.alias, "glm-flash", "no declaration means the writer's own first candidate");
  assert.equal(writer.declared, null);
  // `route` and `candidate` differ exactly when the alias is overridden: the override brings its own providers.
  assert.equal(writer.route, writer.candidate);

  const overridden = executorOf(packaged, { ...fusion, proxy: { alias: "kimi" } });
  assert.equal(overridden.alias, "kimi");
  assert.equal(overridden.declared, "kimi");
  assert.equal(overridden.route, "kimi");
  assert.notEqual(overridden.candidate, "kimi", "the writing seat's declaration is untouched, so its level still governs");
});

test("a fusion that declares `execute: false` has no executor, whatever tools a turn carries", () => {
  assert.equal(executorOf(packaged, packaged.fusions["review-check"]), null);
  assert.equal(executorOf(packaged, packaged.fusions["smrt-review"]), null);
});

test("a mode that writes nothing has no executor, even with an alias declared", () => {
  assert.equal(executorOf(packaged, { mode: "opinion" }), null);
  assert.equal(executorOf(packaged, { mode: "opinion", proxy: { alias: "kimi" } }), null);
});

test("the thinking level a proxied turn runs at is decided by declaration, then candidate, then persona", () => {
  const fusion = deep(packaged.fusions.best);
  assert.equal(executorThinking(packaged, fusion), "high", "the packaged `best` declares a level for its writer");

  // A fusion-level declaration wins over the persona's default.
  assert.equal(executorThinking(packaged, { ...fusion, thinking: { synth: "low" } }), "low");
  // Nothing declared falls to the writing seat's persona level — `quick`'s writer is `technical`, which declares
  // `medium`; `best`'s is `synth`, which declares none, and an absent level stays absent rather than defaulting.
  assert.equal(executorThinking(packaged, { ...deep(packaged.fusions.quick), thinking: {} }), "medium");
  assert.equal(executorThinking(packaged, { ...fusion, thinking: {} }), undefined);
  // `harness` means "run at whatever the harness sent", which is expressed by asking for no level at all: the
  // literal is not a level name and must never reach a provider as one.
  assert.equal(executorThinking(packaged, { ...fusion, thinking: { synth: "harness" } }), undefined);
  // No executor, no level to resolve.
  assert.equal(executorThinking(packaged, packaged.fusions["review-check"]), undefined);
});
