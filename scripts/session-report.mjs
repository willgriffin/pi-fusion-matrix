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
 * unreadable `--session`, a file or directory that cannot be read, a line that did not parse, or a session a
 * filter could not attribute — 2 `--check` failed. An incomplete ledger is never a clean exit: every total
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
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const DEFAULT_ROOTS = [
  { harness: "pi", root: path.join(os.homedir(), ".pi/agent/sessions") },
  { harness: "omp", root: path.join(os.homedir(), ".omp/agent/sessions") },
];

/** The api id every fusion model is registered under, so a turn names the fusion that served it. */
const FUSION_API = "fusion-matrix";
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

/** The custom message type a `/matrix-label` writes: a work item, an outcome, and optional evidence. */
const LABEL_TYPE = "matrix-label";

/**
 * omp invokes an extension tool through its `xd://` device protocol, and stores the result as
 * `details = { xdev: { tool, mode, args, tier, inner: <the real record> } }` — so the record the extension
 * returned is one level in, and a reader that only looks at the outer object drops the run entirely
 * (measured 2026-09-20: one plain deliberation record in the store against two wrapped and invisible, with a
 * session that ran two fusions reporting none). pi does not wrap, and neither does the command path.
 */
const unwrapDetails = (details) => (details && typeof details === "object" && details.xdev && typeof details.xdev === "object" && details.xdev.inner && typeof details.xdev.inner === "object"
  ? details.xdev.inner
  : details);

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

const emptySums = () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, totalTokens: 0, costReported: 0, unpricedMessages: 0 });

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
        toolCalls: callParts.map((call) => call.name),
        toolCallParts: callParts.map((call, index) => ({ id: parts[index]?.id, name: call.name, device: call.device })),
        at: message.timestamp ?? entry.timestamp,
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
      session.toolResults.push({ toolName, isError: message.isError === true, device: call?.device === true, after: current, at: message.timestamp ?? entry.timestamp });
      const details = unwrapDetails(message.details);
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

/**
 * Every row is keyed by the store it came from as well as the model: the two harnesses record different
 * things (omp a duration and ttft, pi neither), and folding them together would average a fact with a
 * silence.
 */
const turnKey = (turn) => `${turn.harness ?? "?"}/${turn.api === FUSION_API ? `fusion:${turn.model}` : `${turn.provider ?? "?"}/${turn.model ?? "?"}`}`;

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
    proxy: new Map(),
    deliberation: new Map(),
    tools: new Map(),
    toolCalls: new Map(),
    gaps: { noDuration: 0, unpriced: 0, sessionsWithoutHeader: 0, unreadable: [], wrappedCalls: 0, toolAttribution: "most recent assistant turn" },
    store: undefined,
  };

  const turn = (map, key, seed) => {
    if (!map.has(key)) map.set(key, { key, turns: 0, sums: emptySums(), timed: 0, missingDuration: 0, durations: [], errors: 0, toolCalls: 0, toolErrors: 0, ...seed });
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
    // Counted from the calls, not from the results: a device invocation whose result row never reached the
    // store (a truncated tail) is still an invocation, and counting results made the accounting disagree with
    // the tools table's own call count.
    for (const t of session.turns) for (const part of t.toolCallParts ?? []) if (part.device) report.gaps.wrappedCalls += 1;

    for (const t of session.turns) {
      const key = turnKey(t);
      const record = turn(report.turns, key, { fusion: t.api === FUSION_API });
      record.turns += 1;
      // `t.usage` is always an object: `extractSession` normalises a message the harness stored without one,
      // so a turn priced by nobody still reaches the counter instead of being reported as neither priced nor
      // unpriced (measured 2026-09-19 on a streamed fusion turn, which stores no `usage` at all).
      addUsage(record.sums, t.usage);
      if (!t.priced) report.gaps.unpriced += 1;
      if (t.durationMs !== undefined) { record.timed += 1; record.durations.push(t.durationMs); }
      else { record.missingDuration += 1; report.gaps.noDuration += 1; }
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
    const fusionSums = emptySums();
    let fusionTurns = 0;
    for (const t of session.turns) {
      if (t.api !== FUSION_API) continue;
      fusionTurns += 1;
      addUsage(fusionSums, t.usage);
    }
    for (const entry of session.records) {
      if (entry.carrier === "assistant") continue;
      addUsage(fusionSums, entry.details?.usage);
    }
    // A session can name more than one work item (a session that continues past one task is the normal case
    // the append-only design anticipates). Its runs and its cost are attributed **once**, to the work item it
    // ended on; the other items keep their own labels and say where their runs were counted, so a session is
    // never counted twice and no item's label is absorbed into another's row.
    const items = [...new Set(session.labels.map((entry) => entry.workItem))];
    const attributesto = session.labels.at(-1)?.workItem;
    for (const item of items) {
      if (!report.labels.has(item)) {
        report.labels.set(item, { workItem: item, outcomes: [], fusions: new Map(), sums: emptySums(), sessions: 0, runs: 0, fusionTurns: 0, alsoLabelled: [], attributedTo: undefined });
      }
      const row = report.labels.get(item);
      row.sessions += 1;
      for (const entry of session.labels) if (entry.workItem === item) row.outcomes.push({ ...entry });
      if (item === attributesto) {
        // This item *is* the endpoint here, so a note from an earlier session's redirection is stale: leaving
        // it would print "runs counted under #15" on a row that counts its own runs.
        row.attributedTo = undefined;
        row.runs += session.records.length;
        row.fusionTurns += fusionTurns;
        mergeSums(row.sums, fusionSums);
        for (const record of session.records) row.fusions.set(record.fusion, (row.fusions.get(record.fusion) ?? 0) + 1);
        for (const other of items) if (other !== item) row.alsoLabelled.push(other);
      } else {
        row.attributedTo = attributesto;
      }
    }
    if (!attributesto && session.records.length > 0) {
      // A run nobody labelled is counted as unlabelled, never assumed to have gone well.
      report.unlabelled.sessions += 1;
      report.unlabelled.runs += session.records.length;
      report.unlabelled.fusionTurns += fusionTurns;
      mergeSums(report.unlabelled.sums, fusionSums);
    }

    for (const entry of session.records) {
      if (entry.kind === "proxy") {
        report.records.proxy += 1;
        const proxied = entry.details;
        const key = entry.fusion ?? proxied.model ?? "?";
        const record = turn(report.proxy, `${session.harness}/${key}`, { aliases: new Map(), levels: new Map(), attempts: new Map(),
          dropped: 0, failures: 0, sums: emptySums(), attemptsSpent: emptySums() });
        record.turns += 1;
        if (typeof proxied.alias === "string") record.aliases.set(proxied.alias, (record.aliases.get(proxied.alias) ?? 0) + 1);
        // `thinking: null` is a turn that ran at no level; an absent key is a record that did not say, and
        // reading the second as the first would overstate the drops.
        const recorded = Object.hasOwn(proxied, "thinking");
        const level = recorded ? (proxied.thinking ?? "none") : "unrecorded";
        record.levels.set(level, (record.levels.get(level) ?? 0) + 1);
        const attempts = Array.isArray(proxied.attempts) ? proxied.attempts : [];
        for (const attempt of attempts) {
          record.attempts.set(attempt?.reason ?? "?", (record.attempts.get(attempt?.reason ?? "?") ?? 0) + 1);
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
        carriers: new Map(), sums: emptySums(), decisionUsage: emptySums(), seats: 0, degradedSeats: 0, seatErrors: 0,
        cascades: 0, cascadesSufficient: 0, cascadesAdvanced: 0, cascadeSeats: new Map(), substitutions: 0, rounds: 0,
        verify: 0, route: 0, saved: 0, failedWrites: 0, failures: 0, routed: undefined,
        runMs: 0, runsTimed: 0, timedSeats: 0, slowestSeat: undefined,
        review: { runs: 0, malformed: 0, superseded: 0, verdicts: new Map(), severities: new Map(), by: new Map(), reasons: new Map(),
          findings: [], paths: 0, pathsMissing: 0, pathsOutside: 0, more: 0 },
      });
      record.runs = (record.runs ?? 0) + 1;
      record.carriers.set(entry.carrier, (record.carriers.get(entry.carrier) ?? 0) + 1);
      // A review rung's answer, as data. `path` is the reviewer's claim and not a fact — the cheap rung names
      // files it has only read as text — so each one is checked against the session's working directory: a
      // hallucinated location is worth *seeing* rather than trusting, and a path that does not exist is the
      // cheapest evidence that a finding was not read off the diff.
      const review = record.review;
      if (details.verdict || details.malformedAnswer) {
        review.runs += 1;
        if (typeof details.dispositionBy === "string") review.by.set(details.dispositionBy, (review.by.get(details.dispositionBy) ?? 0) + 1);
        if (typeof details.verdict === "string") review.verdicts.set(details.verdict, (review.verdicts.get(details.verdict) ?? 0) + 1);
        if (details.malformedAnswer) {
          review.malformed += 1;
          const reason = details.malformedAnswer.reason ?? "no reason recorded";
          review.reasons.set(reason, (review.reasons.get(reason) ?? 0) + 1);
          // Superseded is not the same as absent: the answer failed its contract and a later one answered, and a
          // reader that cannot tell those apart is reading a record that hides a failure.
          if (typeof details.malformedAnswer.supersededBy === "string") review.superseded += 1;
        }
        for (const finding of Array.isArray(details.findings) ? details.findings : []) {
          const severity = typeof finding?.severity === "string" ? finding.severity : "unknown";
          review.severities.set(severity, (review.severities.get(severity) ?? 0) + 1);
          const where = typeof finding?.path === "string" && finding.path ? finding.path : undefined;
          let found;
          if (where !== undefined) {
            review.paths += 1;
            // The claim has to be *inside* the session's tree to be checkable at all. Resolving an absolute path
            // would let a hallucinated `/etc/passwd` report as found simply because this machine has one — the
            // laundering this check exists to prevent — so an absolute path is marked unchecked, not verified.
            if (path.isAbsolute(where)) { review.pathsOutside += 1; }
            else {
              found = fs.existsSync(path.join(session.cwd ?? ".", where));
              if (!found) review.pathsMissing += 1;
            }
          }
          // Bounded: the report is a summary, and a run with hundreds of findings must not become the file.
          if (review.findings.length < 40) review.findings.push({ severity, where, line: finding?.line ?? null, found, claim: typeof finding?.claim === "string" ? finding.claim : undefined });
          else review.more += 1;
        }
      }
      addUsage(record.sums, details.usage);
      addUsage(record.decisionUsage, details.decisionUsage);
      const seats = Array.isArray(details.seats) ? details.seats : [];
      const seatErrors = Array.isArray(details.seatErrors) ? details.seatErrors : [];
      record.seats += seats.length;
      for (const seat of seats) {
        if (seat?.degraded) record.degradedSeats += 1;
        // Deliberately **not** added to `record.sums`: `details.usage` is already the sum of the seats
        // (verified against the store — a one-seat run's `details.usage.input` equals that seat's), so adding
        // each seat again doubled every deliberation's tokens and cost.
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
      if (Number.isFinite(details.durationMs)) { record.runMs = (record.runMs ?? 0) + details.durationMs; record.runsTimed = (record.runsTimed ?? 0) + 1; }
      for (const seat of seats) {
        if (!Number.isFinite(seat?.durationMs)) continue;
        record.timedSeats = (record.timedSeats ?? 0) + 1;
        if (!record.slowestSeat || seat.durationMs > record.slowestSeat.durationMs) record.slowestSeat = { persona: seat.persona, durationMs: seat.durationMs };
      }
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
// A real cost must never print as `$0.0000`: a message priced at a fraction of a cent is priced, and the
// formatter is part of the claim that money states its basis.
const money = (n) => (n === 0 ? "$0.0000" : n < 0.01 ? `$${n.toFixed(6)}` : `$${n.toFixed(2)}`);
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
    const tools = row.toolCalls > 0 ? ` · ${row.toolCalls} tool calls${row.toolErrors ? `, ${row.toolErrors} errored (${pct(row.toolErrors, row.toolCalls)})` : ""}` : "";
    lines.push(`  ${row.key.padEnd(40)} ${String(row.turns).padStart(4)} turns · ${num(row.sums.input).padStart(12)} in · ${num(row.sums.output).padStart(7)} out${reasoning} · ${money(row.sums.costReported).padStart(10)} reported${timing}${missing}${unpriced}${tools}`);
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
    const spent = row.attemptsSpent.unpricedMessages > 0
      ? `, ${num(row.attemptsSpent.input)} in / ${num(row.attemptsSpent.output)} out on failed routes (unpriced)`
      : row.attemptsSpent.input + row.attemptsSpent.output > 0 ? `, ${num(row.attemptsSpent.input)} in / ${num(row.attemptsSpent.output)} out on failed routes (${money(row.attemptsSpent.costReported)} reported)` : "";
    lines.push(`  ${row.key.padEnd(20)} ${String(row.turns).padStart(3)} turns · alias ${aliases} · level ${levels} · ${row.dropped} level drop(s) · attempts ${attempts}${spent}`);
  }
  lines.push("");
  lines.push(`deliberation records (details.fusion): ${report.records.deliberation}`);
  for (const row of [...report.deliberation.values()].sort((a, b) => (b.runs ?? 0) - (a.runs ?? 0))) {
    const carriers = [...row.carriers].map(([k, v]) => `${k}×${v}`).join(", ");
    lines.push(`  ${row.key.padEnd(20)} ${String(row.runs ?? 0).padStart(3)} runs (${carriers}) · ${row.seats} seats, ${row.degradedSeats} degraded, ${row.seatErrors} seat error(s)`);
    const slowest = row.slowestSeat ? ` · slowest seat ${row.slowestSeat.persona ?? "?"} ${ms(row.slowestSeat.durationMs)}` : "";
    lines.push(`  ${"".padEnd(20)} cascades ${row.cascades} (sufficient ${row.cascadesSufficient}, advanced ${row.cascadesAdvanced}) · substitutions ${row.substitutions} · decision tokens ${num(row.decisionUsage.totalTokens)} (${money(row.decisionUsage.costReported)} reported${row.decisionUsage.unpricedMessages ? `, ${row.decisionUsage.unpricedMessages} unpriced` : ""})`);
    // A fast run's clock can legitimately be 0 ms: keyed on the count of timed runs, not on truthiness, so a
    // recorded zero is distinguishable from an absent clock.
    if (row.runsTimed > 0) lines.push(`  ${"".padEnd(20)} run time ${ms(row.runMs)}${slowest} · ${row.timedSeats} seat(s) timed`);
    const unpriced = row.sums.unpricedMessages ? ` (${row.sums.unpricedMessages} unpriced)` : "";
    lines.push(`  ${"".padEnd(20)} turns ${money(row.sums.costReported)} reported${unpriced} · ${num(row.sums.input)} in / ${num(row.sums.output)} out · ${row.failures} failed · routes ${row.route} · verify ${row.verify} check(s) · saved ${row.saved}${row.failedWrites ? `, ${row.failedWrites} write failure(s)` : ""}`);
  }
  lines.push("");
  const reviewRows = [...report.deliberation.values()].filter((row) => (row.review?.runs ?? 0) > 0).sort((a, b) => (b.review.runs - a.review.runs));
  if (reviewRows.length > 0) {
    lines.push("review dispositions (details.verdict / details.malformedAnswer)");
    for (const row of reviewRows) {
      const { review } = row;
      const counts = (map) => [...map].map(([k, v]) => `${k} ${v}`).join(", ") || "—";
      lines.push(`  ${row.key.padEnd(20)} ${review.runs} run(s) with a disposition · verdict ${counts(review.verdicts)} · by ${counts(review.by)}`);
      // "not found" is as of *this* run of the report against this filesystem: a file the finding named and a
      // later commit deleted is not a hallucination, and the wording has to leave room for that.
      lines.push(`  ${"".padEnd(20)} severities ${counts(review.severities)} · ${review.paths} path(s): ${review.pathsMissing} not in the session cwd now, ${review.pathsOutside} absolute (not checkable)`);
      // A malformed answer is why no verdict is recorded — unless a later one answered, in which case saying so
      // is the difference between a record and a covered-up failure.
      if (review.malformed > 0) lines.push(`  ${"".padEnd(20)} malformed ${review.malformed} ×${review.superseded > 0 ? ` (${review.superseded} superseded by a later answer)` : ""}: ${[...review.reasons].map(([k, v]) => `${k} (${v})`).join(" | ")}`);
      for (const finding of review.findings) {
        const line = finding.line === null || finding.line === undefined ? "" : `:${finding.line}`;
        const mark = finding.found === false ? "[path not found] " : finding.found === undefined && finding.where ? "[path outside the session] " : finding.found === undefined ? "[no path] " : "";
        lines.push(`  ${"".padEnd(20)} ${mark}${finding.severity} ${finding.where ?? "?"}${line} — ${(finding.claim ?? "").split("\n")[0].slice(0, 120)}`);
      }
      if (review.more > 0) lines.push(`  ${"".padEnd(20)} … ${review.more} further finding(s) not listed`);
    }
    lines.push("");
  }
  lines.push("outcomes (what the runs were for, and how they ended)");
  const labels = [...report.labels.values()].sort((a, b) => String(b.outcomes.map((e) => e.at).sort().at(-1) ?? "").localeCompare(String(a.outcomes.map((e) => e.at).sort().at(-1) ?? "")));
  if (labels.length === 0 && report.unlabelled.runs === 0) lines.push("  (no fusion runs recorded in these sessions)");
  for (const row of labels) {
    // The current outcome is the latest by *time*, not by the order the store happened to be read in: pi is
    // read before omp, and a session is folded in before or after another according to its path.
    // `when`: a missing or unparseable timestamp sorts before any real one, and ties keep the later entry —
    // so a store whose labels carry no `at` still falls back to read order rather than picking the oldest.
    const when = (entry) => { const t = Date.parse(entry?.at ?? ""); return Number.isNaN(t) ? -Infinity : t; };
    const byTime = (entries) => entries.reduce((best, entry) => (best === undefined || when(entry) >= when(best) ? entry : best), undefined);
    const latest = byTime(row.outcomes);
    const evidence = byTime(row.outcomes.filter((entry) => entry.evidence))?.evidence;
    const fusions = [...row.fusions].map(([k, v]) => `${k}×${v}`).join(", ") || "—";
    // One session's labels are a history (latest wins); labels from several sessions for one work item are
    // separate sessions' views of the same work, and saying "latest wins" there would imply one history.
    const history = row.outcomes.length > 1 ? ` · ${row.outcomes.length} label(s)${row.sessions === 1 ? ", latest wins" : " from separate sessions"}` : "";
    const attribution = row.attributedTo
      ? ` · runs counted under ${row.attributedTo} (the session ended there)`
      : row.alsoLabelled.length ? ` · same session also labelled ${row.alsoLabelled.join(", ")}` : "";
    lines.push(`  ${row.workItem.padEnd(18)} ${String(latest?.outcome ?? "?").padEnd(9)} ${row.sessions} session(s) · ${row.runs} run(s) · ${money(row.sums.costReported)} reported${row.sums.unpricedMessages ? ` + ${row.sums.unpricedMessages} unpriced` : ""}${row.fusionTurns ? ` · ${row.fusionTurns} streamed turn(s)` : ""}${attribution}`);
    lines.push(`  ${"".padEnd(18)} via ${fusions}${evidence ? ` · evidence: ${evidence}` : ""}${history}`);
  }
  if (report.unlabelled.runs > 0) {
    lines.push(`  ${"(unlabelled)".padEnd(18)} ${"".padEnd(9)} ${report.unlabelled.sessions} session(s) · ${report.unlabelled.runs} run(s) · ${money(report.unlabelled.sums.costReported)} reported${report.unlabelled.sums.unpricedMessages ? ` + ${report.unlabelled.sums.unpricedMessages} unpriced` : ""}`);
    lines.push(`  ${"".padEnd(18)} no \`/matrix-label\` was recorded: these runs have a cost and no outcome, and are not counted as successes.`);
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
  if (unattributable.length > 10) lines.push(`    … ${unattributable.length - 10} more, all in the JSON output`);
  for (const unreadable of report.gaps.unreadable.slice(0, 10)) lines.push(`    ${unreadable.path}: ${unreadable.reason}`);
  if (report.gaps.unreadable.length > 10) lines.push(`    … ${report.gaps.unreadable.length - 10} more, all in the JSON output`);
  lines.push(`  tool calls are attributed by ${report.gaps.toolAttribution} — the format carries no caller`);
  if (report.gaps.wrappedCalls > 0) {
    lines.push(`  ${report.gaps.wrappedCalls} call(s) made through omp's \`xd://\` device, counted under the tool they invoked:`);
    lines.push("  omp records such a call as `write` with `path: xd://<tool>`, and wraps the result's record one level in.");
  }
  for (const unknown of report.unknownShapes.slice(0, 10)) {
    lines.push(`    ${unknown.file ?? "?"} (${unknown.harness ?? "?"}) ${unknown.carrier}: ${unknown.keys.join(", ")}${unknown.at ? ` at ${unknown.at}` : ""}`);
  }
  if (report.unknownShapes.length > 10) lines.push(`    … ${report.unknownShapes.length - 10} more unrecognised shape(s), all in the JSON output`);
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
    labels: plain(report.labels),
    unlabelled: report.unlabelled,
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
  const quick = report.turns.get("pi/fusion:quick");
  ok("turns are keyed by fusion id", quick?.turns === 2, `turns=${quick?.turns}`);
  ok("usage accumulates per key exactly", quick?.sums.input === 150 && quick?.sums.output === 15 && Math.abs(quick.sums.costReported - 0.003) < 1e-9 && quick.sums.unpricedMessages === 0, JSON.stringify(quick?.sums));
  ok("priced and unpriced turns are told apart", quick?.sums.unpricedMessages === 0 && report.turns.get("pi/opencode-go/glm-5.3")?.sums.unpricedMessages === 1 && report.gaps.unpriced === 1);
  ok("a missing duration is counted as missing, never as 0", quick?.timed === 1 && quick?.missingDuration === 1 && report.gaps.noDuration === 2, `timed=${quick?.timed} missing=${quick?.missingDuration} total=${report.gaps.noDuration}`);
  ok("tool results are attributed to the turn before them", quick?.toolErrors === 1 && quick?.toolCalls === 1 && report.tools.get("pi/read").errors === 1 && report.toolCalls.get("pi/read") === 1, JSON.stringify(Object.fromEntries(report.toolCalls)));
  const proxy = report.proxy.get("pi/quick");
  ok("a dropped level counts as a drop", proxy?.dropped === 1 && proxy?.levels.get("none") === 1, JSON.stringify([...proxy.levels]));
  ok("attempt reasons are counted", proxy?.attempts.get("thinking") === 1);
  const delib = report.deliberation.get("pi/opinions");
  ok("deliberation runs counted by carrier", delib?.runs === 4 && delib?.carriers.get("toolResult") === 1 && delib?.carriers.get("custom_message") === 3, JSON.stringify([...(delib?.carriers ?? [])]));
  ok("degraded seats and seat errors counted", delib?.seats === 3 && delib?.degradedSeats === 2 && delib?.seatErrors === 2, JSON.stringify({ seats: delib?.seats, degraded: delib?.degradedSeats, errors: delib?.seatErrors }));
  ok("cascades split sufficient from advanced", delib?.cascades === 3 && delib?.cascadesSufficient === 2 && delib?.cascadesAdvanced === 1, JSON.stringify({ total: delib?.cascades, sufficient: delib?.cascadesSufficient, advanced: delib?.cascadesAdvanced }));
  ok("cascades are attributed to their seat", delib?.cascadeSeats.get("stage") === 1 && delib?.cascadeSeats.get("panel") === 1, JSON.stringify([...(delib?.cascadeSeats ?? [])]));
  ok("a run's tokens are counted once, from its own usage (its seats are inside it)",
    delib?.sums.input === 80 + 7 + 3 && delib?.sums.output === 8 + 1 + 0,
    JSON.stringify(delib?.sums));
  ok("a seat's usage is not added a second time",
    delib?.seats === 3 && delib?.sums.input < 80 + 20 + 30 + 7 + 3,
    `input=${delib?.sums.input} seat usages=${JSON.stringify((delib && [20, 30]) || [])}`);
  ok("decision usage is kept apart from seat usage", delib?.decisionUsage.input === 5 && delib?.decisionUsage.output === 1);
  ok("route, verification checks and saved files are read", delib?.route === 1 && delib?.verify === 1 && delib?.saved === 1, JSON.stringify({ route: delib?.route, verify: delib?.verify, saved: delib?.saved }));
  ok("a failed deliberation is counted, thrown or degraded", delib?.failures === 2 && report.records.deliberation === 4, JSON.stringify({ failures: delib?.failures, records: report.records.deliberation }));

  const filtered = entries.filter((e) => e.type !== "custom_message");
  const only = aggregate([extractSession(filtered, { file: "fixture.jsonl" })]);
  ok("filters change the totals", only.records.deliberation === 1 && only.sessions === 1);

  // An absent `thinking` key is a record that did not say, not a turn that ran at no level.
  const legacy = extractSession([sessionMeta, { type: "message", message: { role: "assistant", api: FUSION_API, model: "quick",
    usage: usage(5, 1, 0.001), content: [], details: { proxied: { alias: "glm-flash", attempts: [{ reason: "transient" }] } } } }], { file: "legacy.jsonl", harness: "pi" });
  const legacyRow = aggregate([legacy]).proxy.get("pi/quick");
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

  const unpricedTurn = extractSession([sessionMeta, { type: "message", message: { role: "assistant", api: FUSION_API, model: "quick",
    usage: { input: 10, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 11, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    content: [], details: { proxied: { alias: "glm-flash", thinking: "low", attempts: [] } } } }], { file: "unpriced.jsonl", harness: "omp" });
  const unpricedRow = aggregate([unpricedTurn]).turns.get("omp/fusion:quick");
  ok("money states its basis: a price nobody reported is not a total", unpricedRow?.sums.costReported === 0 && unpricedRow?.sums.unpricedMessages === 1, JSON.stringify(unpricedRow?.sums));

  // F2: the streamed provider path records its run on the assistant message
  const streamed = extractSession([sessionMeta, { type: "message", message: { role: "assistant", api: FUSION_API, model: "quick",
    usage: usage(20, 2, 0.001), content: [], details: { fusion: "quick", mode: "single", seats: [{ persona: "technical", degraded: false, usage: usage(20, 2, 0.001) }],
    cascades: [], seatErrors: [], verification: [], usage: usage(20, 2, 0.001) } } }], { file: "streamed.jsonl", harness: "pi" });
  const streamedReport = aggregate([streamed]);
  ok("a streamed fusion turn is a deliberation record, not an unknown shape", streamedReport.records.deliberation === 1 && streamedReport.unknownShapes.length === 0 && streamedReport.deliberation.get("pi/quick")?.carriers.get("assistant") === 1, JSON.stringify({ records: streamedReport.records, unknown: streamedReport.unknownShapes.length }));

  // F3: the same fusion from two stores is two rows, never an average of a fact and a silence
  const twoStores = aggregate([
    extractSession([sessionMeta, { type: "message", message: { role: "assistant", api: FUSION_API, model: "quick", usage: usage(10, 1, 0.001), duration: 1000, content: [], details: { proxied: { alias: "g", thinking: "low", attempts: [] } } } }], { file: "a.jsonl", harness: "omp" }),
    extractSession([sessionMeta, { type: "message", message: { role: "assistant", api: FUSION_API, model: "quick", usage: usage(10, 1, 0.001), content: [], details: { proxied: { alias: "g", thinking: "low", attempts: [] } } } }], { file: "b.jsonl", harness: "pi" }),
  ]);
  const ompRow = twoStores.turns.get("omp/fusion:quick");
  const piRow = twoStores.turns.get("pi/fusion:quick");
  ok("each store keeps its own row", ompRow?.timed === 1 && ompRow?.missingDuration === 0 && piRow?.timed === 0 && piRow?.missingDuration === 1, JSON.stringify({ omp: [ompRow?.timed, ompRow?.missingDuration], pi: [piRow?.timed, piRow?.missingDuration] }));

  // F6/F8: a parse failure names its line, and an incomplete ledger is not a clean exit
  const { unparsed: n, failures: fs2 } = parseLines(`{"type":"sess\n{"ok":1}\nnot json\nalso not\n`);
  ok("a parse failure keeps its line and reason", n === 3 && fs2.length === 3 && fs2[0].line === 1 && typeof fs2[0].message === "string", JSON.stringify(fs2));
  const capped = parseLines(Array.from({ length: 9 }, () => "x").join("\n"), { maxFailures: 2 });
  ok("a parse failure list is capped, with the count kept", capped.unparsed === 9 && capped.failures.length === 2, JSON.stringify({ unparsed: capped.unparsed, named: capped.failures.length }));
  const incomplete = fs.mkdtempSync(path.join(os.tmpdir(), "session-report-incomplete-"));
  const incompleteSlug = path.join(incomplete, "--private-tmp-project-alpha--");
  fs.mkdirSync(incompleteSlug, { recursive: true });
  fs.writeFileSync(path.join(incompleteSlug, "one.jsonl"), lines([sessionMeta, ...goodEntries.slice(1)]));
  fs.writeFileSync(path.join(incompleteSlug, "two.jsonl"), `{"type":"sess\n${lines([sessionMeta, ...goodEntries.slice(1)])}\n`);
  const incompleteStore = readStore({ roots: [{ harness: "pi", root: incomplete }] });
  ok("an unparsed line is named with its file and line", incompleteStore.store.unparsed === 1 && incompleteStore.store.parseFailures.length === 1 && incompleteStore.store.parseFailures[0].path.endsWith("two.jsonl") && incompleteStore.store.parseFailures[0].line === 1, JSON.stringify(incompleteStore.store.parseFailures));
  const cleanDir = fs.mkdtempSync(path.join(os.tmpdir(), "session-report-clean-"));
  const cleanSlug = path.join(cleanDir, "--private-tmp-project-alpha--");
  fs.mkdirSync(cleanSlug, { recursive: true });
  fs.writeFileSync(path.join(cleanSlug, "one.jsonl"), lines([sessionMeta, ...goodEntries.slice(1)]));
  if (process.getuid?.() !== 0) {
    const dirty = spawnSync(process.execPath, [fileURLToPath(import.meta.url), "--dir", incomplete], { encoding: "utf8" });
    const clean = spawnSync(process.execPath, [fileURLToPath(import.meta.url), "--dir", cleanDir], { encoding: "utf8" });
    ok("an incomplete ledger exits non-zero, a complete one exits 0", dirty.status === 1 && clean.status === 0, `dirty=${dirty.status} clean=${clean.status}`);
    const lonely = spawnSync(process.execPath, [fileURLToPath(import.meta.url), "--dir", path.join(cleanDir, "absent")], { encoding: "utf8" });
    ok("a store that is not there names the path it wanted", lonely.status === 1 && /no sessions directory at/.test(lonely.stderr), `status=${lonely.status}`);
  }
  if (process.getuid?.() !== 0) {
    // F7: the one path that exits before `render` still has to say what it could not read
    const blindDir = fs.mkdtempSync(path.join(os.tmpdir(), "session-report-blind-"));
    const blindSlug = path.join(blindDir, "--private-tmp-project-alpha--");
    fs.mkdirSync(blindSlug, { recursive: true });
    fs.writeFileSync(path.join(blindSlug, "one.jsonl"), lines([sessionMeta, ...goodEntries.slice(1)]));
    fs.chmodSync(blindSlug, 0o000);
    const blind = spawnSync(process.execPath, [fileURLToPath(import.meta.url), "--dir", blindDir], { encoding: "utf8" });
    fs.chmodSync(blindSlug, 0o700);
    ok("a store with nothing readable names the path and the reason before exiting", blind.status === 1 && blind.stderr.includes(blindSlug) && /EACCES|permission denied/.test(blind.stderr), `status=${blind.status} stderr=${JSON.stringify(blind.stderr.split("\n")[0])}`);
    fs.rmSync(blindDir, { recursive: true, force: true });
  }
  fs.rmSync(incomplete, { recursive: true, force: true });
  fs.rmSync(cleanDir, { recursive: true, force: true });

  const noUsage = aggregate([extractSession([sessionMeta, { type: "message", message: { role: "assistant", api: FUSION_API, model: "quick",
    content: [], details: { proxied: { alias: "glm-flash", thinking: "low", attempts: [] } } } }], { file: "nousage.jsonl", harness: "pi" })]);
  ok("a message the harness priced not at all counts as unpriced", noUsage.turns.get("pi/fusion:quick")?.sums.unpricedMessages === 1 && noUsage.turns.get("pi/fusion:quick")?.sums.costReported === 0, JSON.stringify(noUsage.turns.get("pi/fusion:quick")?.sums));

  ok("a cost below a cent does not print as zero", money(0.0000203) === "$0.000020" && money(0) === "$0.0000" && money(0.42) === "$0.42", `${money(0.0000203)} ${money(0)} ${money(0.42)}`);

  // ---- outcomes: the label is the half a run cannot know about itself ---------------------------------
  const labelled = extractSession([sessionMeta,
    { type: "message", message: { role: "assistant", api: FUSION_API, model: "quick", usage: usage(30, 3, 0.002), content: [],
      details: { fusion: "quick", seats: [
        { persona: "technical", degraded: false, usage: usage(30, 3, 0.002), durationMs: 4200 },
        { persona: "skeptic", degraded: false, usage: usage(10, 1, 0.001), durationMs: 900 }],
        cascades: [], seatErrors: [], durationMs: 5300, usage: usage(40, 4, 0.003) } } },
    { type: "custom_message", customType: "matrix-label", content: "#12 — review", display: true, timestamp: "2026-09-19T08:10:00.000Z", details: { workItem: "#12", outcome: "review", evidence: "https://example.test/pull/1" } },
    { type: "custom_message", customType: "matrix-label", content: "#12 — landed", display: true, timestamp: "2026-09-19T09:30:00.000Z", details: { workItem: "#12", outcome: "landed" } },
    { type: "custom_message", customType: "matrix-label", content: "half a label", display: true, details: { workItem: "#12" } },
  ], { file: "labelled.jsonl", harness: "pi" });
  const labelledReport = aggregate([labelled]);
  const label = labelledReport.labels.get("#12");
  ok("a label is read with its evidence, and the latest one is the outcome",
    label?.outcomes.length === 2 && label.outcomes.at(-1).outcome === "landed" && label.outcomes[0].evidence === "https://example.test/pull/1",
    JSON.stringify(label?.outcomes));
  ok("a labelled work item carries its runs, its fusion turns and their cost",
    label?.runs === 1 && label?.fusionTurns === 1 && Math.abs((label?.sums.costReported ?? 0) - 0.002) < 1e-9 && label?.fusions.get("quick") === 1,
    JSON.stringify({ runs: label?.runs, turns: label?.fusionTurns, cost: label?.sums.costReported, fusions: label && Object.fromEntries(label.fusions) }));
  ok("a label missing half of itself is unrecognised, not counted as a label",
    labelled.labels.length === 2 && labelled.unknown.length === 1 && labelledReport.labels.size === 1,
    JSON.stringify({ labels: labelled.labels.length, unknown: labelled.unknown.length }));
  ok("a session with runs and no label is counted as unlabelled, never assumed fine",
    report.labels.size === 0 && report.unlabelled.runs >= 1 && report.unlabelled.sessions >= 1,
    JSON.stringify(report.unlabelled));
  // The other carrier: a `/matrix` run has no assistant message, so its cost lives only in the record — and
  // a streamed run's cost lives only on its message, or the same run is counted twice.
  const commandRun = extractSession([sessionMeta,
    { type: "custom_message", customType: "matrix-answer", content: "answer", display: true,
      details: { fusion: "quick", mode: "single", seats: [{ persona: "technical", degraded: false, usage: usage(30, 3, 0.002) }], cascades: [], seatErrors: [], durationMs: 1500, usage: usage(30, 3, 0.002) } },
    { type: "custom_message", customType: "matrix-label", content: "#12 — landed", display: true, timestamp: "2026-09-19T09:30:00.000Z", details: { workItem: "#12", outcome: "landed" } },
  ], { file: "command-run.jsonl", harness: "omp" });
  const commandReport = aggregate([commandRun]);
  ok("a `/matrix` run's cost is counted from its record, which is the only carrier it has",
    Math.abs((commandReport.labels.get("#12")?.sums.costReported ?? 0) - 0.002) < 1e-9 && commandReport.labels.get("#12")?.runs === 1,
    JSON.stringify({ cost: commandReport.labels.get("#12")?.sums, runs: commandReport.labels.get("#12")?.runs }));
  ok("a streamed run is not counted twice (its record repeats its message's usage)",
    Math.abs((label?.sums.costReported ?? 0) - 0.002) < 1e-9 && Math.abs((label?.sums.totalTokens ?? 0) - 33) < 1e-9,
    JSON.stringify(label?.sums));

  const slow = labelledReport.deliberation.get("pi/quick");
  ok("per-seat wall clock: the run clock and the slowest seat are read",
    slow?.runMs === 5300 && slow?.timedSeats === 2 && slow?.slowestSeat?.durationMs === 4200 && slow?.slowestSeat?.persona === "technical",
    JSON.stringify({ runMs: slow?.runMs, seats: slow?.timedSeats, slowest: slow?.slowestSeat }));
  const spentReport = aggregate([extractSession([sessionMeta,
    { type: "message", message: { role: "assistant", api: FUSION_API, model: "quick", usage: usage(5, 1, 0.001), content: [],
      details: { proxied: { alias: "glm-flash", thinking: "low", attempts: [
        { alias: "glm-flash", reason: "quota", detail: "no", usage: usage(100, 10, 0) },
        { alias: "glm-flash", reason: "transient", detail: "also no" }] } } } },
  ], { file: "spent.jsonl", harness: "pi" })]);
  const spent = spentReport.proxy.get("pi/quick");
  ok("what a failed route spent is counted, and an attempt with no usage adds nothing",
    spent?.attemptsSpent.input === 100 && spent?.attemptsSpent.output === 10 && spent?.attemptsSpent.unpricedMessages === 1 && spent?.attempts.get("transient") === 1,
    JSON.stringify(spent?.attemptsSpent));
  // the text surface comes through the same assembly the CLI uses, so a rendering claim is checked there
  // Two work items in one session: each keeps its own labels, and the session's runs are counted once.
  const twoItems = extractSession([sessionMeta,
    { type: "message", message: { role: "assistant", api: FUSION_API, model: "quick", usage: usage(10, 1, 0.001), content: [],
      details: { fusion: "quick", seats: [], cascades: [], seatErrors: [], usage: usage(10, 1, 0.001) } } },
    { type: "custom_message", customType: "matrix-label", content: "#12 — review", display: true, details: { workItem: "#12", outcome: "review", evidence: "https://example.test/12" } },
    { type: "custom_message", customType: "matrix-label", content: "#15 — landed", display: true, details: { workItem: "#15", outcome: "landed" } },
  ], { file: "two-items.jsonl", harness: "pi" });
  const twoItemReport = aggregate([twoItems]);
  ok("a session naming two work items keeps each item's own labels, and absorbs neither",
    twoItemReport.labels.get("#12")?.outcomes.length === 1 && twoItemReport.labels.get("#12")?.outcomes[0].workItem === "#12"
      && twoItemReport.labels.get("#15")?.outcomes.length === 1 && twoItemReport.labels.get("#15")?.outcomes[0].workItem === "#15",
    JSON.stringify([...twoItemReport.labels].map(([k, v]) => [k, v.outcomes.map((o) => o.workItem)])));
  ok("the session's runs and cost are counted once, under the item it ended on",
    twoItemReport.labels.get("#15")?.runs === 1 && Math.abs((twoItemReport.labels.get("#15")?.sums.costReported ?? 0) - 0.001) < 1e-9
      && twoItemReport.labels.get("#12")?.runs === 0 && twoItemReport.labels.get("#12")?.attributedTo === "#15"
      && Math.abs((twoItemReport.labels.get("#12")?.sums.costReported ?? 0)) < 1e-12,
    JSON.stringify({ twelve: twoItemReport.labels.get("#12")?.attributedTo, fifteen: twoItemReport.labels.get("#15")?.runs }));
  // A label with no timestamp at all still resolves, by read order, rather than picking the oldest by accident
  const undatedSession = extractSession([sessionMeta,
    { type: "custom_message", customType: "matrix-label", content: "#12 — review", display: true, details: { workItem: "#12", outcome: "review" } },
    { type: "custom_message", customType: "matrix-label", content: "#12 — landed", display: true, details: { workItem: "#12", outcome: "landed" } },
  ], { file: "undated.jsonl", harness: "pi" });
  const undatedLabels = aggregate([undatedSession]);
  const undatedLabelText = render(buildReport({ sessions: [undatedSession], roots: [], unreadable: [],
    store: { read: 1, unparsed: 0, withoutHeader: 0, excludedByCwd: 0, excludedBySince: 0, skippedRoots: [], unattributable: [], parseFailures: [], parseFailuresNamed: 0 } }));
  // A dated label beats an undated one, whatever the read order: an absent timestamp is not "newest".
  const mixedSession = extractSession([sessionMeta,
    { type: "custom_message", customType: "matrix-label", content: "#12 — review", display: true, timestamp: "2026-09-19T08:00:00.000Z", details: { workItem: "#12", outcome: "review" } },
    { type: "custom_message", customType: "matrix-label", content: "#12 — landed", display: true, details: { workItem: "#12", outcome: "landed" } },
  ], { file: "mixed.jsonl", harness: "pi" });
  const mixedText = render(buildReport({ sessions: [mixedSession], roots: [], unreadable: [],
    store: { read: 1, unparsed: 0, withoutHeader: 0, excludedByCwd: 0, excludedBySince: 0, skippedRoots: [], unattributable: [], parseFailures: [], parseFailuresNamed: 0 } }));
  ok("a dated label is the current outcome over an undated one, whatever the read order",
    /#12\s+review/.test(mixedText), mixedText.split("\n").find((l) => l.includes("#12")) ?? "no line");

  ok("labels with no timestamp fall back to read order, latest still winning",
    undatedLabels.labels.get("#12")?.outcomes.length === 2 && /#12\s+landed/.test(undatedLabelText),
    undatedLabelText.split("\n").find((l) => l.includes("#12")) ?? "no line");

  // The sequence: one session redirects #12 to #15, a later one ends on #12 — the stale note must go.
  const redirectThenEnd = aggregate([twoItems, extractSession([sessionMeta,
    { type: "message", message: { role: "assistant", api: FUSION_API, model: "quick", usage: usage(20, 2, 0.001), content: [],
      details: { fusion: "quick", seats: [], cascades: [], seatErrors: [], usage: usage(20, 2, 0.001) } } },
    { type: "custom_message", customType: "matrix-label", content: "#12 — landed", display: true, timestamp: "2026-09-19T10:00:00.000Z", details: { workItem: "#12", outcome: "landed" } },
  ], { file: "ends-on-12.jsonl", harness: "omp" })]);
  const redirectText = render(buildReport({ sessions: [twoItems, extractSession([sessionMeta,
    { type: "message", message: { role: "assistant", api: FUSION_API, model: "quick", usage: usage(20, 2, 0.001), content: [],
      details: { fusion: "quick", seats: [], cascades: [], seatErrors: [], usage: usage(20, 2, 0.001) } } },
    { type: "custom_message", customType: "matrix-label", content: "#12 — landed", display: true, timestamp: "2026-09-19T10:00:00.000Z", details: { workItem: "#12", outcome: "landed" } },
  ], { file: "ends-on-12.jsonl", harness: "omp" })], roots: [], unreadable: [],
    store: { read: 2, unparsed: 0, withoutHeader: 0, excludedByCwd: 0, excludedBySince: 0, skippedRoots: [], unattributable: [], parseFailures: [], parseFailuresNamed: 0 } }));
  ok("an item attributed in a later session loses the stale note from an earlier one",
    redirectThenEnd.labels.get("#12")?.runs === 1 && redirectThenEnd.labels.get("#12")?.attributedTo === undefined
      && !/runs counted under/.test(redirectText),
    redirectText.split("\n").filter((l) => l.includes("#12")).join(" | "));

  const twoItemText = render(buildReport({ sessions: [twoItems], roots: [], unreadable: [],
    store: { read: 1, unparsed: 0, withoutHeader: 0, excludedByCwd: 0, excludedBySince: 0, skippedRoots: [], unattributable: [], parseFailures: [], parseFailuresNamed: 0 } }));
  ok("the report says where an unattributed item's runs were counted",
    /runs counted under #15/.test(twoItemText) && /https:\/\/example\.test\/12/.test(twoItemText),
    twoItemText.split("\n").find((l) => l.includes("#12")) ?? "no line");

  // The current outcome is the latest by time, not the order the stores were read in.
  // Read order and time order disagree on purpose: the *first* session read carries the *newest* label, so a
  // reader that picks by position reports `landed` where the store says `review`.
  const laterLabelEarlierRead = extractSession([sessionMeta,
    { type: "custom_message", customType: "matrix-label", content: "#12 — review", display: true, timestamp: "2026-09-19T09:00:00.000Z", details: { workItem: "#12", outcome: "review" } },
  ], { file: "newer-later-read.jsonl", harness: "omp" });
  const olderLabelFirstRead = extractSession([sessionMeta,
    { type: "custom_message", customType: "matrix-label", content: "#12 — landed", display: true, timestamp: "2026-09-19T08:00:00.000Z", details: { workItem: "#12", outcome: "landed", evidence: "https://example.test/landed" } },
  ], { file: "older-first-read.jsonl", harness: "pi" });
  const stale = laterLabelEarlierRead;
  const fresh = olderLabelFirstRead;
  const timeReport = aggregate([stale, fresh]);
  const timeText = render(buildReport({ sessions: [stale, fresh], roots: [], unreadable: [],
    store: { read: 2, unparsed: 0, withoutHeader: 0, excludedByCwd: 0, excludedBySince: 0, skippedRoots: [], unattributable: [], parseFailures: [], parseFailuresNamed: 0 } }));
  ok("the printed outcome and evidence come from the newest label",
    (() => { const line = timeText.split("\n").find((l) => l.includes("#12")) ?? ""; const ev = timeText.split("\n").find((l) => l.includes("evidence:")) ?? ""; return /review/.test(line) && /landed/.test(ev); })(),
    timeText.split("\n").filter((l) => l.includes("#12") || l.includes("evidence:")).join(" | "));
  ok("a later-read session does not win over a newer label",
    new Date("2026-09-19T09:00:00.000Z") > new Date("2026-09-19T08:00:00.000Z") && timeReport.labels.get("#12")?.outcomes.length === 2,
    JSON.stringify(timeReport.labels.get("#12")?.outcomes.map((o) => [o.outcome, o.at])));

  const twoSessions = render(buildReport({ sessions: [labelled, commandRun], roots: [{ harness: "pi", root: "/tmp/fixture", files: 2, missing: false }], unreadable: [],
    store: { read: 2, unparsed: 0, withoutHeader: 0, excludedByCwd: 0, excludedBySince: 0, skippedRoots: [], unattributable: [], parseFailures: [], parseFailuresNamed: 0 } }));
  ok("labels from separate sessions say so rather than implying one history",
    /3 label\(s\) from separate sessions/.test(twoSessions) && !/latest wins/.test(twoSessions),
    twoSessions.split("\n").find((l) => l.includes("label(s)")) ?? "no line");

  const text = render(buildReport({ sessions: [labelled], roots: [{ harness: "pi", root: "/tmp/fixture", files: 1, missing: false }], unreadable: [],
    store: { read: 1, unparsed: 0, withoutHeader: 0, excludedByCwd: 0, excludedBySince: 0, skippedRoots: [], unattributable: [], parseFailures: [], parseFailuresNamed: 0 } }));
  ok("the text report prints the outcome, the evidence and the unlabelled count",
    /#12\s+landed/.test(text) && /https:\/\/example\.test\/pull\/1/.test(text) && /2 label\(s\), latest wins/.test(text),
    text.split("\n").find((l) => l.includes("#12")) ?? "no label line");

  // A store is editable by hand: an outcome nobody defined must not become the current one.
  const handWritten = extractSession([sessionMeta,
    { type: "custom_message", customType: "matrix-label", content: "#12 — shipped", display: true, timestamp: "2026-09-19T10:00:00.000Z", details: { workItem: "#12", outcome: "shipped" } },
  ], { file: "hand-written.jsonl", harness: "pi" });
  ok("a hand-written outcome outside the vocabulary is unrecognised, not a label",
    handWritten.labels.length === 0 && handWritten.unknown.length === 1 && aggregate([handWritten]).labels.size === 0,
    JSON.stringify({ labels: handWritten.labels.length, unknown: handWritten.unknown.length }));

  // A fast run can legitimately record 0 ms; that is not the same as no clock at all.
  const zeroClock = extractSession([sessionMeta,
    { type: "custom_message", customType: "matrix-answer", content: "answer", display: true, timestamp: "2026-09-19T10:00:00.000Z",
      details: { fusion: "quick", mode: "single", seats: [{ persona: "technical", degraded: false, usage: usage(1, 1, 0.0001), durationMs: 0 }], cascades: [], seatErrors: [], durationMs: 0, usage: usage(1, 1, 0.0001) } },
  ], { file: "zero-clock.jsonl", harness: "pi" });
  const zeroText = render(buildReport({ sessions: [zeroClock], roots: [], unreadable: [],
    store: { read: 1, unparsed: 0, withoutHeader: 0, excludedByCwd: 0, excludedBySince: 0, skippedRoots: [], unattributable: [], parseFailures: [], parseFailuresNamed: 0 } }));
  ok("a recorded 0 ms run still prints its clock",
    /run time 0\.0s/.test(zeroText) && /1 seat\(s\) timed/.test(zeroText),
    zeroText.split("\n").find((l) => l.includes("run time")) ?? "no run-time line");

  // ---- omp's device protocol: the record one level in, and the call recorded as `write` -----------------
  // Shapes taken from the live store: a write to `xd://<tool>` invokes it and its result wraps the record as
  // `details.xdev.inner`; a *read* of the same path is discovery and its result carries no wrap; and a device
  // call that *fails* is stored with empty details, so the invoked tool has to come from the call.
  const wrappedRecord = { fusion: "quick", mode: "single", seats: [{ persona: "technical", provider: "cline-pass", model: "z-ai/glm-5.3-flash", degraded: false, usage: usage(117, 6, 0.0000138), durationMs: 1710 }],
    cascades: [], seatErrors: [], usage: usage(117, 6, 0.0000138), durationMs: 1710 };
  const deviceSession = extractSession([sessionMeta,
    { type: "message", message: { role: "assistant", api: "openai-completions", provider: "cline-pass", model: "z-ai/glm-5.3-flash",
      usage: usage(50, 5, 0.001), content: [
        { type: "toolCall", id: "c0", name: "read", arguments: { path: "xd://matrix", i: "Reading matrix tool docs" } },
        { type: "toolCall", id: "c1", name: "write", arguments: { path: "xd://matrix", content: "{\"prompt\": \"x\", \"fusion\": \"quick\"}" } },
        { type: "toolCall", id: "c2", name: "write", arguments: { path: "xd://propose", content: "{}" } },
      ] } },
    { type: "message", message: { role: "toolResult", toolCallId: "c0", toolName: "read", isError: false, content: [],
      details: { contentType: "text/markdown", totalLines: 40, displayContent: "# matrix" } } },
    { type: "message", message: { role: "toolResult", toolCallId: "c1", toolName: "write", isError: false, content: [{ type: "text", text: "PANEL-OK" }],
      details: { xdev: { tool: "matrix", mode: "execute", tier: "exec", args: { prompt: "x", fusion: "quick" }, inner: wrappedRecord } } } },
    { type: "message", message: { role: "toolResult", toolCallId: "c2", toolName: "write", isError: true, content: [{ type: "text", text: "refused" }], details: {} } },
  ], { file: "device.jsonl", harness: "omp" });
  const deviceReport = aggregate([deviceSession]);
  const deviceRender = render(buildReport({ sessions: [deviceSession], roots: [], unreadable: [],
    store: { read: 1, unparsed: 0, withoutHeader: 0, excludedByCwd: 0, excludedBySince: 0, skippedRoots: [], unattributable: [], parseFailures: [], parseFailuresNamed: 0 } }));
  ok("a record omp wrapped in its device protocol is read, not dropped",
    deviceReport.records.deliberation === 1 && deviceReport.deliberation.get("omp/quick")?.runs === 1 && deviceReport.unknownShapes.length === 0,
    JSON.stringify({ records: deviceReport.records, unknown: deviceReport.unknownShapes.length }));
  ok("the unwrapped record keeps its fusion, seats, usage and clock",
    deviceReport.deliberation.get("omp/quick")?.seats === 1 && Math.abs((deviceReport.deliberation.get("omp/quick")?.sums.costReported ?? 0) - 0.0000138) < 1e-12
      && deviceReport.deliberation.get("omp/quick")?.slowestSeat?.durationMs === 1710,
    JSON.stringify({ seats: deviceReport.deliberation.get("omp/quick")?.seats, sums: deviceReport.deliberation.get("omp/quick")?.sums }));
  ok("an invocation is attributed to the tool it invoked, and reading its docs is not one",
    deviceSession.turns[0].toolCalls.join(",") === "read,matrix,propose" && deviceReport.toolCalls.get("omp/matrix") === 1
      && deviceReport.toolCalls.get("omp/propose") === 1 && (deviceReport.toolCalls.get("omp/write") ?? 0) === 0,
    JSON.stringify({ calls: deviceSession.turns[0].toolCalls, counted: Object.fromEntries(deviceReport.toolCalls) }));
  ok("a device result is named by the tool that ran, even when omp wrapped nothing",
    deviceSession.toolResults.map((r) => r.toolName).join(",") === "read,matrix,propose"
      && (deviceReport.tools.get("omp/propose")?.errors ?? 0) === 1 && (deviceReport.tools.get("omp/write")?.errors ?? 0) === 0,
    JSON.stringify({ rows: deviceSession.toolResults.map((r) => r.toolName), tools: Object.fromEntries([...deviceReport.tools].map(([k, v]) => [k, v.errors])) }));
  ok("the device count is a count of invocations, not of wrapped results",
    deviceReport.gaps.wrappedCalls === 2 && /2 call\(s\) made through omp's `xd:\/\/` device/.test(deviceRender),
    `${deviceReport.gaps.wrappedCalls}`);
  // pi has no device protocol: a file whose relative path happens to be `xd://matrix` is a write, nothing more.
  // The calling turn is not guaranteed to be the last one before its result, and a result row can be missing
  // entirely (a truncated tail): pairing must survive the first, and the count must survive the second.
  const nonAdjacent = extractSession([sessionMeta,
    { type: "message", message: { role: "assistant", api: "openai-completions", provider: "cline-pass", model: "z-ai/glm-5.3-flash",
      usage: usage(10, 2, 0.001), content: [{ type: "toolCall", id: "n1", name: "write", arguments: { path: "xd://propose", content: "{}" } }] } },
    { type: "message", message: { role: "assistant", api: "openai-completions", provider: "cline-pass", model: "z-ai/glm-5.3-flash",
      usage: usage(10, 2, 0.001), content: [] } },
    { type: "message", message: { role: "toolResult", toolCallId: "n1", toolName: "write", isError: true, content: [{ type: "text", text: "refused" }], details: {} } },
  ], { file: "non-adjacent.jsonl", harness: "omp" });
  const nonAdjacentReport = aggregate([nonAdjacent]);
  ok("a device result is paired with its call even when another turn intervenes",
    nonAdjacent.toolResults[0]?.toolName === "propose" && (nonAdjacentReport.tools.get("omp/propose")?.errors ?? 0) === 1
      && (nonAdjacentReport.tools.get("omp/write")?.errors ?? 0) === 0 && nonAdjacentReport.gaps.wrappedCalls === 1,
    JSON.stringify({ named: nonAdjacent.toolResults[0]?.toolName, tools: Object.fromEntries([...nonAdjacentReport.tools].map(([k, v]) => [k, v.errors])), device: nonAdjacentReport.gaps.wrappedCalls }));
  const noResult = extractSession([sessionMeta,
    { type: "message", message: { role: "assistant", api: "openai-completions", provider: "cline-pass", model: "z-ai/glm-5.3-flash",
      usage: usage(10, 2, 0.001), content: [{ type: "toolCall", id: "d1", name: "write", arguments: { path: "xd://matrix", content: "{}" } }] } },
  ], { file: "no-result.jsonl", harness: "omp" });
  const noResultReport = aggregate([noResult]);
  ok("an invocation whose result never reached the store is still counted as a device call",
    noResultReport.gaps.wrappedCalls === 1 && noResultReport.toolCalls.get("omp/matrix") === 1 && noResult.toolResults.length === 0,
    JSON.stringify({ device: noResultReport.gaps.wrappedCalls, calls: Object.fromEntries(noResultReport.toolCalls), results: noResult.toolResults.length }));

  // Reading one file explicitly must keep the harness it came from: the device rewrite is gated on omp, and a
  // file selected by path is the same session whether it was found through the root or handed over directly.
  const ompDir = fs.mkdtempSync(path.join(os.tmpdir(), "session-report-"));
  fs.mkdirSync(path.join(ompDir, ".omp", "agent", "sessions", "--slug--"), { recursive: true });
  const ompFile = path.join(ompDir, ".omp", "agent", "sessions", "--slug--", "one.jsonl");
  fs.writeFileSync(ompFile, lines([sessionMeta,
    { type: "message", message: { role: "assistant", api: "openai-completions", provider: "cline-pass", model: "z-ai/glm-5.3-flash",
      usage: usage(10, 2, 0.001), content: [{ type: "toolCall", id: "s1", name: "write", arguments: { path: "xd://matrix", content: "{}" } }] } },
  ]));
  const byPath = readStore({ sessionFile: ompFile });
  const byPathReport = aggregate(byPath.sessions);
  ok("a session read by path keeps the harness it lives in",
    byPath.sessions[0]?.harness === "omp" && byPathReport.toolCalls.get("omp/matrix") === 1
      && byPathReport.gaps.wrappedCalls === 1 && (byPathReport.toolCalls.get("omp/write") ?? 0) === 0,
    JSON.stringify({ harness: byPath.sessions[0]?.harness, calls: Object.fromEntries(byPathReport.toolCalls), device: byPathReport.gaps.wrappedCalls }));
  fs.rmSync(ompDir, { recursive: true, force: true });

  const piWrite = extractSession([sessionMeta,
    { type: "message", message: { role: "assistant", api: "anthropic-messages", provider: "opencode-go", model: "glm-5.3-flash",
      usage: usage(10, 2, 0.001), content: [{ type: "toolCall", id: "p1", name: "write", arguments: { path: "xd://matrix", content: "hi" } }] } },
    { type: "message", message: { role: "toolResult", toolCallId: "p1", toolName: "write", isError: false, content: [], details: { diff: "…", op: "create", path: "xd://matrix" } } },
  ], { file: "pi-write.jsonl", harness: "pi" });
  const piReport = aggregate([piWrite]);
  ok("only omp has a device protocol: a pi write to `xd://…` is a write",
    piWrite.turns[0].toolCalls.join(",") === "write" && piReport.toolCalls.get("pi/write") === 1
      && (piReport.toolCalls.get("pi/matrix") ?? 0) === 0 && piReport.gaps.wrappedCalls === 0,
    JSON.stringify({ calls: piWrite.turns[0].toolCalls, counted: Object.fromEntries(piReport.toolCalls), device: piReport.gaps.wrappedCalls }));

  // A review rung's disposition, as the report has to read it. The path check is the point: `extensions/…/run.js`
  // exists under the session's cwd, `src/disposition.ts` does not, and a report that printed both alike would be
  // laundering a hallucinated location into a fact.
  const reviewDir = fs.mkdtempSync(path.join(os.tmpdir(), "session-report-review-"));
  fs.mkdirSync(path.join(reviewDir, "extensions/pi-fusion-matrix"), { recursive: true });
  fs.writeFileSync(path.join(reviewDir, "extensions/pi-fusion-matrix/run.js"), "// a real file\n");
  const reviewSession = extractSession([{ ...sessionMeta, cwd: reviewDir },
    { type: "message", message: { role: "assistant", api: FUSION_API, provider: "fusion-matrix", model: "review-check",
      usage: usage(500, 100, 0.004), content: [{ type: "text", text: "{\"verdict\":\"findings\"}" }],
      details: { fusion: "review-check", seats: [], seatErrors: [], usage: usage(500, 100, 0.004),
        dispositionBy: "review-synth", verdict: "findings", severityCounts: { blocking: 1, editorial: 1 },
        findings: [
          { severity: "blocking", path: "extensions/pi-fusion-matrix/run.js", line: 42, criterion: "no silent degradation", claim: "the refusal is swallowed\nand then some" },
          { severity: "editorial", path: "src/disposition.ts", line: null, criterion: "docs match evidence", claim: "a count went stale" },
        ] } } },
    { type: "message", message: { role: "assistant", api: FUSION_API, provider: "fusion-matrix", model: "review-quick",
      usage: usage(400, 60, 0.003), content: [{ type: "text", text: "I could not read the diff." }],
      details: { fusion: "review-quick", seats: [], seatErrors: [], usage: usage(400, 60, 0.003),
        malformedAnswer: { persona: "review-synth", reason: "the answer was not a JSON object" } } } },
    // A malformed answer that a later one superseded, and a finding naming an absolute path — which is outside
    // the session's tree by construction and therefore cannot be verified at all, let alone "found".
    { type: "message", message: { role: "assistant", api: FUSION_API, provider: "fusion-matrix", model: "review-single",
      usage: usage(300, 40, 0.002), content: [{ type: "text", text: "{\"verdict\":\"clean\"}" }],
      details: { fusion: "review-single", seats: [], seatErrors: [], usage: usage(300, 40, 0.002),
        dispositionBy: "review-synth", verdict: "clean", severityCounts: {},
        malformedAnswer: { persona: "judge", reason: "the answer was not a JSON object", supersededBy: "review-synth" },
        findings: [{ severity: "minor", path: "/etc/passwd", line: null, criterion: "c", claim: "a path outside the tree" }] } } },
  ], { file: "review.jsonl", harness: "pi" });
  const reviewReport = buildReport({ sessions: [reviewSession], roots: [], unreadable: [] });
  const reviewRow = reviewReport.deliberation.get("pi/review-check");
  const reviewText = render(reviewReport);
  // Two runs, two rungs: a row is a fusion, so the disposition of `review-check` and the malformed answer of
  // `review-quick` are counted under their own rows rather than pooled into one.
  ok("a review disposition is counted: verdict, the persona that stands, severities and paths",
    reviewRow?.review.runs === 1 && reviewRow?.review.verdicts.get("findings") === 1 && reviewRow?.review.by.get("review-synth") === 1
      && reviewRow?.review.severities.get("blocking") === 1 && reviewRow?.review.severities.get("editorial") === 1
      && reviewRow?.review.paths === 2 && reviewRow?.review.pathsMissing === 1 && reviewRow?.review.pathsOutside === 0
      && reviewRow?.review.malformed === 0,
    JSON.stringify({ runs: reviewRow?.review.runs, paths: reviewRow?.review.paths, missing: reviewRow?.review.pathsMissing, malformed: reviewRow?.review.malformed }));
  ok("a finding whose path is not in the session cwd is marked, and a real one is not",
    /\[path not found\] editorial src\/disposition\.ts/.test(reviewText) && !/\[path not found\] blocking extensions\/pi-fusion-matrix\/run\.js/.test(reviewText)
      && /blocking extensions\/pi-fusion-matrix\/run\.js:42/.test(reviewText),
    reviewText.split("\n").filter((l) => l.includes("blocking") || l.includes("editorial")).slice(0, 3).join(" // "));
  ok("a malformed answer is reported by reason, with no verdict beside it",
    reviewReport.deliberation.get("pi/review-quick")?.review.malformed === 1 && /malformed 1 ×: the answer was not a JSON object/.test(reviewText)
      && reviewRow?.review.reasons.size === 0,
    reviewText.split("\n").find((l) => l.includes("malformed 1 ×")) ?? "no malformed line");
  // An absolute path is outside the session's tree by construction, so it is reported as *unchecked*: resolving
  // it would let a hallucinated `/etc/passwd` read as found on any machine that has one, which is the laundering
  // the check exists to prevent.
  ok("an absolute finding path is marked unchecked rather than resolved",
    /\[path outside the session\] minor \/etc\/passwd/.test(reviewText)
      && reviewReport.deliberation.get("pi/review-single")?.review.pathsOutside === 1
      && reviewReport.deliberation.get("pi/review-single")?.review.pathsMissing === 0,
    reviewText.split("\n").find((l) => l.includes("passwd")) ?? "no absolute-path line");
  ok("a superseded malformed answer is named as superseded, not hidden",
    /malformed 1 × \(1 superseded by a later answer\)/.test(reviewText)
      && reviewReport.deliberation.get("pi/review-single")?.review.superseded === 1
      && reviewReport.deliberation.get("pi/review-single")?.review.verdicts.get("clean") === 1,
    reviewText.split("\n").find((l) => l.includes("superseded")) ?? "no superseded line");
  fs.rmSync(reviewDir, { recursive: true, force: true });

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
  const store = { read: 0, unparsed: 0, withoutHeader: 0, excludedByCwd: 0, excludedBySince: 0, skippedRoots: [], unattributable: [], parseFailures: [], parseFailuresNamed: 0 };
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

export function buildReport(read, { sessionFile } = {}) {
  const report = aggregate(read.sessions);
  report.roots = sessionFile ? [{ harness: harnessOfPath(sessionFile), root: path.dirname(path.resolve(sessionFile)), files: 1, missing: false }] : read.roots;
  report.gaps.unreadable = read.unreadable;
  report.store = read.store;
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

  const read = readStore({ roots, harnessFilter, sessionFile, cwdFilter, sinceMs });
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
    for (const r of reportRoots) console.error(`session report: ${r.missing ? "no sessions directory at" : "no session files under"} ${r.root}`);
    for (const skipped of accounting.skippedRoots) console.error(`session report: store left out by --harness ${harnessFilter}: ${skipped.root}`);
    // A store that is present but unreadable is the case where the reason matters most, and this is the one
    // path that exits before `render` can print it.
    for (const entry of unreadablePaths) console.error(`session report: cannot read ${entry.path}: ${entry.reason}`);
    process.exit(1);
  }

  const report = buildReport(read, { sessionFile });

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
  // as a fact about the fusions. That covers a file that could not be read, a session a filter could not
  // attribute, and a line that did not parse — the last of which is excluded from every total below.
  process.exit(unreadablePaths.length === 0 && accounting.unattributable.length === 0 && accounting.unparsed === 0 ? 0 : 1);
}

main();