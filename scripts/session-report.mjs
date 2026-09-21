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
 *
 * It reads files and does nothing else: no network, no keys, no model calls, no writes.
 *
 * Exit status: 0 report produced, 1 the store could not be accounted for — a missing or empty `--dir`, an
 * unreadable `--session`, a file or directory that cannot be read, a line that did not parse, or a session a
 * filter could not attribute. An incomplete ledger is never a clean exit: every total
 * below would be short by the part that did not parse.
 *
 * Filters select the *rows*, never the accounting: the files read, the lines that did not parse, and the
 * sessions a filter could not attribute are reported whatever `--cwd`/`--since` selected, because a filter
 * that hid them would let a store containing a run record report zero records and zero unparsed lines.
 *
 * Two numbers are deliberately reported as *absent* rather than as zero: a message whose harness records no
 * duration, and a message whose provider reports no price. Reading either as 0 would turn "we did not record
 * it" into "it cost nothing", which is exactly the mistake this report exists to prevent — so money is
 * printed as `$X reported` with the unpriced messages counted beside it (`costReported` and
 * `unpricedMessages` in the sums), and never as a single total that silently absorbed both.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const DEFAULT_ROOTS = [
  { harness: "pi", root: path.join(os.homedir(), ".pi/agent/sessions") },
  { harness: "omp", root: path.join(os.homedir(), ".omp/agent/sessions") },
];

/** The api id every fusion model is registered under, so a turn names the fusion that served it. */
export const FUSION_API = "fusion-matrix";
/**
 * The harness a session file belongs to, from where it lives. Reading one file explicitly (`--session <file>`)
 * must not lose it: the device-protocol rewrite is gated on omp, and a file handed to the reader from omp's
 * store has to keep that, or the same session reports its `matrix` runs as `write`s depending on how it was
 * selected.
 */
function harnessOfPath(file) {
  const candidate = String(file ?? "");
  if (candidate.includes(`${path.sep}.omp${path.sep}`)) return "omp";
  if (candidate.includes(`${path.sep}.pi${path.sep}`)) return "pi";
  return "session";
}

/**
 * The record's own clock as one representation. omp stores epoch milliseconds on the *message* and an
 * ISO string on the *entry*, so a reader that takes the message's value first got a number where every
 * downstream `Date.parse` expected a string — the metrics store's turn rows came out with no time at
 * all, and the report's quota join has been reading those refusals as unplaceable. This normaliser runs
 * at each of the two places an `at` enters the record (a turn and a tool result), and never at a third:
 * a new `at` assignment without it is the defect coming back.
 *
 * A value it cannot represent is *absent*, never guessed and never a crash: a finite number outside the
 * ECMAScript Date range (`|v| > 8.64e15`, e.g. an epoch in nanoseconds) would make `toISOString` throw,
 * and one bad row must not take a whole session's extraction with it. A string is passed through as
 * written — the harness wrote it, and a reader is not the place to declare it malformed.
 */
export const isoTime = (value) => {
  if (typeof value === "number" && Number.isFinite(value)) {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
  }
  return typeof value === "string" ? value : undefined;
};

/** Where omp keeps its plan ledger: one row per reading, per provider, per limit window. */
const PLAN_LEDGER = path.join(os.homedir(), ".omp", "agent", "agent.db");

/**
 * The plan windows the harness recorded, read directly from omp's own ledger.
 *
 * Read-only, and derived: this is omp's table, not ours (`usage_history`: recorded_at, provider, limit_id,
 * label, window_label, used_fraction, status, resets_at), and the report never writes it. Every failure mode is
 * a *named* absence rather than an empty table — no ledger, no `node:sqlite`, a schema this build does not
 * know — because "no windows" and "no readings" mean different things to a reader deciding whether a failure
 * was the plan or the model.
 */
export async function readPlanWindows({ dbPath = PLAN_LEDGER, now = Date.now() } = {}) {
  const result = {
    path: dbPath,
    available: false,
    reason: undefined,
    readings: 0,
    windows: [],
    history: [],
    readAt: new Date(now).toISOString(),
  };
  let sqlite;
  try {
    sqlite = await import("node:sqlite");
  } catch (error) {
    result.reason = `this node has no node:sqlite (${error?.message ?? String(error)})`;
    return result;
  }
  if (!fs.existsSync(dbPath)) {
    result.reason = `no plan ledger at ${dbPath}`;
    return result;
  }
  let db;
  try {
    db = new sqlite.DatabaseSync(dbPath, { readOnly: true });
  } catch (error) {
    result.reason = `the plan ledger could not be opened read-only: ${error?.message ?? String(error)}`;
    return result;
  }
  try {
    result.readings = db.prepare("SELECT count(*) AS n FROM usage_history").get()?.n ?? 0;
    // Every reading, for the join: a refusal is only explained by what the ledger read *before* it, so the
    // latest row per window is the display's answer (`windows`) and the history is the join's. Selecting only
    // the latest would let a reading taken after a refusal shadow the one that actually covered it.
    const history = db
      .prepare(
        `SELECT provider, limit_id, label, window_label, used_fraction, status, resets_at, recorded_at
      FROM usage_history`,
      )
      .all()
      .map((row) => ({
        provider: String(row.provider ?? "?"),
        limitId: String(row.limit_id ?? "?"),
        label: String(row.label ?? row.window_label ?? row.limit_id ?? "?"),
        usedFraction: typeof row.used_fraction === "number" ? row.used_fraction : undefined,
        status: String(row.status ?? "?"),
        resetsAt: Number(row.resets_at ?? 0) > 0 ? Number(row.resets_at) : 0,
        recordedAt: Number(row.recorded_at ?? 0) > 0 ? Number(row.recorded_at) : 0,
      }));
    result.history = history;
    const rows = db
      .prepare(
        `SELECT provider, limit_id, label, window_label, used_fraction, status, resets_at, recorded_at
      FROM usage_history WHERE id IN (SELECT max(id) FROM usage_history GROUP BY provider, limit_id)`,
      )
      .all();
    // The latest reading per window. `resets_at` is 0 when the provider stated none, which is not 1970.
    result.windows = rows.map((row) => ({
      provider: String(row.provider ?? "?"),
      limitId: String(row.limit_id ?? "?"),
      label: String(row.label ?? row.window_label ?? row.limit_id ?? "?"),
      usedFraction: typeof row.used_fraction === "number" ? row.used_fraction : undefined,
      status: String(row.status ?? "?"),
      resetsAt: Number(row.resets_at ?? 0) > 0 ? Number(row.resets_at) : 0,
      recordedAt: Number(row.recorded_at ?? 0) > 0 ? Number(row.recorded_at) : 0,
    }));
    result.available = true;
  } catch (error) {
    result.reason = `the plan ledger has no shape this reader knows: ${error?.message ?? String(error)}`;
  } finally {
    try {
      db.close();
    } catch {
      /* closing twice is not a failure worth reporting */
    }
  }
  return result;
}

/** Whether a window reading was in force at a moment: recorded before it, and not already reset. */
const windowCovers = (window, at) => window.recordedAt > 0 && window.recordedAt <= at && (window.resetsAt === 0 || window.resetsAt > at);

/** The custom message type a `/matrix-label` writes: a work item, an outcome, and optional evidence. */
const LABEL_TYPE = "matrix-label";

/**
 * omp invokes an extension tool through its `xd://` device protocol, and stores the result as
 * `details = { xdev: { tool, mode, args, tier, inner: <the real record> } }` — so the record the extension
 * returned is one level in, and a reader that only looks at the outer object drops the run entirely
 * (measured 2026-09-20: one plain deliberation record in the store against two wrapped and invisible, with a
 * session that ran two fusions reporting none). pi does not wrap, and neither does the command path.
 */
const unwrapDetails = (details) =>
  details &&
  typeof details === "object" &&
  details.xdev &&
  typeof details.xdev === "object" &&
  details.xdev.inner &&
  typeof details.xdev.inner === "object"
    ? details.xdev.inner
    : details;

/**
 * The tool a `toolCall` part actually invokes, and whether it went through omp's device protocol.
 *
 * omp records an `xd://` invocation as `write` with `arguments.path = "xd://<tool>"`, while `read` of the same
 * path is discovery — reading a tool's docs is not calling it — so only the write form is an invocation. The
 * rewrite is gated on the harness: pi has no such protocol, and a pi session saving a file whose relative
 * path happens to be `xd://matrix` must not be reported as a tool call that never happened.
 */
function invokedTool(part, harness) {
  const path = part?.arguments?.path;
  if (harness === "omp" && typeof path === "string" && path.startsWith("xd://") && part?.name === "write") {
    return { name: path.slice("xd://".length), device: true };
  }
  return { name: part?.name ?? "?", device: false };
}
// The same closed vocabulary the command enforces: a store is editable by hand, and a report that accepted
// `shipped` would count an outcome nobody defined.
import { isOutcome } from "../extensions/pi-fusion-matrix/labels.js";
/** Keys that only ever appear in a fusion run record: a shape carrying one of these is ours to explain. */
const RECORD_KEYS = ["fusion", "proxied", "cascades", "seats", "seatErrors"];

const args = process.argv.slice(2);
const has = (flag) => args.includes(`--${flag}`);
const values = (name) => args.flatMap((arg, i) => (arg === `--${name}` ? [args[i + 1]].filter((v) => v !== undefined) : []));
const value = (name, fallback) => values(name).at(-1) ?? fallback;
/**
 * Every flag this reader takes. An unrecognised one is a *usage error*: a mistyped `--cwd` would otherwise
 * select the default roots and print a complete-looking report of the wrong store, which is the failure mode
 * every "no silent degradation" rule here exists to prevent.
 */
const KNOWN_FLAGS = ["dir", "harness", "session", "cwd", "since", "json", "verbose", "plans", "no-plans"];

const emptySums = () => ({
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  reasoning: 0,
  totalTokens: 0,
  costReported: 0,
  unpricedMessages: 0,
});

/**
 * Sums into sums. `addUsage` reads a *usage* (it looks at `cost.total`); adding one sums object to another
 * with it counted the whole object as an unpriced message and contributed nothing — measured on the first
 * run of the label fixture, which reported `$0.0000 reported + 1 unpriced` for a turn that cost $0.002.
 */
function mergeSums(target, source) {
  target.input += source.input ?? 0;
  target.output += source.output ?? 0;
  target.cacheRead += source.cacheRead ?? 0;
  target.cacheWrite += source.cacheWrite ?? 0;
  target.reasoning += source.reasoning ?? 0;
  target.totalTokens += source.totalTokens ?? 0;
  target.costReported += source.costReported ?? 0;
  target.unpricedMessages += source.unpricedMessages ?? 0;
  return target;
}

/**
 * `cost.reported` is the only money in these sums, and `unpricedMessages` counts the usages that carried
 * none: a provider that reports no price is not a free message, and a total that silently absorbed the two
 * would be the kind of number this report exists to refuse to print.
 */
function addUsage(sums, usage) {
  if (!usage || typeof usage !== "object") return sums;
  sums.input += usage.input ?? 0;
  sums.output += usage.output ?? 0;
  sums.cacheRead += usage.cacheRead ?? 0;
  sums.cacheWrite += usage.cacheWrite ?? 0;
  sums.reasoning += usage.reasoning ?? 0;
  sums.totalTokens += usage.totalTokens ?? (usage.input ?? 0) + (usage.output ?? 0);
  const reported = usage.cost?.total ?? 0;
  if (reported > 0) sums.costReported += reported;
  else sums.unpricedMessages += 1;
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
export function parseLines(text, { maxFailures = 5 } = {}) {
  const entries = [];
  const failures = [];
  let unparsed = 0;
  let lineNumber = 0;
  for (const line of text.split("\n")) {
    lineNumber += 1;
    if (!line.trim()) continue;
    try {
      entries.push(JSON.parse(line));
    } catch (error) {
      unparsed += 1;
      // The first few are kept with their line and reason: "3 unparsed lines" says a ledger is incomplete,
      // but only the line number says *where*, and a count alone cannot be acted on.
      if (failures.length < maxFailures) failures.push({ line: lineNumber, message: error?.message ?? String(error) });
    }
  }
  return { entries, unparsed, failures };
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
    parseFailures: meta.parseFailures ?? [],
    turns: [],
    toolResults: [],
    records: [],
    labels: [],
    unknown: [],
    problems: [],
  };

  let current = null;
  // Every call this session made, by id. omp does not guarantee that a result row follows its calling turn
  // immediately — the store has no caller field at all — so pairing through a session-level index is what keeps
  // a *failed* device call (stored with empty `details`) from being charged to the `write` that carried it.
  const callIndex = new Map();
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
      // A label is the workflow's own record of what the runs were for and how they ended — the one fact a
      // run cannot know about itself. A hand-written label missing either half is named as unrecognised
      // rather than counted, because a label nothing can be joined to is worse than no label.
      if (entry.customType === LABEL_TYPE) {
        if (typeof details?.workItem === "string" && isOutcome(details?.outcome)) {
          session.labels.push({ workItem: details.workItem, outcome: details.outcome, evidence: details.evidence, at: entry.timestamp });
        } else {
          session.unknown.push({ carrier: "custom_message", keys: Object.keys(details ?? {}).sort(), at: entry.timestamp });
        }
        continue;
      }
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
      const parts = (message.content ?? []).filter((part) => part?.type === "toolCall");
      const callParts = parts.map((part) => invokedTool(part, session.harness));
      const usage = message.usage ?? {};
      const priced = (usage.cost?.total ?? 0) > 0;
      current = {
        harness: session.harness,
        api: message.api,
        provider: message.provider,
        model: message.model,
        stopReason: message.stopReason,
        usage,
        priced,
        durationMs: Number.isFinite(message.duration) ? message.duration : undefined,
        // omp records a time-to-first-token alongside `duration`; the report prints neither yet, but the
        // metrics store's turn row does (#14), so the reader captures it — a field the reader drops is a
        // field no consumer can ever ask for.
        ttftMs: Number.isFinite(message.ttft) ? message.ttft : undefined,
        toolCalls: callParts.map((call) => call.name),
        toolCallParts: callParts.map((call, index) => ({ id: parts[index]?.id, name: call.name, device: call.device })),
        // The message's clock wins where it is representable; a value isoTime cannot represent (a
        // non-finite or out-of-range number) falls through to the entry's own ISO string rather than
        // silently costing the turn a time it had.
        at: isoTime(message.timestamp) ?? isoTime(entry.timestamp),
      };
      session.turns.push(current);
      for (const part of current.toolCallParts) if (part.id !== undefined) callIndex.set(String(part.id), part);
      const details = message.details;
      if (isRecordShape(details)) {
        if (typeof details.proxied === "object" && details.proxied !== null) {
          session.records.push({ kind: "proxy", carrier: "assistant", fusion: current.model, details: details.proxied, at: current.at });
        } else if (typeof details.fusion === "string") {
          // A fusion used as a session's own model streams its answer through the provider path, and that
          // path records the run on the assistant message (`run.js`'s `createFusionStream`): the same record
          // the tool and command carriers carry, so it is counted the same way rather than called unknown.
          session.records.push({ kind: "deliberation", carrier: "assistant", fusion: details.fusion, details, at: current.at });
        } else {
          session.unknown.push({ carrier: "assistant", keys: Object.keys(details).sort(), at: current.at });
        }
      }
      continue;
    }

    if (message.role === "toolResult") {
      // omp does not wrap every device result: a *failed* device call is stored with `details: {}`, so the
      // invoked tool has to come from the call that made it, paired by `toolCallId` — otherwise the call row
      // says `matrix` while its error is charged to the `write` that carried it.
      const call = callIndex.get(String(message.toolCallId));
      const toolName = message?.details?.xdev?.tool ?? call?.name ?? message?.toolName ?? "?";
      session.toolResults.push({
        toolName,
        isError: message.isError === true,
        device: call?.device === true,
        after: current,
        at: isoTime(message.timestamp) ?? isoTime(entry.timestamp),
      });
      const details = unwrapDetails(message.details);
      if (typeof details?.fusion === "string") {
        session.records.push({
          kind: "deliberation",
          carrier: "toolResult",
          fusion: details.fusion,
          details,
          at: session.toolResults.at(-1).at,
        });
      } else if (isRecordShape(details)) {
        session.unknown.push({ carrier: "toolResult", keys: Object.keys(details).sort(), at: session.toolResults.at(-1).at });
      }
    }
  }

  if (!session.cwd) session.problems.push("no session header: cwd unknown");
  return session;
}

/**
 * Every row is keyed by the store it came from as well as the model: the two harnesses record different
 * things (omp a duration and ttft, pi neither), and folding them together would average a fact with a
 * silence.
 */
const turnKey = (turn) =>
  `${turn.harness ?? "?"}/${turn.api === FUSION_API ? `fusion:${turn.model}` : `${turn.provider ?? "?"}/${turn.model ?? "?"}`}`;

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
    labels: new Map(),
    unlabelled: { sessions: 0, runs: 0, fusionTurns: 0, sums: emptySums() },
    providers: new Map(),
    models: new Map(),
    quotaRefusals: [],
    proxy: new Map(),
    deliberation: new Map(),
    tools: new Map(),
    toolCalls: new Map(),
    gaps: {
      noDuration: 0,
      unpriced: 0,
      sessionsWithoutHeader: 0,
      unreadable: [],
      wrappedCalls: 0,
      toolAttribution: "most recent assistant turn",
    },
    store: undefined,
  };

  const turn = (map, key, seed) => {
    if (!map.has(key))
      map.set(key, {
        key,
        turns: 0,
        sums: emptySums(),
        timed: 0,
        missingDuration: 0,
        durations: [],
        errors: 0,
        toolCalls: 0,
        toolErrors: 0,
        ...seed,
      });
    return map.get(key);
  };

  /**
   * A provider this store actually ran, kept per harness. Only omp keeps a plan ledger, so "a provider with no
   * window" is a fact about omp's ledger and a pi provider would be reported as an absence it cannot be: a pi
   * session's provider is not missing from omp's ledger, it was never meant to be in it.
   */
  const usedProvider = (harness, provider) => {
    if (typeof provider !== "string") return;
    if (!report.providers.has(harness)) report.providers.set(harness, new Set());
    report.providers.get(harness).add(provider);
  };

  /**
   * One row per model, across every session in the store — the point is that it accumulates: a seat's cost,
   * its failures and the findings *it* raised are evidence about a model only in aggregate, over days of runs,
   * and the reader walks the whole store every time it runs.
   */
  const modelRow = (model) => {
    if (!report.models.has(model)) {
      report.models.set(model, {
        model,
        seats: 0,
        tokens: 0,
        cost: 0,
        ms: 0,
        degraded: 0,
        personas: new Map(),
        attempts: new Map(),
        findings: 0,
        survived: 0,
        located: 0,
        unlocated: 0,
        uncheckable: 0,
      });
    }
    return report.models.get(model);
  };

  for (const session of sessions) {
    report.entries += session.entries;
    report.unparsed += session.unparsed;
    if (session.problems.length) report.gaps.sessionsWithoutHeader += 1;
    for (const problem of session.problems) report.problems.push(`${session.file ?? session.id ?? "session"}: ${problem}`);
    for (const unknown of session.unknown) {
      report.unknownShapes.push({
        file: session.file,
        harness: session.harness,
        carrier: unknown.carrier,
        keys: unknown.keys,
        at: unknown.at,
      });
    }
    // Counted from the calls, not from the results: a device invocation whose result row never reached the
    // store (a truncated tail) is still an invocation, and counting results made the accounting disagree with
    // the tools table's own call count.
    for (const t of session.turns) for (const part of t.toolCallParts ?? []) if (part.device) report.gaps.wrappedCalls += 1;

    for (const t of session.turns) {
      const key = turnKey(t);
      const record = turn(report.turns, key, { fusion: t.api === FUSION_API });
      record.turns += 1;
      // A fusion turn's `provider` is this extension's own api id, not a provider a plan ledger could ever
      // record: adding it made the join report `fusion-matrix` as "a provider we used with no window", which is
      // a structural fact dressed up as an absence.
      if (t.provider && t.api !== FUSION_API) usedProvider(session.harness, t.provider);
      // `t.usage` is always an object: `extractSession` normalises a message the harness stored without one,
      // so a turn priced by nobody still reaches the counter instead of being reported as neither priced nor
      // unpriced (measured 2026-09-19 on a streamed fusion turn, which stores no `usage` at all).
      addUsage(record.sums, t.usage);
      if (!t.priced) report.gaps.unpriced += 1;
      if (t.durationMs !== undefined) {
        record.timed += 1;
        record.durations.push(t.durationMs);
      } else {
        record.missingDuration += 1;
        report.gaps.noDuration += 1;
      }
      if (t.stopReason === "error" || t.stopReason === "aborted") record.errors += 1;
      record.toolCalls += t.toolCalls.length;
      for (const name of t.toolCalls) {
        const key2 = `${session.harness}/${name}`;
        report.toolCalls.set(key2, (report.toolCalls.get(key2) ?? 0) + 1);
      }
    }

    for (const result of session.toolResults) {
      const record = turn(report.tools, `${session.harness}/${result.toolName}`, {});
      record.turns += 1;
      record.errors += result.isError ? 1 : 0;
      const owner = result.after ? turn(report.turns, turnKey(result.after), { fusion: result.after.api === FUSION_API }) : undefined;
      if (owner && result.isError) owner.toolErrors += 1;
    }

    // What this session cost inside fusions: the raw material of "what did this work item cost". Two
    // carriers, never both for one run — a *streamed* fusion turn carries its cost on the assistant message
    // (and its record repeats the same run's usage), while a `/matrix` or tool run has no assistant message
    // at all and carries its cost only in the record. Counting both would double a streamed run, and counting
    // only the messages reported a `/matrix` session as costing nothing — measured 2026-09-19 on the first
    // live label run, which read `1 run(s) · $0.0000 reported` over a run that cost $0.000066.
    // A session can name more than one work item (a session that continues past one task is the normal case
    // the append-only design anticipates). Its runs and its cost are attributed **once**, to the work item it
    // ended on; the other items keep their own labels and say where their runs were counted, so a session is
    // never counted twice and no item's label is absorbed into another's row.
    const items = [...new Set(session.labels.map((entry) => entry.workItem))];
    const attributesto = session.labels.at(-1)?.workItem;
    const ensureRow = (item) => {
      if (!report.labels.has(item)) {
        report.labels.set(item, {
          workItem: item,
          outcomes: [],
          fusions: new Map(),
          sums: emptySums(),
          sessions: 0,
          runs: 0,
          fusionTurns: 0,
          alsoLabelled: [],
          attributedTo: undefined,
        });
      }
      return report.labels.get(item);
    };
    // Runs that name their own work item are attributed from the *record*, before any label is consulted. That
    // is the whole point of the field: a review runner launched for #21 has a session nobody can type a command
    // into, and its cost has to land on #21 anyway. A work item with runs and no outcome prints `?` rather than
    // disappearing or being counted as a success.
    const selfAttributed = session.records.filter((record) => typeof record.details?.workItem === "string" && record.details.workItem);
    // A work item known only from run records still came from *somewhere*: counting its runs and its cost while
    // reporting `0 sessions` is a row that contradicts itself, and "N sessions · M runs" is read by a human.
    const selfAttributedItems = new Set();
    for (const record of selfAttributed) {
      const row = ensureRow(record.details.workItem);
      if (!selfAttributedItems.has(record.details.workItem)) {
        selfAttributedItems.add(record.details.workItem);
        row.sessions += 1;
      }
      row.runs += 1;
      row.fusionTurns += record.carrier === "assistant" ? 1 : 0;
      addUsage(row.sums, record.details.usage);
      row.fusions.set(record.fusion, (row.fusions.get(record.fusion) ?? 0) + 1);
    }
    // What is left belongs to the session's own label, if it has one. The sums are recomputed rather than
    // reused: a *streamed* run's record repeats the usage its message already carried, so the message of a
    // self-attributed record is excluded by the `at` the two share — otherwise the same tokens would be
    // counted on the work item and on the session.
    const selfAttributedAt = new Set(selfAttributed.filter((record) => record.carrier === "assistant").map((record) => record.at));
    const rest = session.records.filter((record) => !selfAttributed.includes(record));
    const restSums = emptySums();
    let restTurns = 0;
    for (const t of session.turns) {
      if (t.api !== FUSION_API) continue;
      if (selfAttributedAt.has(t.at)) continue;
      restTurns += 1;
      addUsage(restSums, t.usage);
    }
    for (const record of rest) {
      if (record.carrier === "assistant") continue;
      addUsage(restSums, record.details?.usage);
    }
    for (const item of items) {
      const row = ensureRow(item);
      row.sessions += 1;
      for (const entry of session.labels) if (entry.workItem === item) row.outcomes.push({ ...entry });
      if (item === attributesto) {
        // This item *is* the endpoint here, so a note from an earlier session's redirection is stale: leaving
        // it would print "runs counted under #15" on a row that counts its own runs.
        row.attributedTo = undefined;
        row.runs += rest.length;
        row.fusionTurns += restTurns;
        mergeSums(row.sums, restSums);
        for (const record of rest) row.fusions.set(record.fusion, (row.fusions.get(record.fusion) ?? 0) + 1);
        for (const other of items) if (other !== item) row.alsoLabelled.push(other);
      } else {
        row.attributedTo = attributesto;
      }
    }
    if (rest.length > 0 && !attributesto) {
      // A run nobody labelled — and that did not name its own work item — is counted as unlabelled, never
      // assumed to have gone well.
      report.unlabelled.sessions += 1;
      report.unlabelled.runs += rest.length;
      report.unlabelled.fusionTurns += restTurns;
      mergeSums(report.unlabelled.sums, restSums);
    }

    for (const entry of session.records) {
      if (entry.kind === "proxy") {
        report.records.proxy += 1;
        const proxied = entry.details;
        const key = entry.fusion ?? proxied.model ?? "?";
        const record = turn(report.proxy, `${session.harness}/${key}`, {
          aliases: new Map(),
          levels: new Map(),
          attempts: new Map(),
          dropped: 0,
          failures: 0,
          sums: emptySums(),
          attemptsSpent: emptySums(),
        });
        record.turns += 1;
        if (typeof proxied.alias === "string") record.aliases.set(proxied.alias, (record.aliases.get(proxied.alias) ?? 0) + 1);
        if (typeof proxied.provider === "string") usedProvider(session.harness, proxied.provider);
        // `thinking: null` is a turn that ran at no level; an absent key is a record that did not say, and
        // reading the second as the first would overstate the drops.
        const recorded = Object.hasOwn(proxied, "thinking");
        const level = recorded ? (proxied.thinking ?? "none") : "unrecorded";
        record.levels.set(level, (record.levels.get(level) ?? 0) + 1);
        const attempts = Array.isArray(proxied.attempts) ? proxied.attempts : [];
        for (const attempt of attempts) {
          record.attempts.set(attempt?.reason ?? "?", (record.attempts.get(attempt?.reason ?? "?") ?? 0) + 1);
          // A refusal is a *moment*, kept with its time so the plan windows can be asked what they read then —
          // and with the provider of *this attempt*, not of the record: when a route is refused for quota and
          // the next one answers, the record's provider is the survivor, so attributing every attempt to it
          // would ask the ledger about the wrong plan.
          if (attempt?.reason === "quota")
            report.quotaRefusals.push({
              at: Date.parse(entry.at ?? ""),
              provider: attempt.provider ?? proxied.provider ?? "unknown",
              harness: session.harness,
              fusion: entry.fusion,
              carrier: "proxy",
            });
          // The tokens a route burned before it failed: only present when the target actually spent them.
          if (attempt?.usage) addUsage(record.attemptsSpent, attempt.usage);
        }
        // A turn that ran at no level while a route was refused at the level we asked for: the drop is the
        // fact worth counting, because it is what makes a cheap model answer without reasoning.
        if (recorded && proxied.thinking === null && attempts.length > 0) record.dropped += 1;
        continue;
      }

      report.records.deliberation += 1;
      const details = entry.details;
      const key = entry.fusion;
      const record = turn(report.deliberation, `${session.harness}/${key}`, {
        carriers: new Map(),
        sums: emptySums(),
        decisionUsage: emptySums(),
        seats: 0,
        degradedSeats: 0,
        seatErrors: 0,
        cascades: 0,
        cascadesSufficient: 0,
        cascadesAdvanced: 0,
        cascadeSeats: new Map(),
        substitutions: 0,
        rounds: 0,
        verify: 0,
        route: 0,
        saved: 0,
        failedWrites: 0,
        failures: 0,
        routed: undefined,
        runMs: 0,
        runsTimed: 0,
        timedSeats: 0,
        slowestSeat: undefined,
        review: {
          runs: 0,
          malformed: 0,
          superseded: 0,
          verdicts: new Map(),
          severities: new Map(),
          by: new Map(),
          reasons: new Map(),
          findings: [],
          paths: 0,
          pathsMissing: 0,
          pathsOutside: 0,
          more: 0,
        },
      });
      record.runs = (record.runs ?? 0) + 1;
      record.carriers.set(entry.carrier, (record.carriers.get(entry.carrier) ?? 0) + 1);
      // A review rung's answer, as data. `path` is the reviewer's claim and not a fact — the cheap rung names
      // files it has only read as text — so each one is checked against the session's working directory: a
      // hallucinated location is worth *seeing* rather than trusting, and a path that does not exist is the
      // cheapest evidence that a finding was not read off the diff.
      const review = record.review;
      const malformedChain = Array.isArray(details.malformedAnswers) ? details.malformedAnswers : [];
      if (details.verdict || malformedChain.length > 0) {
        review.runs += 1;
        if (typeof details.dispositionBy === "string")
          review.by.set(details.dispositionBy, (review.by.get(details.dispositionBy) ?? 0) + 1);
        if (typeof details.verdict === "string") review.verdicts.set(details.verdict, (review.verdicts.get(details.verdict) ?? 0) + 1);
        // Every entry is counted, superseded or not: a run that produced three bad answers before a good one
        // produced three, and a count that only saw the last would be the lossy record all over again.
        for (const entry of malformedChain) {
          review.malformed += 1;
          const reason = entry?.reason ?? "no reason recorded";
          review.reasons.set(reason, (review.reasons.get(reason) ?? 0) + 1);
          if (typeof entry?.supersededBy === "string") review.superseded += 1;
        }
        for (const finding of Array.isArray(details.findings) ? details.findings : []) {
          const severity = typeof finding?.severity === "string" ? finding.severity : "unknown";
          review.severities.set(severity, (review.severities.get(severity) ?? 0) + 1);
          const { where, found, outside } = pathClaim(finding, session.cwd);
          if (where !== undefined) {
            review.paths += 1;
            if (outside) review.pathsOutside += 1;
            else if (!found) review.pathsMissing += 1;
          }
          // Bounded: the report is a summary, and a run with hundreds of findings must not become the file.
          if (review.findings.length < 40)
            review.findings.push({
              severity,
              where,
              line: finding?.line ?? null,
              found,
              claim: typeof finding?.claim === "string" ? finding.claim : undefined,
            });
          else review.more += 1;
        }
      }
      addUsage(record.sums, details.usage);
      addUsage(record.decisionUsage, details.decisionUsage);
      const seats = Array.isArray(details.seats) ? details.seats : [];
      const seatErrors = Array.isArray(details.seatErrors) ? details.seatErrors : [];
      for (const seat of Array.isArray(details.seats) ? details.seats : []) {
        for (const attempt of Array.isArray(seat?.attempts) ? seat.attempts : []) {
          // The attempt's own provider, for the same reason as the proxy path: the seat's provider is the one
          // that answered, and a refusal belongs to the route that was refused.
          if (attempt?.reason === "quota")
            report.quotaRefusals.push({
              at: Date.parse(entry.at ?? ""),
              provider: attempt.provider ?? seat.provider ?? "unknown",
              harness: session.harness,
              fusion: entry.fusion,
              carrier: "deliberation",
            });
        }
      }
      record.seats += seats.length;
      for (const seat of seats) {
        usedProvider(session.harness, seat?.provider);
        if (seat?.degraded) record.degradedSeats += 1;
        // Deliberately **not** added to `record.sums`: `details.usage` is already the sum of the seats
        // (verified against the store — a one-seat run's `details.usage.input` equals that seat's), so adding
        // each seat again doubled every deliberation's tokens and cost.
        //
        // A seat's *own* findings are a different fact, and they belong to the model: this is the join that makes
        // "how is this model doing" answerable over days of runs rather than from a single review. `located`
        // separates a finding that names a real file from one whose path this session cannot resolve — the
        // difference between a finding you can act on and one you must re-find yourself.
        const model = seat?.provider && seat?.model ? `${seat.provider}/${seat.model}` : undefined;
        if (model) {
          const row = modelRow(model);
          row.seats += 1;
          row.personas.set(seat.persona ?? "?", (row.personas.get(seat.persona ?? "?") ?? 0) + 1);
          row.tokens += (seat.usage?.input ?? 0) + (seat.usage?.output ?? 0);
          row.cost += seat.usage?.cost?.total ?? 0;
          row.ms += seat.durationMs ?? 0;
          if (seat.degraded) row.degraded += 1;
          for (const attempt of seat.attempts ?? [])
            row.attempts.set(attempt.reason ?? "?", (row.attempts.get(attempt.reason ?? "?") ?? 0) + 1);
          // Which of this seat's findings the run's own disposition kept — the difference between finding things
          // and finding things that mattered, which is the number a roster decision is argued from.
          const kept = new Set((Array.isArray(details.findings) ? details.findings : []).filter(isFinding).map(sameFinding));
          for (const finding of Array.isArray(seat.findings) ? seat.findings : []) {
            if (!isFinding(finding)) continue;
            row.findings += 1;
            if (kept.has(sameFinding(finding))) row.survived += 1;
            const { found, outside } = pathClaim(finding, session.cwd);
            if (found === true) row.located += 1;
            else if (found === false) row.unlocated += 1;
            else if (outside) row.uncheckable += 1;
          }
        }
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
      if (Number.isFinite(details.durationMs)) {
        record.runMs = (record.runMs ?? 0) + details.durationMs;
        record.runsTimed = (record.runsTimed ?? 0) + 1;
      }
      for (const seat of seats) {
        if (!Number.isFinite(seat?.durationMs)) continue;
        record.timedSeats = (record.timedSeats ?? 0) + 1;
        if (!record.slowestSeat || seat.durationMs > record.slowestSeat.durationMs)
          record.slowestSeat = { persona: seat.persona, durationMs: seat.durationMs };
      }
      record.rounds += details.rounds ?? 0;
      record.verify += Array.isArray(details.verification) ? details.verification.length : 0;
      if (details.routing) {
        record.route += 1;
        record.routed = details.routing;
      }
      record.saved += Array.isArray(details.saved) ? details.saved.length : 0;
      record.failedWrites += Array.isArray(details.failedWrites) ? details.failedWrites.length : 0;
    }
  }

  return report;
}

/**
 * Where a finding claims to be, and whether that claim is checkable: `found` is the filesystem's answer, `false`
 * the claim is wrong, `undefined` it cannot be checked at all (no path, or a path that does not resolve inside
 * the session's tree). One implementation, because two readers now ask the question — the run's disposition and
 * each seat's own findings — and two answers to "is this path real?" would be one too many.
 */
export const pathClaim = (finding, cwd) => {
  const where = typeof finding?.path === "string" && finding.path ? finding.path : undefined;
  if (where === undefined) return { where, found: undefined, outside: false };
  // The claim has to *resolve inside* the session's tree to be checkable at all. An absolute path never is, and
  // a relative one can leave the tree while looking innocent — `../../etc/passwd` joins to a real file outside
  // the session, and reporting that as found is the same laundering the absolute case is refused for.
  const root = path.resolve(cwd ?? ".");
  const within = path.resolve(root, where);
  if (within !== root && !within.startsWith(root + path.sep)) return { where, found: undefined, outside: true };
  return { where, found: fs.existsSync(within), outside: false };
};

/** Whether a finding asserts a claim at all — a path, a criterion and a claim, which is the schema's contract. */
export const isFinding = (value) =>
  Boolean(
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    typeof value.path === "string" &&
    typeof value.criterion === "string" &&
    typeof value.claim === "string",
  );

/**
 * Whether a seat's finding is the same finding the run's disposition recorded, i.e. whether it survived the
 * synthesis. Matched on location rather than wording: a synthesis keeps a finding's trigger and consequence and
 * may reword its claim, so comparing claims would report every finding dropped. A finding the disposition does
 * not carry at its location is one the synthesis declined — the number a roster decision is argued from.
 */
export const sameFinding = (finding) => `${finding.path}:${finding.line ?? ""}`;

const median = (sorted) => (sorted.length === 0 ? undefined : sorted[Math.floor(sorted.length / 2)]);
const num = (n) => new Intl.NumberFormat("en-US").format(Math.round(n));
// A real cost must never print as `$0.0000`: a message priced at a fraction of a cent is priced, and the
// formatter is part of the claim that money states its basis.
export const money = (n) => (n === 0 ? "$0.0000" : n < 0.01 ? `$${n.toFixed(6)}` : `$${n.toFixed(2)}`);
const ms = (n) => `${(n / 1000).toFixed(1)}s`;
const pct = (part, whole) => (whole === 0 ? "—" : `${((100 * part) / whole).toFixed(1)}%`);

function renderTurns(title, records, { limit = Infinity } = {}) {
  const rows = [...records.values()].filter((r) => r.turns > 0).sort((a, b) => b.sums.totalTokens - a.sums.totalTokens);
  const lines = [title];
  if (rows.length === 0) return [...lines, "  (none)"];
  for (const row of rows.slice(0, limit)) {
    const timing = row.timed > 0 ? ` · median ${ms(median([...row.durations].sort((a, b) => a - b)))}` : "";
    const missing = row.missingDuration > 0 ? ` · ${row.missingDuration} with no duration` : "";
    const unpriced = row.sums.unpricedMessages > 0 ? ` · ${row.sums.unpricedMessages} message(s) unpriced` : "";
    const reasoning = row.sums.reasoning > 0 ? ` · ${num(row.sums.reasoning)} reasoning` : "";
    const tools =
      row.toolCalls > 0
        ? ` · ${row.toolCalls} tool calls${row.toolErrors ? `, ${row.toolErrors} errored (${pct(row.toolErrors, row.toolCalls)})` : ""}`
        : "";
    lines.push(
      `  ${row.key.padEnd(40)} ${String(row.turns).padStart(4)} turns · ${num(row.sums.input).padStart(12)} in · ${num(row.sums.output).padStart(7)} out${reasoning} · ${money(row.sums.costReported).padStart(10)} reported${timing}${missing}${unpriced}${tools}`,
    );
  }
  if (rows.length > limit) lines.push(`  … ${rows.length - limit} more model(s)`);
  return lines;
}

/**
 * The plan windows the harness recorded, and what they read when our runs were refused: refusals grouped by
 * provider, with what the ledger read at each moment. The join is deliberately narrow — a refusal is only
 * called explained by a reading taken *before* it that had not reset, because a window read afterwards says
 * nothing about what the provider thought at the time, and calling it a cause would turn a coincidence into
 * one. `uncovered` counts the refusals no reading covers — older than the ledger's history, or for a provider it
 * never recorded — which are the ones a reader must not assume the plan explains.
 */
export function joinPlanWindows(report, plans) {
  const refusals = report.quotaRefusals ?? [];
  const byProvider = new Map();
  // Providers the store actually ran, collected where they are known and *per harness* — a turn row's key
  // carries a *fusion* id for a fusion turn, so scraping it reported `fusion:quick` as a provider we had no
  // window for, and a pi provider is absent from omp's ledger by construction rather than by omission.
  const usedProviders = report.providers ?? new Map();
  // Only omp keeps this ledger, so only a refusal from an omp session can be joined to it. A pi session's
  // refusal is not "uncovered" — there is nothing to cover it with, and reporting it as unexplained would
  // misstate the reason.
  const joinable = refusals.filter((record) => record.harness === "omp");
  const withoutLedger = refusals.filter((record) => record.harness !== "omp");
  // The latest reading *before* the refusal, within each window the provider has: a reading taken afterwards
  // says nothing about what the provider thought at the time, and letting it stand for the window would report
  // a covered refusal as uncovered and vice versa.
  const readingAt = (provider, limitId, at) =>
    (plans.history ?? plans.windows ?? [])
      .filter((window) => window.provider === provider && window.limitId === limitId && windowCovers(window, at))
      .reduce((best, window) => (best === undefined || window.recordedAt > best.recordedAt ? window : best), undefined);
  const windowsOf = (provider) => [
    ...new Set((plans.history ?? plans.windows ?? []).filter((window) => window.provider === provider).map((window) => window.limitId)),
  ];
  for (const record of joinable) {
    if (!byProvider.has(record.provider))
      byProvider.set(record.provider, {
        provider: record.provider,
        refusals: 0,
        exhausted: 0,
        ok: 0,
        uncovered: 0,
        undated: 0,
        byStatus: new Map(),
      });
    const row = byProvider.get(record.provider);
    row.refusals += 1;
    // A refusal with no placeable time cannot be joined to anything, and folding it into "uncovered" would
    // report a record's missing clock as the ledger's failure to cover the moment.
    if (!Number.isFinite(record.at)) {
      row.undated += 1;
      continue;
    }
    const covering = windowsOf(record.provider)
      .map((limitId) => readingAt(record.provider, limitId, record.at))
      .filter(Boolean);
    if (covering.length === 0) {
      row.uncovered += 1;
      continue;
    }
    // Every covering reading is kept by the status it actually had. Collapsing `warning` into `ok` would report
    // a refusal as happening while a window read fine, which is a different claim from the one the ledger makes.
    for (const window of covering) row.byStatus.set(window.status, (row.byStatus.get(window.status) ?? 0) + 1);
    if (covering.some((window) => window.status === "exhausted")) row.exhausted += 1;
    if (covering.some((window) => window.status === "ok")) row.ok += 1;
  }
  const windowed = new Set((plans.windows ?? []).map((window) => window.provider));
  // Only the providers an *omp* session used can be missing from omp's ledger.
  const ompProviders = usedProviders.get?.("omp") ?? new Set();
  return {
    total: refusals.length,
    byProvider: [...byProvider.values()],
    withoutLedger: withoutLedger.length,
    // Named whether or not any refusal was recorded: a provider absent from the ledger is a fact about the
    // ledger, and printing only "nothing to join" would present that absence as completeness.
    uncoveredProviders: plans.available ? [...ompProviders].filter((provider) => !windowed.has(provider)).sort() : [],
  };
}

function renderPlanWindows(report) {
  const plans = report.plans;
  const lines = ["plan windows (the harness's own ledger, read-only)"];
  if (!plans) return [...lines, "  not read"];
  if (!plans.available) return [...lines, `  ${plans.reason}`];
  const age = (ms) => (ms <= 0 ? "age unknown" : `${Math.round((Date.now() - ms) / 60000)}m ago`);
  const when = (ms) => (ms <= 0 ? "no reset stated" : new Date(ms).toISOString().replace(".000Z", "Z"));
  const fraction = (used) => (used === undefined ? "used unknown" : `${Math.round(used * 100)}% used`);
  lines.push(
    `  ${plans.path.replace(os.homedir(), "~")} · ${plans.readings} reading(s) · ${plans.windows.length} window(s), latest per provider+limit`,
  );
  for (const window of [...plans.windows].sort((a, b) => a.provider.localeCompare(b.provider) || a.limitId.localeCompare(b.limitId))) {
    const stale = window.recordedAt > 0 && Date.now() - window.recordedAt > 6 * 60 * 60 * 1000 ? "  ← stale reading" : "";
    lines.push(
      `  ${window.provider.padEnd(16)} ${window.label.padEnd(18)} ${window.status.padEnd(10)} ${fraction(window.usedFraction).padEnd(12)} resets ${when(window.resetsAt).padEnd(24)} read ${age(window.recordedAt)}${stale}`,
    );
  }
  const join = report.planJoin;
  lines.push("  what the windows read when our runs were refused");
  if (!join || join.total === 0) {
    lines.push("    no quota refusal recorded in these sessions — nothing to join");
  } else if (join.total === join.withoutLedger) {
    // Saying "nothing to join" over refusals that *did* happen would read as no refusals at all.
    lines.push(`    all ${join.total} refusal(s) come from sessions with no plan ledger (only omp records one)`);
  } else {
    for (const row of [...join.byProvider].sort((a, b) => b.refusals - a.refusals)) {
      const covered = row.exhausted + row.ok;
      // The statuses the ledger actually reported, not a bucket: a refusal covered only by a `warning` reading
      // did not happen while the window read fine, and collapsing the two would say that it did.
      const statuses = [...(row.byStatus ?? [])].map(([status, count]) => `${count} read ${status}`).join(", ");
      const undated = row.undated > 0 ? ` · ${row.undated} with no recorded time` : "";
      lines.push(
        `    ${row.provider.padEnd(16)} ${row.refusals} refusal(s) · ${statuses || "no reading covered that moment"} · ${row.uncovered} with no reading covering that moment${undated}${covered === 0 && row.uncovered > 0 ? "  ← the ledger cannot explain these" : ""}`,
      );
    }
    if (join.withoutLedger > 0) lines.push(`    ${join.withoutLedger} refusal(s) from sessions with no plan ledger (only omp records one)`);
  }
  // Named whether or not a refusal was recorded: a provider absent from the ledger is a fact about the ledger,
  // and printing only "nothing to join" presents that absence as completeness.
  if (join?.uncoveredProviders?.length)
    lines.push(`    providers we used with no window in the ledger: ${join.uncoveredProviders.join(", ")}`);
  return lines;
}

export function render(report, { limit = 12 } = {}) {
  const lines = [];
  lines.push("session report — what the two faces recorded");
  lines.push(
    ...report.roots.map((r) => `  ${r.harness}  ${r.root.replace(os.homedir(), "~")}  ${r.missing ? "MISSING" : `${r.files} file(s)`}`),
  );
  const store = report.store;
  const excluded = store ? ` of ${store.read} read (${store.excludedByCwd} by --cwd, ${store.excludedBySince} by --since)` : "";
  lines.push(
    `  sessions ${report.sessions}${excluded} · entries ${num(report.entries)} · unparsed lines ${store ? store.unparsed : report.unparsed}`,
  );
  if (report.problems.length) lines.push(`  sessions without a header: ${report.gaps.sessionsWithoutHeader}`);
  lines.push("");
  lines.push(...renderTurns("turns by model", report.turns, { limit }));
  lines.push("");
  lines.push(`proxy records (details.proxied): ${report.records.proxy}`);
  for (const row of [...report.proxy.values()].sort((a, b) => b.turns - a.turns)) {
    const aliases = [...row.aliases].map(([k, v]) => `${k}×${v}`).join(", ") || "—";
    const levels = [...row.levels].map(([k, v]) => `${k}×${v}`).join(", ") || "—";
    const attempts = [...row.attempts].map(([k, v]) => `${k}×${v}`).join(", ") || "none";
    const spent =
      row.attemptsSpent.unpricedMessages > 0
        ? `, ${num(row.attemptsSpent.input)} in / ${num(row.attemptsSpent.output)} out on failed routes (unpriced)`
        : row.attemptsSpent.input + row.attemptsSpent.output > 0
          ? `, ${num(row.attemptsSpent.input)} in / ${num(row.attemptsSpent.output)} out on failed routes (${money(row.attemptsSpent.costReported)} reported)`
          : "";
    lines.push(
      `  ${row.key.padEnd(20)} ${String(row.turns).padStart(3)} turns · alias ${aliases} · level ${levels} · ${row.dropped} level drop(s) · attempts ${attempts}${spent}`,
    );
  }
  lines.push("");
  lines.push(`deliberation records (details.fusion): ${report.records.deliberation}`);
  for (const row of [...report.deliberation.values()].sort((a, b) => (b.runs ?? 0) - (a.runs ?? 0))) {
    const carriers = [...row.carriers].map(([k, v]) => `${k}×${v}`).join(", ");
    lines.push(
      `  ${row.key.padEnd(20)} ${String(row.runs ?? 0).padStart(3)} runs (${carriers}) · ${row.seats} seats, ${row.degradedSeats} degraded, ${row.seatErrors} seat error(s)`,
    );
    const slowest = row.slowestSeat ? ` · slowest seat ${row.slowestSeat.persona ?? "?"} ${ms(row.slowestSeat.durationMs)}` : "";
    lines.push(
      `  ${"".padEnd(20)} cascades ${row.cascades} (sufficient ${row.cascadesSufficient}, advanced ${row.cascadesAdvanced}) · substitutions ${row.substitutions} · decision tokens ${num(row.decisionUsage.totalTokens)} (${money(row.decisionUsage.costReported)} reported${row.decisionUsage.unpricedMessages ? `, ${row.decisionUsage.unpricedMessages} unpriced` : ""})`,
    );
    // A fast run's clock can legitimately be 0 ms: keyed on the count of timed runs, not on truthiness, so a
    // recorded zero is distinguishable from an absent clock.
    if (row.runsTimed > 0) lines.push(`  ${"".padEnd(20)} run time ${ms(row.runMs)}${slowest} · ${row.timedSeats} seat(s) timed`);
    const unpriced = row.sums.unpricedMessages ? ` (${row.sums.unpricedMessages} unpriced)` : "";
    lines.push(
      `  ${"".padEnd(20)} turns ${money(row.sums.costReported)} reported${unpriced} · ${num(row.sums.input)} in / ${num(row.sums.output)} out · ${row.failures} failed · routes ${row.route} · verify ${row.verify} check(s) · saved ${row.saved}${row.failedWrites ? `, ${row.failedWrites} write failure(s)` : ""}`,
    );
  }
  lines.push("");
  const reviewRows = [...report.deliberation.values()]
    .filter((row) => (row.review?.runs ?? 0) > 0)
    .sort((a, b) => b.review.runs - a.review.runs);
  if (reviewRows.length > 0) {
    lines.push("review dispositions (details.verdict / details.malformedAnswers)");
    for (const row of reviewRows) {
      const { review } = row;
      const counts = (map) => [...map].map(([k, v]) => `${k} ${v}`).join(", ") || "—";
      lines.push(
        `  ${row.key.padEnd(20)} ${review.runs} run(s) with a disposition · verdict ${counts(review.verdicts)} · by ${counts(review.by)}`,
      );
      // "not found" is as of *this* run of the report against this filesystem: a file the finding named and a
      // later commit deleted is not a hallucination, and the wording has to leave room for that.
      lines.push(
        `  ${"".padEnd(20)} severities ${counts(review.severities)} · ${review.paths} path(s): ${review.pathsMissing} not in the session cwd now, ${review.pathsOutside} absolute (not checkable)`,
      );
      // A malformed answer is why no verdict is recorded — unless a later one answered, in which case saying so
      // is the difference between a record and a covered-up failure.
      if (review.malformed > 0)
        lines.push(
          `  ${"".padEnd(20)} malformed ${review.malformed} ×${review.superseded > 0 ? ` (${review.superseded} superseded by a later answer)` : ""}: ${[...review.reasons].map(([k, v]) => `${k} (${v})`).join(" | ")}`,
        );
      for (const finding of review.findings) {
        const line = finding.line === null || finding.line === undefined ? "" : `:${finding.line}`;
        const mark =
          finding.found === false
            ? "[path not found] "
            : finding.found === undefined && finding.where
              ? "[path outside the session] "
              : finding.found === undefined
                ? "[no path] "
                : "";
        lines.push(
          `  ${"".padEnd(20)} ${mark}${finding.severity} ${finding.where ?? "?"}${line} — ${(finding.claim ?? "").split("\n")[0].slice(0, 120)}`,
        );
      }
      if (review.more > 0) lines.push(`  ${"".padEnd(20)} … ${review.more} further finding(s) not listed`);
    }
    lines.push("");
  }
  lines.push(...renderPlanWindows(report));
  lines.push("");
  lines.push("outcomes (what the runs were for, and how they ended)");
  const labels = [...report.labels.values()].sort((a, b) =>
    String(
      b.outcomes
        .map((e) => e.at)
        .sort()
        .at(-1) ?? "",
    ).localeCompare(
      String(
        a.outcomes
          .map((e) => e.at)
          .sort()
          .at(-1) ?? "",
      ),
    ),
  );
  if (labels.length === 0 && report.unlabelled.runs === 0) lines.push("  (no fusion runs recorded in these sessions)");
  for (const row of labels) {
    // The current outcome is the latest by *time*, not by the order the store happened to be read in: pi is
    // read before omp, and a session is folded in before or after another according to its path.
    // `when`: a missing or unparseable timestamp sorts before any real one, and ties keep the later entry —
    // so a store whose labels carry no `at` still falls back to read order rather than picking the oldest.
    const when = (entry) => {
      const t = Date.parse(entry?.at ?? "");
      return Number.isNaN(t) ? -Infinity : t;
    };
    const byTime = (entries) =>
      entries.reduce((best, entry) => (best === undefined || when(entry) >= when(best) ? entry : best), undefined);
    const latest = byTime(row.outcomes);
    const evidence = byTime(row.outcomes.filter((entry) => entry.evidence))?.evidence;
    const fusions = [...row.fusions].map(([k, v]) => `${k}×${v}`).join(", ") || "—";
    // One session's labels are a history (latest wins); labels from several sessions for one work item are
    // separate sessions' views of the same work, and saying "latest wins" there would imply one history.
    const history =
      row.outcomes.length > 1
        ? ` · ${row.outcomes.length} label(s)${row.sessions === 1 ? ", latest wins" : " from separate sessions"}`
        : "";
    const attribution = row.attributedTo
      ? ` · runs counted under ${row.attributedTo} (the session ended there)`
      : row.alsoLabelled.length
        ? ` · same session also labelled ${row.alsoLabelled.join(", ")}`
        : "";
    lines.push(
      `  ${row.workItem.padEnd(18)} ${String(latest?.outcome ?? "?").padEnd(9)} ${row.sessions} session(s) · ${row.runs} run(s) · ${money(row.sums.costReported)} reported${row.sums.unpricedMessages ? ` + ${row.sums.unpricedMessages} unpriced` : ""}${row.fusionTurns ? ` · ${row.fusionTurns} streamed turn(s)` : ""}${attribution}`,
    );
    lines.push(`  ${"".padEnd(18)} via ${fusions}${evidence ? ` · evidence: ${evidence}` : ""}${history}`);
  }
  if (report.unlabelled.runs > 0) {
    lines.push(
      `  ${"(unlabelled)".padEnd(18)} ${"".padEnd(9)} ${report.unlabelled.sessions} session(s) · ${report.unlabelled.runs} run(s) · ${money(report.unlabelled.sums.costReported)} reported${report.unlabelled.sums.unpricedMessages ? ` + ${report.unlabelled.sums.unpricedMessages} unpriced` : ""}`,
    );
    lines.push(
      `  ${"".padEnd(18)} no \`/matrix-label\` was recorded: these runs have a cost and no outcome, and are not counted as successes.`,
    );
  }
  const modelRows = [...report.models.values()].sort((a, b) => b.seats - a.seats);
  lines.push(
    `seats by model (details.seats[], across every session in the store): ${modelRows.length} model(s) · ${modelRows.reduce((t, r) => t + r.seats, 0)} seat(s)`,
  );
  for (const row of modelRows) {
    const attempts = [...row.attempts].map(([k, v]) => `${k}×${v}`).join(", ") || "none";
    lines.push(
      `  ${row.model.padEnd(40)} ${String(row.seats).padStart(4)} seats · ${num(row.tokens).padStart(10)} tok · ${money(row.cost).padStart(10)} · ${ms(row.ms).padStart(7)} seat-time${row.degraded ? ` · ${row.degraded} degraded` : ""} · attempts ${attempts}`,
    );
    if (row.findings > 0) {
      lines.push(
        `  ${"".padEnd(40)} findings ${row.findings} · kept by the disposition ${row.survived}, dropped ${row.findings - row.survived} · located ${row.located}, path not found ${row.unlocated}, outside the session ${row.uncheckable} · as ${[...row.personas].map(([k, v]) => `${k}×${v}`).join(", ")}`,
      );
    }
  }
  lines.push("");
  lines.push("tools");
  const tools = [...report.tools.values()].filter((row) => row.turns > 0).sort((a, b) => b.turns - a.turns);
  if (tools.length === 0) lines.push("  (none)");
  for (const row of tools.slice(0, limit)) {
    const calls = report.toolCalls.get(row.key) ?? 0;
    const silent = calls - row.turns;
    lines.push(
      `  ${row.key.padEnd(34)} ${String(calls).padStart(5)} calls · ${String(row.turns).padStart(5)} results${silent > 0 ? ` (${silent} with no result)` : ""} · ${row.errors} errored (${pct(row.errors, row.turns)})`,
    );
  }
  if (tools.length > limit) lines.push(`  … ${tools.length - limit} more tool(s)`);
  lines.push("");
  lines.push("what this report could not see");
  lines.push(`  messages with no recorded duration: ${report.gaps.noDuration} (pi records none; omp records duration/ttft)`);
  lines.push(`  messages carrying no price: ${report.gaps.unpriced}`);
  lines.push(`  records shaped like ours but not recognised: ${report.unknownShapes.length}`);
  lines.push(`  files or directories that could not be read: ${report.gaps.unreadable.length}`);
  for (const skipped of report.store?.skippedRoots ?? [])
    lines.push(`  store not read (--harness): ${skipped.root.replace(os.homedir(), "~")}`);
  const unattributable = report.store?.unattributable ?? [];
  lines.push(`  sessions a filter could not attribute (no header, or nothing to compare): ${unattributable.length}`);
  for (const entry of unattributable.slice(0, 10)) lines.push(`    ${entry.path}: ${entry.reason}`);
  if (unattributable.length > 10) lines.push(`    … ${unattributable.length - 10} more, all in the JSON output`);
  for (const unreadable of report.gaps.unreadable.slice(0, 10)) lines.push(`    ${unreadable.path}: ${unreadable.reason}`);
  if (report.gaps.unreadable.length > 10) lines.push(`    … ${report.gaps.unreadable.length - 10} more, all in the JSON output`);
  lines.push(`  tool calls are attributed by ${report.gaps.toolAttribution} — the format carries no caller`);
  if (report.gaps.wrappedCalls > 0) {
    lines.push(`  ${report.gaps.wrappedCalls} call(s) made through omp's \`xd://\` device, counted under the tool they invoked:`);
    lines.push("  omp records such a call as `write` with `path: xd://<tool>`, and wraps the result's record one level in.");
  }
  for (const unknown of report.unknownShapes.slice(0, 10)) {
    lines.push(
      `    ${unknown.file ?? "?"} (${unknown.harness ?? "?"}) ${unknown.carrier}: ${unknown.keys.join(", ")}${unknown.at ? ` at ${unknown.at}` : ""}`,
    );
  }
  if (report.unknownShapes.length > 10)
    lines.push(`    … ${report.unknownShapes.length - 10} more unrecognised shape(s), all in the JSON output`);
  for (const failure of (report.store?.parseFailures ?? []).slice(0, 10)) {
    lines.push(`    ${failure.path}:${failure.line} — ${failure.message}`);
  }
  const named = report.store?.parseFailuresNamed ?? 0;
  const unparsed = report.store?.unparsed ?? 0;
  if (unparsed > named) lines.push(`    … ${unparsed - named} more unparsed line(s) not named here (first ${named} shown)`);
  if (report.records.deliberation === 0) {
    lines.push("  NO deliberation record was recognised in these sessions. Whether a deliberation ran is not");
    lines.push("  knowable from this store: a run writes its record to its tool result, its answer message, or the");
    lines.push("  streamed turn, and a session that used none of those leaves no record either way.");
  }
  return lines.join("\n");
}

export function renderJson(report) {
  const plain = (map) =>
    Object.fromEntries(
      [...map.entries()].map(([key, row]) => {
        const out = {};
        for (const [k, v] of Object.entries(row)) out[k] = v instanceof Map ? Object.fromEntries(v) : v;
        return [key, out];
      }),
    );
  return JSON.stringify(
    {
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
      models: plain(report.models),
      tools: plain(report.tools),
      labels: plain(report.labels),
      plans: report.plans,
      planJoin: report.planJoin,
      unlabelled: report.unlabelled,
      toolCalls: Object.fromEntries(report.toolCalls),
      gaps: report.gaps,
      unknownShapes: report.unknownShapes,
      problems: report.problems,
      store: report.store,
    },
    null,
    2,
  );
}

/**
 * The store into sessions. `readFile`/`readdir` are injectable so the accounting for a file that refuses to
 * be read can be proved; in a real run they are `node:fs`.
 */
export function readStore({
  roots,
  harnessFilter,
  sessionFile,
  cwdFilter,
  sinceMs,
  readFile = fs.readFileSync,
  readdir = fs.readdirSync,
} = {}) {
  const reportRoots = [];
  const sessions = [];
  const files = [];
  const unreadable = [];
  const store = {
    read: 0,
    unparsed: 0,
    withoutHeader: 0,
    excludedByCwd: 0,
    excludedBySince: 0,
    skippedRoots: [],
    unattributable: [],
    parseFailures: [],
    parseFailuresNamed: 0,
  };
  if (sessionFile) {
    files.push({ harness: harnessOfPath(sessionFile), root: path.dirname(path.resolve(sessionFile)), file: path.resolve(sessionFile) });
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
    const { entries, unparsed, failures } = parseLines(text);
    const session = extractSession(entries, { file, harness, unparsed, parseFailures: failures });
    store.read += 1;
    store.unparsed += unparsed;
    for (const failure of failures) {
      store.parseFailuresNamed += 1;
      store.parseFailures.push({ harness, path: file, line: failure.line, message: failure.message });
    }
    if (session.problems.length) store.withoutHeader += 1;
    const lacksCwd = !session.cwd;
    if (cwdFilter && !String(session.cwd ?? "").includes(cwdFilter)) {
      // Excluded, but not silently: an exclusion the filter cannot justify (no cwd to compare, no header at
      // all) may be a session that *would* have matched, so it is named instead of counted as a clean miss.
      if (lacksCwd)
        store.unattributable.push({ harness, path: file, reason: "no cwd in the session header, so --cwd cannot tell whether it matches" });
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

export function buildReport(read, { sessionFile } = {}) {
  const report = aggregate(read.sessions);
  report.roots = sessionFile
    ? [{ harness: harnessOfPath(sessionFile), root: path.dirname(path.resolve(sessionFile)), files: 1, missing: false }]
    : read.roots;
  report.gaps.unreadable = read.unreadable;
  report.store = read.store;
  return report;
}

async function main() {
  const unknown = args.filter((arg) => arg.startsWith("--") && !KNOWN_FLAGS.includes(arg.slice(2)));
  if (unknown.length) {
    console.error(
      `session report: unknown flag ${unknown.join(", ")} — this reader takes ${KNOWN_FLAGS.map((flag) => `--${flag}`).join(", ")}`,
    );
    process.exit(1);
  }
  const dirs = values("dir");
  const roots = dirs.length
    ? dirs.map((root) => ({
        harness: root.includes(`${path.sep}.omp`) ? "omp" : root.includes(`${path.sep}.pi`) ? "pi" : "custom",
        root: path.resolve(root),
      }))
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

  const read = readStore({ roots, harnessFilter, sessionFile, cwdFilter, sinceMs });
  const plans = has("no-plans")
    ? {
        path: value("plans", PLAN_LEDGER),
        available: false,
        reason: "not read (--no-plans)",
        readings: 0,
        windows: [],
        readAt: new Date().toISOString(),
      }
    : await readPlanWindows({ dbPath: value("plans", PLAN_LEDGER) });
  const { sessions, roots: reportRoots, unreadable: unreadablePaths, fatal } = read;
  // `read.store` holds the store-level facts (files read, unparsed lines, exclusions); `unreadablePaths` is
  // the same list the report's accounting section prints.
  const accounting = read.store;
  if (fatal) {
    console.error(`session report: cannot read ${fatal}`);
    process.exit(1);
  }
  if (!sessionFile && reportRoots.every((r) => r.missing || r.files === 0)) {
    // Nothing was read, so say why in full: the roots a filter left out are the explanation, and an empty
    // report with a bare exit status is indistinguishable from a crash.
    for (const r of reportRoots)
      console.error(`session report: ${r.missing ? "no sessions directory at" : "no session files under"} ${r.root}`);
    for (const skipped of accounting.skippedRoots)
      console.error(`session report: store left out by --harness ${harnessFilter}: ${skipped.root}`);
    // A store that is present but unreadable is the case where the reason matters most, and this is the one
    // path that exits before `render` can print it.
    for (const entry of unreadablePaths) console.error(`session report: cannot read ${entry.path}: ${entry.reason}`);
    process.exit(1);
  }

  const report = buildReport(read, { sessionFile });
  report.plans = plans;
  report.planJoin = joinPlanWindows(report, plans);

  if (has("json")) console.log(renderJson(report));
  else {
    console.log(render(report));
    if (has("verbose")) {
      console.log("\nrecords");
      for (const session of sessions) {
        for (const record of session.records) {
          const label =
            record.kind === "proxy"
              ? `proxy ${record.fusion} → ${record.details.alias} @${Object.hasOwn(record.details, "thinking") ? (record.details.thinking ?? "no level") : "unrecorded"} (${record.details.attempts?.length ?? 0} attempt(s))`
              : `deliberation ${record.fusion} via ${record.carrier} (${record.details.cascades?.length ?? 0} cascade(s), ${record.details.seatErrors?.length ?? 0} seat error(s))`;
          console.log(`  ${String(session.file).split("/").at(-1).slice(0, 28).padEnd(29)} ${record.at ?? ""} ${label}`);
        }
      }
    }
  }
  // A partial ledger is not a report: say so with the exit status too, so a hook cannot read a short total
  // as a fact about the fusions. That covers a file that could not be read, a session a filter could not
  // attribute, and a line that did not parse — the last of which is excluded from every total below.
  process.exit(unreadablePaths.length === 0 && accounting.unattributable.length === 0 && accounting.unparsed === 0 ? 0 : 1);
}

// The CLI runs only when this file *is* the program: imported by a test, it must be a module whose units can be
// exercised (`readStore`, `extractSession`, `aggregate`, `render`) rather than a script that prints a report and
// exits. `argv[1]` is this file's path when the harness invoked it, and a bin shim's path when it did not.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  // `main` reads the plan ledger asynchronously; a rejection has to be reported rather than swallowed.
  main().catch((error) => {
    console.error(`session report: ${error?.message ?? String(error)}`);
    process.exit(1);
  });
}
