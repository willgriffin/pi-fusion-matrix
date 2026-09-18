#!/usr/bin/env node
/**
 * doctor.mjs — the standalone entry point for the same checks `/matrix-doctor` runs inside pi.
 *
 *   node scripts/doctor.mjs                # config + connectivity, offline
 *   node scripts/doctor.mjs --online       # also ask each provider what it serves
 *   node scripts/doctor.mjs --json         # machine-readable findings
 *   node scripts/doctor.mjs --repair       # print the additive models.json snippet, write nothing
 *   node scripts/doctor.mjs --cwd <path>   # resolve layers as a session in <path> would
 *
 * Exit status separates "broken" from "out of date": 0 clean, 1 config, 2 connectivity, 3 reachability or
 * drift. Inside a bare node process there is no model registry, so connectivity is reported as unknown
 * rather than guessed, and asking for `--online` there exits 3: the reachability check did not run.
 * Run it inside pi (or through /matrix-doctor) for those checks.
 */
import path from "node:path";
import { loadMatrixConfig } from "../extensions/pi-fusion-matrix/config.js";
import { runDoctor, formatFindings, repairSnippet } from "../extensions/pi-fusion-matrix/doctor.js";

const args = process.argv.slice(2);
const has = (flag) => args.includes(`--${flag}`);
const value = (name, fallback) => { const i = args.indexOf(`--${name}`); return i === -1 ? fallback : args[i + 1]; };

const cwd = value("cwd", process.cwd());
let loaded;
try {
  loaded = loadMatrixConfig({ cwd: path.resolve(cwd) });
} catch (error) {
  console.error(`matrix doctor: ${error.message}`);
  process.exit(1);
}

const { findings, exit } = await runDoctor({ config: loaded.config, sources: loaded.sources, online: has("online") });

if (has("json")) {
  console.log(JSON.stringify({ layers: loaded.layers.map((l) => l.file), findings, exit }, null, 2));
} else {
  const layers = loaded.layers.map((l) => l.file.replace(process.env.HOME ?? "", "~")).join(" → ");
  console.log(`matrix doctor — layers: ${layers}`);
  console.log(formatFindings(findings));
  if (has("repair")) {
    const snippet = repairSnippet(findings);
    console.log(snippet ? `\nsuggested models.json additions (nothing was written):\n${snippet}` : "\nnothing to repair");
  }
}
process.exit(exit);