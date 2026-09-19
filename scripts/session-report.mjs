#!/usr/bin/env node
/**
 * session-report.mjs — read back what the two faces recorded, from the sessions on disk.
 *
 * The run record is the contract, and this is its only reader:
 *
 *   deliberate face   a `matrix` tool result or a `/matrix` answer carries `details.fusion` with
 *                     `mode`, `seats` (persona, alias, provider, model, template, thinking, usage,
 *                     degraded, error, reason), `seatErrors`, `rounds`, `substitutions`, `cascades`,
 *                     `routing`, `verification`, `usage` and `decisionUsage`.
 *   proxy face        an assistant message carries `details.proxied` with the alias that answered, the
 *                     level the turn ran at, and every route it tried in `attempts`.
 *   both              the message's own `usage` carries tokens and, when the provider is priced, cost;
 *                     omp adds `duration`/`ttft` in milliseconds, pi does not record a duration at all.
 *
 *   node scripts/session-report.mjs                      # both harnesses, every session
 *   node scripts/session-report.mjs --cwd proxy-check    # one project (substring of the session cwd)
 *   node scripts/session-report.mjs --since 2026-09-19   # sessions started on/after a date
 *   node scripts/session-report.mjs --session <file>     # one session, one line per record
 *   node scripts/session-report.mjs --json               # the same numbers, machine-readable
 *   node scripts/session-report.mjs --check              # fixture self-test; 2 on failure
 *
 * It reads files and does nothing else: no network, no keys, no model calls, no writes.
 *
 * Exit status: 0 report produced, 1 the store could not be read as asked (missing or empty `--dir`,
 * unreadable `--session`), 2 `--check` failed.
 *
 * Two numbers are deliberately reported as *absent* rather than as zero: a message whose harness records
 * no duration, and a message whose provider reports no price. Reading either as 0 would turn "we did not
 * record it" into "it cost nothing", which is exactly the mistake this report exists to prevent.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const DEFAULT_ROOTS = [
  { harness: "pi", root: path.join(os.homedir(), ".pi/agent/sessions") },
  { harness: "omp", root: path.join(os.homedir(), ".omp/agent/sessions") },
];

/** The api id every fusion model is registered under, so a turn names the fusion that served it. */
const FUSION_API = "fusion-matrix";
/** Keys that only ever appear in a fusion run record: a shape carrying one of these is ours to explain. */
const RECORD_KEYS = ["fusion", "proxied", "cascades", "seats", "seatErrors"];

const args = process.argv.slice(2);
const has = (flag) => args.includes(`--${flag}`);
const values = (name) => args.flatMap((arg, i) => (arg === `--${name}` ? [args[i + 1]].filter((v) => v !== undefined) : []));
const value = (name, fallback) => values(name).at(-1) ?? fallback;

const emptySums = () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, totalTokens: 0, cost: 0 });

function addUsage(sums, usage) {
  if (!usage || typeof usage !== "object") return sums;
  sums.input += usage.input ?? 0;
  sums.output += usage.output ?? 0;
  sums.cacheRead += usage.cacheRead ?? 0;
  sums.cacheWrite += usage.cacheWrite ?? 0;
  sums.reasoning += usage.reasoning ?? 0;
  sums.totalTokens += usage.totalTokens ?? (usage.input ?? 0) + (usage.output ?? 0);
  sums.cost += usage.cost?.total ?? 0;
  return sums;
}

/** Every `*.jsonl` under a root, one level of cwd-slug directories deep. */
function findSessions(root) {
  const out = [];
  let cwdDirs;
  try {
    cwdDirs = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return { missing: true, files: out };
  }
  for (const dirent of cwdDirs) {
    if (!dirent.isDirectory()) continue;
    const dir = path.join(root, dirent.name);
    let names;
    try {
      names = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const name of names) {
      if (name.isFile() && name.name.endsWith(".jsonl")) out.push(path.join(dir, name.name));
    }
  }
  out.sort();
  return { missing: false, files: out };
}

/**
 * One session file into entries. A line that does not parse is counted, not skipped: a truncated write is
 * a fact about the store, and silently dropping it would understate every total below.
 */
export function parseLines(text) {
  const entries = [];
  let unparsed = 0;
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      entries.push(JSON.parse(line));
    } catch {
      unparsed += 1;
    }
  }
  return { entries, unparsed };
}

const isRecordShape = (details) => typeof details === "object" && details !== null && RECORD_KEYS.some((key) => key in details);

/**
 * Pull the fusion records and the turn economics out of one session's entries.
 *
 * Tool results are attributed to the most recent assistant turn, which is how the transcript reads: a
 * result cannot name its caller in this format, so "tools this model called" means "tools that came back
 * after this model last spoke". That is an approximation, and the report says so rather than presenting it
 * as attribution by the harness.
 */
export function extractSession(entries, meta = {}) {
  const session = {
    ...meta,
    id: undefined,
    cwd: undefined,
    startedAt: undefined,
    version: undefined,
    entries: entries.length,
    unparsed: meta.unparsed ?? 0,
    turns: [],
    toolResults: [],
    records: [],
    unknown: [],
    problems: [],
  };

  let current = null;
  for (const entry of entries) {
    if (entry?.type === "session") {
      session.id = entry.id ?? session.id;
      session.cwd = entry.cwd ?? session.cwd;
      session.startedAt = entry.timestamp ?? session.startedAt;
      session.version = entry.version ?? session.version;
      continue;
    }

    if (entry?.type === "custom_message") {
      const details = entry.details;
      if (typeof details?.fusion === "string") {
        session.records.push({ kind: "deliberation", carrier: "custom_message", fusion: details.fusion, details, at: entry.timestamp });
      } else if (isRecordShape(details)) {
        session.unknown.push({ carrier: "custom_message", keys: Object.keys(details).sort(), at: entry.timestamp });
      }
      continue;
    }

    const message = entry?.message;
    if (!message || typeof message !== "object") continue;

    if (message.role === "assistant") {
      const usage = message.usage ?? {};
      const priced = (usage.cost?.total ?? 0) > 0;
      current = {
        api: message.api,
        provider: message.provider,
        model: message.model,
        stopReason: message.stopReason,
        usage,
        priced,
        durationMs: Number.isFinite(message.duration) ? message.duration : undefined,
        toolCalls: (message.content ?? []).filter((part) => part?.type === "toolCall").map((part) => part.name ?? "?"),
        at: message.timestamp ?? entry.timestamp,
      };
      session.turns.push(current);
      const details = message.details;
      if (isRecordShape(details)) {
        if (typeof details.proxied === "object" && details.proxied !== null) {
          session.records.push({ kind: "proxy", carrier: "assistant", fusion: current.model, details: details.proxied, at: current.at });
        } else {
          session.unknown.push({ carrier: "assistant", keys: Object.keys(details).sort(), at: current.at });
        }
      }
      continue;
    }

    if (message.role === "toolResult") {
      session.toolResults.push({ toolName: message.toolName ?? "?", isError: message.isError === true, after: current, at: message.timestamp ?? entry.timestamp });
      const details = message.details;
      if (typeof details?.fusion === "string") {
        session.records.push({ kind: "deliberation", carrier: "toolResult", fusion: details.fusion, details, at: session.toolResults.at(-1).at });
      } else if (isRecordShape(details)) {
        session.unknown.push({ carrier: "toolResult", keys: Object.keys(details).sort(), at: session.toolResults.at(-1).at });
      }
    }
  }

  if (!session.cwd) session.problems.push("no session header: cwd unknown");
  return session;
}

const turnKey = (turn) => (turn.api === FUSION_API ? `fusion:${turn.model}` : `${turn.provider ?? "?"}/${turn.model ?? "?"}`);

/** Fold sessions into the report. Pure: the same sessions always give the same numbers. */
export function aggregate(sessions) {
  const report = {
    sessions: sessions.length,
    entries: 0,
    unparsed: 0,
    records: { deliberation: 0, proxy: 0 },
    unknownShapes: [],
    problems: [],
    turns: new Map(),
    proxy: new Map(),
    deliberation: new Map(),
    tools: new Map(),
    toolCalls: new Map(),
    gaps: { noDuration: 0, unpriced: 0, sessionsWithoutHeader: 0, toolAttribution: "most recent assistant turn" },
  };

  const turn = (map, key, seed) => {
    if (!map.has(key)) map.set(key, { key, turns: 0, sums: emptySums(), priced: 0, unpriced: 0, timed: 0, missingDuration: 0, durations: [], errors: 0, toolCalls: 0, toolErrors: 0, ...seed });
    return map.get(key);
  };

  for (const session of sessions) {
    report.entries += session.entries;
    report.unparsed += session.unparsed;
    if (session.problems.length) report.gaps.sessionsWithoutHeader += 1;
    for (const problem of session.problems) report.problems.push(`${session.file ?? session.id ?? "session"}: ${problem}`);
    for (const unknown of session.unknown) {
      report.unknownShapes.push({ file: session.file, harness: session.harness, carrier: unknown.carrier, keys: unknown.keys, at: unknown.at });
    }

    for (const t of session.turns) {
      const key = turnKey(t);
      const record = turn(report.turns, key, { fusion: t.api === FUSION_API });
      record.turns += 1;
      addUsage(record.sums, t.usage);
      if (t.priced) record.priced += 1;
      else { record.unpriced += 1; report.gaps.unpriced += 1; }
      if (t.durationMs !== undefined) { record.timed += 1; record.durations.push(t.durationMs); }
      else { record.missingDuration += 1; report.gaps.noDuration += 1; }
      if (t.stopReason === "error" || t.stopReason === "aborted") record.errors += 1;
      record.toolCalls += t.toolCalls.length;
      for (const name of t.toolCalls) report.toolCalls.set(name, (report.toolCalls.get(name) ?? 0) + 1);
    }

    for (const result of session.toolResults) {
      const record = turn(report.tools, result.toolName, {});
      record.turns += 1;
      record.errors += result.isError ? 1 : 0;
      const owner = result.after ? turn(report.turns, turnKey(result.after), { fusion: result.after.api === FUSION_API }) : undefined;
      if (owner && result.isError) owner.toolErrors += 1;
    }

    for (const entry of session.records) {
      if (entry.kind === "proxy") {
        report.records.proxy += 1;
        const proxied = entry.details;
        const key = entry.fusion ?? proxied.model ?? "?";
        const record = turn(report.proxy, key, { aliases: new Map(), levels: new Map(), attempts: new Map(), dropped: 0, failures: 0, sums: emptySums(), blank: 0 });
        record.turns += 1;
        if (typeof proxied.alias === "string") record.aliases.set(proxied.alias, (record.aliases.get(proxied.alias) ?? 0) + 1);
        const level = proxied.thinking ?? null;
        record.levels.set(level ?? "none", (record.levels.get(level ?? "none") ?? 0) + 1);
        const attempts = Array.isArray(proxied.attempts) ? proxied.attempts : [];
        for (const attempt of attempts) record.attempts.set(attempt?.reason ?? "?", (record.attempts.get(attempt?.reason ?? "?") ?? 0) + 1);
        // A turn that ran at no level while a route was refused at the level we asked for: the drop is the
        // fact worth counting, because it is what makes a cheap model answer without reasoning.
        const dropped = attempts.length > 0 && level === null;
        if (dropped) record.dropped += 1;
        if (typeof proxied.attempts === "undefined") record.blank += 1;
        continue;
      }

      report.records.deliberation += 1;
      const details = entry.details;
      const key = entry.fusion;
      const record = turn(report.deliberation, key, {
        carriers: new Map(), sums: emptySums(), decisionUsage: emptySums(), seats: 0, degradedSeats: 0, seatErrors: 0,
        cascades: 0, cascadesSufficient: 0, cascadesAdvanced: 0, cascadeSeats: new Map(), substitutions: 0, rounds: 0,
        verify: 0, route: 0, saved: 0, failedWrites: 0, failures: 0, routed: undefined,
      });
      record.runs = (record.runs ?? 0) + 1;
      record.carriers.set(entry.carrier, (record.carriers.get(entry.carrier) ?? 0) + 1);
      addUsage(record.sums, details.usage);
      addUsage(record.decisionUsage, details.decisionUsage);
      const seats = Array.isArray(details.seats) ? details.seats : [];
      const seatErrors = Array.isArray(details.seatErrors) ? details.seatErrors : [];
      record.seats += seats.length;
      for (const seat of seats) {
        if (seat?.degraded) record.degradedSeats += 1;
        addUsage(record.sums, seat?.usage);
      }
      record.seatErrors += seatErrors.length;
      const survived = seats.filter((seat) => !seat?.degraded).length;
      // A run failed either because it recorded an error, or because no seat survived it: a degraded run
      // that still "answered" from a partial panel is not the same thing as one that never answered.
      if (details.error || (seats.length > 0 && survived === 0) || (seats.length === 0 && seatErrors.length > 0)) record.failures += 1;
      const cascades = Array.isArray(details.cascades) ? details.cascades : [];
      for (const cascade of cascades) {
        record.cascades += 1;
        if (cascade?.sufficient) record.cascadesSufficient += 1;
        else record.cascadesAdvanced += 1;
        const seat = cascade?.seat ?? "?";
        record.cascadeSeats.set(seat, (record.cascadeSeats.get(seat) ?? 0) + 1);
      }
      record.substitutions += Array.isArray(details.substitutions) ? details.substitutions.length : 0;
      record.rounds += details.rounds ?? 0;
      record.verify += Array.isArray(details.verification) ? details.verification.length : 0;
      if (details.routing) { record.route += 1; record.routed = details.routing; }
      record.saved += Array.isArray(details.saved) ? details.saved.length : 0;
      record.failedWrites += Array.isArray(details.failedWrites) ? details.failedWrites.length : 0;
    }
  }

  return report;
}

const median = (sorted) => (sorted.length === 0 ? undefined : sorted[Math.floor(sorted.length / 2)]);
const num = (n) => new Intl.NumberFormat("en-US").format(Math.round(n));
const money = (n) => `$${n.toFixed(n < 1 ? 4 : 2)}`;
const ms = (n) => `${(n / 1000).toFixed(1)}s`;
const pct = (part, whole) => (whole === 0 ? "—" : `${((100 * part) / whole).toFixed(1)}%`);

function renderTurns(title, records, { limit = Infinity } = {}) {
  const rows = [...records.values()].filter((r) => r.turns > 0).sort((a, b) => b.sums.totalTokens - a.sums.totalTokens);
  const lines = [title];
  if (rows.length === 0) return [...lines, "  (none)"];
  for (const row of rows.slice(0, limit)) {
    const timing = row.timed > 0 ? ` · median ${ms(median([...row.durations].sort((a, b) => a - b)))}` : "";
    const missing = row.missingDuration > 0 ? ` · ${row.missingDuration} with no duration` : "";
    const unpriced = row.unpriced > 0 ? ` · ${row.unpriced} unpriced` : "";
    const tools = row.toolCalls > 0 ? ` · ${row.toolCalls} tool calls${row.toolErrors ? `, ${row.toolErrors} errored (${pct(row.toolErrors, row.toolCalls)})` : ""}` : "";
    lines.push(`  ${row.key.padEnd(34)} ${String(row.turns).padStart(4)} turns · ${num(row.sums.input).padStart(12)} in · ${num(row.sums.output).padStart(7)} out · ${money(row.sums.cost).padStart(10)}${timing}${missing}${unpriced}${tools}`);
  }
  if (rows.length > limit) lines.push(`  … ${rows.length - limit} more model(s)`);
  return lines;
}

export function render(report, { limit = 12 } = {}) {
  const lines = [];
  lines.push("session report — what the two faces recorded");
  lines.push(...report.roots.map((r) => `  ${r.harness}  ${r.root.replace(os.homedir(), "~")}  ${r.missing ? "MISSING" : `${r.files} file(s)`}`));
  lines.push(`  sessions ${report.sessions} · entries ${num(report.entries)} · unparsed lines ${report.unparsed}`);
  if (report.problems.length) lines.push(`  sessions without a header: ${report.gaps.sessionsWithoutHeader}`);
  lines.push("");
  lines.push(...renderTurns("turns by model", report.turns, { limit }));
  lines.push("");
  lines.push(`proxy records (details.proxied): ${report.records.proxy}`);
  for (const row of [...report.proxy.values()].sort((a, b) => b.turns - a.turns)) {
    const aliases = [...row.aliases].map(([k, v]) => `${k}×${v}`).join(", ") || "—";
    const levels = [...row.levels].map(([k, v]) => `${k}×${v}`).join(", ") || "—";
    const attempts = [...row.attempts].map(([k, v]) => `${k}×${v}`).join(", ") || "none";
    lines.push(`  ${row.key.padEnd(20)} ${String(row.turns).padStart(3)} turns · alias ${aliases} · level ${levels} · ${row.dropped} level drop(s) · attempts ${attempts}`);
  }
  lines.push("");
  lines.push(`deliberation records (details.fusion): ${report.records.deliberation}`);
  for (const row of [...report.deliberation.values()].sort((a, b) => (b.runs ?? 0) - (a.runs ?? 0))) {
    const carriers = [...row.carriers].map(([k, v]) => `${k}×${v}`).join(", ");
    lines.push(`  ${row.key.padEnd(20)} ${String(row.runs ?? 0).padStart(3)} runs (${carriers}) · ${row.seats} seats, ${row.degradedSeats} degraded, ${row.seatErrors} seat error(s)`);
    lines.push(`  ${"".padEnd(20)} cascades ${row.cascades} (sufficient ${row.cascadesSufficient}, advanced ${row.cascadesAdvanced}) · substitutions ${row.substitutions} · decision tokens ${num(row.decisionUsage.totalTokens)} (${money(row.decisionUsage.cost)})`);
    lines.push(`  ${"".padEnd(20)} turns cost ${money(row.sums.cost)} · ${num(row.sums.input)} in / ${num(row.sums.output)} out · ${row.failures} failed · routes ${row.route} · verify ${row.verify} check(s) · saved ${row.saved}${row.failedWrites ? `, ${row.failedWrites} write failure(s)` : ""}`);
  }
  lines.push("");
  lines.push("tools");
  const tools = [...report.tools.values()].filter((row) => row.turns > 0).sort((a, b) => b.turns - a.turns);
  if (tools.length === 0) lines.push("  (none)");
  for (const row of tools.slice(0, limit)) {
    const calls = report.toolCalls.get(row.key) ?? 0;
    const silent = calls - row.turns;
    lines.push(`  ${row.key.padEnd(34)} ${String(calls).padStart(5)} calls · ${String(row.turns).padStart(5)} results${silent > 0 ? ` (${silent} with no result)` : ""} · ${row.errors} errored (${pct(row.errors, row.turns)})`);
  }
  if (tools.length > limit) lines.push(`  … ${tools.length - limit} more tool(s)`);
  lines.push("");
  lines.push("what this report could not see");
  lines.push(`  messages with no recorded duration: ${report.gaps.noDuration} (pi records none; omp records duration/ttft)`);
  lines.push(`  messages carrying no price: ${report.gaps.unpriced}`);
  lines.push(`  records shaped like ours but not recognised: ${report.unknownShapes.length}`);
  lines.push(`  tool calls are attributed by ${report.gaps.toolAttribution} — the format carries no caller`);
  for (const unknown of report.unknownShapes.slice(0, 10)) {
    lines.push(`    ${path.basename(String(unknown.file ?? "?"))} ${unknown.carrier}: ${unknown.keys.join(", ")}`);
  }
  if (report.records.deliberation === 0) {
    lines.push("  NO deliberation records: a `matrix` run writes one to its tool result or its answer message;");
    lines.push("  zero here means every deliberation so far ran on a path that dropped the record, not that none ran.");
  }
  return lines.join("\n");
}

function renderJson(report) {
  const plain = (map) => Object.fromEntries([...map.entries()].map(([key, row]) => {
    const out = {};
    for (const [k, v] of Object.entries(row)) out[k] = v instanceof Map ? Object.fromEntries(v) : v;
    return [key, out];
  }));
  return JSON.stringify({
    sessions: report.sessions,
    entries: report.entries,
    unparsed: report.unparsed,
    records: report.records,
    roots: report.roots,
    turns: plain(report.turns),
    proxy: plain(report.proxy),
    deliberation: plain(report.deliberation),
    tools: plain(report.tools),
    toolCalls: Object.fromEntries(report.toolCalls),
    gaps: report.gaps,
    unknownShapes: report.unknownShapes,
    problems: report.problems,
  }, null, 2);
}

/** Fixtures for the reader itself: every claim in the header, one check each. */
function check() {
  const results = [];
  const ok = (name, pass, detail = "") => results.push({ name, pass, detail });
  const usage = (input, output, cost = 0) => ({ input, output, cacheRead: 0, cacheWrite: 0, totalTokens: input + output, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: cost } });
  const lines = (entries) => entries.map((e) => JSON.stringify(e)).join("\n");

  const sessionMeta = { type: "session", id: "s-1", cwd: "/tmp/project-alpha", timestamp: "2026-09-19T08:00:00.000Z", version: 3 };
  const goodEntries = [
    sessionMeta,
    { type: "message", message: { role: "user", content: [{ type: "text", text: "go" }] } },
    // a proxied turn: level dropped after a refusal, one tool call, priced
    { type: "message", message: { role: "assistant", api: FUSION_API, provider: "fusion-matrix", model: "quick", stopReason: "toolUse",
      usage: usage(100, 10, 0.002), content: [{ type: "toolCall", id: "c1", name: "read", arguments: {} }],
      details: { proxied: { alias: "glm-flash", provider: "opencode-go", model: "glm-5.3-flash", template: "glm-5.3-flash", thinking: null,
        attempts: [{ alias: "glm-flash", seat: "opencode-go/glm-5.3-flash", reason: "thinking", detail: "level refused" }] } } } },
    { type: "message", message: { role: "toolResult", toolName: "read", isError: true, content: [] } },
    // a second proxied turn, no attempts, omp-style duration
    { type: "message", message: { role: "assistant", api: FUSION_API, provider: "fusion-matrix", model: "quick", stopReason: "stop",
      usage: usage(50, 5, 0.001), duration: 4200, ttft: 900, content: [],
      details: { proxied: { alias: "glm-flash", provider: "opencode-go", model: "glm-5.3-flash", thinking: "low", attempts: [] } } } },
    // a plain model turn, unpriced, no duration
    { type: "message", message: { role: "assistant", api: "anthropic-messages", provider: "opencode-go", model: "glm-5.3", stopReason: "stop", usage: usage(10, 1, 0), content: [] } },
    // the deliberate face on the tool path
    { type: "message", message: { role: "toolResult", toolName: "matrix", isError: false, content: [],
      details: { fusion: "opinions", mode: "jury", rounds: 1, seats: [{ persona: "systems", degraded: false, usage: usage(20, 2) }, { persona: "skeptic", degraded: true, usage: usage(30, 3) }],
        seatErrors: [{ persona: "skeptic", error: "all candidates failed: skeptic@nope (missing provider)", reason: "missing provider" }], substitutions: [{ seat: "skeptic", from: "a", to: "b", reason: "quota" }],
        cascades: [{ seat: "systems", sufficient: true }, { seat: "panel", sufficient: true }, { seat: "stage", sufficient: false, advancedTo: "next stage" }],
        routing: { fusion: "opinions" }, verification: [{ check: "gate: node -e 0", result: { exit: 0 } }], saved: ["a.ts"], usage: usage(80, 8), decisionUsage: usage(5, 1) } } },
    // the deliberate face on the command path, and a failure
    { type: "custom_message", customType: "matrix-answer", content: "answer", display: true, details: { fusion: "opinions", mode: "jury", seats: [], cascades: [], verification: [], usage: usage(7, 1) } },
    { type: "custom_message", customType: "matrix-answer", content: "fusion failed: boom", display: true, details: { fusion: "opinions", error: "all candidates failed: quota" } },
    // a degraded run: the seat never answered, so the record says so
    { type: "custom_message", customType: "matrix-answer", content: "no answer", display: true, details: { fusion: "opinions", seats: [{ persona: "systems", degraded: true, error: "all candidates failed: missing provider" }], seatErrors: [{ persona: "systems", error: "all candidates failed: systems@nope (missing provider)", reason: "missing provider" }], cascades: [], usage: usage(3, 0) } },
    // shapes that are ours to explain but carry no fusion id, on both carriers
    { type: "message", message: { role: "toolResult", toolName: "other", isError: false, content: [], details: { cascades: [{ sufficient: true }] } } },
    { type: "custom_message", customType: "matrix-answer", content: "answer", display: true, details: { seats: [], cascades: [] } },
  ];
  const { entries, unparsed } = parseLines(`${lines(goodEntries)}\n{ this line is not json`);
  ok("an unparsed line is counted, not dropped", unparsed === 1, `unparsed=${unparsed}`);
  ok("a good session still parses after an unparsed line", entries.length === goodEntries.length, `entries=${entries.length}`);

  const session = extractSession(entries, { file: "fixture.jsonl", harness: "pi" });
  ok("header read", session.cwd === "/tmp/project-alpha" && session.id === "s-1", `${session.cwd} ${session.id}`);
  ok("two proxy records", session.records.filter((r) => r.kind === "proxy").length === 2, `proxy=${session.records.filter((r) => r.kind === "proxy").length}`);
  ok("four deliberation records", session.records.filter((r) => r.kind === "deliberation").length === 4, `deliberation=${session.records.filter((r) => r.kind === "deliberation").length}`);
  ok("six records in total, and no more", session.records.length === 6, `records=${session.records.length}`);
  ok("a fusion-shaped shape without a fusion id is named, not counted as a run", session.unknown.length === 2 && session.records.every((r) => typeof r.fusion === "string" && r.fusion !== "unknown"), JSON.stringify([session.unknown.length, session.records.map((r) => r.fusion)]));

  const report = aggregate([{ ...session, entries: session.entries }]);
  const quick = report.turns.get("fusion:quick");
  ok("turns are keyed by fusion id", quick?.turns === 2, `turns=${quick?.turns}`);
  ok("usage accumulates per key exactly", quick?.sums.input === 150 && quick?.sums.output === 15 && Math.abs(quick.sums.cost - 0.003) < 1e-9, JSON.stringify(quick?.sums));
  ok("priced and unpriced turns are told apart", quick?.priced === 2 && report.turns.get("opencode-go/glm-5.3")?.unpriced === 1 && report.gaps.unpriced === 1);
  ok("a missing duration is counted as missing, never as 0", quick?.timed === 1 && quick?.missingDuration === 1 && report.gaps.noDuration === 2, `timed=${quick?.timed} missing=${quick?.missingDuration} total=${report.gaps.noDuration}`);
  ok("tool results are attributed to the turn before them", quick?.toolErrors === 1 && quick?.toolCalls === 1 && report.tools.get("read").errors === 1 && report.toolCalls.get("read") === 1, JSON.stringify(Object.fromEntries(report.toolCalls)));
  const proxy = report.proxy.get("quick");
  ok("a dropped level counts as a drop", proxy?.dropped === 1 && proxy?.levels.get("none") === 1, JSON.stringify([...proxy.levels]));
  ok("attempt reasons are counted", proxy?.attempts.get("thinking") === 1);
  const delib = report.deliberation.get("opinions");
  ok("deliberation runs counted by carrier", delib?.runs === 4 && delib?.carriers.get("toolResult") === 1 && delib?.carriers.get("custom_message") === 3, JSON.stringify([...(delib?.carriers ?? [])]));
  ok("degraded seats and seat errors counted", delib?.seats === 3 && delib?.degradedSeats === 2 && delib?.seatErrors === 2, JSON.stringify({ seats: delib?.seats, degraded: delib?.degradedSeats, errors: delib?.seatErrors }));
  ok("cascades split sufficient from advanced", delib?.cascades === 3 && delib?.cascadesSufficient === 2 && delib?.cascadesAdvanced === 1, JSON.stringify({ total: delib?.cascades, sufficient: delib?.cascadesSufficient, advanced: delib?.cascadesAdvanced }));
  ok("cascades are attributed to their seat", delib?.cascadeSeats.get("stage") === 1 && delib?.cascadeSeats.get("panel") === 1, JSON.stringify([...(delib?.cascadeSeats ?? [])]));
  ok("seat usage is added to the run's tokens", delib?.sums.input === 80 + 20 + 30 + 7 + 3 && delib?.sums.output === 8 + 2 + 3 + 1, JSON.stringify(delib?.sums));
  ok("decision usage is kept apart from seat usage", delib?.decisionUsage.input === 5 && delib?.decisionUsage.output === 1);
  ok("route, verification checks and saved files are read", delib?.route === 1 && delib?.verify === 1 && delib?.saved === 1, JSON.stringify({ route: delib?.route, verify: delib?.verify, saved: delib?.saved }));
  ok("a failed deliberation is counted, thrown or degraded", delib?.failures === 2 && report.records.deliberation === 4, JSON.stringify({ failures: delib?.failures, records: report.records.deliberation }));

  const filtered = entries.filter((e) => e.type !== "custom_message");
  const only = aggregate([extractSession(filtered, { file: "fixture.jsonl" })]);
  ok("filters change the totals", only.records.deliberation === 1 && only.sessions === 1);

  const failures = results.filter((r) => !r.pass);
  for (const r of results) console.log(`  ${r.pass ? "ok  " : "FAIL"} ${r.name}${r.detail ? ` — ${r.detail}` : ""}`);
  console.log(`\nsession-report: ${results.length - failures.length}/${results.length} checks passed`);
  return failures.length === 0 ? 0 : 2;
}

function main() {
  if (has("check")) process.exit(check());

  const dirs = values("dir");
  const roots = dirs.length
    ? dirs.map((root) => ({ harness: root.includes(`${path.sep}.omp`) ? "omp" : root.includes(`${path.sep}.pi`) ? "pi" : "custom", root: path.resolve(root) }))
    : DEFAULT_ROOTS;
  const harnessFilter = value("harness");
  const sessionFile = value("session");
  const cwdFilter = value("cwd");
  const since = value("since");
  const sinceMs = since ? Date.parse(since) : undefined;
  if (since && Number.isNaN(sinceMs)) {
    console.error(`session report: --since "${since}" is not a date`);
    process.exit(1);
  }

  const reportRoots = [];
  const sessions = [];
  const files = [];
  if (sessionFile) {
    files.push({ harness: "session", root: path.dirname(path.resolve(sessionFile)), file: path.resolve(sessionFile) });
  } else {
    for (const { harness, root } of roots) {
      if (harnessFilter && harness !== harnessFilter) continue;
      const found = findSessions(root);
      reportRoots.push({ harness, root, files: found.files.length, missing: found.missing });
      for (const file of found.files) files.push({ harness, root, file });
    }
  }

  if (!sessionFile && reportRoots.every((r) => r.missing || r.files === 0)) {
    for (const r of reportRoots) console.error(`session report: ${r.missing ? "no sessions directory at" : "no session files under"} ${r.root}`);
    process.exit(1);
  }

  for (const { harness, file } of files) {
    let text;
    try {
      text = fs.readFileSync(file, "utf8");
    } catch (error) {
      if (sessionFile) {
        console.error(`session report: cannot read ${file}: ${error.message}`);
        process.exit(1);
      }
      continue;
    }
    const { entries, unparsed } = parseLines(text);
    const session = extractSession(entries, { file, harness, unparsed });
    if (cwdFilter && !String(session.cwd ?? "").includes(cwdFilter)) continue;
    if (sinceMs !== undefined && Date.parse(session.startedAt ?? "") < sinceMs) continue;
    sessions.push(session);
  }

  const report = aggregate(sessions);
  report.roots = sessionFile ? [{ harness: "session", root: path.dirname(path.resolve(sessionFile)), files: 1, missing: false }] : reportRoots;

  if (has("json")) console.log(renderJson(report));
  else {
    console.log(render(report));
    if (has("verbose")) {
      console.log("\nrecords");
      for (const session of sessions) {
        for (const record of session.records) {
          const label = record.kind === "proxy"
            ? `proxy ${record.fusion} → ${record.details.alias} @${record.details.thinking ?? "no level"} (${record.details.attempts?.length ?? 0} attempt(s))`
            : `deliberation ${record.fusion} via ${record.carrier} (${record.details.cascades?.length ?? 0} cascade(s), ${record.details.seatErrors?.length ?? 0} seat error(s))`;
          console.log(`  ${String(session.file).split("/").at(-1).slice(0, 28).padEnd(29)} ${record.at ?? ""} ${label}`);
        }
      }
    }
  }
  process.exit(0);
}

main();