#!/usr/bin/env node
/**
 * typesafe-stub.mjs — an offline TypeSafe-shaped backend, so the decision client, cascades, route, and
 * verify are all verifiable with no key, no network, and no GPU.
 *
 *   node scripts/typesafe-stub.mjs [--port 8793]
 *   POST /v1/systemone   the real envelope: { model, answers: { <id>: ... }, usage }
 *   POST /__mode         { "mode": "decisive" | "ambiguous" } — how confident the next answers are
 *   GET  /health
 *
 * Answers follow the question type: noul → a probability, choice → the first criterion at high
 * confidence, score → a mid level. `decisive` is what a cascade should accept; `ambiguous` is what it
 * must escalate on, which is how verification item 11 runs without a paid call.
 */
import http from "node:http";

const args = process.argv.slice(2);
const portArg = args.indexOf("--port");
const port = portArg === -1 ? 8793 : Number(args[portArg + 1]);
let mode = process.env.STUB_MODE ?? "decisive";

const CONFIDENT = { noul: 0.99, confidence: 0.91 };
const AMBIGUOUS = { noul: 0.31, confidence: 0.51 };

function answerFor(question) {
  const { noul, confidence } = mode === "ambiguous" ? AMBIGUOUS : CONFIDENT;
  if (question.type === "noul") return { type: "noul", noul };
  if (question.type === "score") {
    const levels = question.criteria?.length ?? 3;
    const index = mode === "ambiguous" ? 0 : levels - 1;
    const probabilities = Object.fromEntries(Array.from({ length: levels }, (_, i) => [String(i), i === index ? confidence : (1 - confidence) / Math.max(1, levels - 1)]));
    return { type: "score", score: index, legend: Object.fromEntries(Array.from({ length: levels }, (_, i) => [String(i), question.criteria[i]])), probabilities, confidence };
  }
  const ids = Object.keys(question.criteria ?? {});
  const winner = ids[0];
  const probabilities = Object.fromEntries(ids.map((id) => [id, id === winner ? confidence : (1 - confidence) / Math.max(1, ids.length - 1)]));
  return { type: "choice", choice: winner, probabilities, confidence };
}

const server = http.createServer((req, res) => {
  const send = (code, body) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
  if (req.method === "GET" && req.url === "/health") return send(200, { status: "ok", mode, models: ["jev-stub"] });
  if (req.method === "POST" && req.url === "/__mode") {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => { try { mode = JSON.parse(body).mode ?? mode; } catch { /* keep */ } send(200, { mode }); });
    return;
  }
  if (req.method !== "POST" || !req.url?.startsWith("/v1/systemone")) return send(404, { error: "not found" });

  let body = "";
  req.on("data", (chunk) => { body += chunk; });
  req.on("end", () => {
    let payload;
    try { payload = JSON.parse(body); } catch { return send(400, { error: "invalid json" }); }
    if (!payload.state || !payload.questions || !payload.model) return send(422, { error: "state, model and questions are required" });
    const answers = {};
    for (const [id, question] of Object.entries(payload.questions)) answers[id] = answerFor(question);
    const inputTokens = Math.ceil(JSON.stringify(body).length / 4);
    send(200, { model: payload.model, answers, usage: { input_tokens: inputTokens, output_tokens: 0 } });
  });
});

server.listen(port, "127.0.0.1", () => console.log(`typesafe-stub listening on http://127.0.0.1:${port} (mode: ${mode})`));