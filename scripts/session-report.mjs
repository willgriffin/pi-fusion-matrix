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
 * Exit status: 0 report produced, 1 the store could not be accounted for — a missing or empty `--dir`, an
 * unreadable `--session`, a file or directory that cannot be read, or a session a filter could not
 * attribute — 2 `--check` failed.
 *
 * Filters select the *rows*, never the accounting: the files read, the lines that did not parse, and the
 * sessions a filter could not attribute are reported whatever `--cwd`/`--since` selected, because a filter
 * that hid them would let a store containing a run record report zero records and zero unparsed lines.
 *
 * Two numbers are deliberately reported as *absent* rather than as zero: a message whose harness records
 * no duration, and a message whose provider reports no price. Reading either as 0 would turn "we did not
 * record it" into "it cost nothing", which is exactly the mistake this report exists to prevent.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

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
export function findSessions(root, { readdir = fs.readdirSync } = {}) {
  const out = [];
  const unreadable = [];
  let cwdDirs;
  try {
    cwdDirs = readdir(root, { withFileTypes: true });
  } catch (error) {
    // A root that is not there is a harness nobody has used; a root that is there and refuses to be read
    // is a store we cannot account for, and those are different facts.
    if (error?.code === "ENOENT") return { missing: true, files: out, unreadable };
    return { missing: false, files: out, unreadable: [{ path: root, reason: error?.message ?? String(error) }] };
  }
  for (const dirent of cwdDirs) {
    if (!dirent.isDirectory()) continue;
    const dir = path.join(root, dirent.name);
    let names;
    try {
      names = readdir(dir, { withFileTypes: true });
    } catch (error) {
      unreadable.push({ path: dir, reason: error?.message ?? String(error) });
      continue;
    }
    for (const name of names) {
      if (name.isFile() && name.name.endsWith(".jsonl")) out.push(path.join(dir, name.name));
    }
  }
  out.sort();
  return { missing: false, files: out, unreadable };
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
    gaps: { noDuration: 0, unpriced: 0, sessionsWithoutHeader: 0, unreadable: [], toolAttribution: "most recent assistant turn" },
    store: undefined,
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
        // `thinking: null` is a turn that ran at no level; an absent key is a record that did not say, and
        // reading the second as the first would overstate the drops.
        const recorded = Object.hasOwn(proxied, "thinking");
        const level = recorded ? (proxied.thinking ?? "none") : "unrecorded";
        record.levels.set(level, (record.levels.get(level) ?? 0) + 1);
        const attempts = Array.isArray(proxied.attempts) ? proxied.attempts : [];
        for (const attempt of attempts) record.attempts.set(attempt?.reason ?? "?", (record.attempts.get(attempt?.reason ?? "?") ?? 0) + 1);
        // A turn that ran at no level while a route was refused at the level we asked for: the drop is the
        // fact worth counting, because it is what makes a cheap model answer without reasoning.
        if (recorded && proxied.thinking === null && attempts.length > 0) record.dropped += 1;
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
  const store = report.store;
  const excluded = store ? ` of ${store.read} read (${store.excludedByCwd} by --cwd, ${store.excludedBySince} by --since)` : "";
  lines.push(`  sessions ${report.sessions}${excluded} · entries ${num(report.entries)} · unparsed lines ${store ? store.unparsed : report.unparsed}`);
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
  lines.push(`  files or directories that could not be read: ${report.gaps.unreadable.length}`);
  for (const skipped of report.store?.skippedRoots ?? []) lines.push(`  store not read (--harness): ${skipped.root.replace(os.homedir(), "~")}`);
  const unattributable = report.store?.unattributable ?? [];
  lines.push(`  sessions a filter could not attribute (no header, or nothing to compare): ${unattributable.length}`);
  for (const entry of unattributable.slice(0, 10)) lines.push(`    ${entry.path}: ${entry.reason}`);
  for (const unreadable of report.gaps.unreadable.slice(0, 10)) lines.push(`    ${unreadable.path}: ${unreadable.reason}`);
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
    sessionsRead: report.store?.read ?? report.sessions,
    entries: report.entries,
    // The same figure the text report prints: unparsed lines are a fact about the store, so a filter must
    // not present a different number under the same name on the machine-readable surface.
    unparsed: report.store?.unparsed ?? report.unparsed,
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
    store: report.store,
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

  // An absent `thinking` key is a record that did not say, not a turn that ran at no level.
  const legacy = extractSession([sessionMeta, { type: "message", message: { role: "assistant", api: FUSION_API, model: "quick",
    usage: usage(5, 1, 0.001), content: [], details: { proxied: { alias: "glm-flash", attempts: [{ reason: "transient" }] } } } }], { file: "legacy.jsonl", harness: "pi" });
  const legacyRow = aggregate([legacy]).proxy.get("quick");
  ok("an unrecorded level is not counted as a drop", legacyRow?.dropped === 0 && legacyRow?.levels.get("unrecorded") === 1, JSON.stringify([...(legacyRow?.levels ?? [])]));

  // The store reader: a file or directory that cannot be read is counted and printed, never skipped, and the
  // exit status says the ledger is incomplete — a reader that dropped it silently would understate totals.
  const storeDir = fs.mkdtempSync(path.join(os.tmpdir(), "session-report-check-"));
  const slug = path.join(storeDir, "--private-tmp-project-alpha--");
  fs.mkdirSync(slug, { recursive: true });
  fs.writeFileSync(path.join(slug, "readable.jsonl"), lines(goodEntries));
  const locked = path.join(slug, "locked.jsonl");
  fs.writeFileSync(locked, "{}\n");
  const roots = [{ harness: "pi", root: storeDir }];
  const denied = (file) => Object.assign(new Error(`EACCES: permission denied, open '${file}'`), { code: "EACCES" });
  const injected = readStore({ roots, readFile: (file, encoding) => (file === locked ? (() => { throw denied(file); })() : fs.readFileSync(file, encoding)) });
  ok("a session file that cannot be read is counted, not skipped", injected.sessions.length === 1 && injected.unreadable.length === 1 && injected.unreadable[0].path === locked, JSON.stringify(injected.unreadable));
  ok("the readable session's records still reach the totals", aggregate(injected.sessions).records.deliberation === 4);
  const unlistable = readStore({ roots, readdir: (dir, ...rest) => { if (dir === slug) throw denied(dir); return fs.readdirSync(dir, ...rest); } });
  ok("a session directory that cannot be listed is counted, not skipped", unlistable.unreadable.length === 1 && unlistable.unreadable[0].path === slug && unlistable.sessions.length === 0, JSON.stringify(unlistable.unreadable));
  ok("a harness with no store is missing, not unreadable", readStore({ roots: [{ harness: "pi", root: path.join(storeDir, "nope") }] }).roots[0].missing === true);
  if (process.getuid?.() === 0) {
    console.log("  skip  the exit status for an unreadable store (running as root)");
  } else {
    fs.chmodSync(locked, 0o000);
    const child = spawnSync(process.execPath, [fileURLToPath(import.meta.url), "--dir", storeDir], { encoding: "utf8" });
    fs.chmodSync(locked, 0o600);
    ok("the exit status says the store could not be fully read", child.status === 1 && /could not be read/.test(child.stdout), `status=${child.status} stdout=${JSON.stringify(child.stdout.split("\n").at(-3))}`);
  }
  fs.rmSync(storeDir, { recursive: true, force: true });

  // A filter must not take the accounting with it: a store whose header line is truncated, read with
  // `--cwd`, must still report the unparsed line and name the session it could not attribute.
  const truncatedDir = fs.mkdtempSync(path.join(os.tmpdir(), "session-report-filter-"));
  const truncatedSlug = path.join(truncatedDir, "--private-tmp-project-alpha--");
  fs.mkdirSync(truncatedSlug, { recursive: true });
  const truncated = path.join(truncatedSlug, "truncated.jsonl");
  fs.writeFileSync(truncated, `{"type":"sess\n${lines(goodEntries.slice(1))}\n`);
  const otherSlug = path.join(truncatedDir, "--private-tmp-project-beta--");
  fs.mkdirSync(otherSlug, { recursive: true });
  fs.writeFileSync(path.join(otherSlug, "other.jsonl"), lines([{ ...sessionMeta, cwd: "/tmp/project-beta" }, ...goodEntries.slice(1)]));
  const roots2 = [{ harness: "pi", root: truncatedDir }];
  const filteredStore = readStore({ roots: roots2, cwdFilter: "project-alpha" });
  ok("a filtered read still counts the store's unparsed lines", filteredStore.store.read === 2 && filteredStore.store.unparsed === 1 && filteredStore.sessions.length === 0, JSON.stringify({ ...filteredStore.store, sessions: filteredStore.sessions.length }));
  ok("a filter names the session it could not attribute", filteredStore.store.unattributable.length === 1 && filteredStore.store.unattributable[0].path === truncated, JSON.stringify(filteredStore.store.unattributable));
  ok("a session merely outside the filter is counted, not named", filteredStore.store.excludedByCwd === 1, JSON.stringify(filteredStore.store));
  const unfilteredStore = readStore({ roots: roots2 });
  ok("without a filter nothing is excluded or unattributable", unfilteredStore.store.read === 2 && unfilteredStore.store.unattributable.length === 0 && unfilteredStore.sessions.length === 2);
  if (process.getuid?.() !== 0) {
    const child = spawnSync(process.execPath, [fileURLToPath(import.meta.url), "--dir", truncatedDir, "--cwd", "project-alpha"], { encoding: "utf8" });
    ok("an unattributable session under a filter exits non-zero", child.status === 1 && /could not attribute/.test(child.stdout), `status=${child.status}`);
  }
  fs.rmSync(truncatedDir, { recursive: true, force: true });

  // A session with no placeable timestamp must not be totalled into a --since window it cannot be shown
  // to belong to, and an explicit --session excluded by a filter must say so.
  const datedDir = fs.mkdtempSync(path.join(os.tmpdir(), "session-report-since-"));
  const datedSlug = path.join(datedDir, "--private-tmp-project-alpha--");
  fs.mkdirSync(datedSlug, { recursive: true });
  const undated = path.join(datedSlug, "undated.jsonl");
  fs.writeFileSync(undated, lines([{ ...sessionMeta, timestamp: "not-a-date" }, ...goodEntries.slice(1)]));
  const dated = path.join(datedSlug, "dated.jsonl");
  fs.writeFileSync(dated, lines([{ ...sessionMeta, timestamp: "2026-09-19T08:00:00.000Z" }, ...goodEntries.slice(1)]));
  const sinceRoots = [{ harness: "pi", root: datedDir }];
  const sinceMs = Date.parse("2026-09-19");
  const windowed = readStore({ roots: sinceRoots, sinceMs });
  ok("a session with no placeable timestamp is named, not totalled into --since", windowed.store.unattributable.length === 1 && windowed.store.unattributable[0].path === undated && windowed.sessions.length === 1, JSON.stringify({ sessions: windowed.sessions.length, unattributable: windowed.store.unattributable.map((u) => u.path.split("/").at(-1)) }));
  const oneFile = readStore({ roots: sinceRoots, sessionFile: dated, cwdFilter: "project-beta" });
  ok("an explicit --session excluded by a filter is named", oneFile.store.unattributable.length === 1 && oneFile.sessions.length === 0);
  if (process.getuid?.() !== 0) {
    const child = spawnSync(process.execPath, [fileURLToPath(import.meta.url), "--dir", datedDir, "--since", "2026-09-19"], { encoding: "utf8" });
    ok("an unplaceable session under --since exits non-zero", child.status === 1 && /could not attribute/.test(child.stdout), `status=${child.status}`);
  }
  const harnessed = readStore({ roots: [{ harness: "pi", root: datedDir }, { harness: "omp", root: datedDir }], harnessFilter: "pi" });
  ok("a store left out by --harness is named, not silently absent", harnessed.store.skippedRoots.length === 1 && harnessed.store.skippedRoots[0].harness === "omp", JSON.stringify(harnessed.store.skippedRoots));
  fs.rmSync(datedDir, { recursive: true, force: true });

  if (process.getuid?.() !== 0) {
    const usage = spawnSync(process.execPath, [fileURLToPath(import.meta.url), "--harness", "foo"], { encoding: "utf8" });
    ok("an unknown --harness is a named usage error, not a silent exit", usage.status === 1 && /names no store/.test(usage.stderr), `status=${usage.status}`);
  }

  const jsonDir = fs.mkdtempSync(path.join(os.tmpdir(), "session-report-json-"));
  const jsonSlug = path.join(jsonDir, "--private-tmp-project-alpha--");
  fs.mkdirSync(jsonSlug, { recursive: true });
  fs.writeFileSync(path.join(jsonSlug, "one.jsonl"), `{"type":"sess\n${lines(goodEntries.slice(1))}\n`);
  fs.writeFileSync(path.join(jsonSlug, "two.jsonl"), lines([{ ...sessionMeta, cwd: "/tmp/project-beta" }, ...goodEntries.slice(1)]));
  const jsonStore = readStore({ roots: [{ harness: "pi", root: jsonDir }], cwdFilter: "project-beta" });
  const jsonReport = JSON.parse(renderJson(buildReport(jsonStore)));
  ok("--json publishes the store's unparsed count, as the text report does", jsonReport.unparsed === 1 && jsonReport.store.unparsed === 1 && jsonReport.sessions === 1 && jsonReport.sessionsRead === 2, JSON.stringify({ unparsed: jsonReport.unparsed, store: jsonReport.store?.unparsed, sessions: jsonReport.sessions, read: jsonReport.sessionsRead }));
  fs.rmSync(jsonDir, { recursive: true, force: true });

  const failures = results.filter((r) => !r.pass);
  for (const r of results) console.log(`  ${r.pass ? "ok  " : "FAIL"} ${r.name}${r.detail ? ` — ${r.detail}` : ""}`);
  console.log(`\nsession-report: ${results.length - failures.length}/${results.length} checks passed`);
  return failures.length === 0 ? 0 : 2;
}

/**
 * The store into sessions. `readFile`/`readdir` are injectable so `--check` can prove the accounting for a
 * file that refuses to be read; in a real run they are `node:fs`.
 */
export function readStore({ roots, harnessFilter, sessionFile, cwdFilter, sinceMs, readFile = fs.readFileSync, readdir = fs.readdirSync } = {}) {
  const reportRoots = [];
  const sessions = [];
  const files = [];
  const unreadable = [];
  const store = { read: 0, unparsed: 0, withoutHeader: 0, excludedByCwd: 0, excludedBySince: 0, skippedRoots: [], unattributable: [] };
  if (sessionFile) {
    files.push({ harness: "session", root: path.dirname(path.resolve(sessionFile)), file: path.resolve(sessionFile) });
  } else {
    for (const { harness, root } of roots) {
      if (harnessFilter && harness !== harnessFilter) {
        // A store `--harness` left out is named, so "pi only" cannot read as "the other store was empty".
        store.skippedRoots.push({ harness, root });
        continue;
      }
      const found = findSessions(root, { readdir });
      reportRoots.push({ harness, root, files: found.files.length, missing: found.missing });
      for (const entry of found.unreadable) unreadable.push({ harness, path: entry.path, reason: entry.reason });
      for (const file of found.files) files.push({ harness, root, file });
    }
  }

  // Store facts, as opposed to the rows a filter selects: a filter must never take the accounting with it,
  // or `--cwd` on a store whose header lines are truncated reports zero records and zero unparsed lines.

  for (const { harness, file } of files) {
    let text;
    try {
      text = readFile(file, "utf8");
    } catch (error) {
      if (sessionFile) return { sessions, roots: reportRoots, unreadable, store, fatal: `${file}: ${error?.message ?? String(error)}` };
      // Never skip quietly: a file that cannot be read takes its turns and its records out of every total
      // below, and an absent total is exactly what this report exists to tell apart from a clean one.
      unreadable.push({ harness, path: file, reason: error?.message ?? String(error) });
      continue;
    }
    const { entries, unparsed } = parseLines(text);
    const session = extractSession(entries, { file, harness, unparsed });
    store.read += 1;
    store.unparsed += unparsed;
    if (session.problems.length) store.withoutHeader += 1;
    const lacksCwd = !session.cwd;
    if (cwdFilter && !String(session.cwd ?? "").includes(cwdFilter)) {
      // Excluded, but not silently: an exclusion the filter cannot justify (no cwd to compare, no header at
      // all) may be a session that *would* have matched, so it is named instead of counted as a clean miss.
      if (lacksCwd) store.unattributable.push({ harness, path: file, reason: "no cwd in the session header, so --cwd cannot tell whether it matches" });
      else if (sessionFile) store.unattributable.push({ harness, path: file, reason: "asked for by --session, then excluded by --cwd" });
      else store.excludedByCwd += 1;
      continue;
    }
    if (sinceMs !== undefined) {
      // `NaN < sinceMs` is false, so an unplaceable session must be caught before the comparison or it is
      // silently totalled into a window it cannot be shown to belong to.
      const startedMs = Date.parse(session.startedAt ?? "");
      if (Number.isNaN(startedMs)) {
        store.unattributable.push({ harness, path: file, reason: "no parseable timestamp, so --since cannot place it" });
        continue;
      }
      if (startedMs < sinceMs) {
        if (sessionFile) store.unattributable.push({ harness, path: file, reason: "asked for by --session, then excluded by --since" });
        else store.excludedBySince += 1;
        continue;
      }
    }
    sessions.push(session);
  }

  return { sessions, roots: reportRoots, unreadable, store, fatal: undefined };
}

export function buildReport(store, { sessionFile } = {}) {
  const report = aggregate(store.sessions);
  report.roots = sessionFile ? [{ harness: "session", root: path.dirname(path.resolve(sessionFile)), files: 1, missing: false }] : store.roots;
  report.gaps.unreadable = store.unreadable;
  report.store = store.store;
  return report;
}

function main() {
  if (has("check")) process.exit(check());

  const dirs = values("dir");
  const roots = dirs.length
    ? dirs.map((root) => ({ harness: root.includes(`${path.sep}.omp`) ? "omp" : root.includes(`${path.sep}.pi`) ? "pi" : "custom", root: path.resolve(root) }))
    : DEFAULT_ROOTS;
  const harnessFilter = value("harness");
  const knownHarnesses = new Set([...DEFAULT_ROOTS.map((r) => r.harness), "custom"]);
  if (harnessFilter && !knownHarnesses.has(harnessFilter) && !values("dir").some((root) => root.includes(`${path.sep}.${harnessFilter}`))) {
    console.error(`session report: --harness "${harnessFilter}" names no store (${[...knownHarnesses].join(", ")})`);
    process.exit(1);
  }
  const sessionFile = value("session");
  const cwdFilter = value("cwd");
  const since = value("since");
  const sinceMs = since ? Date.parse(since) : undefined;
  if (since && Number.isNaN(sinceMs)) {
    console.error(`session report: --since "${since}" is not a date`);
    process.exit(1);
  }

  const store = readStore({ roots, harnessFilter, sessionFile, cwdFilter, sinceMs });
  const { sessions, roots: reportRoots, unreadable: unreadablePaths, fatal } = store;
  if (fatal) {
    console.error(`session report: cannot read ${fatal}`);
    process.exit(1);
  }
  if (!sessionFile && reportRoots.every((r) => r.missing || r.files === 0)) {
    // Nothing was read, so say why in full: the roots a filter left out are the explanation, and an empty
    // report with a bare exit status is indistinguishable from a crash.
    for (const r of reportRoots) console.error(`session report: ${r.missing ? "no sessions directory at" : "no session files under"} ${r.root}`);
    for (const skipped of store.store.skippedRoots) console.error(`session report: store left out by --harness ${harnessFilter}: ${skipped.root}`);
    process.exit(1);
  }

  const report = buildReport(store, { sessionFile });

  if (has("json")) console.log(renderJson(report));
  else {
    console.log(render(report));
    if (has("verbose")) {
      console.log("\nrecords");
      for (const session of sessions) {
        for (const record of session.records) {
          const label = record.kind === "proxy"
            ? `proxy ${record.fusion} → ${record.details.alias} @${Object.hasOwn(record.details, "thinking") ? record.details.thinking ?? "no level" : "unrecorded"} (${record.details.attempts?.length ?? 0} attempt(s))`
            : `deliberation ${record.fusion} via ${record.carrier} (${record.details.cascades?.length ?? 0} cascade(s), ${record.details.seatErrors?.length ?? 0} seat error(s))`;
          console.log(`  ${String(session.file).split("/").at(-1).slice(0, 28).padEnd(29)} ${record.at ?? ""} ${label}`);
        }
      }
    }
  }
  // A partial ledger is not a report: say so with the exit status too, so a hook cannot read a short total
  // as a fact about the fusions. Same for a filter that could not be applied to part of the store — the
  // sessions it skipped may be the ones the filter was looking for.
  process.exit(unreadablePaths.length === 0 && store.store.unattributable.length === 0 ? 0 : 1);
}

main();