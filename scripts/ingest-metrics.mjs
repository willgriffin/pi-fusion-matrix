#!/usr/bin/env node
/**
 * ingest-metrics.mjs — the derived metrics store's ingest, as a command.
 *
 *   node scripts/ingest-metrics.mjs                     # both harnesses' session stores, default db
 *   node scripts/ingest-metrics.mjs --db /tmp/m.db --root ~/.omp/agent/sessions --json
 *   node scripts/ingest-metrics.mjs --rebuild           # replace the store: the recovery rule's `rm`
 *
 * Nothing here is a reader: the accounting it prints is the ingest's own (files read, skipped,
 * unreadable, failed, pruned; lines that did not parse; the rate card it found). Exit status follows
 * the report's rule — `0` when every session file was accounted for, `1` when one could not be read
 * or failed to write, so a store that is short is never a quiet success. A root that is not there is
 * named and not an error: a harness nobody has used is a fact, not a failure. An unparsed line is
 * *landed* in the store (with its file and reason), so it is reported and still exit `0`.
 *
 * The database is derived: deleting it and re-ingesting reproduces it. Nothing here writes to the
 * session stores, which are read-only inputs.
 */
import os from "node:os";
import path from "node:path";

import { DEFAULT_CATALOGUE, DEFAULT_DB, DEFAULT_ROOTS, ingest } from "./metrics-store.mjs";

const args = process.argv.slice(2);
const has = (flag) => args.includes(`--${flag}`);
const values = (name) => args.flatMap((arg, i) => (arg === `--${name}` ? [args[i + 1]].filter((v) => v !== undefined) : []));
const value = (name, fallback) => values(name).at(-1) ?? fallback;

const KNOWN_FLAGS = ["db", "root", "catalogue", "rebuild", "json", "quiet"];
const unknown = args.filter((arg) => arg.startsWith("--") && !KNOWN_FLAGS.includes(arg.slice(2)));
if (unknown.length) {
  console.error(`ingest-metrics: unknown flag ${unknown.join(", ")} — this command takes ${KNOWN_FLAGS.map((f) => `--${f}`).join(", ")}`);
  process.exit(1);
}

/** The harness whose store a root is, from the path segment itself — `~/.ompbackups` is not `~/.omp`. */
const harnessOf = (root) => {
  const segments = path.resolve(root).split(path.sep);
  if (segments.includes(".omp")) return "omp";
  if (segments.includes(".pi")) return "pi";
  return "custom";
};

const dirs = values("root");
const roots = dirs.length
  ? dirs.map((root) => ({ harness: harnessOf(root), root: path.resolve(root.replace(/^~(?=\/|$)/, os.homedir())) }))
  : DEFAULT_ROOTS;

const result = await ingest({
  dbPath: value("db", DEFAULT_DB),
  catalogue: value("catalogue", DEFAULT_CATALOGUE),
  roots,
  rebuild: has("rebuild"),
  log: (message) => {
    if (!has("quiet")) console.log(` · ${message}`);
  },
});

if (!result.ok) {
  console.error(`ingest-metrics: ${result.reason}`);
  process.exit(1);
}

if (has("json")) {
  console.log(JSON.stringify(result, null, 2));
} else if (!has("quiet")) {
  const t = result.totals;
  console.log(`store: ${value("db", DEFAULT_DB)}`);
  console.log(
    `files: ${t.files} (${result.filesRead} read, ${result.filesSkipped} skipped, ${result.filesUnreadable} unreadable, ${result.filesFailed} failed, ${result.filesPruned} pruned)`,
  );
  console.log(
    `sessions: ${t.sessions}${t.sessionsWithoutHeader ? ` (${t.sessionsWithoutHeader} with no header)` : ""} · turns: ${t.turns}`,
  );
  console.log(
    `runs: ${t.deliberationRuns} deliberation + ${t.proxyRuns} proxy · seats: ${t.seats} · findings: ${t.seatFindings} seat / ${t.runFindings} kept in a disposition`,
  );
  console.log(
    `attempts: ${t.attempts} · cascades: ${t.cascades} · verify answers: ${t.verifyAnswers} · malformed answers: ${t.malformedAnswers} · labels: ${t.labels}`,
  );
  console.log(
    result.priceCard.available
      ? `rate card: ${result.priceCard.rows} rate(s) from ${result.priceCard.source}${result.priceCard.skipped ? `, ${result.priceCard.skipped} unpriced` : ""}`
      : `rate card: ${result.priceCard.reason}`,
  );
  console.log(`unparsed lines: ${result.unparsed} (landed with file and reason), in ${t.parseFailures} named row(s)`);
  for (const entry of result.unreadablePaths) {
    console.log(`cannot read: ${entry.harness} ${entry.path} — ${entry.reason}`);
  }
  if (result.filesFailed > 0) console.log(`failed files: ${result.filesFailed} — see store_file.status = 'failed'`);
}

process.exit(result.filesFailed > 0 || result.filesUnreadable > 0 ? 1 : 0);
