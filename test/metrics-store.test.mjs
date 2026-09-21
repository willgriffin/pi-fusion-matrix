/**
 * The metrics store: the derived index over the run records (#14).
 *
 * What these checks hold, and why each one earns its place:
 * - **the record contract has one reader.** The store's numbers are asserted against the *report's*
 *   own aggregate over the same fixture — seat counts, findings raised, kept, located — so the two
 *   readers cannot drift into telling different stories about the same sessions.
 * - **the store is derived and rebuildable.** Ingesting twice is idempotent; ingesting a grown file
 *   and then rebuilding from nothing produce the same totals. A store that only matched itself would
 *   prove neither.
 * - **nothing is dropped, nothing is free.** A line that will not parse lands with its file and line;
 *   a file that will not read is named; an unpriced usage is priced at its basis or says `no rate` —
 *   never a zero.
 * - **no transcript text.** The fixture carries a marker sentence through a user message, a stage
 *   input and a round input; the database file must not contain it, while a finding's claim (the
 *   product of a review, not a transcript) must.
 *
 *   node --test test/metrics-store.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { aggregate, extractSession, isoTime, parseLines } from "../scripts/session-report.mjs";
import {
  SCHEMA_VERSION,
  byFusion,
  byModel,
  byFusionSeat,
  byProxyAlias,
  ingest,
  loadSqlite,
  openStore,
  pricedUsage,
  readPriceCard,
  refusalsByRoute,
  rowsForSession,
  sanitiseDetails,
  totals,
  usageOf,
  verifyByQuestion,
} from "../scripts/metrics-store.mjs";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const sqlite = await loadSqlite();
const noSqlite = sqlite === null ? "this node has no node:sqlite" : false;

/** The marker that must never reach the database: a prompt sentence and a stage input carry it. */
const MARKER = "MARKER-not-a-transcript-line-4f2a";

const usage = (input, output, cost) => ({
  input,
  output,
  totalTokens: input + output,
  cache: {},
  cost: { total: cost ?? 0 },
});

const tempDir = (name) => fs.mkdtempSync(path.join(os.tmpdir(), `metrics-${name}-`));

/**
 * A store of two session files: one omp session with every record shape the contract has (a proxied
 * turn with a dropped level, a deliberation record with seats, findings, cascades, verify answers
 * and a malformed answer, a label, an unparseable line, an unknown-but-ours shape), and one pi
 * session with a plain unpriced turn.
 */
function writeFixtureStore() {
  const dir = tempDir("fixture");
  const ompDir = path.join(dir, "omp", "-tmp-project");
  const piDir = path.join(dir, "pi", "-tmp-other");
  fs.mkdirSync(ompDir, { recursive: true });
  fs.mkdirSync(piDir, { recursive: true });

  const ompEntries = [
    { type: "session", id: "omp-1", cwd: "/tmp/project", timestamp: "2026-09-20T10:00:00.000Z", version: 3 },
    // A user message carries the marker: the store must not keep message text.
    { type: "message", message: { role: "user", content: [{ type: "text", text: `${MARKER} please review` }] } },
    {
      type: "message",
      message: {
        role: "assistant",
        api: "fusion-matrix",
        provider: "fusion-matrix",
        model: "review-quick",
        timestamp: "2026-09-20T10:01:00.000Z",
        stopReason: "stop",
        usage: usage(100, 20, 0.004),
        duration: 900,
        ttft: 250,
        content: [{ type: "toolCall", id: "c1", name: "read", arguments: { path: "x" } }],
        details: {
          proxied: {
            alias: "muse",
            provider: "opencode-go",
            model: "muse-spark-1.3-contributor",
            template: "muse-spark-1.3-contributor",
            thinking: null,
            attempts: [
              {
                alias: "muse",
                seat: "muse@opencode-go",
                provider: "opencode-go",
                model: "muse-spark-1.3-contributor",
                reason: "thinking",
                detail: "level refused",
              },
            ],
          },
        },
      },
    },
    {
      type: "message",
      message: { role: "toolResult", toolName: "read", isError: true, content: [], timestamp: "2026-09-20T10:01:30.000Z" },
    },
    {
      type: "message",
      message: {
        role: "toolResult",
        toolName: "matrix",
        isError: false,
        content: [],
        timestamp: "2026-09-20T10:02:00.000Z",
        details: {
          fusion: "review-check",
          mode: "review-committee",
          rounds: [{ round: 1, seats: ["review-skeptic"], dropped: [], inputs: { "review-skeptic": `${MARKER} round input` } }],
          stages: [{ stage: "parallel", inputs: { "review-skeptic": `${MARKER} stage input` } }],
          workItem: "#14",
          seats: [
            {
              persona: "review-skeptic",
              alias: "glm",
              provider: "opencode-go",
              model: "glm-5.3",
              thinking: "low",
              calls: 2,
              degraded: false,
              usage: usage(50, 10, 0),
              durationMs: 400,
              attempts: [
                {
                  alias: "glm",
                  seat: "glm@opencode-go",
                  provider: "opencode-go",
                  model: "glm-5.3",
                  reason: "quota",
                  detail: "usage limit reached",
                },
                {
                  alias: "glm",
                  seat: "glm@zai",
                  provider: "zai",
                  model: "glm-5.3",
                  reason: "transient",
                  detail: "connection reset",
                  usage: usage(7, 1, 0),
                },
              ],
              findings: [
                { severity: "major", path: "scripts/kept.mjs", line: 12, criterion: "criterion one", claim: "a claim that survives" },
                {
                  severity: "minor",
                  path: "scripts/dropped.mjs",
                  line: null,
                  criterion: "criterion two",
                  claim: "a claim the synthesis dropped",
                },
                // Not a finding: the contract wants a criterion *and* a claim, and this has none.
                { severity: "minor", path: "scripts/no-claim.mjs", line: 3, criterion: "criterion three" },
              ],
            },
            {
              persona: "review-synth",
              alias: "kimi",
              provider: "opencode-go",
              model: "kimi-k3",
              thinking: "high",
              calls: 1,
              degraded: false,
              usage: usage(200, 40, 0.01),
              durationMs: 1200,
              verdict: "findings",
            },
          ],
          seatErrors: [],
          substitutions: [{ seat: "review-skeptic", from: "glm@opencode-go", to: "glm@zai", reason: "transient" }],
          cascades: [
            {
              seat: "review-skeptic",
              kind: "decision",
              sufficient: false,
              advancedTo: "next candidate",
              answer: { type: "choice", choice: "partial", confidence: 0.6 },
            },
            { seat: "review-synth", kind: "decision", sufficient: true, answer: { type: "choice", choice: "agrees", confidence: 0.9 } },
          ],
          routing: { answer: { type: "choice", choice: "standard", confidence: 0.62 }, threshold: 0.6, routedTo: "review-check" },
          verification: [
            {
              check: "how does the review read",
              result: {
                addresses_question: { type: "noul", noul: 0.44 },
                contradiction_handling: { type: "choice", choice: "ignores", confidence: 0.88 },
              },
            },
          ],
          dispositionBy: "review-synth",
          verdict: "findings",
          severityCounts: { major: 1 },
          findings: [
            { severity: "major", path: "scripts/kept.mjs", line: 12, criterion: "criterion one", claim: "the kept finding" },
            // A path that leaves the session's tree cannot be checked from here, and is never "found".
            { severity: "minor", path: "../../etc/passwd", line: null, criterion: "criterion four", claim: "a claim outside the tree" },
          ],
          malformedAnswers: [{ persona: "review-skeptic", reason: "the answer was not a JSON object", supersededBy: "review-synth" }],
          usage: usage(250, 50, 0.01),
          decisionUsage: usage(5, 2, 0),
          saved: [],
          failedWrites: [],
          durationMs: 3000,
        },
      },
    },
    {
      type: "custom_message",
      customType: "matrix-label",
      content: "label",
      details: { workItem: "#14", outcome: "landed" },
      timestamp: "2026-09-20T10:03:00.000Z",
    },
    // Ours, but a shape this build does not know: counted, never silently dropped.
    {
      type: "custom_message",
      customType: "matrix-answer",
      content: "",
      details: { seats: [], cascades: [] },
      timestamp: "2026-09-20T10:04:00.000Z",
    },
  ];
  const ompText = `${ompEntries.map((entry) => JSON.stringify(entry)).join("\n")}\n{ this line is not json\n`;
  fs.writeFileSync(path.join(ompDir, "omp-1.jsonl"), ompText);

  const piEntries = [
    { type: "session", id: "pi-1", cwd: "/tmp/other", timestamp: "2026-09-21T09:00:00.000Z", version: 2 },
    {
      type: "message",
      message: {
        role: "assistant",
        api: "anthropic-messages",
        provider: "opencode-go",
        model: "glm-5.3",
        timestamp: "2026-09-21T09:01:00.000Z",
        stopReason: "stop",
        usage: usage(10, 1, 0),
        content: [],
      },
    },
  ];
  fs.writeFileSync(path.join(piDir, "pi-1.jsonl"), `${piEntries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);

  return {
    dir,
    roots: [
      { harness: "omp", root: path.join(dir, "omp") },
      { harness: "pi", root: path.join(dir, "pi") },
    ],
    ompFile: path.join(ompDir, "omp-1.jsonl"),
    piFile: path.join(piDir, "pi-1.jsonl"),
  };
}

/** A catalogue shaped like the harness's own: priced models, a plan priced at zero, and one unpriced. */
function writeCatalogue() {
  const file = path.join(tempDir("catalogue"), "models.db");
  const db = new sqlite.DatabaseSync(file);
  db.exec("CREATE TABLE model_cache (provider_id TEXT, models TEXT, updated_at INTEGER)");
  const insert = db.prepare("INSERT INTO model_cache VALUES (?, ?, ?)");
  insert.run(
    "opencode-go",
    JSON.stringify([
      { id: "glm-5.3", cost: { input: 0.6, output: 2.2, cacheRead: 0.11, cacheWrite: 0 } },
      { id: "plan-model", cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } },
      { id: "muse-spark-1.3-contributor", cost: { input: 0.1, output: 0.2, cacheRead: 0.002, cacheWrite: 0 } },
    ]),
    1,
  );
  insert.run("zai", JSON.stringify([{ id: "glm-5.3", cost: { input: 0.6, output: 2.2, cacheRead: 0.11, cacheWrite: 0 } }]), 1);
  // A row this build cannot use: it must be *counted* as skipped, not silently absent.
  insert.run("broken", "not json at all", 1);
  db.close();
  return file;
}

const openFixture = async () => {
  const fixture = writeFixtureStore();
  const dbPath = path.join(tempDir("db"), "matrix.db");
  const catalogue = writeCatalogue();
  const result = await ingest({ dbPath, roots: fixture.roots, catalogue });
  return { ...fixture, dbPath, catalogue, result, db: openStore(dbPath) };
};

test("ingest: reads both roots, lands every shape, and says what it could not use", { skip: noSqlite }, async () => {
  const { result, db, dbPath } = await openFixture();
  assert.equal(result.ok, true);
  assert.equal(result.filesRead, 2);
  assert.equal(result.unparsed, 1);
  assert.deepEqual(result.unreadablePaths, []);
  assert.equal(result.priceCard.available, true);
  assert.equal(result.priceCard.rows, 4, "four priced rows; the unparseable catalogue row is not one of them");
  assert.equal(result.priceCard.skipped, 1, "the catalogue row that would not parse is counted, not dropped");

  const counts = totals(db);
  assert.equal(counts.files, 2);
  assert.equal(counts.sessions, 2);
  assert.equal(counts.turns, 2, "the proxied turn and the plain pi turn; a tool result is not a turn");
  assert.equal(counts.deliberationRuns, 1);
  assert.equal(counts.proxyRuns, 1);
  assert.equal(counts.seats, 2);
  assert.equal(counts.seatFindings, 2, "the finding with no path is not a finding");
  assert.equal(counts.runFindings, 2, "the kept finding and one whose path leaves the tree");
  assert.equal(counts.malformedAnswers, 1);
  assert.equal(counts.cascades, 2);
  assert.equal(counts.attempts, 3, "two on the seat, one on the proxy turn");
  assert.equal(counts.verifyAnswers, 2, "one noul and one choice, both kept");
  assert.equal(counts.toolResults, 2);
  assert.equal(counts.labels, 1);
  assert.equal(counts.unknownRecords, 1);
  assert.equal(counts.parseFailures, 1);
  assert.equal(counts.prices, 4);

  // The malformed line lands with its file, its line and its reason — the line number is the last
  // non-empty line of the file it was written on.
  const failure = db.prepare(`SELECT * FROM parse_failure`).get();
  const lastLine = fs
    .readFileSync(failure.path, "utf8")
    .split("\n")
    .filter((line) => line.trim()).length;
  assert.equal(failure.line, lastLine);
  assert.match(failure.message, /JSON/);
  const stored = db.prepare(`SELECT * FROM store_file WHERE path = ?`).get(failure.path);
  assert.equal(stored.unparsed, 1);
  assert.equal(stored.status, "ok");

  // The run record's own fields survive, including the ones only the record has.
  const run = db.prepare(`SELECT * FROM run WHERE kind = 'deliberation'`).get();
  assert.equal(run.fusion, "review-check");
  assert.equal(run.mode, "review-committee");
  assert.equal(run.rounds, 1, "a debate's rounds array is a *count* in the record");
  assert.equal(run.seats, 2);
  assert.equal(run.degraded_seats, 0);
  assert.equal(run.substitutions, 1);
  assert.equal(run.cascades, 2);
  assert.equal(run.cascades_sufficient, 1);
  assert.equal(run.cascades_advanced, 1);
  assert.equal(run.verify_checks, 1);
  assert.equal(run.failure, 0);
  assert.equal(run.work_item, "#14");
  assert.equal(run.verdict, "findings");
  assert.equal(run.disposition_by, "review-synth");
  assert.equal(run.total, 300);
  assert.equal(run.cost_reported_usd, 0.01);
  assert.equal(run.decision_total, 7);
  assert.deepEqual(JSON.parse(run.severity_json), { major: 1 });
  assert.equal(JSON.parse(run.routing_json).routedTo, "review-check");

  // `details_json` keeps the record but not the prompt assembly.
  const details = JSON.parse(run.details_json);
  assert.equal(details.stages[0].inputs, undefined);
  assert.equal(details.rounds[0].inputs, undefined);
  assert.equal(details.verification[0].gate, undefined);
  assert.equal(details.seats.length, 2);

  // The proxy record: the level that was dropped to answer is the fact, alongside what was refused.
  const proxy = db.prepare(`SELECT * FROM run WHERE kind = 'proxy'`).get();
  assert.equal(proxy.alias, "muse");
  assert.equal(proxy.thinking, "none");
  assert.equal(proxy.thinking_recorded, 1);
  assert.equal(proxy.level_dropped, 1);

  const turn = db.prepare(`SELECT * FROM turn WHERE provider = 'fusion-matrix'`).get();
  assert.equal(turn.is_fusion, 1);
  assert.equal(turn.fusion_id, "review-quick");
  assert.equal(turn.details_kind, "proxy");
  assert.equal(turn.ttft_ms, 250);
  assert.equal(turn.duration_ms, 900);
  assert.equal(turn.cost_reported_usd, 0.004);
  assert.equal(turn.tool_calls, 1);

  db.close();
  fs.rmSync(dbPath, { force: true });
});

test("ingest: twice is identical, and a rebuild from nothing matches a grown store", { skip: noSqlite }, async () => {
  const fixture = writeFixtureStore();
  const dbPath = path.join(tempDir("idem"), "matrix.db");
  const catalogue = writeCatalogue();
  const opts = { dbPath, roots: fixture.roots, catalogue };

  const first = await ingest(opts);
  const db = openStore(dbPath);
  const before = totals(db);
  db.close();

  const second = await ingest(opts);
  assert.equal(second.filesSkipped, 2, "an unchanged file is not read again");
  assert.equal(second.filesRead, 0);
  const db2 = openStore(dbPath);
  assert.deepEqual(totals(db2), before, "ingesting twice changes nothing");
  db2.close();

  // Append a run to one file: the *changed* file is re-read, the unchanged one is still skipped.
  const appended = JSON.stringify({
    type: "custom_message",
    customType: "matrix-answer",
    content: "answer",
    timestamp: "2026-09-20T11:00:00.000Z",
    details: { fusion: "quick", mode: "single", seats: [], cascades: [], usage: usage(3, 1, 0) },
  });
  fs.appendFileSync(fixture.ompFile, `${appended}\n`);
  const future = new Date(Date.now() + 1000);
  fs.utimesSync(fixture.ompFile, future, future);

  const third = await ingest(opts);
  assert.equal(third.filesRead, 1);
  assert.equal(third.filesSkipped, 1);
  const grown = openStore(dbPath);
  const after = totals(grown);
  grown.close();
  assert.equal(after.runs, before.runs + 1, "the appended run is the only new row of its kind");
  assert.equal(after.sessions, before.sessions);

  // And a rebuild from nothing, over the same tree, must produce the same store.
  const rebuiltPath = path.join(tempDir("rebuild"), "matrix.db");
  await ingest({ ...opts, dbPath: rebuiltPath, rebuild: true });
  const rebuilt = openStore(rebuiltPath);
  assert.deepEqual(totals(rebuilt), after, "a rebuild equals the incrementally grown store");
  rebuilt.close();
  assert.equal(first.unparsed, third.unparsed, "the unparsed line is counted the same way on every pass");
});

test("ingest: a file that will not read is named; one that disappears is pruned", { skip: noSqlite }, async () => {
  const fixture = writeFixtureStore();
  const dbPath = path.join(tempDir("unreadable"), "matrix.db");
  const catalogue = writeCatalogue();

  const unreadable = await ingest({
    dbPath,
    roots: fixture.roots,
    catalogue,
    readFile: (file, encoding) => {
      if (String(file).endsWith("pi-1.jsonl")) throw new Error("EACCES: permission denied");
      return fs.readFileSync(file, encoding);
    },
  });
  assert.equal(unreadable.filesUnreadable + unreadable.filesFailed, 1, "the file that would not read is counted");
  const db = openStore(dbPath);
  const row = db.prepare(`SELECT * FROM store_file WHERE status <> 'ok'`).get();
  assert.equal(row.status, "failed");
  assert.match(row.reason, /permission denied/);
  assert.equal(db.prepare(`SELECT COUNT(*) n FROM session`).get().n, 1, "the other file is still ingested");
  db.close();

  // A stat that fails is the *unreadable* shape, and also named.
  const statPath = path.join(tempDir("stat"), "matrix.db");
  const statted = await ingest({
    dbPath: statPath,
    roots: fixture.roots,
    catalogue,
    stat: (file) => {
      if (String(file).endsWith("pi-1.jsonl")) throw new Error("ENOENT: vanished mid-walk");
      return fs.statSync(file);
    },
  });
  assert.equal(statted.filesUnreadable, 1);
  const db2 = openStore(statPath);
  assert.equal(db2.prepare(`SELECT status FROM store_file WHERE status = 'unreadable'`).get().status, "unreadable");
  db2.close();

  // Pruning: a session file removed from disk leaves the store.
  fs.rmSync(fixture.piFile);
  const pruned = await ingest({ dbPath, roots: fixture.roots, catalogue });
  assert.equal(pruned.filesPruned, 1);
  const db3 = openStore(dbPath);
  assert.equal(totals(db3).sessions, 1);
  assert.equal(totals(db3).files, 1);
  db3.close();
});

test("costs: every usage is priced at a stated basis, and never a silent zero", { skip: noSqlite }, async () => {
  const { db, dbPath } = await openFixture();

  // reported: the provider's own number.
  assert.deepEqual(pricedUsage(db, "opencode-go", "kimi-k3", { input: 100, output: 10, cache_read: 0, cache_write: 0, reported: 0.01 }), {
    basis: "reported",
    amount: 0.01,
    via: "opencode-go",
  });
  // estimated: unpriced, but this provider's own card rates the model.
  const estimated = pricedUsage(db, "opencode-go", "glm-5.3", { input: 1000000, output: 0, cache_read: 0, cache_write: 0, reported: null });
  assert.equal(estimated.basis, "estimated");
  assert.equal(estimated.amount, 0.6);
  assert.equal(estimated.via, "opencode-go/glm-5.3");
  // list: unpriced, its own provider prices it at zero (a plan), so another provider's rate stands in.
  const list = pricedUsage(db, "plan-provider", "glm-5.3", { input: 1000000, output: 0, cache_read: 0, cache_write: 0, reported: null });
  assert.equal(list.basis, "list");
  assert.equal(list.amount, 0.6);
  assert.equal(list.via, "opencode-go/glm-5.3", "the first provider, by name, is the one the number came from");
  // no rate: nothing to price with is stated, never counted as money.
  assert.deepEqual(pricedUsage(db, "nobody", "unpriced-model", { input: 10, output: 1, cache_read: 0, cache_write: 0, reported: null }), {
    basis: "no rate",
    amount: null,
    via: null,
  });

  // The list basis picks one catalogue row for the model by the highest *sum* across all four rates —
  // a cache-heavy card with a smaller input+output sum must win on its cache rates, or the rule would
  // silently ignore two of the four columns it claims to span.
  db.exec("BEGIN");
  for (const row of [
    { provider: "cachey", model: "mixed-model", input: 0.1, output: 0.1, cache_read: 9, cache_write: 1 },
    { provider: "promptly", model: "mixed-model", input: 2, output: 2, cache_read: 0.1, cache_write: 0 },
  ]) {
    db.prepare(
      `INSERT INTO price (provider, model, input, output, cache_read, cache_write, source, first_seen_ms, last_seen_ms)
       VALUES (?, ?, ?, ?, ?, ?, 'fixture', 1, 1)`,
    ).run(row.provider, row.model, row.input, row.output, row.cache_read, row.cache_write);
  }
  db.exec("COMMIT");
  const picked = pricedUsage(db, "plan-provider", "mixed-model", { input: 1, output: 1, cache_read: 1, cache_write: 1, reported: null });
  assert.equal(picked.basis, "list");
  assert.equal(picked.via, "cachey/mixed-model", "the highest sum across all four rates wins, cache included");

  const models = byModel(db);
  const glm = models.find((m) => m.model === "opencode-go/glm-5.3");
  assert.equal(glm.cost.estimated, (50 * 0.6 + 10 * 2.2) / 1e6, "the seat's own card prices its tokens");
  assert.equal(glm.cost.reported, 0);
  const kimi = models.find((m) => m.model === "opencode-go/kimi-k3");
  assert.equal(kimi.cost.reported, 0.01, "a priced seat contributes only to reported");
  assert.equal(kimi.cost.estimated, 0, "and never to a basis it was not priced on");
  db.close();
  fs.rmSync(dbPath, { force: true });
});

test("the store's numbers agree with the report's aggregate over the same fixture", { skip: noSqlite }, async () => {
  const { db, dbPath, ompFile } = await openFixture();

  const parsed = parseLines(fs.readFileSync(ompFile, "utf8"));
  const session = extractSession(parsed.entries, {
    file: ompFile,
    harness: "omp",
    unparsed: parsed.unparsed,
    parseFailures: parsed.failures,
  });
  const report = aggregate([session]);

  const models = byModel(db);
  for (const [key, row] of report.models) {
    const mine = models.find((m) => m.model === key);
    assert.ok(mine, `the store knows ${key}`);
    assert.equal(mine.seats, row.seats, `${key}: seats`);
    assert.equal(mine.findings, row.findings, `${key}: findings raised`);
    assert.equal(mine.kept, row.survived, `${key}: findings the disposition kept`);
    assert.equal(mine.located, row.located, `${key}: located`);
    assert.equal(mine.unlocated, row.unlocated, `${key}: unlocated`);
    assert.equal(mine.uncheckable, row.uncheckable, `${key}: uncheckable`);
  }

  // The run rollup agrees with the record it was derived from.
  const fusions = byFusion(db);
  assert.equal(fusions.length, 1);
  assert.equal(fusions[0].fusion, "review-check");
  assert.equal(fusions[0].runs, 1);
  assert.equal(fusions[0].cascades.sufficient, 1);
  assert.equal(fusions[0].cascades.advanced, 1);
  assert.equal(fusions[0].malformed, 1);
  assert.deepEqual(fusions[0].verdicts, { findings: 1 });
  assert.deepEqual(fusions[0].workItems, { "#14": 1 });
  assert.equal(fusions[0].marked.total, 2);
  assert.equal(fusions[0].marked.uncheckable, 1, "a path outside the session is uncheckable, never found");
  assert.equal(fusions[0].marked.unlocated + fusions[0].marked.located + fusions[0].marked.uncheckable, 2);

  // Verify answers keep the choice question as well as the score, and name the model that answered.
  const verify = verifyByQuestion(db);
  const score = verify.find((v) => v.question === "addresses_question");
  assert.equal(score.fusion, "review-check");
  assert.equal(score.byModel, "opencode-go/kimi-k3", "the model whose answer stood");
  assert.equal(score.avg, 0.44);
  const contradiction = verify.find((v) => v.question === "contradiction_handling");
  assert.deepEqual(contradiction.choices, { ignores: 1 });

  // Refusals keep the route that was refused, not the route that answered — a seat's two routes and
  // the proxied turn's own refused level are three rows, not one.
  const refusals = refusalsByRoute(db);
  assert.deepEqual(
    refusals.map((r) => [r.provider, r.reason]).sort(),
    [
      ["opencode-go", "quota"],
      ["opencode-go", "thinking"],
      ["zai", "transient"],
    ].sort(),
  );

  // The proxy face: the alias, the level it ran at, and what it refused.
  const proxxy = byProxyAlias(db);
  assert.equal(proxxy.length, 1);
  assert.equal(proxxy[0].alias, "muse");
  assert.equal(proxxy[0].turns, 1);
  assert.equal(proxxy[0].dropped, 1);
  assert.deepEqual(proxxy[0].levels, { none: 1 });
  assert.deepEqual(proxxy[0].refusals, { thinking: 1 });

  db.close();
  fs.rmSync(dbPath, { force: true });
});

test("no prompt or message text reaches the database, while a finding's claim does", { skip: noSqlite }, async () => {
  const { db, dbPath } = await openFixture();
  const claim = "a claim that survives";
  assert.equal(db.prepare(`SELECT COUNT(*) n FROM seat_finding WHERE claim = ?`).get(claim).n, 1, "the finding is stored");
  db.close();

  const bytes = fs.readFileSync(dbPath);
  assert.equal(bytes.includes(Buffer.from(MARKER, "utf8")), false, "the marker sentence is nowhere in the store");
  const details = fs.readFileSync(dbPath, "utf8");
  assert.equal(details.includes("MARKER-not-a-transcript-line"), false);
  fs.rmSync(dbPath, { force: true });
});

test("the rate card: absent is a named absence, and a seen card keeps its first-seen date", { skip: noSqlite }, async () => {
  const fixture = writeFixtureStore();
  const dbPath = path.join(tempDir("card"), "matrix.db");

  const absent = await ingest({ dbPath, roots: fixture.roots, catalogue: path.join(fixture.dir, "nope.db") });
  assert.equal(absent.priceCard.available, false);
  assert.match(absent.priceCard.reason, /no model catalogue at/);
  const db = openStore(dbPath);
  assert.match(db.prepare(`SELECT value FROM meta WHERE key = 'price_source'`).get().value, /^unavailable: no model catalogue/);
  assert.equal(totals(db).prices, 0);
  db.close();

  // A card that is there: rows appear, and re-ingesting does not reset first_seen_ms.
  const catalogue = writeCatalogue();
  await ingest({ dbPath, roots: fixture.roots, catalogue, now: 1000 });
  const db2 = openStore(dbPath);
  const first = db2.prepare(`SELECT * FROM price WHERE model = 'glm-5.3' AND provider = 'opencode-go'`).get();
  db2.close();
  await ingest({ dbPath, roots: fixture.roots, catalogue, now: 2000 });
  const db3 = openStore(dbPath);
  const second = db3.prepare(`SELECT * FROM price WHERE model = 'glm-5.3' AND provider = 'opencode-go'`).get();
  assert.equal(second.first_seen_ms, first.first_seen_ms, "a rate keeps the date it was first seen");
  assert.equal(second.last_seen_ms, 2000, "and records when it was last seen");
  db3.close();

  // A catalogue with no such table is named, not read as an empty card.
  const other = path.join(tempDir("nocat"), "models.db");
  const empty = new sqlite.DatabaseSync(other);
  empty.exec("CREATE TABLE whatever (a TEXT)");
  empty.close();
  const card = readPriceCard(other);
  assert.equal(card.available, false);
  assert.match(card.reason, /has no model_cache table/);
});

test("rowsForSession is pure and complete for one session", { skip: noSqlite }, () => {
  const parsed = parseLines(
    [
      JSON.stringify({ type: "session", id: "s", cwd: "/tmp/x", timestamp: "2026-09-20T00:00:00.000Z" }),
      JSON.stringify({
        type: "message",
        message: {
          role: "assistant",
          api: "anthropic-messages",
          provider: "p",
          model: "m",
          timestamp: "2026-09-20T00:00:01.000Z",
          usage: { input: 3, output: 1 },
          duration: 10,
          ttft: 5,
          stopReason: "error",
          content: [{ type: "toolCall", id: "c", name: "write", arguments: { path: "xd://matrix" } }],
        },
      }),
      JSON.stringify({
        type: "message",
        message: {
          role: "toolResult",
          toolCallId: "c",
          toolName: "matrix",
          isError: true,
          content: [],
          timestamp: "2026-09-20T00:00:02.000Z",
        },
      }),
    ].join("\n"),
  );
  const session = extractSession(parsed.entries, { file: "f", harness: "omp" });
  const rows = rowsForSession(session);

  assert.equal(rows.turns.length, 1);
  assert.equal(rows.turns[0].total, 4, "an absent totalTokens is input + output");
  assert.equal(rows.turns[0].cost_reported_usd, null, "an unpriced turn has NULL money, not zero");
  assert.equal(rows.turns[0].priced, 0);
  assert.equal(rows.turns[0].tool_errors, 1, "the failed result is charged to the turn that called it");
  assert.equal(rows.toolResults[0].device, 1, "an xd:// write through omp is a device call");
  assert.equal("tz_offset_min" in rows.session, false, "no machine-dependent offset is stored under a session's name");
  assert.equal(rows.parseFailures.length, 0);

  // Usage normalisation is its own contract: absent is zero, money is never invented.
  assert.deepEqual(usageOf(undefined), { input: 0, output: 0, cache_read: 0, cache_write: 0, reasoning: 0, total: 0, reported: null });
  assert.equal(usageOf({ input: 5, output: 5, cost: { total: 0 } }).reported, null, "a zero cost is unpriced, not free");
  assert.equal(usageOf({ input: 5, output: 5, cost: { total: 0.5 } }).reported, 0.5);

  // The sanitiser drops prompt assembly and gate output, and keeps the record.
  const clean = sanitiseDetails({
    fusion: "x",
    stages: [{ stage: "parallel", inputs: { a: "text" } }],
    rounds: [{ round: 1, inputs: { a: "text" } }],
    verification: [{ check: "gate", gate: { exit: 0, output: "lots" }, result: { exit: 0 } }],
  });
  assert.equal(clean.stages[0].inputs, undefined);
  assert.equal(clean.rounds[0].inputs, undefined);
  assert.equal(clean.verification[0].gate, undefined);
  assert.equal(clean.fusion, "x");
});

test("a store written by a newer reader is refused by version", { skip: noSqlite }, async () => {
  const dbPath = path.join(tempDir("version"), "matrix.db");
  const db = openStore(dbPath);
  db.prepare(`INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', ?)`).run(String(SCHEMA_VERSION + 1));
  db.close();
  assert.throws(() => openStore(dbPath), /was written by schema/);
});

/**
 * A bounded spawn. The repository forbids an unbounded wait in test code: `spawnSync` blocks the event
 * loop with no deadline of its own, so a regression that hangs the CLI would hang the whole suite with
 * no failed check — a timeout turns that into a *named* failure instead.
 */
const runCli = (args) => {
  const result = spawnSync(process.execPath, args, { cwd: root, encoding: "utf8", timeout: 60_000 });
  assert.equal(result.signal, null, `the CLI was killed after 60s (signal ${result.signal}): ${args.join(" ")}`);
  assert.equal(result.error, undefined, `the CLI could not be run: ${result.error?.message ?? ""}`);
  return result;
};

test("a file that stops being readable takes its old rows with it", { skip: noSqlite }, async () => {
  const fixture = writeFixtureStore();
  const dbPath = path.join(tempDir("ghost"), "matrix.db");
  const catalogue = writeCatalogue();
  const opts = { dbPath, roots: fixture.roots, catalogue };
  const deny = (file, encoding) => {
    if (String(file).endsWith("omp-1.jsonl")) throw new Error("EACCES: permission denied");
    return fs.readFileSync(file, encoding);
  };

  await ingest(opts);
  const before = openStore(dbPath);
  assert.equal(totals(before).sessions, 2, "both files ingested");
  before.close();

  // The omp file stops being readable *and* has moved on (a changed fingerprint, or the ingest would
  // rightly skip it without reading). Its session, turns, runs and findings must leave the store with
  // it: a status of `failed` beside rows that are still counted is a store that overstates the JSONL
  // and disagrees with a `--rebuild` over the same tree.
  fs.appendFileSync(fixture.ompFile, "\n");
  const future = new Date(Date.now() + 1000);
  fs.utimesSync(fixture.ompFile, future, future);
  const broken = await ingest({ ...opts, readFile: deny });
  assert.equal(broken.filesFailed + broken.filesUnreadable, 1);

  const after = openStore(dbPath);
  assert.equal(totals(after).sessions, 1, "the failed file's session is gone, not stale");
  assert.equal(totals(after).deliberationRuns, 0, "and the runs it carried");
  assert.equal(totals(after).turns, 1, "and its turns — only the pi session's remains");
  assert.equal(totals(after).filesFailed, 1, "the failure is counted under its own name");
  assert.equal(totals(after).filesUnreadable, 0, "…and not as unreadable");
  after.close();

  // Which is what a rebuild over the same tree holds as well.
  const rebuiltPath = path.join(tempDir("ghost-rebuild"), "matrix.db");
  await ingest({ ...opts, dbPath: rebuiltPath, rebuild: true, readFile: deny });
  const rebuilt = openStore(rebuiltPath);
  const incremental = openStore(dbPath);
  assert.deepEqual(totals(rebuilt), totals(incremental), "the incrementally updated store equals a rebuild");
  rebuilt.close();
  incremental.close();
});

test("seats by fusion name the alias that answered and the routes that refused", { skip: noSqlite }, async () => {
  const { db, dbPath } = await openFixture();
  const seats = byFusionSeat(db);
  const skeptic = seats.find((s) => s.fusion === "review-check" && s.persona === "review-skeptic");
  assert.equal(skeptic.seats, 1);
  assert.deepEqual({ ...skeptic.answered }, { glm: 1 }, "the alias that answered, not just its model");
  // Keyed by provider *and* model: the SQL groups by both, and a provider running two models must not
  // read as one route refusing twice. Compared as a consumer reads it, so the map's prototype is not
  // part of the contract.
  const refusalShape = (refusals) => Object.fromEntries(Object.entries(refusals).map(([route, reasons]) => [route, { ...reasons }]));
  assert.deepEqual(
    refusalShape(skeptic.refusals),
    { "opencode-go/glm-5.3": { quota: 1 }, "zai/glm-5.3": { transient: 1 } },
    "every route that refused it, by model and reason",
  );
  const synth = seats.find((s) => s.persona === "review-synth");
  assert.equal(synth.seats, 1);
  assert.deepEqual({ ...synth.answered }, { kimi: 1 });
  assert.deepEqual({ ...synth.refusals }, {}, "a seat nobody refused has no refusals, rather than an absent row");
  db.close();
  fs.rmSync(dbPath, { force: true });
});

test("a record's clock is a string or absent, whatever the harness wrote", () => {
  const entries = [
    { type: "session", id: "s", cwd: "/tmp/x", timestamp: "2026-09-20T00:00:00.000Z" },
    // omp writes epoch milliseconds on the message.
    { type: "message", message: { role: "assistant", provider: "p", model: "m", timestamp: 1789862400000, content: [] } },
    // A finite number outside the Date range — the shape that used to make toISOString throw and take
    // the whole session's extraction with it.
    { type: "message", message: { role: "assistant", provider: "p", model: "m", timestamp: 1.7e18, content: [] } },
    // A message clock the normaliser cannot represent, with a usable one on the entry: the entry wins
    // rather than the turn losing its time.
    {
      type: "message",
      timestamp: "2026-09-20T00:00:05.000Z",
      message: { role: "assistant", provider: "p", model: "m", timestamp: Number.NaN, content: [] },
    },
  ];
  const session = extractSession(entries, { file: "f", harness: "omp" });

  assert.equal(session.turns.length, 3);
  assert.equal(session.turns[0].at, "2026-09-20T00:00:00.000Z", "epoch milliseconds became an ISO string");
  assert.equal(typeof session.turns[0].at, "string");
  assert.equal(session.turns[1].at, undefined, "an out-of-range epoch is absent, not a crash");
  assert.equal(session.turns[2].at, "2026-09-20T00:00:05.000Z", "the entry's clock stands in for an unrepresentable message one");

  // And the normaliser itself, at its edges.
  assert.equal(isoTime(1789862400000), "2026-09-20T00:00:00.000Z");
  assert.equal(isoTime("2026-09-20T00:00:00.000Z"), "2026-09-20T00:00:00.000Z");
  assert.equal(isoTime(1.7e18), undefined);
  assert.equal(isoTime(Number.NaN), undefined);
  assert.equal(isoTime(undefined), undefined);
  assert.equal(isoTime({}), undefined);
});

test("the CLI accounts for the store it built, and refuses a flag it does not take", { skip: noSqlite }, async () => {
  const fixture = writeFixtureStore();
  const dbPath = path.join(tempDir("cli"), "matrix.db");
  const catalogue = writeCatalogue();

  const run = runCli(["scripts/ingest-metrics.mjs", "--db", dbPath, "--root", path.join(fixture.dir, "omp"), "--catalogue", catalogue]);
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /files: 1 \(1 read/);
  assert.match(run.stdout, /unparsed lines: 1/);

  const json = runCli([
    "scripts/ingest-metrics.mjs",
    "--db",
    dbPath,
    "--root",
    path.join(fixture.dir, "omp"),
    "--catalogue",
    catalogue,
    "--json",
    "--quiet",
  ]);
  assert.equal(json.status, 0, json.stderr);
  const parsed = JSON.parse(json.stdout);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.totals.deliberationRuns, 1);

  const bad = runCli(["scripts/ingest-metrics.mjs", "--nope"]);
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /unknown flag --nope/);
});
