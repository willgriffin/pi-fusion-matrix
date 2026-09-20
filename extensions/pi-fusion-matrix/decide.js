/**
 * decide.js — the decision client, for both backend kinds.
 *
 * One choice vocabulary in, each backend's wire format out:
 *   - a `criteria` decision becomes one choice question (TypeSafe) or SemIf's `options` array;
 *   - a `questions` decision is passed through, batched (TypeSafe only — SemIf's row schema is one
 *     question per request, so a `questions` decision on a SemIf backend is a load error);
 *   - `over` fans one question across items: TypeSafe packs them into one request (its documented
 *     fan-out pattern — every question is evaluated against the same state, so each carries its own
 *     item), while SemIf needs one request per item by construction.
 *
 * Answers normalise to one shape, which is why seat code never branches on the backend.
 *
 * Verified shapes: TypeSafe `{ model, answers: { <id>: {...} }, usage: { input_tokens, output_tokens } }`
 * at `POST /v1/systemone`; SemIf's row schema and response keys per
 * `src/semif_phase1/core.py: validate_row`.
 */

import { randomUUID } from "node:crypto";
import { interpolate, LOOPBACK_URL } from "./config.js";

const STATE_BUDGET_TOKENS = 32768;
const estimateTokens = (text) => Math.ceil(String(text ?? "").length / 4);

/** Trim an oversized state from the middle: the head carries the request, the tail the latest turns. */
export function truncateState(state, budget, onNotice) {
  const tokens = estimateTokens(state);
  if (tokens <= budget) return state;
  const keep = Math.max(1000, Math.floor((budget * 4) / 2));
  const head = String(state).slice(0, keep);
  const tail = String(state).slice(-keep);
  onNotice?.(`⚠️ decision state truncated for the backend (${tokens} tokens > ${budget})`);
  return `${head}\n\n[… ${tokens - budget} tokens elided …]\n\n${tail}`;
}

function timeoutSignal(timeoutMs, external) {
  const timeout = AbortSignal.timeout(timeoutMs ?? 60000);
  if (!external) return timeout;
  return AbortSignal.any([external, timeout]);
}

function retryAfterMs(response) {
  const header = response.headers?.get?.("retry-after");
  if (!header) return null;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return seconds * 1000;
  const at = Date.parse(header);
  return Number.isNaN(at) ? null : Math.max(0, at - Date.now());
}

async function postJson(fetchImpl, url, body, { apiKey, timeoutMs, signal, log }) {
  const headers = { "content-type": "application/json", ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) };
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    let response;
    try {
      response = await fetchImpl(url, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: timeoutSignal(timeoutMs, signal),
      });
    } catch (error) {
      // `fetch` rejects before a response exists: refused connection, DNS, or the timeout signal. That
      // is the same transient class as a 429, so it gets the same single retry, and the platform
      // message becomes the detail rather than escaping unlabelled. An aborted run is not transient —
      // it propagates at once instead of sleeping 2 s first.
      const detail = error?.message ?? String(error);
      if (attempt === 1 && !signal?.aborted) {
        log?.(`decision backend unreachable (${detail}); retrying in 2s`);
        await new Promise((resolve) => setTimeout(resolve, 2000));
        continue;
      }
      throw new Error(`decision backend ${url} failed: ${detail}`, { cause: error });
    }
    if (response.status === 429 && attempt === 1) {
      const wait = retryAfterMs(response) ?? 2000;
      log?.(`decision backend rate limited; retrying in ${Math.round(wait / 1000)}s`);
      await new Promise((resolve) => setTimeout(resolve, Math.min(wait, 30000)));
      continue;
    }
    const text = await response.text();
    if (!response.ok) throw new Error(`decision backend ${url} failed: HTTP ${response.status} ${text.slice(0, 200)}`);
    try {
      return JSON.parse(text);
    } catch {
      throw new Error(`decision backend ${url} failed: response was not JSON (${text.slice(0, 120)})`);
    }
  }
  throw new Error(`decision backend ${url} failed: rate limited twice`);
}

function normaliseTypeSafeAnswers(payload, expectedIds) {
  const answers = payload?.answers;
  if (!answers || typeof answers !== "object") throw new Error("TypeSafe response had no answers object");
  const out = {};
  for (const id of expectedIds) {
    const answer = answers[id];
    if (!answer) {
      out[id] = null;
      continue;
    }
    if (answer.type === "noul") out[id] = { type: "noul", noul: answer.noul };
    else if (answer.type === "score")
      out[id] = {
        type: "score",
        score: answer.score,
        legend: answer.legend,
        probabilities: answer.probabilities,
        confidence: answer.confidence,
      };
    else out[id] = { type: "choice", choice: answer.choice, probabilities: answer.probabilities, confidence: answer.confidence };
  }
  return out;
}

const usageFrom = (payload) => ({
  input: payload?.usage?.input_tokens ?? 0,
  output: payload?.usage?.output_tokens ?? 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: (payload?.usage?.input_tokens ?? 0) + (payload?.usage?.output_tokens ?? 0),
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
});

/**
 * @returns {Promise<(spec, vars, signal) => Promise<{ backend, model, answers, usage }>>}
 */
export function createDecide({ config, fetchImpl = globalThis.fetch, log } = {}) {
  return async function decide(spec, vars = {}, signal) {
    const backendName = spec.backend ?? config.decide?.defaultBackend;
    const backend = config.backends?.[backendName];
    if (!backend) throw new Error(`unknown decision backend "${backendName}"`);
    const apiKey = backend.apiKeyEnv ? process.env[backend.apiKeyEnv] : undefined;
    // A backend on this machine needs no credential, exactly as the validator says. It also gets no
    // Authorization header, so a stub cannot be handed someone else's key; a non-loopback backend
    // without a key still fails here.
    const loopback = LOOPBACK_URL.test(backend.url ?? "");
    if (backend.apiKeyEnv && !apiKey && !loopback) throw new Error(`decision backend "${backendName}" needs env var ${backend.apiKeyEnv}`);

    if (backend.kind === "semif" && spec.questions) {
      throw new Error(
        `backend "${backendName}" is SemIf and takes one question per request; use a criteria decision or the questions form on a typesafe backend`,
      );
    }
    const state = truncateState(interpolate(spec.state ?? vars.input ?? "", vars, "decision state"), STATE_BUDGET_TOKENS, log);
    const options = { apiKey, timeoutMs: backend.timeoutMs, signal, log };
    const criteria = spec.criteria;

    // A `score` stage's criteria are the rating levels, not an option map — the one place an array is
    // legal — and every `over` item is then a `score` question over those levels. A decide/fan-out with
    // an option map stays a `choice` question. (Before this, a score stage built `choice` questions over
    // `{"0": "off-topic", …}`, so no answer ever carried a `score` and every weight rendered as 0.00.)
    const levels = Array.isArray(criteria) ? criteria : undefined;
    const optionMap = levels ? undefined : criteria;

    if (backend.kind === "typesafe") {
      const questions = spec.questions
        ? interpolate(spec.questions, vars, "decision questions")
        : optionMap
          ? { choice: { type: "choice", instructions: spec.instructions, criteria: fromCriteria(optionMap) } }
          : {};
      if (spec.over?.length) {
        for (const item of spec.over) {
          questions[item.persona] = {
            type: levels ? "score" : "choice",
            instructions: `${spec.instructions}\n\nResponse to evaluate (${item.persona}):\n${item.text ?? ""}`,
            criteria: levels ?? fromCriteria(optionMap),
          };
        }
      }
      const body = { state, model: backend.model, questions };
      const payload = await postJson(fetchImpl, backend.url, body, options);
      return {
        backend: backendName,
        model: payload?.model ?? backend.model,
        answers: normaliseTypeSafeAnswers(payload, Object.keys(questions)),
        usage: usageFrom(payload),
      };
    }

    // SemIf: one question per request, so `over` becomes N requests and `questions` is rejected at load.
    if (spec.over?.length) {
      const answers = {};
      let usage = usageFrom(null);
      for (const item of spec.over) {
        const payload = await postJson(
          fetchImpl,
          backend.url,
          {
            id: randomUUID(),
            state: `${state}\n\nResponse to evaluate (${item.persona}):\n${item.text ?? ""}`,
            question: spec.instructions,
            options: toOptions(criteria),
            model: backend.model,
            max_tokens: 4096,
          },
          options,
        );
        answers[item.persona] = normaliseSemifAnswer(payload, criteria, backend.url);
        usage = sumUsage(usage, usageFrom(payload));
      }
      return { backend: backendName, model: backend.model, answers, usage };
    }

    const payload = await postJson(
      fetchImpl,
      backend.url,
      {
        id: randomUUID(),
        state,
        question: spec.instructions,
        options: toOptions(criteria),
        model: backend.model,
        max_tokens: 4096,
      },
      options,
    );
    return {
      backend: backendName,
      model: backend.model,
      answers: { choice: normaliseSemifAnswer(payload, criteria, backend.url) },
      usage: usageFrom(payload),
    };
  };
}

const fromCriteria = (criteria) =>
  Object.fromEntries(
    Object.entries(criteria ?? {}).map(([id, value]) => [id, typeof value === "string" ? value : (value?.description ?? null)]),
  );

const toOptions = (criteria) =>
  Object.entries(criteria ?? {}).map(([id, value]) => ({
    id,
    description: typeof value === "string" ? value : (value?.description ?? ""),
  }));

function normaliseSemifAnswer(payload, criteria, url) {
  const failure = (detail) => new Error(`decision backend ${url} failed: ${detail}`);
  if (!payload || typeof payload !== "object") throw failure("response was not a JSON object");
  const reportsIds = Array.isArray(payload.option_ids) && payload.option_ids.length > 0;
  if (payload.probabilities === undefined && !reportsIds) throw failure("response carried neither option_ids nor probabilities");
  const ids = reportsIds ? payload.option_ids : Object.keys(criteria ?? {});
  const values = payload.probabilities;
  // SemIf aligns `probabilities` to the request's option order, so a short (or absent) array is a
  // malformed answer rather than a low one: indexing past it as 0 would turn `{}` or a truncated
  // payload into a confident winner at probability 0. The plan makes "probabilities length ≠ option
  // count" a failure, not a value.
  if (!Array.isArray(values) || values.length !== ids.length) {
    throw failure(`${Array.isArray(values) ? values.length : 0} probabilities for ${ids.length} options`);
  }
  if (ids.length === 0) throw failure("response carried no options to align");
  const probabilities = {};
  ids.forEach((id, index) => {
    probabilities[id] = values[index];
  });
  const winner = ids.reduce((best, id) => (probabilities[id] > (probabilities[best] ?? -1) ? id : best), ids[0]);
  // SemIf reports no confidence at all — its own output says the probabilities are uncalibrated as
  // decision confidence — so this answer can never satisfy a confidence gate. That is why any
  // sufficientWhen (or route) resolving to a SemIf backend is a load error, not a run that cascades.
  return { type: "probabilities", choice: winner, probabilities };
}

function sumUsage(a, b) {
  return {
    input: a.input + b.input,
    output: a.output + b.output,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: a.totalTokens + b.totalTokens,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}
