#!/usr/bin/env node
/**
 * semif-probe.mjs — assert the SemIf row-schema contract against a backend.
 *
 *   node scripts/semif-probe.mjs --backend http://127.0.0.1:8792/score
 *   node scripts/semif-probe.mjs --backend http://127.0.0.1:8791/score --fixture /path/to/decisions.jsonl
 *
 * Rows are three representative decisions in upstream's row schema (`id`, `state`, `question`,
 * `options`), which is also what the SemIf CLI validates against. Pass `--fixture` to run upstream's own
 * `examples/decisions.jsonl` instead. Asserts HTTP 200, probabilities aligned to the request's option
 * order, every value in 0..1, and a sum of 1. Exits 1 with the failing row and body.
 */
import fs from "node:fs";
import { randomUUID } from "node:crypto";

const args = process.argv.slice(2);
const arg = (name, fallback) => { const i = args.indexOf(`--${name}`); return i === -1 ? fallback : args[i + 1]; };

const backend = arg("backend", "http://127.0.0.1:8792/score");
const apiKey = process.env[arg("apiKeyEnv", "SEMIF_API_KEY")] ?? "";
const fixture = arg("fixture", null);

const embedded = [
  { id: "route-1", state: "Customer cannot access an account after a password reset.",
    question: "Which queue should handle this request?",
    options: [{ id: "access", description: "Account access support." }, { id: "billing", description: "Billing support." }] },
  { id: "urgent-1", state: "Help! My payouts have been failing for 3 days.",
    question: "How urgent is this?", options: [{ id: "low", description: "Not time sensitive." }, { id: "high", description: "Explicitly time sensitive." }] },
  { id: "quality-1", state: "A bug report with a reproduction and a stack trace.",
    question: "How actionable is this report?",
    options: [{ id: "unusable", description: "No repro." }, { id: "partial", description: "Some detail." }, { id: "actionable", description: "Reproduction and trace." }] },
];

const rows = fixture
  ? fs.readFileSync(fixture, "utf8").split("\n").filter((line) => line.trim()).map((line) => JSON.parse(line))
  : embedded;

const failures = [];
for (const row of rows) {
  if (!row.id || !row.state || !row.question || !Array.isArray(row.options)) { failures.push(`${row.id ?? "?"}: row is not in the SemIf schema`); continue; }
  let response;
  let payload;
  try {
    response = await fetch(backend, {
      method: "POST",
      headers: { "content-type": "application/json", ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) },
      body: JSON.stringify({ id: row.id ?? randomUUID(), state: row.state, question: row.question, options: row.options, model: arg("model", "qwen3.5-4b"), max_tokens: 4096 }),
    });
    payload = await response.json();
  } catch (error) {
    failures.push(`${row.id}: request failed: ${error.message}`);
    continue;
  }
  if (!response.ok) { failures.push(`${row.id}: HTTP ${response.status} ${JSON.stringify(payload).slice(0, 200)}`); continue; }

  const expected = row.options.map((o) => o.id);
  const got = payload.option_ids ?? [];
  if (got.length !== expected.length || got.some((id, i) => id !== expected[i])) {
    failures.push(`${row.id}: option_ids ${JSON.stringify(got)} do not match the request order ${JSON.stringify(expected)}`);
  }
  const probabilities = payload.probabilities ?? [];
  if (probabilities.length !== expected.length) { failures.push(`${row.id}: ${probabilities.length} probabilities for ${expected.length} options`); continue; }
  const sum = probabilities.reduce((a, b) => a + b, 0);
  if (Math.abs(sum - 1) > 1e-6) failures.push(`${row.id}: probabilities sum to ${sum}`);
  probabilities.forEach((p, i) => {
    if (typeof p !== "number" || p < 0 || p > 1) failures.push(`${row.id}: probability[${i}] = ${p} outside 0..1`);
  });
  if (!payload.model?.revision) failures.push(`${row.id}: response has no pinned model revision`);
}

if (failures.length) {
  console.error(`semif-probe: ${failures.length} failure(s) against ${backend}`);
  for (const failure of failures) console.error("  ", failure);
  process.exit(1);
}
console.log(`semif-probe: ok — ${rows.length} rows against ${backend}${fixture ? ` (fixture ${fixture})` : " (embedded rows)"}`);