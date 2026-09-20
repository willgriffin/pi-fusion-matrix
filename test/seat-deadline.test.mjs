/**
 * The seat deadline: a provider that accepts a request and never answers must fail as an attempt, advance the
 * cascade, and be reported — never leave the run waiting with nothing to say.
 *
 * A hang is worse than a failure. A failure advances and is recorded; a hang is a silent run for as long as the
 * harness waits, which is indefinitely. These call `runSeat` directly rather than the pipeline, because the
 * deadline is the seat's contract and a whole-run test cannot tell which seat failed to be bounded.
 *
 *   node --test test/
 */
import test from "node:test";
import assert from "node:assert/strict";
import { runSeat } from "../extensions/pi-fusion-matrix/pipeline.js";

const fakeModel = (provider, id) => ({
  id,
  name: id,
  api: "openai-completions",
  provider,
  baseUrl: "http://127.0.0.1:1/v1",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 1000,
  maxTokens: 100,
});
const registry = {
  find: (provider, id) => fakeModel(provider, id),
  getAll: () => [fakeModel("opencode-go", "deepseek-v4-pro"), fakeModel("zai", "glm-5.3")],
  getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "fake", headers: {} }),
  getProviderAuthStatus: () => ({ authenticated: true }),
};
const config = {
  aliases: {
    "deepseek-pro": { model: "deepseek-v4-pro", providers: ["opencode-go"] },
    glm: { model: "glm-5.3", providers: ["opencode-go", "zai"] },
  },
};
const emit = { delta: () => {}, substitution: () => {} };

/**
 * A provider that takes the request and goes quiet: it settles only if the signal it was handed aborts.
 *
 * The 3 s fallback is the fixture's own bound, not the code's. A test that hangs is indistinguishable from one
 * that found a deadlock and from one that found nothing, so if the seat loses its deadline this must *fail* with
 * that fact rather than leave the suite sitting there.
 */
const silentProvider = (args) =>
  new Promise((_, reject) => {
    assert.ok(args?.signal, "a seat call must be handed an abort signal, or nothing can bound it");
    const giveUp = setTimeout(() => reject(new Error("the fixture waited 3 s for a call the seat never bounded")), 3000);
    args.signal.addEventListener(
      "abort",
      () => {
        clearTimeout(giveUp);
        reject(new Error("the request was aborted"));
      },
      { once: true },
    );
  });

const seat = (over = {}) =>
  runSeat({
    personaName: "skeptic",
    persona: { name: "skeptic", prompt: "p", temperature: 0.7 },
    candidates: ["deepseek-pro"],
    fusion: { id: "f", seatTimeoutMs: 40 },
    config,
    registry,
    callModel: silentProvider,
    decide: async () => ({ answers: {}, usage: {} }),
    emit,
    vars: { prompt: "a packet" },
    maxAdvance: 3,
    ...over,
  });

test("a seat that never answers fails with reason timeout instead of hanging", async () => {
  const started = Date.now();
  const result = await seat();
  assert.equal(result.degraded, true);
  assert.deepEqual(
    result.attempts.map((a) => a.reason),
    ["timeout"],
  );
  assert.match(result.attempts[0].detail, /no answer within 40 ms/);
  // The bound is what ended it, so the call must not have been retried as a transient failure: a retry would
  // buy a second full deadline, which is the silence the deadline exists to remove.
  assert.equal(result.calls, 1);
  assert.ok(Date.now() - started < 2000, `settled in ${Date.now() - started} ms`);
});

test("a hanging candidate advances to the next one, and each attempt is recorded", async () => {
  const result = await seat({ candidates: ["glm", "deepseek-pro"] });
  assert.equal(result.degraded, true);
  // glm has two providers, deepseek-pro one: every route gets its own bounded attempt, none of them retried.
  assert.deepEqual(
    result.attempts.map((a) => a.reason),
    ["timeout", "timeout", "timeout"],
  );
  // Each failed route records where it advanced to; the last one has nowhere left and names that with the
  // rendered "—" rather than by omitting its own failure.
  assert.deepEqual(
    result.substitutions.map((s) => [s.from, s.to]),
    [
      ["glm@opencode-go", "glm@zai"],
      ["glm@zai", "deepseek-pro@opencode-go"],
      ["deepseek-pro@opencode-go", "—"],
    ],
  );
});

test("the run's own abort is not a seat timeout", async () => {
  const controller = new AbortController();
  const pending = seat({ signal: controller.signal });
  controller.abort();
  const started = Date.now();
  const result = await pending;
  assert.equal(result.degraded, true);
  // A cancelled run is neither a provider failure nor a timeout: filed as `transient` it would read as a
  // provider that failed, and the failure taxonomy is what a later reader uses to decide what to retry.
  assert.equal(result.attempts[0].reason, "aborted");
  assert.doesNotMatch(result.attempts[0].detail, /no answer within/);
  assert.equal(result.calls, 1, "a stopped run must not buy a retry");
  assert.ok(Date.now() - started < 1000, `settled in ${Date.now() - started} ms`);
});
