#!/usr/bin/env node
/**
 * metrics-store.mjs — the derived store over the run records (#14).
 *
 * The session JSONL stays authoritative; this database is derived and rebuildable. Nothing is written
 * that a re-read of the store cannot regenerate, so a parser bug is "delete metrics.db and ingest
 * again", never a data loss. The ingest reuses `scripts/session-report.mjs`'s reader — `findSessions`,
 * `parseLines`, `extractSession`, `pathClaim`, `isFinding` — because the record contract has one
 * reader, not two.
 *
 * Two deliberate deviations from #14's sketch, both stated rather than slipped in:
 * - **Incrementality is per file, not per byte.** #14 sketched a read offset per session file. An
 *   ingest that resumes mid-file cannot number unparsed lines honestly (line numbers are part of the
 *   malformed-line accounting), and a half-written trailing line resurfaces the moment it completes.
 *   So a file whose size and mtime are unchanged is skipped outright — the common case — and a changed
 *   file is re-read whole, its rows replaced in one transaction. `store_file` still records what was
 *   read; the pair the skip decision reads is `size`/`mtime`, which is what an offset would serve.
 * - **No `run_cost` table; costs are labelled at read time.** A cost is tokens × a rate card, and the
 *   rate card is itself in the store (`price`, with first/last seen dates, so a later card cannot
 *   silently reprice history without leaving a trace). Storing per-owner cost rows would duplicate a
 *   join; the readers return every cost with its basis and never a total that mixes them.
 * - **No `tz_offset_min` column.** #14's sketch asked for the session's offset "as it was", but these
 *   records carry UTC and nothing else, so the only value a reader could store is the *ingesting*
 *   machine's offset for that instant — a fact about where the ingest ran, under a name that claims to
 *   be a fact about the session. A rebuild on another machine would change it. Nothing consumes it, so
 *   it is absent rather than plausible.
 *
 * Cost bases, per #14: `reported` — the provider priced the usage (`usage.cost.total > 0`, stored on
 * the row itself, NULL when it priced nothing); `estimated` — the model's own non-zero rate from the
 * card; `list` — the first non-zero rate any provider carries for the same model id, i.e. what a
 * plan-subsidised token would have cost at list price. Without that last one an unmetered turn reads
 * as free next to a metered rung, which is the comparison #14 exists to make honest. A model with no
 * usable rate states `no rate`, never a zero.
 *
 * No prompt or message text is stored — no transcript text, no stage inputs, no round inputs, no gate
 * output. What is stored are the run record's own structured facts: routes, tokens, findings (path,
 * line, severity, criterion, claim — a finding is the product of the run, not a transcript line),
 * cascades, verify answers, refusals. Every absence — a file that would not read, a line that would
 * not parse, a session with no header, a record shape nobody recognises — lands as a row of its own,
 * never dropped and never wearable as a clean zero.
 *
 *   import { ingest, byModel, byFusion } from "./metrics-store.mjs";
 *   const accounting = await ingest({ dbPath, now: Date.now() });
 *
 * The CLI is `scripts/ingest-metrics.mjs`; this module is import-only, so every unit in it can be
 * exercised by a test without spawning anything.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { DEFAULT_ROOTS, FUSION_API, extractSession, findSessions, isFinding, parseLines, pathClaim } from "./session-report.mjs";

export { DEFAULT_ROOTS, FUSION_API };

/** The version this module writes; a store written by a newer reader is refused, not half-read. */
export const SCHEMA_VERSION = 1;

/** Where the derived store lives by default: beside the plan ledger it shares a taxonomy with. */
export const DEFAULT_DB = path.join(os.homedir(), ".omp", "agent", "matrix.db");
/** Where the rate card is read from by default: the harness's own model catalogue. */
export const DEFAULT_CATALOGUE = path.join(os.homedir(), ".omp", "agent", "models.db");

/* ------------------------------------------------------------------ schema */

const TABLES = {
  meta: `CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
  store_file: `CREATE TABLE store_file (
    path TEXT PRIMARY KEY,
    harness TEXT NOT NULL,
    size INTEGER NOT NULL,
    mtime_ms INTEGER NOT NULL,
    status TEXT NOT NULL,
    reason TEXT,
    entries INTEGER NOT NULL DEFAULT 0,
    unparsed INTEGER NOT NULL DEFAULT 0,
    ingested_at INTEGER NOT NULL
  )`,
  parse_failure: `CREATE TABLE parse_failure (
    id INTEGER PRIMARY KEY,
    path TEXT NOT NULL REFERENCES store_file(path) ON DELETE CASCADE,
    line INTEGER NOT NULL,
    message TEXT NOT NULL
  )`,
  session: `CREATE TABLE session (
    id INTEGER PRIMARY KEY,
    path TEXT NOT NULL UNIQUE REFERENCES store_file(path) ON DELETE CASCADE,
    sid TEXT,
    harness TEXT NOT NULL,
    cwd TEXT,
    project TEXT,
    started_at_ms INTEGER,
    version TEXT,
    entries INTEGER NOT NULL,
    problems_json TEXT
  )`,
  turn: `CREATE TABLE turn (
    id INTEGER PRIMARY KEY,
    session_id INTEGER NOT NULL REFERENCES session(id) ON DELETE CASCADE,
    seq INTEGER NOT NULL,
    at TEXT,
    api TEXT,
    provider TEXT,
    model TEXT,
    is_fusion INTEGER NOT NULL DEFAULT 0,
    fusion_id TEXT,
    details_kind TEXT,
    stop_reason TEXT,
    priced INTEGER NOT NULL DEFAULT 0,
    input INTEGER NOT NULL DEFAULT 0,
    output INTEGER NOT NULL DEFAULT 0,
    cache_read INTEGER NOT NULL DEFAULT 0,
    cache_write INTEGER NOT NULL DEFAULT 0,
    reasoning INTEGER NOT NULL DEFAULT 0,
    total INTEGER NOT NULL DEFAULT 0,
    cost_reported_usd REAL,
    duration_ms INTEGER,
    ttft_ms INTEGER,
    tool_calls INTEGER NOT NULL DEFAULT 0,
    device_tool_calls INTEGER NOT NULL DEFAULT 0,
    tool_errors INTEGER NOT NULL DEFAULT 0
  )`,
  run: `CREATE TABLE run (
    id INTEGER PRIMARY KEY,
    session_id INTEGER NOT NULL REFERENCES session(id) ON DELETE CASCADE,
    seq INTEGER NOT NULL,
    at TEXT,
    kind TEXT NOT NULL,
    carrier TEXT NOT NULL,
    fusion TEXT,
    mode TEXT,
    rounds INTEGER NOT NULL DEFAULT 0,
    duration_ms INTEGER,
    seats INTEGER NOT NULL DEFAULT 0,
    degraded_seats INTEGER NOT NULL DEFAULT 0,
    seat_errors INTEGER NOT NULL DEFAULT 0,
    substitutions INTEGER NOT NULL DEFAULT 0,
    cascades INTEGER NOT NULL DEFAULT 0,
    cascades_sufficient INTEGER NOT NULL DEFAULT 0,
    cascades_advanced INTEGER NOT NULL DEFAULT 0,
    verify_checks INTEGER NOT NULL DEFAULT 0,
    saved INTEGER NOT NULL DEFAULT 0,
    failed_writes INTEGER NOT NULL DEFAULT 0,
    failure INTEGER NOT NULL DEFAULT 0,
    work_item TEXT,
    verdict TEXT,
    disposition_by TEXT,
    error TEXT,
    severity_json TEXT,
    routing_json TEXT,
    details_json TEXT,
    input INTEGER NOT NULL DEFAULT 0,
    output INTEGER NOT NULL DEFAULT 0,
    cache_read INTEGER NOT NULL DEFAULT 0,
    cache_write INTEGER NOT NULL DEFAULT 0,
    reasoning INTEGER NOT NULL DEFAULT 0,
    total INTEGER NOT NULL DEFAULT 0,
    cost_reported_usd REAL,
    decision_input INTEGER NOT NULL DEFAULT 0,
    decision_output INTEGER NOT NULL DEFAULT 0,
    decision_total INTEGER NOT NULL DEFAULT 0,
    decision_cost_reported_usd REAL,
    alias TEXT,
    proxy_provider TEXT,
    proxy_model TEXT,
    thinking TEXT,
    thinking_recorded INTEGER,
    level_dropped INTEGER
  )`,
  seat: `CREATE TABLE seat (
    run_id INTEGER NOT NULL REFERENCES run(id) ON DELETE CASCADE,
    seq INTEGER NOT NULL,
    persona TEXT,
    alias TEXT,
    provider TEXT,
    model TEXT,
    template TEXT,
    thinking TEXT,
    calls INTEGER,
    degraded INTEGER NOT NULL DEFAULT 0,
    error TEXT,
    reason TEXT,
    malformed INTEGER NOT NULL DEFAULT 0,
    verdict TEXT,
    input INTEGER NOT NULL DEFAULT 0,
    output INTEGER NOT NULL DEFAULT 0,
    cache_read INTEGER NOT NULL DEFAULT 0,
    cache_write INTEGER NOT NULL DEFAULT 0,
    reasoning INTEGER NOT NULL DEFAULT 0,
    total INTEGER NOT NULL DEFAULT 0,
    cost_reported_usd REAL,
    duration_ms INTEGER,
    attempts INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (run_id, seq)
  )`,
  seat_finding: `CREATE TABLE seat_finding (
    id INTEGER PRIMARY KEY,
    run_id INTEGER NOT NULL REFERENCES run(id) ON DELETE CASCADE,
    seat_seq INTEGER NOT NULL,
    idx INTEGER NOT NULL,
    severity TEXT,
    path TEXT,
    line INTEGER,
    criterion TEXT,
    claim TEXT,
    location TEXT NOT NULL
  )`,
  run_finding: `CREATE TABLE run_finding (
    id INTEGER PRIMARY KEY,
    run_id INTEGER NOT NULL REFERENCES run(id) ON DELETE CASCADE,
    idx INTEGER NOT NULL,
    severity TEXT,
    path TEXT,
    line INTEGER,
    criterion TEXT,
    claim TEXT,
    location TEXT NOT NULL
  )`,
  malformed_answer: `CREATE TABLE malformed_answer (
    id INTEGER PRIMARY KEY,
    run_id INTEGER NOT NULL REFERENCES run(id) ON DELETE CASCADE,
    idx INTEGER NOT NULL,
    persona TEXT,
    reason TEXT,
    superseded_by TEXT
  )`,
  cascade: `CREATE TABLE cascade (
    id INTEGER PRIMARY KEY,
    run_id INTEGER NOT NULL REFERENCES run(id) ON DELETE CASCADE,
    idx INTEGER NOT NULL,
    seat TEXT,
    kind TEXT,
    sufficient INTEGER NOT NULL DEFAULT 0,
    advanced_to TEXT,
    choice TEXT,
    confidence REAL,
    answer_json TEXT
  )`,
  substitution: `CREATE TABLE substitution (
    id INTEGER PRIMARY KEY,
    run_id INTEGER NOT NULL REFERENCES run(id) ON DELETE CASCADE,
    idx INTEGER NOT NULL,
    seat TEXT,
    from_label TEXT,
    to_label TEXT,
    reason TEXT
  )`,
  attempt: `CREATE TABLE attempt (
    id INTEGER PRIMARY KEY,
    run_id INTEGER NOT NULL REFERENCES run(id) ON DELETE CASCADE,
    seat_seq INTEGER,
    idx INTEGER NOT NULL,
    alias TEXT,
    seat TEXT,
    provider TEXT,
    model TEXT,
    reason TEXT,
    detail TEXT,
    duration_ms INTEGER,
    had_usage INTEGER NOT NULL DEFAULT 0,
    input INTEGER NOT NULL DEFAULT 0,
    output INTEGER NOT NULL DEFAULT 0
  )`,
  verification: `CREATE TABLE verification (
    id INTEGER PRIMARY KEY,
    run_id INTEGER NOT NULL REFERENCES run(id) ON DELETE CASCADE,
    seq INTEGER NOT NULL,
    idx INTEGER NOT NULL,
    check_name TEXT,
    question TEXT,
    kind TEXT,
    value REAL,
    choice TEXT,
    confidence REAL,
    detail TEXT
  )`,
  tool_result: `CREATE TABLE tool_result (
    id INTEGER PRIMARY KEY,
    session_id INTEGER NOT NULL REFERENCES session(id) ON DELETE CASCADE,
    idx INTEGER NOT NULL DEFAULT 0,
    turn_seq INTEGER,
    tool TEXT NOT NULL,
    is_error INTEGER NOT NULL DEFAULT 0,
    device INTEGER NOT NULL DEFAULT 0,
    at TEXT
  )`,
  label: `CREATE TABLE label (
    id INTEGER PRIMARY KEY,
    session_id INTEGER NOT NULL REFERENCES session(id) ON DELETE CASCADE,
    work_item TEXT NOT NULL,
    outcome TEXT,
    evidence TEXT,
    at TEXT
  )`,
  unknown_record: `CREATE TABLE unknown_record (
    id INTEGER PRIMARY KEY,
    session_id INTEGER NOT NULL REFERENCES session(id) ON DELETE CASCADE,
    carrier TEXT,
    keys_json TEXT NOT NULL,
    at TEXT
  )`,
  price: `CREATE TABLE price (
    id INTEGER PRIMARY KEY,
    provider TEXT NOT NULL,
    model TEXT NOT NULL,
    input REAL NOT NULL,
    output REAL NOT NULL,
    cache_read REAL NOT NULL,
    cache_write REAL NOT NULL,
    source TEXT NOT NULL,
    first_seen_ms INTEGER NOT NULL,
    last_seen_ms INTEGER NOT NULL,
    UNIQUE (provider, model)
  )`,
};

/** Views are derived, not stored (#14): every one is queryable from the tables above. */
const VIEWS = {
  // A seat's finding survives when the run's own disposition carries a finding at the same location —
  // the join the report makes, now as data. Null-safe on `line`: null means "the finding names no line".
  v_seat_finding: `CREATE VIEW v_seat_finding AS
    SELECT f.*,
      EXISTS (
        SELECT 1 FROM run_finding g
        WHERE g.run_id = f.run_id AND g.path = f.path
          AND ((g.line IS NULL AND f.line IS NULL) OR g.line = f.line)
      ) AS kept
    FROM seat_finding f`,
  v_cascade_rate: `CREATE VIEW v_cascade_rate AS
    SELECT fusion, SUM(cascades_sufficient) AS sufficient, SUM(cascades_advanced) AS advanced
    FROM run WHERE kind = 'deliberation' GROUP BY fusion`,
  v_tool_errors: `CREATE VIEW v_tool_errors AS
    SELECT tool, COUNT(*) AS calls, SUM(is_error) AS errors FROM tool_result GROUP BY tool`,
  v_provider_hour: `CREATE VIEW v_provider_hour AS
    SELECT provider, substr(at, 1, 13) AS hour, COUNT(*) AS turns,
      SUM(CASE WHEN cost_reported_usd IS NULL THEN 0 ELSE cost_reported_usd END) AS cost_reported_usd,
      SUM(total) AS tokens, SUM(CASE WHEN stop_reason = 'error' THEN 1 ELSE 0 END) AS errors
    FROM turn WHERE provider IS NOT NULL GROUP BY provider, hour`,
  v_run_day: `CREATE VIEW v_run_day AS
    SELECT fusion, substr(at, 1, 10) AS day, COUNT(*) AS runs,
      SUM(CASE WHEN failure THEN 1 ELSE 0 END) AS failures, SUM(total) AS tokens,
      SUM(CASE WHEN cost_reported_usd IS NULL THEN 0 ELSE cost_reported_usd END) AS cost_reported_usd
    FROM run WHERE kind = 'deliberation' GROUP BY fusion, day`,
};

const DROP_ORDER = [
  ...Object.keys(VIEWS).map((name) => `VIEW ${name}`),
  ...Object.keys(TABLES)
    .reverse()
    .map((name) => `TABLE ${name}`),
];

/* ------------------------------------------------------------------ records */

/** One usage with the schema's column names: an absent field is a zero, and a stated cost is money — a zero or absent one is unpriced, never free. */
export function usageOf(usage) {
  const u = usage && typeof usage === "object" ? usage : {};
  const input = u.input ?? 0;
  const output = u.output ?? 0;
  const reported = u.cost?.total;
  return {
    input,
    output,
    cache_read: u.cacheRead ?? 0,
    cache_write: u.cacheWrite ?? 0,
    reasoning: u.reasoning ?? 0,
    total: u.totalTokens ?? input + output,
    reported: typeof reported === "number" && reported > 0 ? reported : null,
  };
}

const str = (value) => (typeof value === "string" && value ? value : null);
const int = (value) => (Number.isFinite(value) ? value : null);

/**
 * The route an attempt was made on. Older records name it in the `seat` label only —
 * `alias@provider`, written by the same `label()` that fills `provider` — because the proxy path
 * gained the separate `provider`/`model` keys after those sessions were written. A refusal belongs
 * to the route that was *refused*, so the label is read before any fallback to the record's provider
 * (which, for a turn that advanced, is the route that answered).
 */
const routeOf = (attempt, fallbackProvider) => {
  const label = str(attempt?.seat);
  const fromLabel = label && label.includes("@") ? label.slice(label.lastIndexOf("@") + 1) : null;
  return { provider: str(attempt?.provider) ?? fromLabel ?? str(fallbackProvider), model: str(attempt?.model) };
};

function locationOf(finding, cwd) {
  const { where, found, outside } = pathClaim(finding, cwd);
  if (where === undefined) return "uncheckable";
  if (outside) return "outside";
  return found ? "found" : "missing";
}

/**
 * The record's details as `details_json`: everything the record carried, minus what duplicates
 * transcript text. `stages[].inputs`, `rounds[].inputs` and `verification[].gate` are dropped — the
 * inputs are prompt assembly (the transcript has the originals), and a verify *gate* result carries
 * command output up to the gate's own byte bound. Everything else is the record's own data.
 */
export const sanitiseDetails = (details) => {
  if (!details || typeof details !== "object") return details ?? null;
  const out = { ...details };
  const stripInputs = (entry) => {
    if (!entry || typeof entry !== "object") return entry;
    const copy = { ...entry };
    delete copy.inputs;
    return copy;
  };
  if (Array.isArray(out.stages)) out.stages = out.stages.map(stripInputs);
  if (Array.isArray(out.rounds)) out.rounds = out.rounds.map(stripInputs);
  if (Array.isArray(out.verification)) {
    out.verification = out.verification.map((entry) => {
      if (!entry || typeof entry !== "object") return entry;
      const copy = { ...entry };
      delete copy.gate;
      return copy;
    });
  }
  return out;
};

const findingRows = (finding, extra) =>
  isFinding(finding)
    ? {
        severity: str(finding.severity),
        path: str(finding.path),
        line: Number.isInteger(finding.line) ? finding.line : null,
        criterion: str(finding.criterion),
        claim: str(finding.claim),
        location: locationOf(finding, extra.cwd),
        ...extra.keys,
      }
    : undefined;

/**
 * One extracted session into the rows the schema stores. Pure: the same session always yields the
 * same rows, so a test can hold it against a hand count and a rebuild can be proved identical to the
 * first ingest.
 */
export function rowsForSession(session) {
  const turns = session.turns.map((t, seq) => {
    const u = usageOf(t.usage);
    return {
      seq,
      at: str(t.at),
      api: str(t.api),
      provider: str(t.provider),
      model: str(t.model),
      is_fusion: t.api === FUSION_API ? 1 : 0,
      fusion_id: t.api === FUSION_API ? str(t.model) : null,
      details_kind: null,
      stop_reason: str(t.stopReason),
      priced: t.priced ? 1 : 0,
      input: u.input,
      output: u.output,
      cache_read: u.cache_read,
      cache_write: u.cache_write,
      reasoning: u.reasoning,
      total: u.total,
      cost_reported_usd: u.reported,
      duration_ms: int(t.durationMs),
      ttft_ms: int(t.ttftMs),
      tool_calls: Array.isArray(t.toolCalls) ? t.toolCalls.length : 0,
      device_tool_calls: (t.toolCallParts ?? []).filter((part) => part.device).length,
    };
  });

  // Which record rode which assistant message, for the turn's `details_kind`. Keyed by the moment,
  // which is what both sides record; a message with no timestamp stays `null` rather than guessing.
  const kindByAt = new Map();
  for (const record of session.records) {
    if (record.carrier === "assistant" && record.at !== undefined && !kindByAt.has(record.at)) {
      kindByAt.set(record.at, record.kind);
    }
  }
  for (const turn of turns) turn.details_kind = kindByAt.get(turn.at) ?? null;

  const turnSeqOf = new Map(session.turns.map((t, seq) => [t, seq]));
  const toolErrors = new Map();
  for (const result of session.toolResults) {
    if (result.isError && turnSeqOf.has(result.after)) {
      const seq = turnSeqOf.get(result.after);
      toolErrors.set(seq, (toolErrors.get(seq) ?? 0) + 1);
    }
  }
  for (const turn of turns) turn.tool_errors = toolErrors.get(turn.seq) ?? 0;

  const runs = [];
  const children = new Map();

  for (const [seq, record] of session.records.entries()) {
    if (record.kind === "proxy") {
      const p = record.details ?? {};
      const recorded = Object.hasOwn(p, "thinking");
      const attempts = Array.isArray(p.attempts) ? p.attempts : [];
      runs.push({
        seq,
        at: str(record.at),
        kind: "proxy",
        carrier: record.carrier ?? "?",
        fusion: str(record.fusion),
        alias: str(p.alias),
        proxy_provider: str(p.provider),
        proxy_model: str(p.model),
        thinking: recorded ? (p.thinking === null ? "none" : str(p.thinking)) : null,
        thinking_recorded: recorded ? 1 : 0,
        // A level dropped to answer at all: the turn asked for one, the route refused it, and the
        // answer came back at none — the fact the thinking report turns on.
        level_dropped: Number(Boolean(recorded && p.thinking === null && attempts.length > 0)),
      });
      children.set(seq, {
        attempts: attempts.map((a, idx) => {
          const au = usageOf(a?.usage);
          const route = routeOf(a, p.provider);
          return {
            seat_seq: null,
            idx,
            alias: str(a?.alias),
            seat: str(a?.seat),
            provider: route.provider,
            model: route.model,
            reason: str(a?.reason),
            detail: str(a?.detail)?.slice(0, 200) ?? null,
            duration_ms: int(a?.durationMs),
            had_usage: a?.usage === undefined ? 0 : 1,
            input: au.input,
            output: au.output,
          };
        }),
      });
      continue;
    }

    const d = record.details ?? {};
    const seats = Array.isArray(d.seats) ? d.seats : [];
    const seatErrors = Array.isArray(d.seatErrors) ? d.seatErrors : [];
    const cascades = Array.isArray(d.cascades) ? d.cascades : [];
    const verification = Array.isArray(d.verification) ? d.verification : [];
    const malformed = Array.isArray(d.malformedAnswers) ? d.malformedAnswers : [];
    const substitutions = Array.isArray(d.substitutions) ? d.substitutions : [];
    const u = usageOf(d.usage);
    const du = usageOf(d.decisionUsage);
    const survived = seats.filter((s) => !s?.degraded).length;
    const sufficient = cascades.filter((c) => c?.sufficient).length;
    const routing = d.routing && typeof d.routing === "object" ? d.routing : null;

    runs.push({
      seq,
      at: str(record.at),
      kind: "deliberation",
      carrier: record.carrier ?? "?",
      fusion: str(record.fusion) ?? str(d.fusion),
      mode: str(d.mode),
      // `rounds` is an array of a debate's rounds; the count is what the record means by it.
      rounds: Array.isArray(d.rounds) ? d.rounds.length : Number.isFinite(d.rounds) ? d.rounds : 0,
      duration_ms: int(d.durationMs),
      seats: seats.length,
      degraded_seats: seats.filter((s) => s?.degraded).length,
      seat_errors: seatErrors.length,
      substitutions: substitutions.length,
      cascades: cascades.length,
      cascades_sufficient: sufficient,
      cascades_advanced: cascades.length - sufficient,
      verify_checks: verification.length,
      saved: Array.isArray(d.saved) ? d.saved.length : 0,
      failed_writes: Array.isArray(d.failedWrites) ? d.failedWrites.length : 0,
      // The reader's own failure rule: an error, a run whose every seat degraded, or one that never
      // got a seat to fail — the three ways a run can say "this did not answer".
      failure: Number(Boolean(d.error) || (seats.length > 0 && survived === 0) || (seats.length === 0 && seatErrors.length > 0)),
      work_item: str(d.workItem),
      verdict: str(d.verdict),
      disposition_by: str(d.dispositionBy),
      error: str(d.error),
      severity_json: d.severityCounts ? JSON.stringify(d.severityCounts) : null,
      routing_json: routing ? JSON.stringify(routing) : null,
      details_json: JSON.stringify(sanitiseDetails(d)),
      input: u.input,
      output: u.output,
      cache_read: u.cache_read,
      cache_write: u.cache_write,
      reasoning: u.reasoning,
      total: u.total,
      cost_reported_usd: u.reported,
      decision_input: du.input,
      decision_output: du.output,
      decision_total: du.total,
      decision_cost_reported_usd: du.reported,
    });

    children.set(seq, {
      seats: seats.map((s, seatSeq) => {
        const su = usageOf(s?.usage);
        return {
          seq: seatSeq,
          persona: str(s?.persona),
          alias: str(s?.alias),
          provider: str(s?.provider),
          model: str(s?.model),
          template: str(s?.template),
          thinking: s?.thinking === null ? "none" : str(s?.thinking),
          calls: int(s?.calls),
          degraded: s?.degraded ? 1 : 0,
          error: str(s?.error),
          reason: str(s?.reason),
          malformed: s?.malformed ? 1 : 0,
          verdict: str(s?.verdict),
          input: su.input,
          output: su.output,
          cache_read: su.cache_read,
          cache_write: su.cache_write,
          reasoning: su.reasoning,
          total: su.total,
          cost_reported_usd: su.reported,
          duration_ms: int(s?.durationMs),
          attempts: Array.isArray(s?.attempts) ? s.attempts.length : 0,
        };
      }),
      attempts: seats.flatMap((s, seatSeq) =>
        (Array.isArray(s?.attempts) ? s.attempts : []).map((a, idx) => {
          const au = usageOf(a?.usage);
          const route = routeOf(a, s?.provider);
          return {
            seat_seq: seatSeq,
            idx,
            alias: str(a?.alias),
            seat: str(a?.seat),
            provider: route.provider,
            model: route.model,
            reason: str(a?.reason),
            detail: str(a?.detail)?.slice(0, 200) ?? null,
            duration_ms: int(a?.durationMs),
            had_usage: a?.usage === undefined ? 0 : 1,
            input: au.input,
            output: au.output,
          };
        }),
      ),
      seatFindings: seats.flatMap((s, seatSeq) =>
        (Array.isArray(s?.findings) ? s.findings : [])
          .map((f, idx) => findingRows(f, { cwd: session.cwd, keys: { seat_seq: seatSeq, idx } }))
          .filter(Boolean),
      ),
      runFindings: (Array.isArray(d.findings) ? d.findings : [])
        .map((f, idx) => findingRows(f, { cwd: session.cwd, keys: { idx } }))
        .filter(Boolean),
      malformedAnswers: malformed.map((m, idx) => ({
        idx,
        persona: str(m?.persona),
        reason: str(m?.reason),
        superseded_by: str(m?.supersededBy),
      })),
      cascades: cascades.map((c, idx) => ({
        idx,
        seat: str(c?.seat),
        kind: str(c?.kind),
        sufficient: c?.sufficient ? 1 : 0,
        advanced_to: str(c?.advancedTo),
        choice: str(c?.answer?.choice),
        confidence: int(c?.answer?.confidence),
        answer_json: c?.answer ? JSON.stringify(c.answer) : null,
      })),
      substitutions: substitutions.map((s, idx) => ({
        idx,
        seat: str(s?.seat),
        from_label: str(s?.from),
        to_label: str(s?.to),
        reason: str(s?.reason),
      })),
      verification: verification.flatMap((v, checkSeq) => {
        const checkName = str(v?.check) ?? "decision";
        const result = v?.result;
        const row = (idx, answer) => ({
          seq: checkSeq,
          idx,
          check_name: checkName.slice(0, 120),
          question: answer.question,
          kind: answer.kind,
          value: answer.value,
          choice: answer.choice,
          confidence: answer.confidence,
          detail: answer.detail,
        });
        if (!result || typeof result !== "object") {
          return [row(0, { question: null, kind: "unknown", value: null, choice: null, confidence: null, detail: null })];
        }
        if (typeof result.exit === "number") {
          return [
            row(0, {
              question: "exit",
              kind: "gate",
              value: result.exit,
              choice: null,
              confidence: null,
              detail: typeof result.expected === "number" ? `expected ${result.expected}` : null,
            }),
          ];
        }
        if (typeof result.skipped === "string") {
          return [
            row(0, { question: null, kind: "skipped", value: null, choice: null, confidence: null, detail: result.skipped.slice(0, 200) }),
          ];
        }
        return Object.entries(result).map(([question, a], idx) =>
          row(idx, {
            question,
            kind: str(a?.type) ?? "unknown",
            value: int(a?.noul),
            choice: str(a?.choice),
            confidence: int(a?.confidence),
            detail: null,
          }),
        );
      }),
    });
  }

  return {
    session: {
      sid: str(session.id),
      harness: session.harness ?? "?",
      cwd: str(session.cwd),
      project: str(session.cwd) ? path.basename(session.cwd) : null,
      started_at_ms: int(Date.parse(session.startedAt)),
      version: session.version === undefined || session.version === null ? null : String(session.version),
      entries: session.entries ?? 0,
      problems_json: session.problems?.length ? JSON.stringify(session.problems) : null,
    },
    turns,
    toolResults: session.toolResults.map((r, idx) => ({
      idx,
      turn_seq: turnSeqOf.get(r.after) ?? null,
      tool: r.toolName ?? "?",
      is_error: r.isError ? 1 : 0,
      device: r.device ? 1 : 0,
      at: str(r.at),
    })),
    labels: session.labels.map((l) => ({
      work_item: l.workItem,
      outcome: str(l.outcome),
      evidence: str(l.evidence),
      at: str(l.at),
    })),
    unknown: session.unknown.map((u) => ({
      carrier: u.carrier ?? "?",
      keys_json: JSON.stringify(u.keys ?? []),
      at: str(u.at),
    })),
    parseFailures: session.parseFailures ?? [],
    runs,
    children,
  };
}

/* ------------------------------------------------------------------ sqlite */

let cachedSqlite;
export async function loadSqlite() {
  if (cachedSqlite === undefined) {
    try {
      cachedSqlite = await import("node:sqlite");
    } catch {
      cachedSqlite = null;
    }
  }
  return cachedSqlite;
}

/**
 * Open the store, creating the schema when it is not there. A store written by a *newer* reader is
 * refused by version rather than read with columns this build does not know; `rebuild` replaces
 * whatever is there, which is how a parser bug is recovered from — the `rm` of the recovery rule,
 * without leaving the file.
 */
export function openStore(dbPath, { sqlite = cachedSqlite, rebuild = false } = {}) {
  if (!sqlite) throw new Error("openStore needs node:sqlite — call loadSqlite() first, or pass { sqlite }");
  const db = new sqlite.DatabaseSync(dbPath);
  let existing = null;
  try {
    existing = Number(db.prepare(`SELECT value FROM meta WHERE key = 'schema_version'`).get()?.value);
  } catch {
    /* no store yet, or no version row: both mean "create it" */
  }
  if (!rebuild && Number.isFinite(existing) && existing > SCHEMA_VERSION) {
    // Only a *read* is refused: `rebuild` drops every object and writes this build's schema, so it is
    // the recovery path for a store a newer reader left behind — the guard must not close the door the
    // docstring promises.
    db.close();
    throw new Error(`metrics store at ${dbPath} was written by schema ${existing}; this reader writes ${SCHEMA_VERSION}`);
  }
  db.exec("PRAGMA foreign_keys = ON");
  if (rebuild || !Number.isFinite(existing)) {
    db.exec("BEGIN");
    for (const drop of DROP_ORDER) db.exec(`DROP ${drop.split(" ")[0]} IF EXISTS ${drop.split(" ")[1]}`);
    db.exec("COMMIT");
    db.exec("PRAGMA foreign_keys = ON");
    for (const sql of Object.values(TABLES)) db.exec(sql);
    for (const sql of Object.values(VIEWS)) db.exec(sql);
    db.prepare(`INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', ?)`).run(String(SCHEMA_VERSION));
  }
  return db;
}

/* --------------------------------------------------------------- rate card */

/**
 * The rate card, read from the harness's own catalogue. `readOnly` — this is another program's
 * database, and the store records what it says. A missing file, a missing table, or a row that will
 * not parse is a *named* absence in the result, never an empty card dressed as one.
 */
export function readPriceCard(cataloguePath = DEFAULT_CATALOGUE, { sqlite = cachedSqlite } = {}) {
  if (!sqlite) return { available: false, reason: "this node has no node:sqlite", rows: [], skipped: [] };
  if (!fs.existsSync(cataloguePath)) {
    return { available: false, reason: `no model catalogue at ${cataloguePath}`, rows: [], skipped: [] };
  }
  let db;
  try {
    db = new sqlite.DatabaseSync(cataloguePath, { readOnly: true });
  } catch (error) {
    return {
      available: false,
      reason: `the model catalogue could not be opened read-only: ${error?.message ?? String(error)}`,
      rows: [],
      skipped: [],
    };
  }
  try {
    if (!db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'model_cache'`).get()) {
      return { available: false, reason: `the catalogue at ${cataloguePath} has no model_cache table`, rows: [], skipped: [] };
    }
    const rows = [];
    const skipped = [];
    for (const { provider_id, models } of db.prepare(`SELECT provider_id, models FROM model_cache`).all()) {
      let parsed;
      try {
        parsed = JSON.parse(models ?? "[]");
      } catch (error) {
        skipped.push({ provider: provider_id, model: "?", reason: `models column would not parse: ${error?.message ?? String(error)}` });
        continue;
      }
      for (const model of Array.isArray(parsed) ? parsed : []) {
        const cost = model?.cost;
        if (
          typeof model?.id !== "string" ||
          !cost ||
          typeof cost !== "object" ||
          [cost.input, cost.output, cost.cacheRead, cost.cacheWrite].some((rate) => typeof rate !== "number")
        ) {
          skipped.push({ provider: provider_id, model: str(model?.id) ?? "?", reason: "no priced cost block" });
          continue;
        }
        rows.push({
          provider: provider_id,
          model: model.id,
          input: cost.input,
          output: cost.output,
          cache_read: cost.cacheRead,
          cache_write: cost.cacheWrite,
        });
      }
    }
    return { available: true, source: "omp model_cache", rows, skipped };
  } finally {
    db.close();
  }
}

function applyPriceCard(db, card, now) {
  if (!card.available) {
    db.prepare(`INSERT OR REPLACE INTO meta (key, value) VALUES ('price_source', ?)`).run(`unavailable: ${card.reason}`);
    return;
  }
  const upsert = db.prepare(`
    INSERT INTO price (provider, model, input, output, cache_read, cache_write, source, first_seen_ms, last_seen_ms)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (provider, model) DO UPDATE SET
      input = excluded.input, output = excluded.output, cache_read = excluded.cache_read,
      cache_write = excluded.cache_write, source = excluded.source, last_seen_ms = excluded.last_seen_ms
  `);
  const seen = db.prepare(`SELECT first_seen_ms FROM price WHERE provider = ? AND model = ?`);
  db.exec("BEGIN");
  for (const row of card.rows) {
    const prior = seen.get(row.provider, row.model);
    upsert.run(
      row.provider,
      row.model,
      row.input,
      row.output,
      row.cache_read,
      row.cache_write,
      card.source,
      prior?.first_seen_ms ?? now,
      now,
    );
  }
  db.exec("COMMIT");
  db.prepare(`INSERT OR REPLACE INTO meta (key, value) VALUES ('price_source', ?)`).run(card.source);
}

/* ------------------------------------------------------------------ ingest */

/**
 * Everything on disk into the store. A file whose size and mtime are unchanged since the last ingest
 * is skipped; anything else is read whole and written in one transaction, so a half-applied file is
 * impossible and a file that fails is *named*. Files that have vanished are pruned, because the store
 * describes what is there now.
 */
export async function ingest({
  dbPath = DEFAULT_DB,
  roots = DEFAULT_ROOTS,
  catalogue = DEFAULT_CATALOGUE,
  rebuild = false,
  now = Date.now(),
  readFile = fs.readFileSync,
  readdir = fs.readdirSync,
  stat = fs.statSync,
  log = () => {},
} = {}) {
  const sqlite = await loadSqlite();
  if (!sqlite) return { ok: false, reason: "this node has no node:sqlite" };
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = openStore(dbPath, { rebuild, sqlite });

  const accounting = {
    filesRead: 0,
    filesSkipped: 0,
    filesUnreadable: 0,
    filesFailed: 0,
    filesPruned: 0,
    unparsed: 0,
    unreadablePaths: [],
    priceCard: undefined,
  };

  const card = readPriceCard(catalogue, { sqlite });
  applyPriceCard(db, card, now);
  accounting.priceCard = card.available
    ? { available: true, source: card.source, rows: card.rows.length, skipped: card.skipped.length }
    : { available: false, reason: card.reason };
  if (!card.available) log(`no rate card: ${card.reason}`);

  const priorFile = db.prepare(`SELECT size, mtime_ms, status FROM store_file WHERE path = ?`);
  const dropParse = db.prepare(`DELETE FROM parse_failure WHERE path = ?`);
  const dropSession = db.prepare(`DELETE FROM session WHERE path = ?`);
  const deleteFile = db.prepare(`DELETE FROM store_file WHERE path = ?`);
  const upsertFile = db.prepare(`
    INSERT INTO store_file (path, harness, size, mtime_ms, status, reason, entries, unparsed, ingested_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (path) DO UPDATE SET
      harness = excluded.harness, size = excluded.size, mtime_ms = excluded.mtime_ms,
      status = excluded.status, reason = excluded.reason, entries = excluded.entries,
      unparsed = excluded.unparsed, ingested_at = excluded.ingested_at
  `);

  /** Prepared statements memoised per (table, columns): the rows are consistent per kind. */
  const inserters = new Map();
  const insert = (table, row) => {
    const cols = Object.keys(row);
    const key = `${table}|${cols.join(",")}`;
    let stmt = inserters.get(key);
    if (!stmt) {
      stmt = db.prepare(`INSERT INTO ${table} (${cols.map((c) => `"${c}"`).join(",")}) VALUES (${cols.map(() => "?").join(",")})`);
      inserters.set(key, stmt);
    }
    return stmt.run(...Object.values(row).map((value) => (value === undefined ? null : value)));
  };

  const writeSession = (file, harness, st, parsed, rows) => {
    db.exec("BEGIN");
    try {
      dropParse.run(file);
      dropSession.run(file);
      upsertFile.run(file, harness, st.size, Math.round(st.mtimeMs), "ok", null, rows.session.entries, parsed.unparsed, now);
      const { lastInsertRowid } = insert("session", { path: file, ...rows.session });
      const sessionId = Number(lastInsertRowid);
      for (const turn of rows.turns) insert("turn", { session_id: sessionId, ...turn });
      for (const result of rows.toolResults) insert("tool_result", { session_id: sessionId, ...result });
      for (const label of rows.labels) insert("label", { session_id: sessionId, ...label });
      for (const unknown of rows.unknown) insert("unknown_record", { session_id: sessionId, ...unknown });
      for (const failure of rows.parseFailures) insert("parse_failure", { path: file, line: failure.line, message: failure.message });
      for (const run of rows.runs) {
        const { lastInsertRowid: runId } = insert("run", { session_id: sessionId, ...run });
        const kids = rows.children.get(run.seq) ?? {};
        for (const seat of kids.seats ?? []) insert("seat", { run_id: Number(runId), ...seat });
        for (const attempt of kids.attempts ?? []) insert("attempt", { run_id: Number(runId), ...attempt });
        for (const finding of kids.seatFindings ?? []) insert("seat_finding", { run_id: Number(runId), ...finding });
        for (const finding of kids.runFindings ?? []) insert("run_finding", { run_id: Number(runId), ...finding });
        for (const answer of kids.malformedAnswers ?? []) insert("malformed_answer", { run_id: Number(runId), ...answer });
        for (const cascade of kids.cascades ?? []) insert("cascade", { run_id: Number(runId), ...cascade });
        for (const substitution of kids.substitutions ?? []) insert("substitution", { run_id: Number(runId), ...substitution });
        for (const check of kids.verification ?? []) insert("verification", { run_id: Number(runId), ...check });
      }
      db.exec("COMMIT");
    } catch (error) {
      try {
        db.exec("ROLLBACK");
      } catch {
        /* the transaction never opened or already resolved; the file's own accounting still lands */
      }
      throw error;
    }
  };

  const seen = new Set();
  for (const { harness, root } of roots) {
    const found = findSessions(root, { readdir });
    if (found.missing) {
      accounting.unreadablePaths.push({ harness, path: root, reason: "no sessions directory" });
      continue;
    }
    for (const unreadable of found.unreadable) {
      // A directory (or path) the walk could not read is a file-level absence, so it lands as a row of
      // its own and not only as prose: otherwise the store is short of it, `totals` does not count it,
      // and a caller reading the exit status is told the accounting was complete when it was not.
      accounting.unreadablePaths.push({ harness, path: unreadable.path, reason: unreadable.reason });
      db.exec("BEGIN");
      dropParse.run(unreadable.path);
      dropSession.run(unreadable.path);
      upsertFile.run(unreadable.path, harness, 0, 0, "unreadable", unreadable.reason, 0, 0, now);
      db.exec("COMMIT");
      accounting.filesUnreadable += 1;
    }
    for (const file of found.files) {
      seen.add(file);
      let st;
      try {
        st = stat(file);
      } catch (error) {
        // The file's *old* rows go with the new status, in one transaction: a file recorded as
        // unreadable while its previous session, turns, runs and findings stayed in the tables is a
        // store whose incremental totals overstate the JSONL and disagree with a `--rebuild` over the
        // same tree — the exact divergence the derived-store rule exists to prevent.
        db.exec("BEGIN");
        dropParse.run(file);
        dropSession.run(file);
        upsertFile.run(file, harness, 0, 0, "unreadable", error?.message ?? String(error), 0, 0, now);
        db.exec("COMMIT");
        accounting.filesUnreadable += 1;
        continue;
      }
      const prior = priorFile.get(file);
      if (prior && prior.status === "ok" && prior.size === st.size && prior.mtime_ms === Math.round(st.mtimeMs)) {
        accounting.filesSkipped += 1;
        continue;
      }
      try {
        const text = readFile(file, "utf8");
        const parsed = parseLines(text);
        const session = extractSession(parsed.entries, {
          file,
          harness,
          unparsed: parsed.unparsed,
          parseFailures: parsed.failures,
        });
        writeSession(file, harness, st, parsed, rowsForSession(session));
        accounting.filesRead += 1;
        accounting.unparsed += parsed.unparsed;
      } catch (error) {
        // Same rule for a file that read but would not write: the rolled-back transaction left the
        // *previous* rows standing, so the status alone would be a lie about what the store holds.
        db.exec("BEGIN");
        dropParse.run(file);
        dropSession.run(file);
        upsertFile.run(file, harness, st.size, Math.round(st.mtimeMs), "failed", error?.message ?? String(error), 0, 0, now);
        db.exec("COMMIT");
        accounting.filesFailed += 1;
      }
    }
  }

  for (const { path: stored } of db.prepare(`SELECT path FROM store_file`).all()) {
    if (seen.has(stored)) continue;
    db.exec("BEGIN");
    dropParse.run(stored);
    dropSession.run(stored);
    deleteFile.run(stored);
    db.exec("COMMIT");
    accounting.filesPruned += 1;
  }

  db.prepare(`INSERT OR REPLACE INTO meta (key, value) VALUES ('last_ingest_at', ?)`).run(String(now));
  db.prepare(`INSERT OR REPLACE INTO meta (key, value) VALUES ('roots', ?)`).run(JSON.stringify(roots.map((r) => r.root)));

  accounting.totals = totals(db);
  db.close();
  return { ok: true, ...accounting };
}

/* ----------------------------------------------------------------- readers */

const usable = (row) => (row && [row.input, row.output, row.cache_read, row.cache_write].some((rate) => rate > 0) ? row : null);

const cardCost = (usage, rates) =>
  rates === null || rates === undefined
    ? null
    : (usage.input * rates.input +
        usage.output * rates.output +
        usage.cache_read * rates.cache_read +
        usage.cache_write * rates.cache_write) /
      1e6;

/**
 * What one usage's tokens cost, always with the basis it was priced on:
 * - `reported` — the provider stated a price; the number is the provider's own, and no card is applied;
 * - `estimated` — the provider priced nothing, and *its* card rates the model: a metered route's tokens;
 * - `list` — the provider priced nothing and has no usable rate, so one catalogue row stands in for the
 *   model: the row with the highest **sum across its four rates** (`input + output + cache_read +
 *   cache_write`), ties broken by provider name. A vendor's list price is one number and catalogue rows
 *   for it differ by reseller, so the dearest card is the best single stand-in — and because the ordering
 *   is a stated composite over all four columns, it is deterministic and does not drift with the order a
 *   catalogue happens to grow in. It is a heuristic, not a bound: a candidate row can still be cheaper on
 *   one dimension and dearer on another, so this is the closest available stand-in rather than a promise
 *   that no other row would have priced a given usage higher;
 * - `no rate` — nothing to price with, stated rather than counted as zero.
 */
export function pricedUsage(db, provider, model, usage) {
  if (usage.reported !== null) return { basis: "reported", amount: usage.reported, via: provider };
  if (!provider || !model) return { basis: "no rate", amount: null, via: null };
  const own = db.prepare(`SELECT * FROM price WHERE provider = ? AND model = ?`).get(provider, model);
  const rates = usable(own);
  if (rates) return { basis: "estimated", amount: cardCost(usage, rates), via: `${rates.provider}/${rates.model}` };
  const reference = db
    .prepare(
      `SELECT * FROM price WHERE model = ? AND (input > 0 OR output > 0 OR cache_read > 0 OR cache_write > 0)
       ORDER BY (input + output + cache_read + cache_write) DESC, provider LIMIT 1`,
    )
    .get(model);
  const fallback = usable(reference);
  if (fallback) return { basis: "list", amount: cardCost(usage, fallback), via: `${fallback.provider}/${fallback.model}` };
  return { basis: "no rate", amount: null, via: null };
}

const money = () => ({ reported: 0, estimated: 0, list: 0, noRate: 0, priced: 0 });

const addMoney = (bucket, priced) => {
  // `priced` counts the usages the reported total actually covers: a sum printed without its
  // denominator reads as a price for everything, and a plan's unpriced tokens are not free.
  if (priced.basis === "reported") {
    bucket.reported += priced.amount;
    bucket.priced += 1;
  } else if (priced.basis === "estimated") bucket.estimated += priced.amount;
  else if (priced.basis === "list") bucket.list += priced.amount;
  else bucket.noRate += 1;
  return bucket;
};

/** Seats by model, across every session the store has ingested — the view that accumulates. */
export function byModel(db) {
  const seats = db
    .prepare(
      `SELECT s.*, r.at AS run_at, sess.harness AS harness FROM seat s
       JOIN run r ON r.id = s.run_id
       JOIN session sess ON sess.id = r.session_id
       WHERE s.provider IS NOT NULL AND s.model IS NOT NULL`,
    )
    .all();
  const findings = db
    .prepare(
      `SELECT f.*, s.provider AS seat_provider, s.model AS seat_model FROM v_seat_finding f
       JOIN seat s ON s.run_id = f.run_id AND s.seq = f.seat_seq
       WHERE s.provider IS NOT NULL AND s.model IS NOT NULL`,
    )
    .all();
  const attempts = db
    .prepare(
      `SELECT s.provider AS seat_provider, s.model AS seat_model, a.reason AS reason, COUNT(*) AS n FROM attempt a
       JOIN seat s ON s.run_id = a.run_id AND s.seq = a.seat_seq
       GROUP BY 1, 2, 3`,
    )
    .all();

  const models = new Map();
  const row = (model) => {
    if (!models.has(model)) {
      models.set(model, {
        model,
        seats: 0,
        degraded: 0,
        harnesses: {},
        personas: {},
        findings: 0,
        kept: 0,
        located: 0,
        unlocated: 0,
        uncheckable: 0,
        input: 0,
        output: 0,
        total: 0,
        cost: money(),
        seatMs: 0,
        attempts: {},
        lastSeatAt: null,
      });
    }
    return models.get(model);
  };

  for (const s of seats) {
    const r = row(`${s.provider}/${s.model}`);
    r.seats += 1;
    r.degraded += s.degraded;
    r.harnesses[s.harness ?? "?"] = (r.harnesses[s.harness ?? "?"] ?? 0) + 1;
    r.personas[s.persona ?? "?"] = (r.personas[s.persona ?? "?"] ?? 0) + 1;
    r.input += s.input;
    r.output += s.output;
    r.total += s.total;
    r.seatMs += s.duration_ms ?? 0;
    addMoney(
      r.cost,
      pricedUsage(db, s.provider, s.model, {
        input: s.input,
        output: s.output,
        cache_read: s.cache_read,
        cache_write: s.cache_write,
        reported: s.cost_reported_usd,
      }),
    );
    if (s.run_at && (r.lastSeatAt === null || s.run_at > r.lastSeatAt)) r.lastSeatAt = s.run_at;
  }
  for (const f of findings) {
    const r = row(`${f.seat_provider}/${f.seat_model}`);
    r.findings += 1;
    if (f.kept) r.kept += 1;
    if (f.location === "found") r.located += 1;
    else if (f.location === "missing") r.unlocated += 1;
    else if (f.location === "outside") r.uncheckable += 1;
  }
  for (const a of attempts) {
    const r = row(`${a.seat_provider}/${a.seat_model}`);
    r.attempts[a.reason ?? "?"] = (r.attempts[a.reason ?? "?"] ?? 0) + 1;
  }
  return [...models.values()].sort((a, b) => b.total - a.total);
}

/** Runs by fusion: what each rung cost, how it ended, and what its reviewers produced. */
export function byFusion(db) {
  const runs = db.prepare(`SELECT * FROM run WHERE kind = 'deliberation'`).all();
  const findings = db.prepare(`SELECT * FROM run_finding`).all();
  const malformed = db.prepare(`SELECT run_id, COUNT(*) AS n FROM malformed_answer GROUP BY run_id`).all();
  const malformedByRun = new Map(malformed.map((m) => [m.run_id, m.n]));
  const seats = db
    .prepare(
      `SELECT s.provider AS provider, s.model AS model, r.id AS run_id, s.input AS input, s.output AS output,
        s.cache_read AS cache_read, s.cache_write AS cache_write, s.total AS total, s.cost_reported_usd AS cost_reported_usd
       FROM seat s JOIN run r ON r.id = s.run_id WHERE r.kind = 'deliberation'`,
    )
    .all();

  const fusions = new Map();
  const row = (fusion) => {
    if (!fusions.has(fusion)) {
      fusions.set(fusion, {
        fusion,
        runs: 0,
        failures: 0,
        seats: 0,
        degradedSeats: 0,
        seatErrors: 0,
        cascades: { total: 0, sufficient: 0, advanced: 0 },
        verifyChecks: 0,
        substitutions: 0,
        saved: 0,
        failedWrites: 0,
        marked: { total: 0, located: 0, unlocated: 0, uncheckable: 0 },
        malformed: 0,
        verdicts: {},
        dispositionBy: {},
        workItems: {},
        runMs: 0,
        timedRuns: 0,
        decisionTokens: 0,
        decisionCostReported: 0,
        cost: money(),
        lastRunAt: null,
      });
    }
    return fusions.get(fusion);
  };

  for (const run of runs) {
    const r = row(run.fusion ?? "(none)");
    r.runs += 1;
    r.failures += run.failure;
    r.seats += run.seats;
    r.degradedSeats += run.degraded_seats;
    r.seatErrors += run.seat_errors;
    r.cascades.total += run.cascades;
    r.cascades.sufficient += run.cascades_sufficient;
    r.cascades.advanced += run.cascades_advanced;
    r.verifyChecks += run.verify_checks;
    r.substitutions += run.substitutions;
    r.saved += run.saved;
    r.failedWrites += run.failed_writes;
    r.malformed += malformedByRun.get(run.id) ?? 0;
    r.decisionTokens += run.decision_total;
    r.decisionCostReported += run.decision_cost_reported_usd ?? 0;
    r.timedRuns += run.duration_ms === null ? 0 : 1;
    r.runMs += run.duration_ms ?? 0;
    if (run.verdict) r.verdicts[run.verdict] = (r.verdicts[run.verdict] ?? 0) + 1;
    if (run.disposition_by) r.dispositionBy[run.disposition_by] = (r.dispositionBy[run.disposition_by] ?? 0) + 1;
    if (run.work_item) r.workItems[run.work_item] = (r.workItems[run.work_item] ?? 0) + 1;
    if (run.at && (r.lastRunAt === null || run.at > r.lastRunAt)) r.lastRunAt = run.at;
  }
  for (const f of findings) {
    const run = runs.find((x) => x.id === f.run_id);
    if (!run) continue;
    const r = row(run.fusion ?? "(none)");
    r.marked.total += 1;
    if (f.location === "found") r.marked.located += 1;
    else if (f.location === "missing") r.marked.unlocated += 1;
    else if (f.location === "outside") r.marked.uncheckable += 1;
  }
  for (const seat of seats) {
    const run = runs.find((x) => x.id === seat.run_id);
    if (!run) continue;
    addMoney(
      row(run.fusion ?? "(none)").cost,
      pricedUsage(db, seat.provider, seat.model, {
        input: seat.input,
        output: seat.output,
        cache_read: seat.cache_read,
        cache_write: seat.cache_write,
        reported: seat.cost_reported_usd,
      }),
    );
  }
  return [...fusions.values()].sort((a, b) => b.runs - a.runs);
}

/** The verify answers, by fusion and question, with the model whose answer stood in the run. */
export function verifyByQuestion(db) {
  const scores = db
    .prepare(
      `SELECT r.fusion AS fusion,
        (SELECT s.provider || '/' || s.model FROM seat s WHERE s.run_id = r.id AND s.persona = r.disposition_by LIMIT 1) AS byModel,
        v.question AS question, COUNT(*) AS n, MIN(v.value) AS min, AVG(v.value) AS avg, MAX(v.value) AS max
       FROM verification v JOIN run r ON r.id = v.run_id
       WHERE v.kind = 'noul' AND v.question IS NOT NULL
       GROUP BY r.fusion, v.question, byModel`,
    )
    .all();
  const choices = db
    .prepare(
      `SELECT r.fusion AS fusion,
        (SELECT s.provider || '/' || s.model FROM seat s WHERE s.run_id = r.id AND s.persona = r.disposition_by LIMIT 1) AS byModel,
        v.question AS question, v.choice AS choice, COUNT(*) AS n
       FROM verification v JOIN run r ON r.id = v.run_id
       WHERE v.kind = 'choice' AND v.choice IS NOT NULL
       GROUP BY r.fusion, v.question, v.choice, byModel`,
    )
    .all();

  // A question is keyed by the model whose answer stood, because a score belongs to that model — and a
  // choice question gets its own row whether or not the same run also answered a `noul` question.
  const out = new Map();
  const entry = (fusion, question, byModel) => {
    const key = `${fusion}|${question}|${byModel ?? ""}`;
    if (!out.has(key)) {
      out.set(key, { fusion, question, byModel: byModel ?? null, n: 0, min: null, avg: null, max: null, choices: {} });
    }
    return out.get(key);
  };
  for (const row of scores) {
    Object.assign(entry(row.fusion, row.question, row.byModel), { n: row.n, min: row.min, avg: row.avg, max: row.max });
  }
  for (const row of choices) {
    const row_ = entry(row.fusion, row.question, row.byModel);
    row_.choices[row.choice] = row.n;
    row_.n += row.n;
  }
  return [...out.values()];
}

/** Route refusals, by the route that was refused: which provider said no, and why. */
export function refusalsByRoute(db) {
  return db
    .prepare(
      `SELECT provider, model, reason, COUNT(*) AS n, MAX(r.at) AS lastAt FROM attempt a
       JOIN run r ON r.id = a.run_id
       GROUP BY provider, model, reason ORDER BY n DESC`,
    )
    .all();
}

/** The proxy face, by alias: turns, the levels they ran at, and what they refused. */
export function byProxyAlias(db) {
  const turns = db
    .prepare(
      `SELECT COALESCE(alias, '?') AS alias, COALESCE(proxy_provider, '?') AS provider, COALESCE(proxy_model, '?') AS model,
        COUNT(*) AS turns, SUM(level_dropped) AS dropped, SUM(thinking_recorded) AS recorded
       FROM run WHERE kind = 'proxy' GROUP BY 1, 2, 3 ORDER BY turns DESC`,
    )
    .all();
  const levels = db
    .prepare(
      `SELECT COALESCE(alias, '?') AS alias, COALESCE(thinking, 'unrecorded') AS thinking, COUNT(*) AS n
       FROM run WHERE kind = 'proxy' GROUP BY 1, 2`,
    )
    .all();
  const refusals = db
    .prepare(
      `SELECT COALESCE(r.alias, '?') AS alias, COALESCE(a.reason, '?') AS reason, COUNT(*) AS n FROM attempt a
       JOIN run r ON r.id = a.run_id WHERE a.seat_seq IS NULL GROUP BY 1, 2`,
    )
    .all();

  // One alias can walk more than one route (`deepseek-flash` was refused on `alibaba-token-plan` and
  // answered on `cline-pass`), so an alias is a *sum* over its routes — overwriting per route reported
  // one route's turns as the alias's.
  const byAlias = new Map();
  const row = (alias) => {
    if (!byAlias.has(alias)) {
      byAlias.set(alias, { alias, turns: 0, dropped: 0, recorded: 0, routes: {}, levels: {}, refusals: {} });
    }
    return byAlias.get(alias);
  };
  for (const r of turns) {
    const entry = row(r.alias);
    entry.turns += r.turns;
    entry.dropped += r.dropped;
    entry.recorded += r.recorded;
    entry.routes[`${r.provider}/${r.model}`] = (entry.routes[`${r.provider}/${r.model}`] ?? 0) + r.turns;
  }
  for (const r of levels) row(r.alias).levels[r.thinking] = r.n;
  for (const r of refusals) row(r.alias).refusals[r.reason] = r.n;
  return [...byAlias.values()].sort((a, b) => b.turns - a.turns);
}

/**
 * One route's name, for both halves of the join: the alias when the seat was configured with one, the
 * provider/model when only that is known, and one sentinel when neither is — a consumer must not have to
 * learn two words for "this route cannot be named".
 */
const routeKey = (alias, provider, model) =>
  str(alias) ?? (str(provider) && str(model) ? `${provider}/${model}` : (str(provider) ?? "unknown"));

/**
 * What each fusion's seat actually ran, route by route: the answer a seat gave (alias, provider,
 * model), how often, and every route that refused it. This is the join the routes tab is made of —
 * config says what a seat *may* walk, this says what it *did*.
 *
 * The two halves describe the *same* population: a seat with no persona is excluded from both (it is
 * not a seat the per-persona view can report), and a refusal is keyed by the same route name the answer
 * is, model included — the SQL groups by provider *and* model, and collapsing that in JavaScript would
 * report one route refusing twice where two refused once each.
 */
export function byFusionSeat(db) {
  const answered = db
    .prepare(
      `SELECT r.fusion AS fusion, s.persona AS persona, s.alias AS alias, s.provider AS provider, s.model AS model,
        COUNT(*) AS seats, SUM(s.degraded) AS degraded, SUM(s.total) AS tokens,
        SUM(COALESCE(s.duration_ms, 0)) AS seatMs, SUM(COALESCE(s.cost_reported_usd, 0)) AS reportedUsd,
        SUM(CASE WHEN s.cost_reported_usd IS NULL THEN 1 ELSE 0 END) AS unpricedSeats
       FROM seat s JOIN run r ON r.id = s.run_id
       WHERE r.kind = 'deliberation' AND s.persona IS NOT NULL
       GROUP BY 1, 2, 3, 4, 5`,
    )
    .all();
  const refused = db
    .prepare(
      `SELECT r.fusion AS fusion, s.persona AS persona, a.alias AS alias, a.provider AS provider, a.model AS model, a.reason AS reason, COUNT(*) AS n
       FROM attempt a JOIN seat s ON s.run_id = a.run_id AND s.seq = a.seat_seq JOIN run r ON r.id = a.run_id
       WHERE r.kind = 'deliberation' AND s.persona IS NOT NULL GROUP BY 1, 2, 3, 4, 5, 6`,
    )
    .all();

  const seats = new Map();
  const row = (fusion, persona) => {
    const key = `${fusion}|${persona}`;
    if (!seats.has(key)) {
      seats.set(key, {
        fusion,
        persona,
        seats: 0,
        degraded: 0,
        tokens: 0,
        seatMs: 0,
        reportedUsd: 0,
        unpricedSeats: 0,
        // Prototype-safe maps: an alias or provider named `__proto__` must count, not read back
        // `Object.prototype` and write through to it.
        answered: Object.create(null),
        refusals: Object.create(null),
      });
    }
    return seats.get(key);
  };
  for (const a of answered) {
    const entry = row(a.fusion ?? "(none)", a.persona);
    entry.seats += a.seats;
    entry.degraded += a.degraded;
    entry.tokens += a.tokens;
    entry.seatMs += a.seatMs;
    entry.reportedUsd += a.reportedUsd;
    entry.unpricedSeats += a.unpricedSeats;
    const route = routeKey(a.alias, a.provider, a.model);
    entry.answered[route] = (entry.answered[route] ?? 0) + a.seats;
  }
  for (const r of refused) {
    const entry = row(r.fusion ?? "(none)", r.persona);
    // The attempt's *alias* counts here as it does for an answer: an aliased route is named by its
    // alias on both halves, or the same physical route lands under two keys — `glm` from the answer and
    // `zai/glm-5.3` from the refusal — which is the join this reader exists to make.
    const route = routeKey(r.alias, r.provider, r.model);
    entry.refusals[route] = entry.refusals[route] ?? Object.create(null);
    entry.refusals[route][r.reason ?? "?"] = (entry.refusals[route][r.reason ?? "?"] ?? 0) + r.n;
  }
  return [...seats.values()].sort(
    (a, b) => (a.fusion ?? "").localeCompare(b.fusion ?? "") || String(a.persona).localeCompare(String(b.persona)),
  );
}

/** What the store holds, as counts: the ingest's own accounting, and every reader's denominator. */
export function totals(db) {
  const count = (sql) => db.prepare(sql).get().n;
  return {
    files: count(`SELECT COUNT(*) n FROM store_file`),
    filesUnreadable: count(`SELECT COUNT(*) n FROM store_file WHERE status = 'unreadable'`),
    filesFailed: count(`SELECT COUNT(*) n FROM store_file WHERE status = 'failed'`),
    sessions: count(`SELECT COUNT(*) n FROM session`),
    sessionsWithoutHeader: count(`SELECT COUNT(*) n FROM session WHERE sid IS NULL`),
    turns: count(`SELECT COUNT(*) n FROM turn`),
    runs: count(`SELECT COUNT(*) n FROM run`),
    deliberationRuns: count(`SELECT COUNT(*) n FROM run WHERE kind = 'deliberation'`),
    proxyRuns: count(`SELECT COUNT(*) n FROM run WHERE kind = 'proxy'`),
    seats: count(`SELECT COUNT(*) n FROM seat`),
    seatFindings: count(`SELECT COUNT(*) n FROM seat_finding`),
    runFindings: count(`SELECT COUNT(*) n FROM run_finding`),
    malformedAnswers: count(`SELECT COUNT(*) n FROM malformed_answer`),
    cascades: count(`SELECT COUNT(*) n FROM cascade`),
    attempts: count(`SELECT COUNT(*) n FROM attempt`),
    verifyAnswers: count(`SELECT COUNT(*) n FROM verification`),
    toolResults: count(`SELECT COUNT(*) n FROM tool_result`),
    labels: count(`SELECT COUNT(*) n FROM label`),
    unknownRecords: count(`SELECT COUNT(*) n FROM unknown_record`),
    parseFailures: count(`SELECT COUNT(*) n FROM parse_failure`),
    prices: count(`SELECT COUNT(*) n FROM price`),
  };
}
