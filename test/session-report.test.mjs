/**
 * The run-record reader, under `node --test`.
 *
 * These are the checks `scripts/session-report.mjs` used to run against itself behind `--check`: whether a
 * store was accounted for, what a record was read as, and what the aggregates and the printed report claim.
 * That is the reader's behaviour, so it belongs in the unit suite with every other module's — a change that
 * breaks one of these claims has to fail `npm test`, not a script nobody ran.
 *
 * Two kinds of check live here, and they are deliberately different:
 *
 *   in process   the exported units (`parseLines`, `extractSession`, `aggregate`, `render`, `readStore`, …),
 *                exercised directly. This is where a unit's contract is pinned.
 *   as a child   the checks about the command line — the exit status a partial ledger produces, what the
 *                error output names. Those spawn `scripts/session-report.mjs` by path, because the surface
 *                they assert is the program's, and every one carries its own deadline (`spawnSync`).
 *
 * Nothing is silently passed: a check that needs a permission this process may not have (a non-root uid) and
 * a plan-window check on a node without `node:sqlite` are *skipped*, and reported as skipped.
 *
 *   node --test test/session-report.test.mjs
 */
import test, { after, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  aggregate,
  buildReport,
  extractSession,
  joinPlanWindows,
  money,
  parseLines,
  readPlanWindows,
  readStore,
  render,
  renderJson,
} from "../scripts/session-report.mjs";

/** The api id every fusion model is registered under, so a turn names the fusion that served it. */
const FUSION_API = "fusion-matrix";

/** The reader as a program, for the checks that assert its exit status and its printed report. */
const SCRIPT = fileURLToPath(new URL("../scripts/session-report.mjs", import.meta.url));

/** Where `process.getuid` does not exist the permission checks still run; where it says root they cannot. */
const runningAsRoot = process.getuid?.() === 0;
const rootSkip = runningAsRoot ? "running as root: the permission checks need a non-root uid" : false;

const usage = (input, output, cost = 0) => ({
  input,
  output,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: input + output,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: cost },
});
const lines = (entries) => entries.map((e) => JSON.stringify(e)).join("\n");

const sessionMeta = { type: "session", id: "s-1", cwd: "/tmp/project-alpha", timestamp: "2026-09-19T08:00:00.000Z", version: 3 };
const goodEntries = [
  sessionMeta,
  { type: "message", message: { role: "user", content: [{ type: "text", text: "go" }] } },
  // a proxied turn: level dropped after a refusal, one tool call, priced
  {
    type: "message",
    message: {
      role: "assistant",
      api: FUSION_API,
      provider: "fusion-matrix",
      model: "quick",
      stopReason: "toolUse",
      usage: usage(100, 10, 0.002),
      content: [{ type: "toolCall", id: "c1", name: "read", arguments: {} }],
      details: {
        proxied: {
          alias: "glm-flash",
          provider: "opencode-go",
          model: "glm-5.3-flash",
          template: "glm-5.3-flash",
          thinking: null,
          attempts: [{ alias: "glm-flash", seat: "opencode-go/glm-5.3-flash", reason: "thinking", detail: "level refused" }],
        },
      },
    },
  },
  { type: "message", message: { role: "toolResult", toolName: "read", isError: true, content: [] } },
  // a second proxied turn, no attempts, omp-style duration
  {
    type: "message",
    message: {
      role: "assistant",
      api: FUSION_API,
      provider: "fusion-matrix",
      model: "quick",
      stopReason: "stop",
      usage: usage(50, 5, 0.001),
      duration: 4200,
      ttft: 900,
      content: [],
      details: { proxied: { alias: "glm-flash", provider: "opencode-go", model: "glm-5.3-flash", thinking: "low", attempts: [] } },
    },
  },
  // a plain model turn, unpriced, no duration
  {
    type: "message",
    message: {
      role: "assistant",
      api: "anthropic-messages",
      provider: "opencode-go",
      model: "glm-5.3",
      stopReason: "stop",
      usage: usage(10, 1, 0),
      content: [],
    },
  },
  // the deliberate face on the tool path
  {
    type: "message",
    message: {
      role: "toolResult",
      toolName: "matrix",
      isError: false,
      content: [],
      details: {
        fusion: "opinions",
        mode: "jury",
        rounds: 1,
        seats: [
          { persona: "systems", degraded: false, usage: usage(20, 2) },
          { persona: "skeptic", degraded: true, usage: usage(30, 3) },
        ],
        seatErrors: [{ persona: "skeptic", error: "all candidates failed: skeptic@nope (missing provider)", reason: "missing provider" }],
        substitutions: [{ seat: "skeptic", from: "a", to: "b", reason: "quota" }],
        cascades: [
          { seat: "systems", sufficient: true },
          { seat: "panel", sufficient: true },
          { seat: "stage", sufficient: false, advancedTo: "next stage" },
        ],
        routing: { fusion: "opinions" },
        verification: [{ check: "gate: node -e 0", result: { exit: 0 } }],
        saved: ["a.ts"],
        usage: usage(80, 8),
        decisionUsage: usage(5, 1),
      },
    },
  },
  // the deliberate face on the command path, and a failure
  {
    type: "custom_message",
    customType: "matrix-answer",
    content: "answer",
    display: true,
    details: { fusion: "opinions", mode: "jury", seats: [], cascades: [], verification: [], usage: usage(7, 1) },
  },
  {
    type: "custom_message",
    customType: "matrix-answer",
    content: "fusion failed: boom",
    display: true,
    details: { fusion: "opinions", error: "all candidates failed: quota" },
  },
  // a degraded run: the seat never answered, so the record says so
  {
    type: "custom_message",
    customType: "matrix-answer",
    content: "no answer",
    display: true,
    details: {
      fusion: "opinions",
      seats: [{ persona: "systems", degraded: true, error: "all candidates failed: missing provider" }],
      seatErrors: [{ persona: "systems", error: "all candidates failed: systems@nope (missing provider)", reason: "missing provider" }],
      cascades: [],
      usage: usage(3, 0),
    },
  },
  // shapes that are ours to explain but carry no fusion id, on both carriers
  {
    type: "message",
    message: { role: "toolResult", toolName: "other", isError: false, content: [], details: { cascades: [{ sufficient: true }] } },
  },
  { type: "custom_message", customType: "matrix-answer", content: "answer", display: true, details: { seats: [], cascades: [] } },
];

// One store's worth of lines, the entries parsed from them (one line of which does not parse), the session
// that came out, and the aggregate over it: several groups below read the same session, so the fixture is
// built once, at module scope, and never mutated.
const { entries, unparsed } = parseLines(`${lines(goodEntries)}\n{ this line is not json`);
const session = extractSession(entries, { file: "fixture.jsonl", harness: "pi" });
const report = aggregate([{ ...session, entries: session.entries }]);

describe("parsing and extraction", () => {
  test("an unparsed line is counted, not dropped", () => {
    assert.ok(unparsed === 1, `unparsed=${unparsed}`);
  });
  test("a good session still parses after an unparsed line", () => {
    assert.ok(entries.length === goodEntries.length, `entries=${entries.length}`);
  });

  test("header read", () => {
    assert.ok(session.cwd === "/tmp/project-alpha" && session.id === "s-1", `${session.cwd} ${session.id}`);
  });
  test("two proxy records", () => {
    assert.ok(
      session.records.filter((r) => r.kind === "proxy").length === 2,
      `proxy=${session.records.filter((r) => r.kind === "proxy").length}`,
    );
  });
  test("four deliberation records", () => {
    assert.ok(
      session.records.filter((r) => r.kind === "deliberation").length === 4,
      `deliberation=${session.records.filter((r) => r.kind === "deliberation").length}`,
    );
  });
  test("six records in total, and no more", () => {
    assert.ok(session.records.length === 6, `records=${session.records.length}`);
  });
  test("a fusion-shaped shape without a fusion id is named, not counted as a run", () => {
    assert.ok(
      session.unknown.length === 2 && session.records.every((r) => typeof r.fusion === "string" && r.fusion !== "unknown"),
      JSON.stringify([session.unknown.length, session.records.map((r) => r.fusion)]),
    );
  });

  // F6: a parse failure names its line, so `3 unparsed lines` can be acted on rather than only counted.
  const { unparsed: n, failures: fs2 } = parseLines(`{"type":"sess\n{"ok":1}\nnot json\nalso not\n`);
  const capped = parseLines(Array.from({ length: 9 }, () => "x").join("\n"), { maxFailures: 2 });
  test("a parse failure keeps its line and reason", () => {
    assert.ok(n === 3 && fs2.length === 3 && fs2[0].line === 1 && typeof fs2[0].message === "string", JSON.stringify(fs2));
  });
  test("a parse failure list is capped, with the count kept", () => {
    assert.ok(
      capped.unparsed === 9 && capped.failures.length === 2,
      JSON.stringify({ unparsed: capped.unparsed, named: capped.failures.length }),
    );
  });
});

describe("the aggregates", () => {
  const quick = report.turns.get("pi/fusion:quick");
  const proxy = report.proxy.get("pi/quick");
  const delib = report.deliberation.get("pi/opinions");
  const filtered = entries.filter((e) => e.type !== "custom_message");
  const only = aggregate([extractSession(filtered, { file: "fixture.jsonl" })]);
  // An absent `thinking` key is a record that did not say, not a turn that ran at no level.
  const legacy = extractSession(
    [
      sessionMeta,
      {
        type: "message",
        message: {
          role: "assistant",
          api: FUSION_API,
          model: "quick",
          usage: usage(5, 1, 0.001),
          content: [],
          details: { proxied: { alias: "glm-flash", attempts: [{ reason: "transient" }] } },
        },
      },
    ],
    { file: "legacy.jsonl", harness: "pi" },
  );
  const legacyRow = aggregate([legacy]).proxy.get("pi/quick");
  const unpricedTurn = extractSession(
    [
      sessionMeta,
      {
        type: "message",
        message: {
          role: "assistant",
          api: FUSION_API,
          model: "quick",
          usage: {
            input: 10,
            output: 1,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 11,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
          content: [],
          details: { proxied: { alias: "glm-flash", thinking: "low", attempts: [] } },
        },
      },
    ],
    { file: "unpriced.jsonl", harness: "omp" },
  );
  const unpricedRow = aggregate([unpricedTurn]).turns.get("omp/fusion:quick");
  // F2: the streamed provider path records its run on the assistant message
  const streamed = extractSession(
    [
      sessionMeta,
      {
        type: "message",
        message: {
          role: "assistant",
          api: FUSION_API,
          model: "quick",
          usage: usage(20, 2, 0.001),
          content: [],
          details: {
            fusion: "quick",
            mode: "single",
            seats: [{ persona: "technical", degraded: false, usage: usage(20, 2, 0.001) }],
            cascades: [],
            seatErrors: [],
            verification: [],
            usage: usage(20, 2, 0.001),
          },
        },
      },
    ],
    { file: "streamed.jsonl", harness: "pi" },
  );
  const streamedReport = aggregate([streamed]);
  // F3: the same fusion from two stores is two rows, never an average of a fact and a silence
  const twoStores = aggregate([
    extractSession(
      [
        sessionMeta,
        {
          type: "message",
          message: {
            role: "assistant",
            api: FUSION_API,
            model: "quick",
            usage: usage(10, 1, 0.001),
            duration: 1000,
            content: [],
            details: { proxied: { alias: "g", thinking: "low", attempts: [] } },
          },
        },
      ],
      { file: "a.jsonl", harness: "omp" },
    ),
    extractSession(
      [
        sessionMeta,
        {
          type: "message",
          message: {
            role: "assistant",
            api: FUSION_API,
            model: "quick",
            usage: usage(10, 1, 0.001),
            content: [],
            details: { proxied: { alias: "g", thinking: "low", attempts: [] } },
          },
        },
      ],
      { file: "b.jsonl", harness: "pi" },
    ),
  ]);
  const ompRow = twoStores.turns.get("omp/fusion:quick");
  const piRow = twoStores.turns.get("pi/fusion:quick");
  const noUsage = aggregate([
    extractSession(
      [
        sessionMeta,
        {
          type: "message",
          message: {
            role: "assistant",
            api: FUSION_API,
            model: "quick",
            content: [],
            details: { proxied: { alias: "glm-flash", thinking: "low", attempts: [] } },
          },
        },
      ],
      { file: "nousage.jsonl", harness: "pi" },
    ),
  ]);

  test("turns are keyed by fusion id", () => {
    assert.ok(quick?.turns === 2, `turns=${quick?.turns}`);
  });
  test("usage accumulates per key exactly", () => {
    assert.ok(
      quick?.sums.input === 150 &&
        quick?.sums.output === 15 &&
        Math.abs(quick.sums.costReported - 0.003) < 1e-9 &&
        quick.sums.unpricedMessages === 0,
      JSON.stringify(quick?.sums),
    );
  });
  test("priced and unpriced turns are told apart", () => {
    assert.ok(
      quick?.sums.unpricedMessages === 0 &&
        report.turns.get("pi/opencode-go/glm-5.3")?.sums.unpricedMessages === 1 &&
        report.gaps.unpriced === 1,
    );
  });
  test("a missing duration is counted as missing, never as 0", () => {
    assert.ok(
      quick?.timed === 1 && quick?.missingDuration === 1 && report.gaps.noDuration === 2,
      `timed=${quick?.timed} missing=${quick?.missingDuration} total=${report.gaps.noDuration}`,
    );
  });
  test("tool results are attributed to the turn before them", () => {
    assert.ok(
      quick?.toolErrors === 1 &&
        quick?.toolCalls === 1 &&
        report.tools.get("pi/read").errors === 1 &&
        report.toolCalls.get("pi/read") === 1,
      JSON.stringify(Object.fromEntries(report.toolCalls)),
    );
  });
  test("a dropped level counts as a drop", () => {
    assert.ok(proxy?.dropped === 1 && proxy?.levels.get("none") === 1, JSON.stringify([...proxy.levels]));
  });
  test("attempt reasons are counted", () => {
    assert.ok(proxy?.attempts.get("thinking") === 1);
  });
  test("deliberation runs counted by carrier", () => {
    assert.ok(
      delib?.runs === 4 && delib?.carriers.get("toolResult") === 1 && delib?.carriers.get("custom_message") === 3,
      JSON.stringify([...(delib?.carriers ?? [])]),
    );
  });
  test("degraded seats and seat errors counted", () => {
    assert.ok(
      delib?.seats === 3 && delib?.degradedSeats === 2 && delib?.seatErrors === 2,
      JSON.stringify({ seats: delib?.seats, degraded: delib?.degradedSeats, errors: delib?.seatErrors }),
    );
  });
  test("cascades split sufficient from advanced", () => {
    assert.ok(
      delib?.cascades === 3 && delib?.cascadesSufficient === 2 && delib?.cascadesAdvanced === 1,
      JSON.stringify({ total: delib?.cascades, sufficient: delib?.cascadesSufficient, advanced: delib?.cascadesAdvanced }),
    );
  });
  test("cascades are attributed to their seat", () => {
    assert.ok(
      delib?.cascadeSeats.get("stage") === 1 && delib?.cascadeSeats.get("panel") === 1,
      JSON.stringify([...(delib?.cascadeSeats ?? [])]),
    );
  });
  test("a run's tokens are counted once, from its own usage (its seats are inside it)", () => {
    assert.ok(delib?.sums.input === 80 + 7 + 3 && delib?.sums.output === 8 + 1 + 0, JSON.stringify(delib?.sums));
  });
  test("a seat's usage is not added a second time", () => {
    assert.ok(
      delib?.seats === 3 && delib?.sums.input < 80 + 20 + 30 + 7 + 3,
      `input=${delib?.sums.input} seat usages=${JSON.stringify((delib && [20, 30]) || [])}`,
    );
  });
  test("decision usage is kept apart from seat usage", () => {
    assert.ok(delib?.decisionUsage.input === 5 && delib?.decisionUsage.output === 1);
  });
  test("route, verification checks and saved files are read", () => {
    assert.ok(
      delib?.route === 1 && delib?.verify === 1 && delib?.saved === 1,
      JSON.stringify({ route: delib?.route, verify: delib?.verify, saved: delib?.saved }),
    );
  });
  test("a failed deliberation is counted, thrown or degraded", () => {
    assert.ok(
      delib?.failures === 2 && report.records.deliberation === 4,
      JSON.stringify({ failures: delib?.failures, records: report.records.deliberation }),
    );
  });
  test("filters change the totals", () => {
    assert.ok(only.records.deliberation === 1 && only.sessions === 1);
  });
  test("an unrecorded level is not counted as a drop", () => {
    assert.ok(legacyRow?.dropped === 0 && legacyRow?.levels.get("unrecorded") === 1, JSON.stringify([...(legacyRow?.levels ?? [])]));
  });
  test("money states its basis: a price nobody reported is not a total", () => {
    assert.ok(unpricedRow?.sums.costReported === 0 && unpricedRow?.sums.unpricedMessages === 1, JSON.stringify(unpricedRow?.sums));
  });
  test("a streamed fusion turn is a deliberation record, not an unknown shape", () => {
    assert.ok(
      streamedReport.records.deliberation === 1 &&
        streamedReport.unknownShapes.length === 0 &&
        streamedReport.deliberation.get("pi/quick")?.carriers.get("assistant") === 1,
      JSON.stringify({ records: streamedReport.records, unknown: streamedReport.unknownShapes.length }),
    );
  });
  test("each store keeps its own row", () => {
    assert.ok(
      ompRow?.timed === 1 && ompRow?.missingDuration === 0 && piRow?.timed === 0 && piRow?.missingDuration === 1,
      JSON.stringify({ omp: [ompRow?.timed, ompRow?.missingDuration], pi: [piRow?.timed, piRow?.missingDuration] }),
    );
  });
  test("a message the harness priced not at all counts as unpriced", () => {
    assert.ok(
      noUsage.turns.get("pi/fusion:quick")?.sums.unpricedMessages === 1 && noUsage.turns.get("pi/fusion:quick")?.sums.costReported === 0,
      JSON.stringify(noUsage.turns.get("pi/fusion:quick")?.sums),
    );
  });
  test("a cost below a cent does not print as zero", () => {
    assert.ok(
      money(0.0000203) === "$0.000020" && money(0) === "$0.0000" && money(0.42) === "$0.42",
      `${money(0.0000203)} ${money(0)} ${money(0.42)}`,
    );
  });
});

describe("store reading and filters", () => {
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
  const injected = readStore({
    roots,
    readFile: (file, encoding) =>
      file === locked
        ? (() => {
            throw denied(file);
          })()
        : fs.readFileSync(file, encoding),
  });
  const unlistable = readStore({
    roots,
    readdir: (dir, ...rest) => {
      if (dir === slug) throw denied(dir);
      return fs.readdirSync(dir, ...rest);
    },
  });

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
  const unfilteredStore = readStore({ roots: roots2 });

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
  const oneFile = readStore({ roots: sinceRoots, sessionFile: dated, cwdFilter: "project-beta" });
  const harnessed = readStore({
    roots: [
      { harness: "pi", root: datedDir },
      { harness: "omp", root: datedDir },
    ],
    harnessFilter: "pi",
  });

  const jsonDir = fs.mkdtempSync(path.join(os.tmpdir(), "session-report-json-"));
  const jsonSlug = path.join(jsonDir, "--private-tmp-project-alpha--");
  fs.mkdirSync(jsonSlug, { recursive: true });
  fs.writeFileSync(path.join(jsonSlug, "one.jsonl"), `{"type":"sess\n${lines(goodEntries.slice(1))}\n`);
  fs.writeFileSync(path.join(jsonSlug, "two.jsonl"), lines([{ ...sessionMeta, cwd: "/tmp/project-beta" }, ...goodEntries.slice(1)]));
  const jsonStore = readStore({ roots: [{ harness: "pi", root: jsonDir }], cwdFilter: "project-beta" });
  const jsonReport = JSON.parse(renderJson(buildReport(jsonStore)));

  // F8: an unparsed line is named with its file and line, and an incomplete ledger is not a clean exit.
  const incomplete = fs.mkdtempSync(path.join(os.tmpdir(), "session-report-incomplete-"));
  const incompleteSlug = path.join(incomplete, "--private-tmp-project-alpha--");
  fs.mkdirSync(incompleteSlug, { recursive: true });
  fs.writeFileSync(path.join(incompleteSlug, "one.jsonl"), lines([sessionMeta, ...goodEntries.slice(1)]));
  fs.writeFileSync(path.join(incompleteSlug, "two.jsonl"), `{"type":"sess\n${lines([sessionMeta, ...goodEntries.slice(1)])}\n`);
  const incompleteStore = readStore({ roots: [{ harness: "pi", root: incomplete }] });
  const cleanDir = fs.mkdtempSync(path.join(os.tmpdir(), "session-report-clean-"));
  const cleanSlug = path.join(cleanDir, "--private-tmp-project-alpha--");
  fs.mkdirSync(cleanSlug, { recursive: true });
  fs.writeFileSync(path.join(cleanSlug, "one.jsonl"), lines([sessionMeta, ...goodEntries.slice(1)]));

  after(() => {
    for (const dir of [storeDir, truncatedDir, datedDir, jsonDir, incomplete, cleanDir]) fs.rmSync(dir, { recursive: true, force: true });
  });

  test("a session file that cannot be read is counted, not skipped", () => {
    assert.ok(
      injected.sessions.length === 1 && injected.unreadable.length === 1 && injected.unreadable[0].path === locked,
      JSON.stringify(injected.unreadable),
    );
  });
  test("the readable session's records still reach the totals", () => {
    assert.ok(aggregate(injected.sessions).records.deliberation === 4);
  });
  test("a session directory that cannot be listed is counted, not skipped", () => {
    assert.ok(
      unlistable.unreadable.length === 1 && unlistable.unreadable[0].path === slug && unlistable.sessions.length === 0,
      JSON.stringify(unlistable.unreadable),
    );
  });
  test("a harness with no store is missing, not unreadable", () => {
    assert.ok(readStore({ roots: [{ harness: "pi", root: path.join(storeDir, "nope") }] }).roots[0].missing === true);
  });
  test("the exit status says the store could not be fully read", { skip: rootSkip }, () => {
    fs.chmodSync(locked, 0o000);
    const child = spawnSync(process.execPath, [SCRIPT, "--dir", storeDir], { encoding: "utf8" });
    fs.chmodSync(locked, 0o600);
    assert.ok(
      child.status === 1 && /could not be read/.test(child.stdout),
      `status=${child.status} stdout=${JSON.stringify(child.stdout.split("\n").at(-3))}`,
    );
  });

  test("a filtered read still counts the store's unparsed lines", () => {
    assert.ok(
      filteredStore.store.read === 2 && filteredStore.store.unparsed === 1 && filteredStore.sessions.length === 0,
      JSON.stringify({ ...filteredStore.store, sessions: filteredStore.sessions.length }),
    );
  });
  test("a filter names the session it could not attribute", () => {
    assert.ok(
      filteredStore.store.unattributable.length === 1 && filteredStore.store.unattributable[0].path === truncated,
      JSON.stringify(filteredStore.store.unattributable),
    );
  });
  test("a session merely outside the filter is counted, not named", () => {
    assert.ok(filteredStore.store.excludedByCwd === 1, JSON.stringify(filteredStore.store));
  });
  test("without a filter nothing is excluded or unattributable", () => {
    assert.ok(
      unfilteredStore.store.read === 2 && unfilteredStore.store.unattributable.length === 0 && unfilteredStore.sessions.length === 2,
    );
  });
  test("an unattributable session under a filter exits non-zero", { skip: rootSkip }, () => {
    const child = spawnSync(process.execPath, [SCRIPT, "--dir", truncatedDir, "--cwd", "project-alpha"], {
      encoding: "utf8",
    });
    assert.ok(child.status === 1 && /could not attribute/.test(child.stdout), `status=${child.status}`);
  });

  test("a session with no placeable timestamp is named, not totalled into --since", () => {
    assert.ok(
      windowed.store.unattributable.length === 1 && windowed.store.unattributable[0].path === undated && windowed.sessions.length === 1,
      JSON.stringify({
        sessions: windowed.sessions.length,
        unattributable: windowed.store.unattributable.map((u) => u.path.split("/").at(-1)),
      }),
    );
  });
  test("an explicit --session excluded by a filter is named", () => {
    assert.ok(oneFile.store.unattributable.length === 1 && oneFile.sessions.length === 0);
  });
  test("an unplaceable session under --since exits non-zero", { skip: rootSkip }, () => {
    const child = spawnSync(process.execPath, [SCRIPT, "--dir", datedDir, "--since", "2026-09-19"], {
      encoding: "utf8",
    });
    assert.ok(child.status === 1 && /could not attribute/.test(child.stdout), `status=${child.status}`);
  });
  test("a store left out by --harness is named, not silently absent", () => {
    assert.ok(
      harnessed.store.skippedRoots.length === 1 && harnessed.store.skippedRoots[0].harness === "omp",
      JSON.stringify(harnessed.store.skippedRoots),
    );
  });
  test("an unknown --harness is a named usage error, not a silent exit", { skip: rootSkip }, () => {
    const usageRun = spawnSync(process.execPath, [SCRIPT, "--harness", "foo"], { encoding: "utf8" });
    assert.ok(usageRun.status === 1 && /names no store/.test(usageRun.stderr), `status=${usageRun.status}`);
  });

  // `--check` used to be a mode of this script and is now gone. Without a guard it would have been *ignored* —
  // the reader would print a normal report and exit 0 — which is the silence this repository refuses, and a
  // removed flag is exactly where it hides. Any unknown flag is a usage error naming it and the flags that exist.
  test("an unknown flag is a usage error naming it, not a silently ignored argument", () => {
    const gone = spawnSync(process.execPath, [SCRIPT, "--check"], { encoding: "utf8" });
    assert.ok(
      gone.status === 1 && /unknown flag --check/.test(gone.stderr) && /--json/.test(gone.stderr) && gone.stdout === "",
      `status=${gone.status} stderr=${gone.stderr.split("\n")[0]}`,
    );
    const typo = spawnSync(process.execPath, [SCRIPT, "--cwrd", "x"], { encoding: "utf8" });
    assert.ok(typo.status === 1 && /unknown flag --cwrd/.test(typo.stderr), `status=${typo.status}`);
    // …and a flag that exists still runs and prints its report: this fixture store deliberately holds an
    // unparsed line and an unreadable file, so exit 1 here is the *accounting* saying so, not the flag being
    // refused. The guard rejects ignorance; it does not turn a partial ledger into a usage error.
    const real = spawnSync(process.execPath, [SCRIPT, "--dir", storeDir, "--json"], { encoding: "utf8" });
    assert.ok(
      real.stdout.startsWith("{") && !/unknown flag/.test(real.stderr),
      `head=${real.stdout.slice(0, 20)} stderr=${real.stderr.slice(0, 40)}`,
    );
  });

  test("--json publishes the store's unparsed count, as the text report does", () => {
    assert.ok(
      jsonReport.unparsed === 1 && jsonReport.store.unparsed === 1 && jsonReport.sessions === 1 && jsonReport.sessionsRead === 2,
      JSON.stringify({
        unparsed: jsonReport.unparsed,
        store: jsonReport.store?.unparsed,
        sessions: jsonReport.sessions,
        read: jsonReport.sessionsRead,
      }),
    );
  });

  test("an unparsed line is named with its file and line", () => {
    assert.ok(
      incompleteStore.store.unparsed === 1 &&
        incompleteStore.store.parseFailures.length === 1 &&
        incompleteStore.store.parseFailures[0].path.endsWith("two.jsonl") &&
        incompleteStore.store.parseFailures[0].line === 1,
      JSON.stringify(incompleteStore.store.parseFailures),
    );
  });
  test("an incomplete ledger exits non-zero, a complete one exits 0", { skip: rootSkip }, () => {
    const dirty = spawnSync(process.execPath, [SCRIPT, "--dir", incomplete], { encoding: "utf8" });
    const clean = spawnSync(process.execPath, [SCRIPT, "--dir", cleanDir], { encoding: "utf8" });
    assert.ok(dirty.status === 1 && clean.status === 0, `dirty=${dirty.status} clean=${clean.status}`);
  });
  test("a store that is not there names the path it wanted", { skip: rootSkip }, () => {
    const lonely = spawnSync(process.execPath, [SCRIPT, "--dir", path.join(cleanDir, "absent")], {
      encoding: "utf8",
    });
    assert.ok(lonely.status === 1 && /no sessions directory at/.test(lonely.stderr), `status=${lonely.status}`);
  });
  test("a store with nothing readable names the path and the reason before exiting", { skip: rootSkip }, () => {
    // F7: the one path that exits before `render` still has to say what it could not read
    const blindDir = fs.mkdtempSync(path.join(os.tmpdir(), "session-report-blind-"));
    const blindSlug = path.join(blindDir, "--private-tmp-project-alpha--");
    fs.mkdirSync(blindSlug, { recursive: true });
    fs.writeFileSync(path.join(blindSlug, "one.jsonl"), lines([sessionMeta, ...goodEntries.slice(1)]));
    fs.chmodSync(blindSlug, 0o000);
    const blind = spawnSync(process.execPath, [SCRIPT, "--dir", blindDir], { encoding: "utf8" });
    fs.chmodSync(blindSlug, 0o700);
    assert.ok(
      blind.status === 1 && blind.stderr.includes(blindSlug) && /EACCES|permission denied/.test(blind.stderr),
      `status=${blind.status} stderr=${JSON.stringify(blind.stderr.split("\n")[0])}`,
    );
    fs.rmSync(blindDir, { recursive: true, force: true });
  });
});

// ---- outcomes: the label is the half a run cannot know about itself ---------------------------------
describe("labels and outcomes", () => {
  const labelled = extractSession(
    [
      sessionMeta,
      {
        type: "message",
        message: {
          role: "assistant",
          api: FUSION_API,
          model: "quick",
          usage: usage(30, 3, 0.002),
          content: [],
          details: {
            fusion: "quick",
            seats: [
              { persona: "technical", degraded: false, usage: usage(30, 3, 0.002), durationMs: 4200 },
              { persona: "skeptic", degraded: false, usage: usage(10, 1, 0.001), durationMs: 900 },
            ],
            cascades: [],
            seatErrors: [],
            durationMs: 5300,
            usage: usage(40, 4, 0.003),
          },
        },
      },
      {
        type: "custom_message",
        customType: "matrix-label",
        content: "#12 — review",
        display: true,
        timestamp: "2026-09-19T08:10:00.000Z",
        details: { workItem: "#12", outcome: "review", evidence: "https://example.test/pull/1" },
      },
      {
        type: "custom_message",
        customType: "matrix-label",
        content: "#12 — landed",
        display: true,
        timestamp: "2026-09-19T09:30:00.000Z",
        details: { workItem: "#12", outcome: "landed" },
      },
      { type: "custom_message", customType: "matrix-label", content: "half a label", display: true, details: { workItem: "#12" } },
    ],
    { file: "labelled.jsonl", harness: "pi" },
  );
  const labelledReport = aggregate([labelled]);
  const label = labelledReport.labels.get("#12");

  // A run that names its own work item, in a session nobody labelled: a review runner launched for one piece of
  // work has a session no command can be typed into, so the item travels on the record and the report attributes
  // the run from there. Its outcome is unknown, and says so rather than reading as a success.
  const selfAttributed = extractSession(
    [
      sessionMeta,
      {
        type: "message",
        message: {
          role: "assistant",
          api: FUSION_API,
          provider: "fusion-matrix",
          model: "smrt-review",
          timestamp: "2026-09-20T10:00:00.000Z",
          usage: usage(500, 60, 0.004),
          content: [],
          details: {
            fusion: "smrt-review",
            seats: [],
            seatErrors: [],
            cascades: [],
            durationMs: 1000,
            workItem: "#21",
            usage: usage(500, 60, 0.004),
          },
        },
      },
      {
        type: "custom_message",
        customType: "matrix-answer",
        content: "a run through the tool path",
        display: true,
        timestamp: "2026-09-20T10:05:00.000Z",
        details: { fusion: "review-check", seats: [], seatErrors: [], cascades: [], workItem: "#21", usage: usage(200, 20, 0.001) },
      },
    ],
    { file: "self-attributed.jsonl", harness: "omp" },
  );
  const selfReport = buildReport({ sessions: [selfAttributed], roots: [], unreadable: [] });
  const selfRow = selfReport.labels.get("#21");
  const selfText = render(selfReport);

  // The streamed run's record repeats the usage its message carries: attributing both would count the same
  // tokens on the work item and on the session, which is the double-count this reader exists to avoid.
  const bothSession = extractSession(
    [
      sessionMeta,
      {
        type: "message",
        message: {
          role: "assistant",
          api: FUSION_API,
          provider: "fusion-matrix",
          model: "quick",
          timestamp: "2026-09-20T11:00:00.000Z",
          usage: usage(300, 30, 0.003),
          content: [],
          details: {
            fusion: "quick",
            seats: [],
            seatErrors: [],
            cascades: [],
            durationMs: 900,
            workItem: "#30",
            usage: usage(300, 30, 0.003),
          },
        },
      },
      {
        type: "custom_message",
        customType: "matrix-label",
        content: "#22 — review",
        display: true,
        details: { workItem: "#22", outcome: "review" },
      },
    ],
    { file: "both.jsonl", harness: "omp" },
  );
  const bothReport = buildReport({ sessions: [bothSession], roots: [], unreadable: [] });

  // The other carrier: a `/matrix` run has no assistant message, so its cost lives only in the record — and
  // a streamed run's cost lives only on its message, or the same run is counted twice.
  const commandRun = extractSession(
    [
      sessionMeta,
      {
        type: "custom_message",
        customType: "matrix-answer",
        content: "answer",
        display: true,
        details: {
          fusion: "quick",
          mode: "single",
          seats: [{ persona: "technical", degraded: false, usage: usage(30, 3, 0.002) }],
          cascades: [],
          seatErrors: [],
          durationMs: 1500,
          usage: usage(30, 3, 0.002),
        },
      },
      {
        type: "custom_message",
        customType: "matrix-label",
        content: "#12 — landed",
        display: true,
        timestamp: "2026-09-19T09:30:00.000Z",
        details: { workItem: "#12", outcome: "landed" },
      },
    ],
    { file: "command-run.jsonl", harness: "omp" },
  );
  const commandReport = aggregate([commandRun]);
  const slow = labelledReport.deliberation.get("pi/quick");

  const spentReport = aggregate([
    extractSession(
      [
        sessionMeta,
        {
          type: "message",
          message: {
            role: "assistant",
            api: FUSION_API,
            model: "quick",
            usage: usage(5, 1, 0.001),
            content: [],
            details: {
              proxied: {
                alias: "glm-flash",
                thinking: "low",
                attempts: [
                  { alias: "glm-flash", reason: "quota", detail: "no", usage: usage(100, 10, 0) },
                  { alias: "glm-flash", reason: "transient", detail: "also no" },
                ],
              },
            },
          },
        },
      ],
      { file: "spent.jsonl", harness: "pi" },
    ),
  ]);
  const spent = spentReport.proxy.get("pi/quick");

  // the text surface comes through the same assembly the CLI uses, so a rendering claim is checked there
  // Two work items in one session: each keeps its own labels, and the session's runs are counted once.
  const twoItems = extractSession(
    [
      sessionMeta,
      {
        type: "message",
        message: {
          role: "assistant",
          api: FUSION_API,
          model: "quick",
          usage: usage(10, 1, 0.001),
          content: [],
          details: { fusion: "quick", seats: [], cascades: [], seatErrors: [], usage: usage(10, 1, 0.001) },
        },
      },
      {
        type: "custom_message",
        customType: "matrix-label",
        content: "#12 — review",
        display: true,
        details: { workItem: "#12", outcome: "review", evidence: "https://example.test/12" },
      },
      {
        type: "custom_message",
        customType: "matrix-label",
        content: "#15 — landed",
        display: true,
        details: { workItem: "#15", outcome: "landed" },
      },
    ],
    { file: "two-items.jsonl", harness: "pi" },
  );
  const twoItemReport = aggregate([twoItems]);

  // A label with no timestamp at all still resolves, by read order, rather than picking the oldest by accident
  const undatedSession = extractSession(
    [
      sessionMeta,
      {
        type: "custom_message",
        customType: "matrix-label",
        content: "#12 — review",
        display: true,
        details: { workItem: "#12", outcome: "review" },
      },
      {
        type: "custom_message",
        customType: "matrix-label",
        content: "#12 — landed",
        display: true,
        details: { workItem: "#12", outcome: "landed" },
      },
    ],
    { file: "undated.jsonl", harness: "pi" },
  );
  const undatedLabels = aggregate([undatedSession]);
  const undatedLabelText = render(
    buildReport({
      sessions: [undatedSession],
      roots: [],
      unreadable: [],
      store: {
        read: 1,
        unparsed: 0,
        withoutHeader: 0,
        excludedByCwd: 0,
        excludedBySince: 0,
        skippedRoots: [],
        unattributable: [],
        parseFailures: [],
        parseFailuresNamed: 0,
      },
    }),
  );

  // A dated label beats an undated one, whatever the read order: an absent timestamp is not "newest".
  const mixedSession = extractSession(
    [
      sessionMeta,
      {
        type: "custom_message",
        customType: "matrix-label",
        content: "#12 — review",
        display: true,
        timestamp: "2026-09-19T08:00:00.000Z",
        details: { workItem: "#12", outcome: "review" },
      },
      {
        type: "custom_message",
        customType: "matrix-label",
        content: "#12 — landed",
        display: true,
        details: { workItem: "#12", outcome: "landed" },
      },
    ],
    { file: "mixed.jsonl", harness: "pi" },
  );
  const mixedText = render(
    buildReport({
      sessions: [mixedSession],
      roots: [],
      unreadable: [],
      store: {
        read: 1,
        unparsed: 0,
        withoutHeader: 0,
        excludedByCwd: 0,
        excludedBySince: 0,
        skippedRoots: [],
        unattributable: [],
        parseFailures: [],
        parseFailuresNamed: 0,
      },
    }),
  );

  // The sequence: one session redirects #12 to #15, a later one ends on #12 — the stale note must go.
  const redirectThenEnd = aggregate([
    twoItems,
    extractSession(
      [
        sessionMeta,
        {
          type: "message",
          message: {
            role: "assistant",
            api: FUSION_API,
            model: "quick",
            usage: usage(20, 2, 0.001),
            content: [],
            details: { fusion: "quick", seats: [], cascades: [], seatErrors: [], usage: usage(20, 2, 0.001) },
          },
        },
        {
          type: "custom_message",
          customType: "matrix-label",
          content: "#12 — landed",
          display: true,
          timestamp: "2026-09-19T10:00:00.000Z",
          details: { workItem: "#12", outcome: "landed" },
        },
      ],
      { file: "ends-on-12.jsonl", harness: "omp" },
    ),
  ]);
  const redirectText = render(
    buildReport({
      sessions: [
        twoItems,
        extractSession(
          [
            sessionMeta,
            {
              type: "message",
              message: {
                role: "assistant",
                api: FUSION_API,
                model: "quick",
                usage: usage(20, 2, 0.001),
                content: [],
                details: { fusion: "quick", seats: [], cascades: [], seatErrors: [], usage: usage(20, 2, 0.001) },
              },
            },
            {
              type: "custom_message",
              customType: "matrix-label",
              content: "#12 — landed",
              display: true,
              timestamp: "2026-09-19T10:00:00.000Z",
              details: { workItem: "#12", outcome: "landed" },
            },
          ],
          { file: "ends-on-12.jsonl", harness: "omp" },
        ),
      ],
      roots: [],
      unreadable: [],
      store: {
        read: 2,
        unparsed: 0,
        withoutHeader: 0,
        excludedByCwd: 0,
        excludedBySince: 0,
        skippedRoots: [],
        unattributable: [],
        parseFailures: [],
        parseFailuresNamed: 0,
      },
    }),
  );

  const twoItemText = render(
    buildReport({
      sessions: [twoItems],
      roots: [],
      unreadable: [],
      store: {
        read: 1,
        unparsed: 0,
        withoutHeader: 0,
        excludedByCwd: 0,
        excludedBySince: 0,
        skippedRoots: [],
        unattributable: [],
        parseFailures: [],
        parseFailuresNamed: 0,
      },
    }),
  );

  // The current outcome is the latest by time, not the order the stores were read in.
  // Read order and time order disagree on purpose: the *first* session read carries the *newest* label, so a
  // reader that picks by position reports `landed` where the store says `review`.
  const laterLabelEarlierRead = extractSession(
    [
      sessionMeta,
      {
        type: "custom_message",
        customType: "matrix-label",
        content: "#12 — review",
        display: true,
        timestamp: "2026-09-19T09:00:00.000Z",
        details: { workItem: "#12", outcome: "review" },
      },
    ],
    { file: "newer-later-read.jsonl", harness: "omp" },
  );
  const olderLabelFirstRead = extractSession(
    [
      sessionMeta,
      {
        type: "custom_message",
        customType: "matrix-label",
        content: "#12 — landed",
        display: true,
        timestamp: "2026-09-19T08:00:00.000Z",
        details: { workItem: "#12", outcome: "landed", evidence: "https://example.test/landed" },
      },
    ],
    { file: "older-first-read.jsonl", harness: "pi" },
  );
  const stale = laterLabelEarlierRead;
  const fresh = olderLabelFirstRead;
  const timeReport = aggregate([stale, fresh]);
  const timeText = render(
    buildReport({
      sessions: [stale, fresh],
      roots: [],
      unreadable: [],
      store: {
        read: 2,
        unparsed: 0,
        withoutHeader: 0,
        excludedByCwd: 0,
        excludedBySince: 0,
        skippedRoots: [],
        unattributable: [],
        parseFailures: [],
        parseFailuresNamed: 0,
      },
    }),
  );

  const twoSessions = render(
    buildReport({
      sessions: [labelled, commandRun],
      roots: [{ harness: "pi", root: "/tmp/fixture", files: 2, missing: false }],
      unreadable: [],
      store: {
        read: 2,
        unparsed: 0,
        withoutHeader: 0,
        excludedByCwd: 0,
        excludedBySince: 0,
        skippedRoots: [],
        unattributable: [],
        parseFailures: [],
        parseFailuresNamed: 0,
      },
    }),
  );

  const text = render(
    buildReport({
      sessions: [labelled],
      roots: [{ harness: "pi", root: "/tmp/fixture", files: 1, missing: false }],
      unreadable: [],
      store: {
        read: 1,
        unparsed: 0,
        withoutHeader: 0,
        excludedByCwd: 0,
        excludedBySince: 0,
        skippedRoots: [],
        unattributable: [],
        parseFailures: [],
        parseFailuresNamed: 0,
      },
    }),
  );

  // A store is editable by hand: an outcome nobody defined must not become the current one.
  const handWritten = extractSession(
    [
      sessionMeta,
      {
        type: "custom_message",
        customType: "matrix-label",
        content: "#12 — shipped",
        display: true,
        timestamp: "2026-09-19T10:00:00.000Z",
        details: { workItem: "#12", outcome: "shipped" },
      },
    ],
    { file: "hand-written.jsonl", harness: "pi" },
  );

  // A fast run can legitimately record 0 ms; that is not the same as no clock at all.
  const zeroClock = extractSession(
    [
      sessionMeta,
      {
        type: "custom_message",
        customType: "matrix-answer",
        content: "answer",
        display: true,
        timestamp: "2026-09-19T10:00:00.000Z",
        details: {
          fusion: "quick",
          mode: "single",
          seats: [{ persona: "technical", degraded: false, usage: usage(1, 1, 0.0001), durationMs: 0 }],
          cascades: [],
          seatErrors: [],
          durationMs: 0,
          usage: usage(1, 1, 0.0001),
        },
      },
    ],
    { file: "zero-clock.jsonl", harness: "pi" },
  );
  const zeroText = render(
    buildReport({
      sessions: [zeroClock],
      roots: [],
      unreadable: [],
      store: {
        read: 1,
        unparsed: 0,
        withoutHeader: 0,
        excludedByCwd: 0,
        excludedBySince: 0,
        skippedRoots: [],
        unattributable: [],
        parseFailures: [],
        parseFailuresNamed: 0,
      },
    }),
  );

  test("a label is read with its evidence, and the latest one is the outcome", () => {
    assert.ok(
      label?.outcomes.length === 2 &&
        label.outcomes.at(-1).outcome === "landed" &&
        label.outcomes[0].evidence === "https://example.test/pull/1",
      JSON.stringify(label?.outcomes),
    );
  });
  test("a labelled work item carries its runs, its fusion turns and their cost", () => {
    assert.ok(
      label?.runs === 1 &&
        label?.fusionTurns === 1 &&
        Math.abs((label?.sums.costReported ?? 0) - 0.002) < 1e-9 &&
        label?.fusions.get("quick") === 1,
      JSON.stringify({
        runs: label?.runs,
        turns: label?.fusionTurns,
        cost: label?.sums.costReported,
        fusions: label && Object.fromEntries(label.fusions),
      }),
    );
  });
  test("a label missing half of itself is unrecognised, not counted as a label", () => {
    assert.ok(
      labelled.labels.length === 2 && labelled.unknown.length === 1 && labelledReport.labels.size === 1,
      JSON.stringify({ labels: labelled.labels.length, unknown: labelled.unknown.length }),
    );
  });
  test("a run that names its own work item is attributed to it, with its cost, and no label", () => {
    assert.ok(
      selfRow?.runs === 2 &&
        selfRow?.sessions === 1 &&
        selfRow?.outcomes.length === 0 &&
        Math.abs(selfRow.sums.costReported - 0.005) < 1e-9 &&
        selfRow.fusions.get("smrt-review") === 1 &&
        selfRow.fusions.get("review-check") === 1,
      JSON.stringify({
        runs: selfRow?.runs,
        sessions: selfRow?.sessions,
        cost: selfRow?.sums.costReported,
        fusions: selfRow && Object.fromEntries(selfRow.fusions),
      }),
    );
  });
  test("a work item with runs and no outcome is shown as `?`, not dropped and not a success", () => {
    assert.ok(
      /\s#21\s+\?\s/.test(selfText) && /#21/.test(selfText) && !/\(unlabelled\)/.test(selfText),
      selfText
        .split("\n")
        .filter((l) => l.includes("#21"))
        .join(" // ") || "no #21 row",
    );
  });
  test("a self-attributed run is not also counted on the session's label", () => {
    assert.ok(
      bothReport.labels.get("#30")?.runs === 1 &&
        Math.abs(bothReport.labels.get("#30")?.sums.costReported - 0.003) < 1e-9 &&
        (bothReport.labels.get("#22")?.runs ?? 0) === 0 &&
        Math.abs(bothReport.labels.get("#22")?.sums.costReported ?? 0) < 1e-9,
      JSON.stringify({
        attributed: bothReport.labels.get("#30")?.sums.costReported,
        labelled: bothReport.labels.get("#22")?.sums.costReported,
        labelledRuns: bothReport.labels.get("#22")?.runs,
      }),
    );
  });
  test("a session with runs and no label is counted as unlabelled, never assumed fine", () => {
    assert.ok(
      report.labels.size === 0 && report.unlabelled.runs >= 1 && report.unlabelled.sessions >= 1,
      JSON.stringify(report.unlabelled),
    );
  });
  test("a `/matrix` run's cost is counted from its record, which is the only carrier it has", () => {
    assert.ok(
      Math.abs((commandReport.labels.get("#12")?.sums.costReported ?? 0) - 0.002) < 1e-9 && commandReport.labels.get("#12")?.runs === 1,
      JSON.stringify({ cost: commandReport.labels.get("#12")?.sums, runs: commandReport.labels.get("#12")?.runs }),
    );
  });
  test("a streamed run is not counted twice (its record repeats its message's usage)", () => {
    assert.ok(
      Math.abs((label?.sums.costReported ?? 0) - 0.002) < 1e-9 && Math.abs((label?.sums.totalTokens ?? 0) - 33) < 1e-9,
      JSON.stringify(label?.sums),
    );
  });
  test("per-seat wall clock: the run clock and the slowest seat are read", () => {
    assert.ok(
      slow?.runMs === 5300 &&
        slow?.timedSeats === 2 &&
        slow?.slowestSeat?.durationMs === 4200 &&
        slow?.slowestSeat?.persona === "technical",
      JSON.stringify({ runMs: slow?.runMs, seats: slow?.timedSeats, slowest: slow?.slowestSeat }),
    );
  });
  test("what a failed route spent is counted, and an attempt with no usage adds nothing", () => {
    assert.ok(
      spent?.attemptsSpent.input === 100 &&
        spent?.attemptsSpent.output === 10 &&
        spent?.attemptsSpent.unpricedMessages === 1 &&
        spent?.attempts.get("transient") === 1,
      JSON.stringify(spent?.attemptsSpent),
    );
  });
  test("a session naming two work items keeps each item's own labels, and absorbs neither", () => {
    assert.ok(
      twoItemReport.labels.get("#12")?.outcomes.length === 1 &&
        twoItemReport.labels.get("#12")?.outcomes[0].workItem === "#12" &&
        twoItemReport.labels.get("#15")?.outcomes.length === 1 &&
        twoItemReport.labels.get("#15")?.outcomes[0].workItem === "#15",
      JSON.stringify([...twoItemReport.labels].map(([k, v]) => [k, v.outcomes.map((o) => o.workItem)])),
    );
  });
  test("the session's runs and cost are counted once, under the item it ended on", () => {
    assert.ok(
      twoItemReport.labels.get("#15")?.runs === 1 &&
        Math.abs((twoItemReport.labels.get("#15")?.sums.costReported ?? 0) - 0.001) < 1e-9 &&
        twoItemReport.labels.get("#12")?.runs === 0 &&
        twoItemReport.labels.get("#12")?.attributedTo === "#15" &&
        Math.abs(twoItemReport.labels.get("#12")?.sums.costReported ?? 0) < 1e-12,
      JSON.stringify({ twelve: twoItemReport.labels.get("#12")?.attributedTo, fifteen: twoItemReport.labels.get("#15")?.runs }),
    );
  });
  test("a dated label is the current outcome over an undated one, whatever the read order", () => {
    assert.ok(/#12\s+review/.test(mixedText), mixedText.split("\n").find((l) => l.includes("#12")) ?? "no line");
  });
  test("labels with no timestamp fall back to read order, latest still winning", () => {
    assert.ok(
      undatedLabels.labels.get("#12")?.outcomes.length === 2 && /#12\s+landed/.test(undatedLabelText),
      undatedLabelText.split("\n").find((l) => l.includes("#12")) ?? "no line",
    );
  });
  test("an item attributed in a later session loses the stale note from an earlier one", () => {
    assert.ok(
      redirectThenEnd.labels.get("#12")?.runs === 1 &&
        redirectThenEnd.labels.get("#12")?.attributedTo === undefined &&
        !/runs counted under/.test(redirectText),
      redirectText
        .split("\n")
        .filter((l) => l.includes("#12"))
        .join(" | "),
    );
  });
  test("the report says where an unattributed item's runs were counted", () => {
    assert.ok(
      /runs counted under #15/.test(twoItemText) && /https:\/\/example\.test\/12/.test(twoItemText),
      twoItemText.split("\n").find((l) => l.includes("#12")) ?? "no line",
    );
  });
  test("the printed outcome and evidence come from the newest label", () => {
    assert.ok(
      (() => {
        const line = timeText.split("\n").find((l) => l.includes("#12")) ?? "";
        const ev = timeText.split("\n").find((l) => l.includes("evidence:")) ?? "";
        return /review/.test(line) && /landed/.test(ev);
      })(),
      timeText
        .split("\n")
        .filter((l) => l.includes("#12") || l.includes("evidence:"))
        .join(" | "),
    );
  });
  test("a later-read session does not win over a newer label", () => {
    assert.ok(
      new Date("2026-09-19T09:00:00.000Z") > new Date("2026-09-19T08:00:00.000Z") && timeReport.labels.get("#12")?.outcomes.length === 2,
      JSON.stringify(timeReport.labels.get("#12")?.outcomes.map((o) => [o.outcome, o.at])),
    );
  });
  test("labels from separate sessions say so rather than implying one history", () => {
    assert.ok(
      /3 label\(s\) from separate sessions/.test(twoSessions) && !/latest wins/.test(twoSessions),
      twoSessions.split("\n").find((l) => l.includes("label(s)")) ?? "no line",
    );
  });
  test("the text report prints the outcome, the evidence and the unlabelled count", () => {
    assert.ok(
      /#12\s+landed/.test(text) && /https:\/\/example\.test\/pull\/1/.test(text) && /2 label\(s\), latest wins/.test(text),
      text.split("\n").find((l) => l.includes("#12")) ?? "no label line",
    );
  });
  test("a hand-written outcome outside the vocabulary is unrecognised, not a label", () => {
    assert.ok(
      handWritten.labels.length === 0 && handWritten.unknown.length === 1 && aggregate([handWritten]).labels.size === 0,
      JSON.stringify({ labels: handWritten.labels.length, unknown: handWritten.unknown.length }),
    );
  });
  test("a recorded 0 ms run still prints its clock", () => {
    assert.ok(
      /run time 0\.0s/.test(zeroText) && /1 seat\(s\) timed/.test(zeroText),
      zeroText.split("\n").find((l) => l.includes("run time")) ?? "no run-time line",
    );
  });
});

// ---- omp's device protocol: the record one level in, and the call recorded as `write` -----------------
describe("omp's device protocol", () => {
  // Shapes taken from the live store: a write to `xd://<tool>` invokes it and its result wraps the record as
  // `details.xdev.inner`; a *read* of the same path is discovery and its result carries no wrap; and a device
  // call that *fails* is stored with empty details, so the invoked tool has to come from the call.
  const wrappedRecord = {
    fusion: "quick",
    mode: "single",
    seats: [
      {
        persona: "technical",
        provider: "cline-pass",
        model: "z-ai/glm-5.3-flash",
        degraded: false,
        usage: usage(117, 6, 0.0000138),
        durationMs: 1710,
      },
    ],
    cascades: [],
    seatErrors: [],
    usage: usage(117, 6, 0.0000138),
    durationMs: 1710,
  };
  const deviceSession = extractSession(
    [
      sessionMeta,
      {
        type: "message",
        message: {
          role: "assistant",
          api: "openai-completions",
          provider: "cline-pass",
          model: "z-ai/glm-5.3-flash",
          usage: usage(50, 5, 0.001),
          content: [
            { type: "toolCall", id: "c0", name: "read", arguments: { path: "xd://matrix", i: "Reading matrix tool docs" } },
            {
              type: "toolCall",
              id: "c1",
              name: "write",
              arguments: { path: "xd://matrix", content: '{"prompt": "x", "fusion": "quick"}' },
            },
            { type: "toolCall", id: "c2", name: "write", arguments: { path: "xd://propose", content: "{}" } },
          ],
        },
      },
      {
        type: "message",
        message: {
          role: "toolResult",
          toolCallId: "c0",
          toolName: "read",
          isError: false,
          content: [],
          details: { contentType: "text/markdown", totalLines: 40, displayContent: "# matrix" },
        },
      },
      {
        type: "message",
        message: {
          role: "toolResult",
          toolCallId: "c1",
          toolName: "write",
          isError: false,
          content: [{ type: "text", text: "PANEL-OK" }],
          details: {
            xdev: { tool: "matrix", mode: "execute", tier: "exec", args: { prompt: "x", fusion: "quick" }, inner: wrappedRecord },
          },
        },
      },
      {
        type: "message",
        message: {
          role: "toolResult",
          toolCallId: "c2",
          toolName: "write",
          isError: true,
          content: [{ type: "text", text: "refused" }],
          details: {},
        },
      },
    ],
    { file: "device.jsonl", harness: "omp" },
  );
  const deviceReport = aggregate([deviceSession]);
  const deviceRender = render(
    buildReport({
      sessions: [deviceSession],
      roots: [],
      unreadable: [],
      store: {
        read: 1,
        unparsed: 0,
        withoutHeader: 0,
        excludedByCwd: 0,
        excludedBySince: 0,
        skippedRoots: [],
        unattributable: [],
        parseFailures: [],
        parseFailuresNamed: 0,
      },
    }),
  );

  // pi has no device protocol: a file whose relative path happens to be `xd://matrix` is a write, nothing more.
  // The calling turn is not guaranteed to be the last one before its result, and a result row can be missing
  // entirely (a truncated tail): pairing must survive the first, and the count must survive the second.
  const nonAdjacent = extractSession(
    [
      sessionMeta,
      {
        type: "message",
        message: {
          role: "assistant",
          api: "openai-completions",
          provider: "cline-pass",
          model: "z-ai/glm-5.3-flash",
          usage: usage(10, 2, 0.001),
          content: [{ type: "toolCall", id: "n1", name: "write", arguments: { path: "xd://propose", content: "{}" } }],
        },
      },
      {
        type: "message",
        message: {
          role: "assistant",
          api: "openai-completions",
          provider: "cline-pass",
          model: "z-ai/glm-5.3-flash",
          usage: usage(10, 2, 0.001),
          content: [],
        },
      },
      {
        type: "message",
        message: {
          role: "toolResult",
          toolCallId: "n1",
          toolName: "write",
          isError: true,
          content: [{ type: "text", text: "refused" }],
          details: {},
        },
      },
    ],
    { file: "non-adjacent.jsonl", harness: "omp" },
  );
  const nonAdjacentReport = aggregate([nonAdjacent]);
  const noResult = extractSession(
    [
      sessionMeta,
      {
        type: "message",
        message: {
          role: "assistant",
          api: "openai-completions",
          provider: "cline-pass",
          model: "z-ai/glm-5.3-flash",
          usage: usage(10, 2, 0.001),
          content: [{ type: "toolCall", id: "d1", name: "write", arguments: { path: "xd://matrix", content: "{}" } }],
        },
      },
    ],
    { file: "no-result.jsonl", harness: "omp" },
  );
  const noResultReport = aggregate([noResult]);

  // Reading one file explicitly must keep the harness it came from: the device rewrite is gated on omp, and a
  // file selected by path is the same session whether it was found through the root or handed over directly.
  const ompDir = fs.mkdtempSync(path.join(os.tmpdir(), "session-report-"));
  fs.mkdirSync(path.join(ompDir, ".omp", "agent", "sessions", "--slug--"), { recursive: true });
  const ompFile = path.join(ompDir, ".omp", "agent", "sessions", "--slug--", "one.jsonl");
  fs.writeFileSync(
    ompFile,
    lines([
      sessionMeta,
      {
        type: "message",
        message: {
          role: "assistant",
          api: "openai-completions",
          provider: "cline-pass",
          model: "z-ai/glm-5.3-flash",
          usage: usage(10, 2, 0.001),
          content: [{ type: "toolCall", id: "s1", name: "write", arguments: { path: "xd://matrix", content: "{}" } }],
        },
      },
    ]),
  );
  const byPath = readStore({ sessionFile: ompFile });
  const byPathReport = aggregate(byPath.sessions);
  const piWrite = extractSession(
    [
      sessionMeta,
      {
        type: "message",
        message: {
          role: "assistant",
          api: "anthropic-messages",
          provider: "opencode-go",
          model: "glm-5.3-flash",
          usage: usage(10, 2, 0.001),
          content: [{ type: "toolCall", id: "p1", name: "write", arguments: { path: "xd://matrix", content: "hi" } }],
        },
      },
      {
        type: "message",
        message: {
          role: "toolResult",
          toolCallId: "p1",
          toolName: "write",
          isError: false,
          content: [],
          details: { diff: "…", op: "create", path: "xd://matrix" },
        },
      },
    ],
    { file: "pi-write.jsonl", harness: "pi" },
  );
  const piReport = aggregate([piWrite]);

  after(() => fs.rmSync(ompDir, { recursive: true, force: true }));

  test("a record omp wrapped in its device protocol is read, not dropped", () => {
    assert.ok(
      deviceReport.records.deliberation === 1 &&
        deviceReport.deliberation.get("omp/quick")?.runs === 1 &&
        deviceReport.unknownShapes.length === 0,
      JSON.stringify({ records: deviceReport.records, unknown: deviceReport.unknownShapes.length }),
    );
  });
  test("the unwrapped record keeps its fusion, seats, usage and clock", () => {
    assert.ok(
      deviceReport.deliberation.get("omp/quick")?.seats === 1 &&
        Math.abs((deviceReport.deliberation.get("omp/quick")?.sums.costReported ?? 0) - 0.0000138) < 1e-12 &&
        deviceReport.deliberation.get("omp/quick")?.slowestSeat?.durationMs === 1710,
      JSON.stringify({ seats: deviceReport.deliberation.get("omp/quick")?.seats, sums: deviceReport.deliberation.get("omp/quick")?.sums }),
    );
  });
  test("an invocation is attributed to the tool it invoked, and reading its docs is not one", () => {
    assert.ok(
      deviceSession.turns[0].toolCalls.join(",") === "read,matrix,propose" &&
        deviceReport.toolCalls.get("omp/matrix") === 1 &&
        deviceReport.toolCalls.get("omp/propose") === 1 &&
        (deviceReport.toolCalls.get("omp/write") ?? 0) === 0,
      JSON.stringify({ calls: deviceSession.turns[0].toolCalls, counted: Object.fromEntries(deviceReport.toolCalls) }),
    );
  });
  test("a device result is named by the tool that ran, even when omp wrapped nothing", () => {
    assert.ok(
      deviceSession.toolResults.map((r) => r.toolName).join(",") === "read,matrix,propose" &&
        (deviceReport.tools.get("omp/propose")?.errors ?? 0) === 1 &&
        (deviceReport.tools.get("omp/write")?.errors ?? 0) === 0,
      JSON.stringify({
        rows: deviceSession.toolResults.map((r) => r.toolName),
        tools: Object.fromEntries([...deviceReport.tools].map(([k, v]) => [k, v.errors])),
      }),
    );
  });
  test("the device count is a count of invocations, not of wrapped results", () => {
    assert.ok(
      deviceReport.gaps.wrappedCalls === 2 && /2 call\(s\) made through omp's `xd:\/\/` device/.test(deviceRender),
      `${deviceReport.gaps.wrappedCalls}`,
    );
  });
  test("a device result is paired with its call even when another turn intervenes", () => {
    assert.ok(
      nonAdjacent.toolResults[0]?.toolName === "propose" &&
        (nonAdjacentReport.tools.get("omp/propose")?.errors ?? 0) === 1 &&
        (nonAdjacentReport.tools.get("omp/write")?.errors ?? 0) === 0 &&
        nonAdjacentReport.gaps.wrappedCalls === 1,
      JSON.stringify({
        named: nonAdjacent.toolResults[0]?.toolName,
        tools: Object.fromEntries([...nonAdjacentReport.tools].map(([k, v]) => [k, v.errors])),
        device: nonAdjacentReport.gaps.wrappedCalls,
      }),
    );
  });
  test("an invocation whose result never reached the store is still counted as a device call", () => {
    assert.ok(
      noResultReport.gaps.wrappedCalls === 1 && noResultReport.toolCalls.get("omp/matrix") === 1 && noResult.toolResults.length === 0,
      JSON.stringify({
        device: noResultReport.gaps.wrappedCalls,
        calls: Object.fromEntries(noResultReport.toolCalls),
        results: noResult.toolResults.length,
      }),
    );
  });
  test("a session read by path keeps the harness it lives in", () => {
    assert.ok(
      byPath.sessions[0]?.harness === "omp" &&
        byPathReport.toolCalls.get("omp/matrix") === 1 &&
        byPathReport.gaps.wrappedCalls === 1 &&
        (byPathReport.toolCalls.get("omp/write") ?? 0) === 0,
      JSON.stringify({
        harness: byPath.sessions[0]?.harness,
        calls: Object.fromEntries(byPathReport.toolCalls),
        device: byPathReport.gaps.wrappedCalls,
      }),
    );
  });
  test("only omp has a device protocol: a pi write to `xd://…` is a write", () => {
    assert.ok(
      piWrite.turns[0].toolCalls.join(",") === "write" &&
        piReport.toolCalls.get("pi/write") === 1 &&
        (piReport.toolCalls.get("pi/matrix") ?? 0) === 0 &&
        piReport.gaps.wrappedCalls === 0,
      JSON.stringify({
        calls: piWrite.turns[0].toolCalls,
        counted: Object.fromEntries(piReport.toolCalls),
        device: piReport.gaps.wrappedCalls,
      }),
    );
  });
});

describe("review dispositions", () => {
  // A review rung's disposition, as the report has to read it. The path check is the point: `extensions/…/run.js`
  // exists under the session's cwd, `src/disposition.ts` does not, and a report that printed both alike would be
  // laundering a hallucinated location into a fact.
  const reviewDir = fs.mkdtempSync(path.join(os.tmpdir(), "session-report-review-"));
  fs.mkdirSync(path.join(reviewDir, "extensions/pi-fusion-matrix"), { recursive: true });
  fs.writeFileSync(path.join(reviewDir, "extensions/pi-fusion-matrix/run.js"), "// a real file\n");
  const reviewSession = extractSession(
    [
      { ...sessionMeta, cwd: reviewDir },
      {
        type: "message",
        message: {
          role: "assistant",
          api: FUSION_API,
          provider: "fusion-matrix",
          model: "review-check",
          usage: usage(500, 100, 0.004),
          content: [{ type: "text", text: '{"verdict":"findings"}' }],
          details: {
            fusion: "review-check",
            seats: [],
            seatErrors: [],
            usage: usage(500, 100, 0.004),
            dispositionBy: "review-synth",
            verdict: "findings",
            severityCounts: { blocking: 1, editorial: 1 },
            findings: [
              {
                severity: "blocking",
                path: "extensions/pi-fusion-matrix/run.js",
                line: 42,
                criterion: "no silent degradation",
                claim: "the refusal is swallowed\nand then some",
              },
              {
                severity: "editorial",
                path: "src/disposition.ts",
                line: null,
                criterion: "docs match evidence",
                claim: "a count went stale",
              },
            ],
          },
        },
      },
      {
        type: "message",
        message: {
          role: "assistant",
          api: FUSION_API,
          provider: "fusion-matrix",
          model: "review-quick",
          usage: usage(400, 60, 0.003),
          content: [{ type: "text", text: "I could not read the diff." }],
          details: {
            fusion: "review-quick",
            seats: [],
            seatErrors: [],
            usage: usage(400, 60, 0.003),
            malformedAnswers: [{ persona: "review-synth", reason: "the answer was not a JSON object" }],
          },
        },
      },
      // A malformed answer that a later one superseded, and a finding naming an absolute path — which is outside
      // the session's tree by construction and therefore cannot be verified at all, let alone "found".
      {
        type: "message",
        message: {
          role: "assistant",
          api: FUSION_API,
          provider: "fusion-matrix",
          model: "review-single",
          usage: usage(300, 40, 0.002),
          content: [{ type: "text", text: '{"verdict":"clean"}' }],
          details: {
            fusion: "review-single",
            seats: [],
            seatErrors: [],
            usage: usage(300, 40, 0.002),
            dispositionBy: "review-synth",
            verdict: "clean",
            severityCounts: {},
            malformedAnswers: [{ persona: "judge", reason: "the answer was not a JSON object", supersededBy: "review-synth" }],
            findings: [
              { severity: "minor", path: "/etc/passwd", line: null, criterion: "c", claim: "a path outside the tree" },
              { severity: "major", path: "../outside/secret.ts", line: 3, criterion: "c", claim: "a relative path that leaves the tree" },
            ],
          },
        },
      },
    ],
    { file: "review.jsonl", harness: "pi" },
  );
  const reviewReport = buildReport({ sessions: [reviewSession], roots: [], unreadable: [] });
  const reviewRow = reviewReport.deliberation.get("pi/review-check");
  const reviewText = render(reviewReport);

  // A run can fail its contract more than once. The chain is counted entry by entry, because a record that kept
  // only the last bad answer would have lost the earlier ones — the exact loss this shape exists to prevent.
  const chainedSession = extractSession(
    [
      { ...sessionMeta, cwd: reviewDir },
      {
        type: "message",
        message: {
          role: "assistant",
          api: FUSION_API,
          provider: "fusion-matrix",
          model: "review-check",
          usage: usage(200, 20, 0.001),
          content: [{ type: "text", text: "not a disposition" }],
          details: {
            fusion: "review-check",
            seats: [],
            seatErrors: [],
            usage: usage(200, 20, 0.001),
            malformedAnswers: [
              { persona: "judge", reason: "the answer was not a JSON object", supersededBy: "review-synth" },
              { persona: "review-synth", reason: "verdict is not one of clean|findings" },
            ],
          },
        },
      },
    ],
    { file: "chained.jsonl", harness: "pi" },
  );
  const chainedReport = buildReport({ sessions: [chainedSession], roots: [], unreadable: [] });
  const chainedReview = chainedReport.deliberation.get("pi/review-check")?.review;

  after(() => fs.rmSync(reviewDir, { recursive: true, force: true }));

  // Two runs, two rungs: a row is a fusion, so the disposition of `review-check` and the malformed answer of
  // `review-quick` are counted under their own rows rather than pooled into one.
  test("a review disposition is counted: verdict, the persona that stands, severities and paths", () => {
    assert.ok(
      reviewRow?.review.runs === 1 &&
        reviewRow?.review.verdicts.get("findings") === 1 &&
        reviewRow?.review.by.get("review-synth") === 1 &&
        reviewRow?.review.severities.get("blocking") === 1 &&
        reviewRow?.review.severities.get("editorial") === 1 &&
        reviewRow?.review.paths === 2 &&
        reviewRow?.review.pathsMissing === 1 &&
        reviewRow?.review.pathsOutside === 0 &&
        reviewRow?.review.malformed === 0,
      JSON.stringify({
        runs: reviewRow?.review.runs,
        paths: reviewRow?.review.paths,
        missing: reviewRow?.review.pathsMissing,
        malformed: reviewRow?.review.malformed,
      }),
    );
  });
  test("a finding whose path is not in the session cwd is marked, and a real one is not", () => {
    assert.ok(
      /\[path not found\] editorial src\/disposition\.ts/.test(reviewText) &&
        !/\[path not found\] blocking extensions\/pi-fusion-matrix\/run\.js/.test(reviewText) &&
        /blocking extensions\/pi-fusion-matrix\/run\.js:42/.test(reviewText),
      reviewText
        .split("\n")
        .filter((l) => l.includes("blocking") || l.includes("editorial"))
        .slice(0, 3)
        .join(" // "),
    );
  });
  test("a malformed answer is reported by reason, with no verdict beside it", () => {
    assert.ok(
      reviewReport.deliberation.get("pi/review-quick")?.review.malformed === 1 &&
        /malformed 1 ×: the answer was not a JSON object/.test(reviewText) &&
        reviewRow?.review.reasons.size === 0,
      reviewText.split("\n").find((l) => l.includes("malformed 1 ×")) ?? "no malformed line",
    );
  });
  // An absolute path never resolves inside the session's tree, and a relative one can leave it while looking
  // innocent: `../outside/secret.ts` joins to a real file outside. Both are reported *unchecked*, because resolving
  // either would let a hallucinated path read as found — the laundering the check exists to prevent.
  test("an absolute or escaping finding path is marked unchecked rather than resolved", () => {
    assert.ok(
      /\[path outside the session\] minor \/etc\/passwd/.test(reviewText) &&
        /\[path outside the session\] major \.\.\/outside\/secret\.ts/.test(reviewText) &&
        reviewReport.deliberation.get("pi/review-single")?.review.pathsOutside === 2 &&
        reviewReport.deliberation.get("pi/review-single")?.review.pathsMissing === 0,
      reviewText
        .split("\n")
        .filter((l) => l.includes("passwd") || l.includes("secret"))
        .join(" // "),
    );
  });
  test("a superseded malformed answer is named as superseded, not hidden", () => {
    assert.ok(
      /malformed 1 × \(1 superseded by a later answer\)/.test(reviewText) &&
        reviewReport.deliberation.get("pi/review-single")?.review.superseded === 1 &&
        reviewReport.deliberation.get("pi/review-single")?.review.verdicts.get("clean") === 1,
      reviewText.split("\n").find((l) => l.includes("superseded")) ?? "no superseded line",
    );
  });
  test("two bad answers are both counted, and the chain says which one stands", () => {
    assert.ok(
      chainedReview?.malformed === 2 &&
        chainedReview?.superseded === 1 &&
        chainedReview?.reasons.get("the answer was not a JSON object") === 1 &&
        render(chainedReport).includes("malformed 2 × (1 superseded by a later answer)"),
      JSON.stringify({
        malformed: chainedReview?.malformed,
        superseded: chainedReview?.superseded,
        reasons: [...(chainedReview?.reasons ?? [])],
      }),
    );
  });
});

// ---- plan windows: the harness's own ledger, read read-only, and joined to our refusals -------------
// The ledger is read before the suite runs, because reading it is asynchronous. A node without `node:sqlite`
// gets its plan-window checks *skipped* — reported as skipped, never silently passed.
let sqlite = null;
try {
  sqlite = await import("node:sqlite");
} catch {
  /* reported below as a skip, not a silent pass */
}
const noSqlite = sqlite === null ? "this node has no node:sqlite" : false;

/** The instant the ledger fixture is written around: every reading below is before it or after it. */
const T = Date.parse("2026-09-20T10:00:00Z");

/** omp's own table, with the rows the plan-window checks read. Returns the ledger's path. */
function writeLedgerFixture(dir) {
  const ledger = path.join(dir, "agent.db");
  const db = new sqlite.DatabaseSync(ledger);
  db.exec(
    "CREATE TABLE usage_history (id INTEGER PRIMARY KEY, recorded_at INTEGER, provider TEXT, account_key TEXT, limit_id TEXT, label TEXT, window_label TEXT, used_fraction REAL, status TEXT, resets_at INTEGER)",
  );
  const insert = db.prepare(
    "INSERT INTO usage_history (recorded_at, provider, limit_id, label, window_label, used_fraction, status, resets_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  );
  insert.run(T - 600000, "opencode-go", "weekly", "Weekly limit", "Weekly", 1, "exhausted", Date.parse("2026-09-21T00:00:00Z"));
  // the same window read again, still exhausted: only the latest reading may stand for the window
  insert.run(T - 60000, "opencode-go", "weekly", "Weekly limit", "Weekly", 1, "exhausted", Date.parse("2026-09-21T00:00:00Z"));
  insert.run(T - 60000, "zai", "zai:tokens:5h", "ZAI 5 Hours", "5 Hours", 0, "ok", 0); // no reset stated
  insert.run(Date.parse("2026-08-05T13:00:00Z"), "kimi-code", "kimi-code:1", "5h limit", "5h limit", 0, "ok", 0); // stale
  db.close();
  return ledger;
}

const ledgerDir = sqlite === null ? undefined : fs.mkdtempSync(path.join(os.tmpdir(), "session-report-ledger-"));
const ledger = sqlite === null ? undefined : writeLedgerFixture(ledgerDir);
const plans = sqlite === null ? undefined : await readPlanWindows({ dbPath: ledger });

describe("plan windows", () => {
  after(() => {
    if (ledgerDir !== undefined) fs.rmSync(ledgerDir, { recursive: true, force: true });
  });

  // the join: a refusal is only explained by a reading taken *before* it that had not reset
  const windows = [
    {
      provider: "opencode-go",
      limitId: "weekly",
      label: "Weekly",
      status: "exhausted",
      usedFraction: 1,
      resetsAt: Date.parse("2026-09-21T00:00:00Z"),
      recordedAt: T - 60000,
    },
    { provider: "zai", limitId: "5h", label: "5h", status: "ok", usedFraction: 0, resetsAt: 0, recordedAt: T - 60000 },
    {
      provider: "kimi-code",
      limitId: "1w",
      label: "weekly",
      status: "ok",
      usedFraction: 0.2,
      resetsAt: Date.parse("2026-09-24T00:00:00Z"),
      recordedAt: Date.parse("2026-08-05T13:00:00Z"),
    },
  ];
  // A fusion row is present on purpose: scraping providers from row keys would report `fusion:quick` as one.
  const refusalReport = {
    providers: new Map([["omp", new Set(["opencode-go", "zai", "kimi-code", "bifrost"])]]),
    turns: new Map([["omp/fusion:quick", { key: "omp/fusion:quick", fusion: true }]]),
    quotaRefusals: [
      { at: T, provider: "opencode-go", harness: "omp" }, // covered, exhausted
      { at: T, provider: "zai", harness: "omp" }, // covered, ok
      { at: Date.parse("2026-08-01T00:00:00Z"), provider: "kimi-code", harness: "omp" }, // before its only reading: uncovered
      { at: Date.parse("2026-09-25T00:00:00Z"), provider: "kimi-code", harness: "omp" }, // after that window reset: uncovered
      { at: T, provider: "bifrost", harness: "omp" }, // no window at all
    ],
  };
  const history = [
    {
      provider: "opencode-go",
      limitId: "weekly",
      label: "Weekly",
      status: "exhausted",
      usedFraction: 1,
      resetsAt: Date.parse("2026-09-21T00:00:00Z"),
      recordedAt: T - 600000,
    },
    // read again *after* the refusal, and reading ok: the moment is still the exhausted one, so the later
    // reading must not be allowed to stand for the window and call the refusal unexplained.
    {
      provider: "opencode-go",
      limitId: "weekly",
      label: "Weekly",
      status: "ok",
      usedFraction: 0.1,
      resetsAt: Date.parse("2026-09-21T00:00:00Z"),
      recordedAt: T + 600000,
    },
    { provider: "zai", limitId: "5h", label: "5h", status: "ok", usedFraction: 0, resetsAt: 0, recordedAt: T - 60000 },
    // a status that is neither ok nor exhausted: kept as what it read, not folded into `ok`
    { provider: "warning-co", limitId: "5h", label: "5h", status: "warning", usedFraction: 0.8, resetsAt: 0, recordedAt: T - 60000 },
    {
      provider: "kimi-code",
      limitId: "1w",
      label: "weekly",
      status: "ok",
      usedFraction: 0.2,
      resetsAt: Date.parse("2026-09-24T00:00:00Z"),
      recordedAt: Date.parse("2026-08-05T13:00:00Z"),
    },
    // a pi session's provider: only omp keeps this ledger, so a refusal from pi is not "uncovered"
    { provider: "pi-only", limitId: "5h", label: "5h", status: "ok", usedFraction: 0, resetsAt: 0, recordedAt: T - 60000 },
  ];
  const join = joinPlanWindows(
    {
      ...refusalReport,
      quotaRefusals: [
        ...refusalReport.quotaRefusals,
        { at: T, provider: "warning-co", harness: "omp" },
        { at: T, provider: "pi-only", harness: "pi" },
      ],
    },
    { available: true, windows, history },
  );
  const byProvider = Object.fromEntries(join.byProvider.map((r) => [r.provider, r]));
  // A provider absent from the ledger is a fact about the ledger, and it is named whether or not any refusal
  // was recorded.
  const noRefusalJoin = joinPlanWindows(
    { providers: new Map([["omp", new Set(["opencode-go", "ghost"])]]), quotaRefusals: [] },
    { available: true, windows, history },
  );

  const now = Date.parse("2026-09-20T10:00:00Z");
  // Providers come from the run records, and a fusion turn's provider is this extension's api id: it must not
  // appear as a provider the ledger failed to record.
  const fusionTurn = aggregate([
    extractSession(
      [
        sessionMeta,
        {
          type: "message",
          message: {
            role: "assistant",
            api: FUSION_API,
            provider: "fusion-matrix",
            model: "quick",
            usage: usage(5, 1, 0.001),
            content: [],
          },
        },
        {
          type: "message",
          message: {
            role: "assistant",
            api: "openai-completions",
            provider: "cline-pass",
            model: "z-ai/glm-5.3-flash",
            usage: usage(5, 1, 0.001),
            content: [],
          },
        },
      ],
      { file: "providers.jsonl", harness: "omp" },
    ),
  ]);
  const providersJoin = joinPlanWindows(fusionTurn, {
    available: true,
    windows: [{ provider: "cline-pass", limitId: "5h", label: "5h", status: "ok", usedFraction: 0, resetsAt: 0, recordedAt: now - 60000 }],
  });

  // A refusal belongs to the route that was refused, not to the provider that ended up answering: a record
  // whose surviving route is the fallback still carries each attempt's own provider.
  const attributed = aggregate([
    extractSession(
      [
        sessionMeta,
        {
          type: "message",
          message: {
            role: "assistant",
            api: FUSION_API,
            provider: "fusion-matrix",
            model: "quick",
            timestamp: "2026-09-20T10:00:00Z",
            usage: usage(5, 1, 0.001),
            content: [],
            details: {
              proxied: {
                alias: "qwen-max",
                provider: "alibaba-token-plan",
                model: "qwen3.8-max",
                thinking: "low",
                attempts: [
                  {
                    alias: "qwen-max",
                    seat: "qwen-max@opencode-go",
                    provider: "opencode-go",
                    model: "qwen3.8-max",
                    reason: "quota",
                    detail: "429 usage limit",
                  },
                ],
              },
            },
          },
        },
      ],
      { file: "attempts.jsonl", harness: "omp" },
    ),
  ]);
  const attemptJoin = joinPlanWindows(attributed, {
    available: true,
    windows: [
      {
        provider: "opencode-go",
        limitId: "weekly",
        label: "Weekly",
        status: "exhausted",
        usedFraction: 1,
        resetsAt: 0,
        recordedAt: now - 60000,
      },
      { provider: "alibaba-token-plan", limitId: "5h", label: "5h", status: "ok", usedFraction: 0, resetsAt: 0, recordedAt: now - 60000 },
    ],
  });

  // A seat that never resolved a provider names the gap rather than printing `undefined`.
  const unresolvedSeat = aggregate([
    extractSession(
      [
        sessionMeta,
        {
          type: "custom_message",
          customType: "matrix-answer",
          content: "x",
          display: true,
          timestamp: "2026-09-20T10:00:00Z",
          details: {
            fusion: "quick",
            mode: "single",
            seats: [
              {
                persona: "technical",
                degraded: true,
                error: "all candidates failed: quota",
                attempts: [{ alias: "a", reason: "quota", detail: "quota" }],
              },
            ],
            cascades: [],
            seatErrors: [{ persona: "technical", reason: "quota" }],
          },
        },
      ],
      { file: "unresolved.jsonl", harness: "omp" },
    ),
  ]);
  const unresolvedJoin = joinPlanWindows(unresolvedSeat, { available: true, windows: [] });

  test("the ledger is read read-only, latest reading per window", { skip: noSqlite }, () => {
    assert.ok(
      plans.available === true &&
        plans.readings === 4 &&
        plans.windows.length === 3 &&
        plans.windows.find((w) => w.provider === "opencode-go")?.recordedAt === T - 60000,
      JSON.stringify({
        available: plans.available,
        readings: plans.readings,
        windows: plans.windows.map((w) => [w.provider, w.recordedAt]),
      }),
    );
  });
  test("a reset the provider never stated is not 1970", { skip: noSqlite }, () => {
    assert.ok(
      plans.windows.find((w) => w.provider === "zai")?.resetsAt === 0 &&
        /no reset stated/.test(
          render({
            ...aggregate([]),
            plans,
            planJoin: { total: 0, byProvider: [], uncoveredProviders: [] },
            roots: [],
            store: { unreadable: [], skippedRoots: [], unattributable: [], parseFailures: [], unparsed: 0, read: 0 },
          }),
        ) &&
        !/1970/.test(
          render({
            ...aggregate([]),
            plans,
            planJoin: { total: 0, byProvider: [], uncoveredProviders: [] },
            roots: [],
            store: { unreadable: [], skippedRoots: [], unattributable: [], parseFailures: [], unparsed: 0, read: 0 },
          }),
        ),
      JSON.stringify(plans.windows.find((w) => w.provider === "zai")),
    );
  });
  test("a ledger that is not there is a named absence, not an empty table", { skip: noSqlite }, async () => {
    const absent = await readPlanWindows({ dbPath: path.join(ledgerDir, "nope.db") });
    assert.ok(absent.reason?.includes("no plan ledger at") === true, String(absent.reason));
  });
  test("a refusal is explained only by a reading that covers its moment, and what it read then", { skip: noSqlite }, () => {
    assert.ok(
      join.total === 7 &&
        byProvider["opencode-go"]?.exhausted === 1 &&
        byProvider["zai"]?.ok === 1 &&
        byProvider["kimi-code"]?.uncovered === 2 &&
        byProvider["bifrost"]?.uncovered === 1 &&
        join.uncoveredProviders.join(",") === "bifrost",
      JSON.stringify(join),
    );
  });
  test("a window that resets before the refusal does not explain it", { skip: noSqlite }, () => {
    assert.ok(byProvider["kimi-code"]?.ok === 0 && byProvider["kimi-code"]?.exhausted === 0, JSON.stringify(byProvider["kimi-code"]));
  });
  // The reading a refusal is joined to is the latest one *before* it: taking the window's latest row would let
  // a reading taken afterwards shadow the one that actually covered the moment.
  test("a reading taken after the refusal does not stand for the window", { skip: noSqlite }, () => {
    assert.ok(byProvider["opencode-go"]?.exhausted === 1 && byProvider["opencode-go"]?.ok === 0, JSON.stringify(byProvider["opencode-go"]));
  });
  // Every covering reading is kept by the status it actually had: `warning` is not `ok`.
  test("a covering reading keeps its own status", { skip: noSqlite }, () => {
    assert.ok(
      byProvider["warning-co"]?.byStatus.get("warning") === 1 &&
        byProvider["warning-co"]?.ok === 0 &&
        byProvider["warning-co"]?.uncovered === 0,
      JSON.stringify([...(byProvider["warning-co"]?.byStatus ?? [])]),
    );
  });
  // A pi session has no plan ledger, so its refusal is reported as exactly that rather than as unexplained.
  test("a refusal from a store with no plan ledger is named, not counted as uncovered", { skip: noSqlite }, () => {
    assert.ok(
      join.withoutLedger === 1 && byProvider["pi-only"] === undefined,
      JSON.stringify({ withoutLedger: join.withoutLedger, piOnly: byProvider["pi-only"] }),
    );
  });
  test("a provider with no window is named even when no refusal was recorded", { skip: noSqlite }, () => {
    const noRefusalText = render({
      ...aggregate([]),
      plans,
      planJoin: noRefusalJoin,
      roots: [],
      store: { unreadable: [], skippedRoots: [], unattributable: [], parseFailures: [], unparsed: 0, read: 0 },
    });
    assert.ok(
      noRefusalJoin.total === 0 &&
        noRefusalJoin.uncoveredProviders.join(",") === "ghost" &&
        /providers we used with no window in the ledger: ghost/.test(noRefusalText),
      noRefusalText
        .split("\n")
        .filter((l) => l.includes("no window") || l.includes("nothing to join"))
        .join(" // "),
    );
  });

  test("this extension's own api id is not a provider we failed to find a window for", { skip: noSqlite }, () => {
    assert.ok(
      providersJoin.uncoveredProviders.length === 0 &&
        fusionTurn.providers.get("omp")?.has("cline-pass") === true &&
        [...(fusionTurn.providers.get("omp") ?? [])].includes("fusion-matrix") === false,
      JSON.stringify({ uncovered: providersJoin.uncoveredProviders, providers: [...(fusionTurn.providers.get("omp") ?? [])] }),
    );
  });
  test("a quota refusal is attributed to the route that was refused, not to the one that answered", { skip: noSqlite }, () => {
    assert.ok(
      attributed.quotaRefusals[0]?.provider === "opencode-go" &&
        attemptJoin.byProvider[0]?.provider === "opencode-go" &&
        attemptJoin.byProvider[0]?.exhausted === 1,
      JSON.stringify({ refusals: attributed.quotaRefusals, join: attemptJoin.byProvider }),
    );
  });
  test("a refusal with no provider resolved is named, not printed as `undefined`", { skip: noSqlite }, () => {
    assert.ok(
      unresolvedJoin.byProvider[0]?.provider === "unknown" &&
        unresolvedSeat.quotaRefusals[0]?.provider === "unknown" &&
        !/undefined/.test(
          render(
            buildReport({
              sessions: [],
              roots: [],
              unreadable: [],
              store: {
                read: 0,
                unparsed: 0,
                withoutHeader: 0,
                excludedByCwd: 0,
                excludedBySince: 0,
                skippedRoots: [],
                unattributable: [],
                parseFailures: [],
                parseFailuresNamed: 0,
              },
            }),
          ).replace(/^[\s\S]*plan windows/, "") + JSON.stringify(unresolvedJoin),
        ),
      JSON.stringify(unresolvedJoin.byProvider),
    );
  });
});

describe("seats by model", () => {
  // The join this view exists for: a panel seat answers findings as data, they ride that seat's record, and the
  // model is on the same record — so "how is this model doing" is a question the store can answer, over days.
  const modelsDir = fs.mkdtempSync(path.join(os.tmpdir(), "session-report-models-"));
  fs.mkdirSync(path.join(modelsDir, "extensions/pi-fusion-matrix"), { recursive: true });
  fs.writeFileSync(path.join(modelsDir, "extensions/pi-fusion-matrix/run.js"), "// a real file\n");
  const seatFinding = (over) => ({
    severity: "major",
    criterion: "c1",
    claim: "…",
    path: "extensions/pi-fusion-matrix/run.js",
    line: 12,
    ...over,
  });
  const modelSession = extractSession(
    [
      { ...sessionMeta, cwd: modelsDir },
      {
        type: "custom_message",
        customType: "matrix-answer",
        content: "a review",
        display: true,
        timestamp: "2026-09-21T09:00:00.000Z",
        details: {
          fusion: "review-check",
          seatErrors: [],
          usage: usage(600, 60, 0.05),
          seats: [
            {
              persona: "review-skeptic",
              provider: "opencode-go",
              model: "deepseek-v4-pro",
              degraded: false,
              durationMs: 40000,
              usage: usage(400, 40, 0.03),
              attempts: [{ reason: "transient" }],
              verdict: "findings",
              // Three claims: one names a file that exists, one names a file that does not, one leaves the tree.
              findings: [seatFinding({}), seatFinding({ path: "src/nope.ts" }), seatFinding({ path: "../outside/secret.ts" })],
            },
            {
              persona: "review-technical",
              provider: "kimi-code",
              model: "k3",
              degraded: true,
              durationMs: 0,
              usage: usage(200, 20, 0.02),
              attempts: [],
              error: "all candidates failed",
            },
          ],
        },
      },
    ],
    { file: "models.jsonl", harness: "omp" },
  );
  const modelReport = buildReport({ sessions: [modelSession], roots: [], unreadable: [] });
  const skepticRow = modelReport.models.get("opencode-go/deepseek-v4-pro");
  const technicalRow = modelReport.models.get("kimi-code/k3");

  after(() => fs.rmSync(modelsDir, { recursive: true, force: true }));

  test("a model's seats, tokens, cost, failures and substitutions are counted", () => {
    assert.ok(
      skepticRow?.seats === 1 &&
        skepticRow.tokens === 440 &&
        Math.abs(skepticRow.cost - 0.03) < 1e-9 &&
        skepticRow.ms === 40000 &&
        skepticRow.degraded === 0 &&
        skepticRow.attempts.get("transient") === 1 &&
        skepticRow.personas.get("review-skeptic") === 1,
      JSON.stringify(skepticRow),
    );
  });
  test("a model's findings are counted, and split by whether their location can be checked", () => {
    assert.ok(
      skepticRow?.findings === 3 && skepticRow.located === 1 && skepticRow.unlocated === 1 && skepticRow.uncheckable === 1,
      JSON.stringify({
        findings: skepticRow?.findings,
        located: skepticRow?.located,
        unlocated: skepticRow?.unlocated,
        uncheckable: skepticRow?.uncheckable,
      }),
    );
  });
  test("a seat that raised nothing contributes no findings, and a degraded seat is counted as one", () => {
    assert.ok(
      technicalRow?.seats === 1 && technicalRow.findings === 0 && technicalRow.degraded === 1,
      JSON.stringify({ seats: technicalRow?.seats, findings: technicalRow?.findings, degraded: technicalRow?.degraded }),
    );
  });
  test("the report prints the model, its seat-time and what it found", () => {
    const text = render(modelReport);
    assert.ok(
      /seats by model/.test(text) &&
        /opencode-go\/deepseek-v4-pro\s+1 seats/.test(text) &&
        /findings 3 · located 1, path not found 1, outside the session 1/.test(text),
      text
        .split("\n")
        .filter((line) => line.includes("deepseek-v4-pro"))
        .join(" // "),
    );
  });
});
