#!/usr/bin/env node
/**
 * typesafe-probe.mjs — assert the TypeSafe contract against a backend (the stub, or the real one).
 *
 *   node scripts/typesafe-probe.mjs --backend http://127.0.0.1:8793/v1/systemone
 *   node scripts/typesafe-probe.mjs --backend https://api.typesafe.ai/v1/systemone
 *
 * The model defaults to the packaged pin (`backends.typesafe.model`, `jev-1.13.0`), not to a literal
 * here: the pin lives in `matrix.json` so a version bump is one reviewed edit, and the probe and the
 * extension cannot drift apart. A backend that serves something else takes `--model`.
 *
 * Asserts, per row: HTTP 200; one answer per question id; `probabilities` keyed by the criteria ids and
 * summing to 1; and `confidence` present on every choice and score answer. Exits 1 with the failing row
 * and response body, because "the backend is misconfigured" and "the extension is wrong" must not look
 * the same.
 */
import { loadMatrixConfig } from "../extensions/pi-fusion-matrix/config.js";

const args = process.argv.slice(2);
const arg = (name, fallback) => { const i = args.indexOf(`--${name}`); return i === -1 ? fallback : args[i + 1]; };

const backend = arg("backend", "http://127.0.0.1:8793/v1/systemone");
const model = arg("model", loadMatrixConfig({ cwd: process.cwd() }).config.backends?.typesafe?.model ?? "jev-1.13.0");
const apiKey = process.env[arg("apiKeyEnv", "TYPESAFE_API_KEY")] ?? "";

const rows = [
  { id: "route-1", state: "Customer cannot access an account after a password reset.",
    questions: { department: { type: "choice", instructions: "Which team should handle this?", criteria: { access: "Account access support.", billing: "Billing support." } } } },
  { id: "urgent-1", state: "Help! My payouts have been failing for 3 days.",
    questions: { is_urgent: { type: "noul", instructions: "Does this convey urgency?" } } },
  { id: "score-1", state: "A crisp bug report with a reproduction and a stack trace.",
    questions: { quality: { type: "score", instructions: "How actionable is this report?", criteria: ["Unusable", "Partial", "Actionable"] } } },
];

const failures = [];
const near = (a, b, eps = 1e-6) => Math.abs(a - b) < eps;

for (const row of rows) {
  let response;
  let payload;
  try {
    response = await fetch(backend, {
      method: "POST",
      headers: { "content-type": "application/json", ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) },
      body: JSON.stringify({ state: row.state, model, questions: row.questions }),
    });
    payload = await response.json();
  } catch (error) {
    failures.push(`${row.id}: request failed: ${error.message}`);
    continue;
  }
  if (!response.ok) { failures.push(`${row.id}: HTTP ${response.status} ${JSON.stringify(payload).slice(0, 200)}`); continue; }

  for (const [id, question] of Object.entries(row.questions)) {
    const answer = payload.answers?.[id];
    if (!answer) { failures.push(`${row.id}: no answer for "${id}"`); continue; }
    if (answer.type !== question.type) failures.push(`${row.id}.${id}: answer type ${answer.type} != question type ${question.type}`);
    if (question.type === "noul") {
      if (typeof answer.noul !== "number" || answer.noul < 0 || answer.noul > 1) failures.push(`${row.id}.${id}: noul ${answer.noul} outside 0..1`);
      continue;
    }
    const ids = Object.keys(answer.probabilities ?? {});
    const expected = question.type === "choice" ? Object.keys(question.criteria) : question.criteria.map((_, i) => String(i));
    if (ids.length !== expected.length) failures.push(`${row.id}.${id}: ${ids.length} probabilities for ${expected.length} options (${ids.join(",")})`);
    const sum = Object.values(answer.probabilities ?? {}).reduce((a, b) => a + b, 0);
    if (!near(sum, 1)) failures.push(`${row.id}.${id}: probabilities sum to ${sum}`);
    for (const [key, p] of Object.entries(answer.probabilities ?? {})) {
      if (typeof p !== "number" || p < 0 || p > 1) failures.push(`${row.id}.${id}: probability ${key}=${p} outside 0..1`);
    }
    if (typeof answer.confidence !== "number") failures.push(`${row.id}.${id}: no confidence on a ${question.type} answer`);
  }
}

if (failures.length) {
  console.error(`typesafe-probe: ${failures.length} failure(s) against ${backend}`);
  for (const failure of failures) console.error("  ", failure);
  process.exit(1);
}
console.log(`typesafe-probe: ok — ${rows.length} rows against ${backend} (model ${model})`);