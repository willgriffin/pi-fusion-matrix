#!/usr/bin/env node
/**
 * matrix-tui.mjs — a terminal interface for the fusion matrix: the roster, the rungs, and the routes,
 * with the rain behind them.
 *
 * Three tabs, and each one joins the configuration to the metrics store (#14) rather than restating
 * it: **aliases** (what each alias names, the routes it may walk, and what the store saw it do),
 * **fusions** (how each rung runs, how it ended, what it cost, what its reviews produced), and
 * **routes** (per fusion and seat: what the config offers, which alias actually answered, and every
 * route that refused it). A column that only repeats the config would be a decoration, so every one
 * carries a number the store answered.
 *
 *   node scripts/matrix-tui.mjs                      # the whole interface, rain and all
 *   node scripts/matrix-tui.mjs --plain              # one frame as text, for a pipe or a test
 *   node scripts/matrix-tui.mjs --no-rain --no-color # quiet, and readable on a mono terminal
 *
 * Editing is deliberate and two-step. `e` proposes a change (a seat's candidate alias, or an alias's
 * route order), the status bar shows the change, the layer it would be written to, *and whether the
 * config still validates*; `s` writes it, `esc` discards it. A change that would not load is refused
 * with the loader's own message before the file is touched — the same rule the loader enforces, not a
 * second opinion about it.
 *
 * The driver is the only part that needs a terminal: the rain (`tui-rain.mjs`), the layout, the
 * tables and the key handling (`tui-view.mjs`) are pure, so a test drives the interface without a TTY
 * and `--plain` renders a frame through the same code the interactive path uses.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { cells, createRain, resizeRain, stepRain } from "./tui-rain.mjs";
import {
  TABS,
  aliasRows,
  clamp,
  columnsFor,
  createGrid,
  drawPanel,
  fusionRows,
  gridLine,
  paintTable,
  paletteFor,
  put,
  routeRows,
  truncate,
} from "./tui-view.mjs";
import { DEFAULT_CATALOGUE, DEFAULT_DB, byFusion, byFusionSeat, byModel, ingest, loadSqlite, openStore, totals } from "./metrics-store.mjs";
import { configPaths, loadMatrixConfig, mergeConfig, validateConfig } from "../extensions/pi-fusion-matrix/config.js";

const args = process.argv.slice(2);
const has = (flag) => args.includes(`--${flag}`);
const value = (name, fallback) => {
  const at = args.lastIndexOf(`--${name}`);
  return at === -1 ? fallback : (args[at + 1] ?? fallback);
};

/* ------------------------------------------------------------------- state */

/**
 * The whole interface state, built from the config and the store. `rows` is rebuilt on every reload;
 * `cursors` remembers where each tab was, so switching tabs does not lose your place. The layer paths
 * ride along because a proposal has to say which file it would write.
 */
export function buildState({
  config,
  modelStats = [],
  fusionStats = [],
  seatStats = [],
  storeTotals = null,
  source = "",
  baseConfig = {},
  layerConfig = {},
  layerFile = "",
  layerReadError = null,
} = {}) {
  return {
    tab: "aliases",
    cursors: { aliases: 0, fusions: 0, routes: 0 },
    rows: {
      aliases: aliasRows({ config, modelStats }),
      fusions: fusionRows({ config, fusionStats, seatStats }),
      routes: routeRows({ config, seatStats }),
    },
    stats: { modelStats, fusionStats, seatStats },
    config,
    baseConfig,
    layerConfig,
    layerFile,
    storeTotals,
    pending: null,
    picker: null,
    help: false,
    rain: true,
    color: true,
    message: source,
    layerReadError,
  };
}

/** The row the cursor is on, or undefined on an empty tab. */
export const selected = (state) => state.rows[state.tab][state.cursors[state.tab]];

/**
 * A key into a new state. No terminal, no I/O: the driver applies the effect, and the tests drive
 * this directly. Effects: `quit`, `reload`, `reingest`, `propose`, `save`, `none`.
 */
export function applyKey(state, key) {
  const next = { ...state, cursors: { ...state.cursors }, message: state.message };
  const move = (delta) => {
    const rows = state.rows[state.tab];
    next.cursors[state.tab] = clamp(state.cursors[state.tab] + delta, 0, Math.max(0, rows.length - 1));
  };

  if (state.picker) {
    if (key === "escape" || key === "q") return { state: { ...next, picker: null }, effect: "none" };
    if (key === "j" || key === "down")
      next.picker = { ...state.picker, cursor: clamp(state.picker.cursor + 1, 0, state.picker.options.length - 1) };
    else if (key === "k" || key === "up")
      next.picker = { ...state.picker, cursor: clamp(state.picker.cursor - 1, 0, state.picker.options.length - 1) };
    else if (key === "return" || key === "enter") {
      const chosen = state.picker.options[state.picker.cursor];
      next.picker = null;
      return { state: { ...next, pending: state.picker.pending(chosen), message: "" }, effect: "none" };
    }
    return { state: next, effect: "none" };
  }

  if (key === "q") return { state: next, effect: "quit" };
  if (key === "escape") {
    if (state.pending) return { state: { ...next, pending: null, message: "change discarded" }, effect: "none" };
    return { state: next, effect: "none" };
  }
  if (key === "j" || key === "down") move(1);
  else if (key === "k" || key === "up") move(-1);
  else if (key === "g") next.cursors[state.tab] = 0;
  else if (key === "G") next.cursors[state.tab] = Math.max(0, state.rows[state.tab].length - 1);
  else if (key === "tab" || key === "l" || key === "right") next.tab = TABS[(TABS.indexOf(state.tab) + 1) % TABS.length];
  else if (key === "shift-tab" || key === "h" || key === "left") next.tab = TABS[(TABS.indexOf(state.tab) - 1 + TABS.length) % TABS.length];
  else if (key === "1" || key === "2" || key === "3") next.tab = TABS[Number(key) - 1];
  else if (key === "a") next.rain = !state.rain;
  else if (key === "c") next.color = !state.color;
  else if (key === "?") next.help = !state.help;
  else if (key === "r") return { state: next, effect: "reload" };
  else if (key === "R") return { state: next, effect: "reingest" };
  else if (key === "e") return { state: next, effect: "propose" };
  else if (key === "s") {
    if (!state.pending) next.message = "nothing to save — e proposes a change";
    else if (state.pending.saveable === false) next.message = "nothing to write — that proposal changes nothing";
    else if (state.pending.errors.length > 0) next.message = `refused: ${state.pending.errors[0]}`;
    else return { state: next, effect: "save" };
  }
  return { state: next, effect: "none" };
}

/** A terminal chunk into a key name. Arrows and shift-tab arrive as escape sequences in one chunk. */
export function keyName(chunk) {
  if (chunk === "\t") return "tab";
  if (chunk === "\r" || chunk === "\n") return "return";
  if (chunk === "\u0003") return "q";
  if (chunk === "\u001b") return "escape";
  if (chunk.startsWith("\u001b[")) {
    const code = chunk.slice(2);
    if (code === "A") return "up";
    if (code === "B") return "down";
    if (code === "C") return "right";
    if (code === "D") return "left";
    if (code === "Z") return "shift-tab";
  }
  return chunk;
}

/* -------------------------------------------------------------- proposing */

const deepClone = (value) => JSON.parse(JSON.stringify(value ?? {}));

/**
 * The change a routes-tab row proposes: this seat's candidate list becomes one alias. That is what
 * "tinker with the routes" means most directly — a seat that keeps refusing gets re-pointed — and it
 * is a *proposal*: the caller validates it against the loader before anything is written.
 */
export function proposeSeatAlias({ state, row, alias }) {
  const patch = deepClone(state.layerConfig);
  patch.fusions = patch.fusions ?? {};
  patch.fusions[row.fusion] = patch.fusions[row.fusion] ?? {};
  patch.fusions[row.fusion].candidates = patch.fusions[row.fusion].candidates ?? {};
  patch.fusions[row.fusion].candidates[row.seat] = [alias];
  return {
    layerFile: state.layerFile,
    patch,
    summary: `${row.fusion}.${row.seat} walks ${alias} (was ${row.candidates})`,
    errors: validateAgainst(state, patch),
    options: Object.keys(state.config.aliases ?? {}).sort(),
  };
}

/** The change an aliases-tab row proposes: the alias's routes rotate, so the second becomes first. */
export function proposeRouteOrder({ state, row }) {
  const patch = deepClone(state.layerConfig);
  const providers = state.config.aliases?.[row.alias]?.providers ?? [];
  if (providers.length < 2) {
    // Not an error, but not a change either: `s` must not create or rewrite a layer file to write the
    // state it already has, so the proposal says it is unsaveable rather than relying on the summary.
    return { layerFile: state.layerFile, patch, summary: `${row.alias} has one route; nothing to reorder`, errors: [], saveable: false };
  }
  const rotated = [...providers.slice(1), providers[0]];
  patch.aliases = patch.aliases ?? {};
  patch.aliases[row.alias] = patch.aliases[row.alias] ?? {};
  patch.aliases[row.alias].providers = rotated;
  return {
    layerFile: state.layerFile,
    patch,
    summary: `${row.alias} now tries ${rotated.map((ref) => (typeof ref === "string" ? ref : ref.id)).join(" → ")}`,
    errors: validateAgainst(state, patch),
  };
}

/** What the loader says about the config this patch would produce — the loader's own answer, not ours. */
export function validateAgainst(state, patch) {
  try {
    return validateConfig(mergeConfig(state.baseConfig, patch), {}).map((error) =>
      typeof error === "string" ? error : JSON.stringify(error),
    );
  } catch (error) {
    return [error?.message ?? String(error)];
  }
}

/** The interactive `e`: a proposal for the selected row, through a picker where one is needed. */
export function proposeFor(state) {
  const row = selected(state);
  if (!row) return { ...state, message: "nothing selected" };
  if (state.tab === "routes") {
    const options = Object.keys(state.config.aliases ?? {}).sort();
    if (options.length === 0) return { ...state, message: "no aliases to point a seat at" };
    return {
      ...state,
      message: "",
      picker: {
        title: `${row.fusion}.${row.seat}: point at`,
        options,
        cursor: 0,
        pending: (alias) => proposeSeatAlias({ state, row, alias }),
      },
    };
  }
  if (state.tab === "aliases") {
    const pending = proposeRouteOrder({ state, row });
    return { ...state, pending, message: pending.errors.length ? "" : "proposed — s saves, esc discards" };
  }
  return { ...state, message: "the fusions tab is read-only for now" };
}

/* ---------------------------------------------------------------- drawing */

/**
 * One frame: the interface on a blank grid. The rain is composed *under* this by the driver, so a
 * cell the interface leaves blank is a window onto it.
 */
export function frameFor({ width, height, state, palette, clock = "" }) {
  const grid = createGrid(width, height);
  const rows = state.rows[state.tab];
  const cursor = state.cursors[state.tab];

  const tabs = TABS.map((tab, i) => `${i + 1}:${tab}${tab === state.tab ? "*" : ""}`).join("  ");
  const store = state.storeTotals
    ? `store · ${state.storeTotals.sessions} sessions · ${state.storeTotals.deliberationRuns}+${state.storeTotals.proxyRuns} runs · ${state.storeTotals.seats} seats · ${state.storeTotals.seatFindings} findings`
    : "store · not built yet";
  put(grid, 0, 1, " FUSION MATRIX ", palette.title);
  put(grid, 0, 17, tabs, palette.accent);
  put(grid, 0, Math.max(19 + tabs.length, width - store.length - 2), store, palette.dim);

  const footerRows = state.pending ? 2 : 1;
  const panelHeight = Math.max(6, height - 4 - footerRows);
  const panel = drawPanel(grid, { row: 1, col: 0, width, height: panelHeight, title: `${state.tab} — ${rows.length} row(s)` }, palette);
  paintTable(grid, {
    columns: columnsFor(state.tab),
    rows,
    row: panel.row,
    col: panel.col,
    width: panel.width,
    height: panel.height,
    cursor,
    palette,
  });

  const detailRow = 1 + panelHeight;
  put(grid, detailRow, 1, truncate(detailFor(state, rows[cursor]), width - 2), palette.dim);

  if (state.pending) {
    const file = String(state.pending.layerFile).replace(process.env.HOME ?? "~", "~");
    put(grid, detailRow + 1, 1, truncate(`change: ${state.pending.summary}`, width - 2), palette.accent);
    const verdict = state.pending.errors.length ? `INVALID — ${state.pending.errors[0]}` : "valid";
    put(
      grid,
      detailRow + 2,
      1,
      truncate(`writes: ${file} · ${verdict} (s saves, esc discards)`, width - 2),
      state.pending.errors.length ? palette.box : palette.ink,
    );
  } else {
    put(grid, detailRow + 1, 1, truncate(state.message ?? "", width - 2), palette.dim);
  }

  const keys = "1-3/tab tabs · j/k rows · e edit · s save · R reingest · r reload · a rain · c colour · ? help · q quit";
  put(grid, height - 1, Math.max(1, width - keys.length - 1), width > keys.length + 12 ? keys : "e edit · s save · q quit", palette.dim);
  put(grid, height - 1, 1, clock, palette.dim);

  if (state.help) {
    const helpRows = [
      "aliases — the alias, the model it names, its routes, and what the store saw it do",
      "fusions — mode and face, then runs, failures, degraded seats, cascades, verify, findings, cost",
      "routes  — per fusion and seat: the ordered candidates from config, which alias answered, what refused",
      "e proposes a change for the selected row (routes: a new candidate alias; aliases: rotate the routes)",
      "s writes it to the layer named under it after the loader validates it; esc discards it",
      "$report is what providers priced (with the seats it covers), $est is their own rate card applied to",
      "unpriced seats, $list is the same tokens at list price — one basis per column, never folded together",
    ];
    const boxWidth = Math.min(width - 4, Math.max(...helpRows.map((line) => line.length)) + 4);
    const boxHeight = helpRows.length + 2;
    const top = Math.max(2, Math.floor((height - boxHeight) / 2));
    const inner = drawPanel(
      grid,
      { row: top, col: Math.floor((width - boxWidth) / 2), width: boxWidth, height: boxHeight, title: "keys" },
      palette,
    );
    helpRows.forEach((line, i) => put(grid, inner.row + i, inner.col, truncate(line, inner.width), palette.ink));
  }

  if (state.picker) {
    const options = state.picker.options.map((option, i) => `${i === state.picker.cursor ? "▸" : " "} ${option}`);
    const boxWidth = Math.min(width - 6, Math.max(24, ...options.map((line) => line.length + 4)));
    const boxHeight = Math.min(height - 4, options.length + 2);
    const top = Math.max(2, Math.floor((height - boxHeight) / 2));
    const inner = drawPanel(
      grid,
      { row: top, col: Math.floor((width - boxWidth) / 2), width: boxWidth, height: boxHeight, title: state.picker.title },
      palette,
    );
    // The option the cursor is on must be the one on screen — a picker whose highlight scrolls out of
    // its own box makes the operator commit blind.
    const visible = inner.height;
    const first = clamp(state.picker.cursor - visible + 1, 0, Math.max(0, options.length - visible));
    for (let i = 0; i < visible && first + i < options.length; i += 1) {
      const index = first + i;
      put(
        grid,
        inner.row + i,
        inner.col,
        truncate(options[index], inner.width),
        index === state.picker.cursor ? palette.selected : palette.ink,
      );
    }
  }

  return grid;
}

/** The line under the table: the selected row's own detail, so a truncated cell stays readable. */
export function detailFor(state, row) {
  if (!row) return "";
  if (state.tab === "aliases") {
    return `${row.alias} → ${row.model} · routes: ${row.routeDetail || "none"} · seats ${row.seats} · kept ${row.kept}/${row.raised} · located ${row.located}, unlocated ${row.unlocated}${row.noRate ? ` · ${row.noRate} seat(s) with no rate` : ""}`;
  }
  if (state.tab === "fusions") {
    const stats = state.stats.fusionStats.find((entry) => entry.fusion === row.fusion);
    const verdicts = stats
      ? Object.entries(stats.verdicts)
          .map(([verdict, n]) => `${verdict}×${n}`)
          .join(" ")
      : "";
    const work = stats ? Object.keys(stats.workItems).join(" ") : "";
    const decision = stats ? stats.decisionTokens : 0;
    return `${row.fusion} · ${row.mode} · ${row.face} · runs ${row.runs}, failures ${row.failures} · cascades ${row.sufficient} sufficient · verdicts ${verdicts || "none"} · work items ${work || "none"} · verify ${row.verify} checks · decision tokens ${decision}`;
  }
  const stat = state.stats.seatStats.find((entry) => entry.fusion === row.fusion && entry.persona === row.seat);
  const refused =
    stat && Object.keys(stat.refusals).length
      ? Object.entries(stat.refusals)
          .map(
            ([route, reasons]) =>
              `${route} ${Object.entries(reasons)
                .map(([reason, n]) => `${reason}×${n}`)
                .join(", ")}`,
          )
          .join(" · ")
      : "nothing refused";
  const unconfigured = row.unconfigured ? " · not in the config any more (history only)" : "";
  return `${row.fusion}.${row.seat} · candidates ${row.candidates}${unconfigured} · seats ${row.seats} · refused: ${refused}`;
}

/** The rain under the interface: interface cells win, blanks let the rain through. */
export function composeOverRain(grid, rainField, palette, { width, height }) {
  const { levels, glyphs } = cells(rainField);
  const composed = createGrid(width, height);
  const colors = { 1: palette.tail, 2: palette.body, 3: palette.head };
  for (let i = 0; i < composed.ch.length; i += 1) {
    const level = levels[i] ?? 0;
    if (level > 0 && grid.ch[i] === " ") {
      composed.ch[i] = glyphs[i];
      composed.fg[i] = colors[level] ?? palette.tail;
    } else {
      composed.ch[i] = grid.ch[i];
      composed.fg[i] = grid.fg[i];
    }
  }
  return composed;
}

/**
 * The cells that changed between two frames, grouped into runs per row — the reason the rain can run
 * at 20fps without repainting a screen: a frame costs what changed, not what exists.
 */
export function diff(prev, next) {
  const runs = [];
  if (!prev) {
    for (let row = 0; row < next.height; row += 1) {
      runs.push({ row, col: 0, text: gridLine(next, row), fg: next.fg.slice(row * next.width, (row + 1) * next.width) });
    }
    return runs;
  }
  for (let row = 0; row < next.height; row += 1) {
    let start = -1;
    for (let col = 0; col <= next.width; col += 1) {
      const at = row * next.width + col;
      const changed = col < next.width && (prev.ch[at] !== next.ch[at] || prev.fg[at] !== next.fg[at]);
      if (changed && start === -1) start = col;
      if (!changed && start !== -1) {
        runs.push({
          row,
          col: start,
          text: next.ch.slice(row * next.width + start, row * next.width + col).join(""),
          fg: next.fg.slice(row * next.width + start, row * next.width + col),
        });
        start = -1;
      }
    }
  }
  return runs;
}

/** Runs into bytes: one cursor move and as few style changes as the run needs, never one per cell. */
export function paint(runs, palette) {
  let out = "";
  for (const run of runs) {
    out += `\x1b[${run.row + 1};${run.col + 1}H`;
    let style = null;
    let text = "";
    for (let i = 0; i < run.text.length; i += 1) {
      const cellStyle = run.fg[i] ?? "";
      if (cellStyle !== style) {
        out += text + (style === null ? "" : palette.reset) + cellStyle;
        text = "";
        style = cellStyle;
      }
      text += run.text[i];
    }
    out += text + palette.reset;
  }
  return out;
}

/* ------------------------------------------------------------------ world */

/**
 * A layer file as data, with its two absences told apart: a file that is **not there** is a legitimate
 * empty layer (the first edit to a fresh machine creates it), while a file that is there and will not
 * parse is an operator's config this program must not touch — reading it as `{}` and then writing a
 * patch built from nothing would overwrite their real file, silently.
 */
const readLayer = (file) => {
  if (!fs.existsSync(file)) return { ok: true, config: {} };
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { ok: false, reason: `${file} is not a JSON object` };
    }
    return { ok: true, config: parsed };
  } catch (error) {
    return { ok: false, reason: `${file} does not parse as JSON: ${error?.message ?? String(error)}` };
  }
};

/** Load the config and the store's stats. A missing store is a named state, not an empty table. */
export async function loadWorld({ dbPath = DEFAULT_DB, cwd = process.cwd(), layerFile } = {}) {
  const loaded = loadMatrixConfig({ cwd });
  const paths = configPaths({ cwd });
  const target = layerFile ?? paths.machine;
  const baseConfig = loadMatrixConfig({ cwd, layers: ["packaged", "cwd"] }).config;
  const layer = readLayer(target);
  const layerConfig = layer.ok ? layer.config : {};
  const sqlite = await loadSqlite();
  let stats = { modelStats: [], fusionStats: [], seatStats: [], storeTotals: null, note: "" };
  if (!sqlite) stats.note = "no node:sqlite: the numbers are missing here, not zero";
  else if (!fs.existsSync(dbPath)) stats.note = `no store at ${String(dbPath).replace(process.env.HOME ?? "~", "~")} — press R to build it`;
  else {
    try {
      const db = openStore(dbPath, { sqlite });
      stats = { modelStats: byModel(db), fusionStats: byFusion(db), seatStats: byFusionSeat(db), storeTotals: totals(db), note: "" };
      db.close();
    } catch (error) {
      stats.note = `the store could not be read: ${error?.message ?? String(error)}`;
    }
  }
  const state = buildState({
    config: loaded.config,
    baseConfig,
    layerConfig,
    layerFile: target,
    // An unreadable layer is a named state, not an empty one: the interface must say so and refuse to
    // propose anything against it, because a patch built over `{}` would overwrite the operator's file.
    layerReadError: layer.ok ? null : layer.reason,
    source: layer.ok ? stats.note : layer.reason,
    modelStats: stats.modelStats,
    fusionStats: stats.fusionStats,
    seatStats: stats.seatStats,
    storeTotals: stats.storeTotals,
  });
  return { state, paths };
}

async function reingest({ dbPath, catalogue }) {
  const sqlite = await loadSqlite();
  if (!sqlite) return "no node:sqlite: nothing was ingested";
  try {
    const result = await ingest({ dbPath, catalogue });
    if (!result.ok) return `ingest failed: ${result.reason}`;
    return `ingested: ${result.filesRead} read, ${result.filesSkipped} skipped, ${result.totals.runs} run(s) now in the store`;
  } catch (error) {
    return `ingest failed: ${error?.message ?? String(error)}`;
  }
}

/* ----------------------------------------------------------------- driver */

/**
 * A freshly loaded world, adopted without losing your place: the tab, the per-tab cursors and the
 * display toggles belong to the *view*, and a reload that reset them sent the reader back to the first
 * tab every time a change was saved. Cursors are clamped to what the reloaded tabs actually hold — a
 * reload can shrink a table (a store that emptied, a fusion that went away), and a stale cursor reads
 * as "nothing selected" with a blank detail line rather than as the move it was.
 */
export const adopt = (current, reloaded) => {
  const cursors = { ...current.cursors };
  for (const tab of TABS) cursors[tab] = clamp(cursors[tab] ?? 0, 0, Math.max(0, (reloaded.state.rows[tab]?.length ?? 0) - 1));
  return {
    ...current,
    ...reloaded.state,
    tab: TABS.includes(current.tab) && reloaded.state.rows[current.tab] ? current.tab : "aliases",
    cursors,
    help: current.help,
    picker: null,
    rain: current.rain,
    color: current.color,
  };
};

export async function main() {
  const dbPath = value("db", DEFAULT_DB);
  const catalogue = value("catalogue", DEFAULT_CATALOGUE);
  const fps = Number(value("fps", "20"));
  const frames = value("frames", null);
  const plain = has("plain") || !process.stdout.isTTY;
  // Which layer a change is written to: the harness's machine layer by default, or exactly the file
  // named here — the flag that lets a smoke test exercise the write path without touching an
  // operator's own overlay.
  const layerFile = value("layer", null) ?? undefined;
  const world = await loadWorld({ dbPath, layerFile });
  let state = { ...world.state, color: !has("no-color") && !process.env.NO_COLOR, rain: !has("no-rain") };
  let palette = paletteFor({ color: state.color });

  if (plain) {
    const width = Number(value("width", "150"));
    const height = Number(value("height", "40"));
    const frame = frameFor({ width, height, state, palette, clock: new Date().toISOString().slice(0, 19) });
    process.stdout.write(`${Array.from({ length: height }, (_, row) => gridLine(frame, row)).join("\n")}\n`);
    if (state.message) process.stdout.write(`note: ${state.message}\n`);
    return 0;
  }

  let width = process.stdout.columns ?? 120;
  let height = process.stdout.rows ?? 30;
  let rainField = createRain({ width, height, seed: Date.now() % 100000, density: 0.5 });
  let frame = null;
  let painted = 0;
  let stopped = false;
  const buffer = [];

  const draw = () => {
    const grid = frameFor({ width, height, state, palette, clock: new Date().toISOString().slice(11, 19) });
    const composed = state.rain ? composeOverRain(grid, rainField, palette, { width, height }) : grid;
    buffer.push(paint(diff(frame, composed), palette));
    frame = composed;
    if (buffer.length) {
      process.stdout.write(buffer.join(""));
      buffer.length = 0;
    }
  };

  const cleanup = () => {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
    process.stdin.setRawMode?.(false);
    process.stdin.pause();
    process.stdout.write(`${palette.reset}\x1b[?25h\x1b[?1049l`);
  };

  const save = async () => {
    const pending = state.pending;
    if (!pending || pending.errors.length > 0) return;
    // The loader is asked again, here, against the state as it is *now*: `pending.errors` was the answer
    // when the change was proposed, and the layer or the base config can have moved since — by an
    // operator's edit in another window, or by the target being switched. A validated-write contract
    // has to hold at the moment of writing, not at the moment of proposing.
    const now = validateAgainst(state, pending.patch);
    if (now.length > 0) {
      state = { ...state, message: `refused: ${now[0]}` };
      return;
    }
    if (state.layerReadError) {
      state = { ...state, message: `refused: ${state.layerReadError}` };
      return;
    }
    try {
      fs.mkdirSync(path.dirname(pending.layerFile), { recursive: true });
      fs.writeFileSync(pending.layerFile, `${JSON.stringify(pending.patch, null, 2)}\n`);
      const reloaded = await loadWorld({ dbPath, layerFile });
      state = { ...adopt(state, reloaded), pending: null, message: `saved: ${pending.summary}` };
    } catch (error) {
      state = { ...state, message: `the change could not be written: ${error?.message ?? String(error)}` };
    }
  };

  const reload = async (note) => {
    const reloaded = await loadWorld({ dbPath, layerFile });
    state = { ...adopt(state, reloaded), message: note || reloaded.state.message };
  };

  process.stdout.write("\x1b[?1049h\x1b[?25l\x1b[2J");
  process.stdin.setRawMode?.(true);
  process.stdin.resume();
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    const { state: next, effect } = applyKey(state, keyName(chunk));
    state = next;
    // The colour key has to rebuild the palette: a palette computed once meant `c` changed a flag
    // nobody read, and the toggle did nothing at all.
    palette = paletteFor({ color: state.color });
    if (effect === "quit") {
      cleanup();
      process.exit(0);
    } else if (effect === "save") void save();
    else if (effect === "propose") state = proposeFor(state);
    else if (effect === "reload") void reload("");
    else if (effect === "reingest") {
      state = { ...state, message: "ingesting…" };
      void reingest({ dbPath, catalogue }).then((note) => reload(note));
    }
  });
  process.stdout.on("resize", () => {
    width = process.stdout.columns ?? width;
    height = process.stdout.rows ?? height;
    rainField = resizeRain(rainField, { width, height });
    frame = null;
  });
  process.on("exit", cleanup);
  process.on("SIGINT", () => {
    cleanup();
    process.exit(0);
  });

  const timer = setInterval(
    () => {
      if (state.rain) stepRain(rainField);
      draw();
      painted += 1;
      if (frames && painted >= Number(frames)) {
        cleanup();
        process.exit(0);
      }
    },
    Math.max(20, Math.round(1000 / (Number.isFinite(fps) ? fps : 20))),
  );

  return new Promise(() => {});
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const code = await main();
  if (typeof code === "number") process.exit(code);
}
