#!/usr/bin/env node
/**
 * semif-stub.mjs — an offline SemIf-shaped backend: one question per request, probabilities, no
 * confidence. Being confidence-less is the point: it is what proves a SemIf backend can never satisfy
 * a cascade or steer a route.
 *
 *   node scripts/semif-stub.mjs [--port 8792]
 *   POST /score   { id, state, question, options: [{id, description}], model, max_tokens }
 *   GET  /health
 */
import http from "node:http";
import { createHash, randomUUID } from "node:crypto";

const args = process.argv.slice(2);
const portArg = args.indexOf("--port");
const port = portArg === -1 ? 8792 : Number(args[portArg + 1]);

const server = http.createServer((req, res) => {
  const send = (code, body) => {
    res.writeHead(code, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  if (req.method === "GET" && req.url === "/health") return send(200, { status: "ok", models: ["qwen3.5-4b"] });
  if (req.method !== "POST" || !req.url?.startsWith("/score")) return send(404, { error: "not found" });

  let body = "";
  req.on("data", (chunk) => {
    body += chunk;
  });
  req.on("end", () => {
    let payload;
    try {
      payload = JSON.parse(body);
    } catch {
      return send(400, { error: "invalid json" });
    }
    const options = payload.options;
    if (!Array.isArray(options) || options.length < 2 || options.length > 16) {
      return send(422, { error: "options must contain 2-16 entries" });
    }
    if (typeof payload.question !== "string" || !payload.question) return send(422, { error: "question is required" });
    if (typeof payload.state !== "string" || !payload.state) return send(422, { error: "state is required" });

    // First option 0.6, the rest even; mirrors the documented stub behaviour.
    const rest = (1 - 0.6) / (options.length - 1);
    const probabilities = options.map((_, i) => (i === 0 ? 0.6 : rest));
    const logits = probabilities.map((p) => Math.log(p));
    const prompt = `${payload.question}\n${payload.state}\n${options.map((o) => o.description).join("\n")}`;
    send(200, {
      id: payload.id ?? randomUUID(),
      option_ids: options.map((o) => o.id),
      probabilities,
      option_logits: logits,
      model: { source: "stub/qwen3.5-4b", revision: "0".repeat(40) },
      total_seconds: 0.001,
      prompt_sha256: createHash("sha256").update(prompt).digest("hex"),
      readout: "stub",
      probability_status: "uncalibrated as decision confidence",
    });
  });
});

server.listen(port, "127.0.0.1", () => console.log(`semif-stub listening on http://127.0.0.1:${port}`));
