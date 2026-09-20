/**
 * The decision backend seam: one request builder for two backend kinds, normalised so no caller branches on
 * which one answered. These drive the exported `createDecide` with an injected `fetch`, so they need no
 * network, no key, and no stub server — and the failure paths, which are the ones that matter, are reachable
 * without one.
 *
 *   node --test test/
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createDecide, truncateState } from "../extensions/pi-fusion-matrix/decide.js";

const backendConfig = (over = {}) => ({
  decide: { defaultBackend: "typesafe" },
  backends: {
    typesafe: {
      kind: "typesafe",
      url: "https://backend.test/v1/systemone",
      apiKeyEnv: "TYPESAFE_API_KEY",
      model: "jev-1.13.0",
      timeoutMs: 5000,
      ...over,
    },
    local: {
      kind: "typesafe",
      url: "http://127.0.0.1:8793/v1/systemone",
      apiKeyEnv: "TYPESAFE_API_KEY",
      model: "jev-stub",
      timeoutMs: 5000,
    },
    semif: { kind: "semif", url: "http://127.0.0.1:8791/score", model: "qwen3.5-4b", timeoutMs: 5000 },
  },
});
const spec = { state: "{{prompt}}", instructions: "Is this mechanical or standard?", criteria: { mechanical: "docs", standard: "code" } };
const answers = {
  answers: { choice: { type: "choice", choice: "mechanical", probabilities: { mechanical: 0.9 }, confidence: 0.9 } },
  usage: { input_tokens: 10, output_tokens: 2 },
  model: "jev-1.13.0",
};
const ok = (payload) => async () => ({ ok: true, status: 200, text: async () => JSON.stringify(payload) });

test("a decision normalises a choice answer and its usage, under the variables it was given", async () => {
  let sent;
  const decide = createDecide({
    config: backendConfig(),
    fetchImpl: async (url, init) => {
      sent = JSON.parse(init.body);
      return ok(answers)();
    },
  });
  const result = await decide(spec, { prompt: "a one-line README edit" });
  assert.equal(result.backend, "typesafe");
  assert.equal(result.model, "jev-1.13.0");
  assert.equal(result.answers.choice.choice, "mechanical");
  assert.equal(result.answers.choice.confidence, 0.9);
  assert.deepEqual([result.usage.input, result.usage.output, result.usage.totalTokens], [10, 2, 12]);
  // The state is the *interpolated* prompt, not the template: the backend sees what was asked, not `{{prompt}}`.
  assert.equal(sent.state, "a one-line README edit");
  assert.equal(sent.questions.choice.type, "choice");
  assert.equal(sent.questions.choice.criteria.mechanical, "docs");
  assert.equal(sent.model, "jev-1.13.0");
});

test("the credential is read through the backend's own `apiKeyEnv`, and only when it is not loopback", async () => {
  const previous = process.env.TYPESAFE_API_KEY;
  process.env.TYPESAFE_API_KEY = "fixture-value-not-a-real-key";
  try {
    let headers;
    const decide = createDecide({
      config: backendConfig(),
      fetchImpl: async (_url, init) => {
        headers = init.headers;
        return ok(answers)();
      },
    });
    await decide(spec, { prompt: "x" });
    assert.equal(headers.authorization, "Bearer fixture-value-not-a-real-key");
  } finally {
    if (previous === undefined) delete process.env.TYPESAFE_API_KEY;
    else process.env.TYPESAFE_API_KEY = previous;
  }
});

test("a non-loopback backend with no key is refused before any request is made", async () => {
  const previous = process.env.TYPESAFE_API_KEY;
  delete process.env.TYPESAFE_API_KEY;
  try {
    let called = false;
    const decide = createDecide({
      config: backendConfig(),
      fetchImpl: async () => {
        called = true;
        return ok(answers)();
      },
    });
    await assert.rejects(() => decide(spec, { prompt: "x" }), /needs env var TYPESAFE_API_KEY/);
    assert.equal(called, false, "a backend that cannot be authenticated is not called");
  } finally {
    if (previous !== undefined) process.env.TYPESAFE_API_KEY = previous;
  }
});

test("a local backend needs no credential, and gets no Authorization header", async () => {
  const previous = process.env.TYPESAFE_API_KEY;
  delete process.env.TYPESAFE_API_KEY;
  try {
    let headers;
    const decide = createDecide({
      config: backendConfig(),
      fetchImpl: async (_url, init) => {
        headers = init.headers;
        return ok(answers)();
      },
    });
    // `loopback` is the local backend, whose url is 127.0.0.1 — the validator's own rule, honoured here.
    await decide({ ...spec, backend: "local" }, { prompt: "x" });
    assert.equal("authorization" in headers, false, "a stub is never handed someone else's key");
  } finally {
    if (previous !== undefined) process.env.TYPESAFE_API_KEY = previous;
  }
});

test("a rate limit is waited out once, using the header the backend sent", async () => {
  let calls = 0;
  const decide = createDecide({
    config: backendConfig(),
    fetchImpl: async () => {
      calls += 1;
      if (calls === 1) return { ok: false, status: 429, headers: { get: () => "0" }, text: async () => "slow down" };
      return ok(answers)();
    },
  });
  const result = await decide(spec, { prompt: "x" });
  assert.equal(calls, 2);
  assert.equal(result.answers.choice.choice, "mechanical");
});

test("a rate limit that repeats is a named failure with the status, not a third attempt", async () => {
  let calls = 0;
  const decide = createDecide({
    config: backendConfig(),
    fetchImpl: async () => {
      calls += 1;
      return { ok: false, status: 429, headers: { get: () => "0" }, text: async () => "slow down" };
    },
  });
  // The second 429 is reported as what the backend said — an HTTP 429 — rather than as a retry that failed:
  // the message names the status and the body, which is what a reader needs to tell a plan limit from a bug.
  await assert.rejects(() => decide(spec, { prompt: "x" }), /HTTP 429 slow down/);
  assert.equal(calls, 2, "one retry, then the truth");
});

test("a refusal to connect is retried once and then named with the url", async () => {
  let calls = 0;
  const decide = createDecide({
    config: backendConfig(),
    fetchImpl: async () => {
      calls += 1;
      throw new Error("fetch failed");
    },
  });
  await assert.rejects(() => decide(spec, { prompt: "x" }), /decision backend https:\/\/backend\.test\/v1\/systemone failed: fetch failed/);
  assert.equal(calls, 2);
});

test("a response that is not JSON is a named failure, quoting what came back", async () => {
  const decide = createDecide({
    config: backendConfig(),
    fetchImpl: async () => ({ ok: true, status: 200, text: async () => "<html>a proxy</html>" }),
  });
  await assert.rejects(() => decide(spec, { prompt: "x" }), /response was not JSON \(<html>a proxy<\/html>\)/);
});

test("an HTTP error names the status and the body", async () => {
  const decide = createDecide({
    config: backendConfig(),
    fetchImpl: async () => ({ ok: false, status: 502, text: async () => "bad gateway" }),
  });
  await assert.rejects(() => decide(spec, { prompt: "x" }), /HTTP 502 bad gateway/);
});

test("an unknown backend is refused by name", async () => {
  const decide = createDecide({ config: backendConfig(), fetchImpl: ok(answers) });
  await assert.rejects(() => decide({ ...spec, backend: "nope" }, { prompt: "x" }), /unknown decision backend "nope"/);
});

test("SemIf cannot answer a multi-question request, and says why instead of answering one", async () => {
  const decide = createDecide({ config: backendConfig(), fetchImpl: ok(answers) });
  await assert.rejects(
    () => decide({ ...spec, backend: "semif", questions: { a: "x", b: "y" } }, { prompt: "x" }),
    /takes one question per request/,
  );
});

test("an oversized state is trimmed from the middle, and says so", () => {
  const small = "short";
  assert.equal(
    truncateState(small, 100, () => {}),
    small,
    "under budget is untouched",
  );

  const notices = [];
  const long = `${"h".repeat(4000)}\n${"m".repeat(4000)}\n${"t".repeat(4000)}`;
  const trimmed = truncateState(long, 1000, (message) => notices.push(message));
  assert.ok(trimmed.length < long.length);
  assert.match(trimmed, /tokens elided/);
  assert.ok(trimmed.startsWith("h"), "the head carries the request");
  assert.ok(trimmed.endsWith("t"), "the tail carries the latest turns");
  assert.equal(notices.length, 1);
  assert.match(notices[0], /decision state truncated/);
});
