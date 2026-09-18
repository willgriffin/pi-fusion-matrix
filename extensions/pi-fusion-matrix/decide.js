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
import { interpolate } from "./config.js";

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
    const response = await fetchImpl(url, {
      method: "POST", headers, body: JSON.stringify(body), signal: timeoutSignal(timeoutMs, signal),
    });
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
    if (!answer) { out[id] = null; continue; }
    if (answer.type === "noul") out[id] = { type: "noul", noul: answer.noul };
    else if (answer.type === "score") out[id] = { type: "score", score: answer.score, legend: answer.legend, probabilities: answer.probabilities, confidence: answer.confidence };
    else out[id] = { type: "choice", choice: answer.choice, probabilities: answer.probabilities, confidence: answer.confidence };
  }
  return out;
}

const usageFrom = (payload) => ({
  input: payload?.usage?.input_tokens ?? 0,
  output: payload?.usage?.output_tokens ?? 0,
  cacheRead: 0, cacheWrite: 0,
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
    if (backend.apiKeyEnv && !apiKey) throw new Error(`decision backend "${backendName}" needs env var ${backend.apiKeyEnv}`);

    if (backend.kind === "semif" && spec.questions) {
      throw new Error(`backend "${backendName}" is SemIf and takes one question per request; use a criteria decision or the questions form on a typesafe backend`);
    }
    const state = truncateState(interpolate(spec.state ?? vars.input ?? "", vars, "decision state"), STATE_BUDGET_TOKENS, log);
    const options = { apiKey, timeoutMs: backend.timeoutMs, signal, log };
    const criteria = spec.criteria;

    if (backend.kind === "typesafe") {
      const questions = spec.questions
        ? interpolate(spec.questions, vars, "decision questions")
        : criteria
          ? { choice: { type: "choice", instructions: spec.instructions, criteria: fromCriteria(criteria) } }
          : {};
      if (spec.over?.length) {
        for (const item of spec.over) {
          questions[item.persona] = {
            type: spec.score ? "score" : "choice",
            instructions: `${spec.instructions}\n\nResponse to evaluate (${item.persona}):\n${item.text ?? ""}`,
            criteria: spec.score ? spec.score.criteria : fromCriteria(criteria),
          };
        }
      }
      const body = { state, model: backend.model, questions };
      const payload = await postJson(fetchImpl, backend.url, body, options);
      return {
        backend: backendName, model: payload?.model ?? backend.model,
        answers: normaliseTypeSafeAnswers(payload, Object.keys(questions)),
        usage: usageFrom(payload),
      };
    }

    // SemIf: one question per request, so `over` becomes N requests and `questions` is rejected at load.
    if (spec.over?.length) {
      const answers = {};
      let usage = usageFrom(null);
      for (const item of spec.over) {
        const payload = await postJson(fetchImpl, backend.url, {
          id: randomUUID(), state: `${state}\n\nResponse to evaluate (${item.persona}):\n${item.text ?? ""}`,
          question: spec.instructions, options: toOptions(criteria), model: backend.model, max_tokens: 4096,
        }, options);
        answers[item.persona] = normaliseSemifAnswer(payload, criteria);
        usage = sumUsage(usage, usageFrom(payload));
      }
      return { backend: backendName, model: backend.model, answers, usage };
    }

    const payload = await postJson(fetchImpl, backend.url, {
      id: randomUUID(), state, question: spec.instructions, options: toOptions(criteria),
      model: backend.model, max_tokens: 4096,
    }, options);
    return {
      backend: backendName, model: backend.model,
      answers: { choice: normaliseSemifAnswer(payload, criteria) }, usage: usageFrom(payload),
    };
  };
}

const fromCriteria = (criteria) =>
  Object.fromEntries(Object.entries(criteria ?? {}).map(([id, value]) => [id, typeof value === "string" ? value : value?.description ?? null]));

const toOptions = (criteria) =>
  Object.entries(criteria ?? {}).map(([id, value]) => ({ id, description: typeof value === "string" ? value : value?.description ?? "" }));

function normaliseSemifAnswer(payload, criteria) {
  const probabilities = {};
  const ids = payload?.option_ids ?? Object.keys(criteria ?? {});
  const values = payload?.probabilities ?? [];
  ids.forEach((id, index) => { probabilities[id] = values[index] ?? 0; });
  const winner = ids.reduce((best, id) => (probabilities[id] > (probabilities[best] ?? -1) ? id : best), ids[0]);
  // SemIf reports no confidence at all — its own output says the probabilities are uncalibrated as
  // decision confidence — so this answer can never satisfy a confidence gate. That is why a route
  // resolving to a SemIf backend is a load error.
  return { type: "probabilities", choice: winner, probabilities };
}

function sumUsage(a, b) {
  return {
    input: a.input + b.input, output: a.output + b.output, cacheRead: 0, cacheWrite: 0,
    totalTokens: a.totalTokens + b.totalTokens,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}