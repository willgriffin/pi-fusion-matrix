#!/usr/bin/env node
/**
 * tui-view.mjs — what the interface looks like, and what a key does to it. Pure.
 *
 * A frame is a flat cell grid: `ch` (one character per cell) and `fg` (the escape prefix that
 * colours it). Nothing here knows about terminals — the driver turns a grid into bytes, and a test
 * can assert on a line of a grid without a TTY anywhere in sight. The rain is *not* a layer of the
 * grid: it is composed underneath, so a panel's blank interior shows rain through it while every
 * painted cell stays solid.
 *
 * The tables are built from two inputs and never from one: the configuration says what a seat *may*
 * run (its candidates, its routes), and the metrics store says what it *did* (which alias answered,
 * what refused it, what it found, what it cost). A column that only repeats the config is not a
 * statistic, so each tab's columns carry a number from the store.
 */

/** The closed tab list, in display order. */
export const TABS = ["aliases", "fusions", "routes"];

const BOX = { tl: "┌", tr: "┐", bl: "└", br: "┘", h: "─", v: "│", tee: "├", teeR: "┤" };

/**
 * The palette: the rain's three levels, the interface's own ink, and the selection. `NO_COLOR` (or
 * `--no-color`) drops every escape but keeps the selection readable with reverse video — the
 * interface is usable without colour, which is the only honest way to offer a colour-heavy one.
 */
export function paletteFor({ color = true } = {}) {
  const fg = (r, g, b) => `\x1b[38;2;${r};${g};${b}m`;
  const bg = (r, g, b) => `\x1b[48;2;${r};${g};${b}m`;
  if (!color) {
    return {
      head: "",
      body: "",
      tail: "",
      ink: "",
      dim: "",
      box: "",
      title: "",
      accent: "",
      selected: "\x1b[7m",
      reset: "\x1b[0m",
    };
  }
  return {
    head: fg(205, 255, 205),
    body: fg(0, 255, 120),
    tail: fg(0, 120, 55),
    ink: fg(180, 255, 190),
    dim: fg(110, 165, 115),
    box: fg(0, 190, 80),
    title: fg(0, 255, 140),
    accent: fg(255, 245, 150),
    selected: bg(0, 190, 80) + fg(0, 20, 5),
    reset: "\x1b[0m",
  };
}

/** A blank grid: one character and one style per terminal cell. */
export function createGrid(width, height) {
  const size = Math.max(0, width * height);
  return { width, height, ch: new Array(size).fill(" "), fg: new Array(size).fill("") };
}

export const clamp = (value, low, high) => Math.max(low, Math.min(high, value));

/** Write text into a grid, clipped to it. A cell outside the grid is simply not drawn. */
export function put(grid, row, col, text, style = "") {
  if (row < 0 || row >= grid.height) return;
  const line = String(text ?? "");
  for (let i = 0; i < line.length; i += 1) {
    const x = col + i;
    if (x < 0 || x >= grid.width) continue;
    const at = row * grid.width + x;
    grid.ch[at] = line[i];
    grid.fg[at] = style;
  }
}

/** A line of a grid as text — what a test reads, and what the plain (non-TTY) output prints. */
export const gridLine = (grid, row) =>
  row < 0 || row >= grid.height ? "" : grid.ch.slice(row * grid.width, (row + 1) * grid.width).join("");

export function fillRow(grid, row, col, width, ch, style = "") {
  for (let i = 0; i < width; i += 1) put(grid, row, col + i, ch, style);
}

/** A titled panel: a box the rain shows through, because only the border and the title are painted. */
export function drawPanel(grid, { row, col, width, height, title }, palette) {
  if (width < 4 || height < 3) return { row, col, width: 0, height: 0 };
  const right = col + width - 1;
  const bottom = row + height - 1;
  put(grid, row, col, BOX.tl, palette.box);
  put(grid, row, right, BOX.tr, palette.box);
  put(grid, bottom, col, BOX.bl, palette.box);
  put(grid, bottom, right, BOX.br, palette.box);
  fillRow(grid, row, col + 1, width - 2, BOX.h, palette.box);
  fillRow(grid, bottom, col + 1, width - 2, BOX.h, palette.box);
  for (let y = row + 1; y < bottom; y += 1) {
    put(grid, y, col, BOX.v, palette.box);
    put(grid, y, right, BOX.v, palette.box);
  }
  if (title) put(grid, row, col + 2, ` ${title} `, palette.title);
  return { row: row + 1, col: col + 1, width: width - 2, height: height - 2 };
}

/** `1234567` → `1.23M`, so a token column fits without lying about the order of magnitude. */
export function compact(n) {
  if (n === null || n === undefined) return "—";
  const value = Number(n);
  if (!Number.isFinite(value)) return "—";
  if (Math.abs(value) >= 1e9) return `${(value / 1e9).toFixed(2)}B`;
  if (Math.abs(value) >= 1e6) return `${(value / 1e6).toFixed(2)}M`;
  if (Math.abs(value) >= 1e3) return `${(value / 1e3).toFixed(1)}k`;
  return String(Math.round(value));
}

/** Money with its basis attached: cents-sized numbers keep enough digits to not read as zero. */
export function money(value, { dash = "—" } = {}) {
  if (value === null || value === undefined || !Number.isFinite(value)) return dash;
  if (value === 0) return "$0";
  if (Math.abs(value) < 0.01) return `$${value.toFixed(5)}`;
  return `$${value.toFixed(2)}`;
}

/** Truncate with an ellipsis, never mid-cell: the grid has no room for wide characters. */
export function truncate(text, width) {
  const line = String(text ?? "");
  if (width <= 0) return "";
  if (line.length <= width) return line;
  if (width === 1) return "…";
  return `${line.slice(0, width - 1)}…`;
}

export const pad = (text, width, align = "left") => {
  const line = truncate(text, width);
  if (line.length >= width) return line;
  const space = " ".repeat(width - line.length);
  return align === "right" ? space + line : line + space;
};

/** Column widths from the header and the content, then squeezed to the width available. */
export function columnWidths(columns, rows, total, { gap = 2 } = {}) {
  const natural = columns.map((column) =>
    Math.max(
      column.label.length,
      ...rows.map((row) => String(column.format ? column.format(row) : (row[column.key] ?? "")).length),
      column.min ?? 0,
    ),
  );
  const widths = natural.map((width, i) => Math.min(width, columns[i].max ?? Number.MAX_SAFE_INTEGER));
  const room = total - gap * (columns.length - 1);
  while (widths.reduce((sum, width) => sum + width, 0) > room) {
    // Shrink the widest column first, and let a column fall to its `min` before its neighbour gives
    // up anything: the readable identity columns matter more than the last digit of a total.
    let widest = 0;
    for (let i = 1; i < widths.length; i += 1) if (widths[i] > widths[widest]) widest = i;
    if (widths[widest] <= (columns[widest].min ?? 3)) break;
    widths[widest] -= 1;
  }
  return widths.map((width, i) => Math.max(columns[i].min ?? 3, width));
}

/**
 * Paint a table into a grid region and return the grid row each data row landed on — so a cursor can
 * be revealed by scrolling, and a test can ask which row a click or a key would select.
 */
export function paintTable(grid, { columns, rows, row, col, width, height, cursor = 0, palette, empty = "nothing recorded yet" }) {
  const widths = columnWidths(columns, rows, width);
  const header = columns.map((column, i) => pad(column.label, widths[i], column.align)).join(" ".repeat(2));
  put(grid, row, col, truncate(header, width), palette.title);
  // `height` counts the header too: a caller hands in the region it owns, and the body is what is left.
  const bodyRows = Math.max(0, height - 1);
  const first = clamp(cursor - (bodyRows - 1), 0, Math.max(0, rows.length - bodyRows));
  const at = [];
  if (rows.length === 0) {
    put(grid, row + 1, col, empty, palette.dim);
    return at;
  }
  for (let i = first; i < rows.length && i - first < bodyRows; i += 1) {
    const selected = i === cursor;
    const style = selected ? palette.selected : palette.ink;
    const line = columns
      .map((column, c) => pad(column.format ? column.format(rows[i]) : (rows[i][column.key] ?? ""), widths[c], column.align))
      .join(" ".repeat(2));
    const y = row + 1 + (i - first);
    put(grid, y, col, truncate(line, width), style);
    if (selected) {
      // The selection paints to the panel's edge, not just under the text: a highlighted row that
      // stops mid-width reads as a text style rather than as the cursor.
      const used = Math.min(line.length, width);
      fillRow(grid, y, col + used, width - used, " ", palette.selected);
    }
    at[i] = y;
  }
  return at;
}

/* ------------------------------------------------------------------- views */

const routeNames = (alias) => (alias?.providers ?? []).map((ref) => (typeof ref === "string" ? ref : (ref.id ?? "?")));
const routeDetail = (alias) =>
  (alias?.providers ?? []).map((ref) => (typeof ref === "string" ? ref : `${ref.id}→${ref.modelOverride ?? alias.model}`)).join(", ");

/**
 * A route's effective model: an alias may point a provider at a *different* model id
 * (`{"id": "cline-pass", "modelOverride": "cline-free/muse-spark-1.3-contributor"}`), and the store
 * keys its rows by the model that actually ran — so looking the alias's own `model` up against every
 * provider reported zero seats for exactly the routes that were working as configured.
 */
const effectiveModel = (alias, ref) => (typeof ref === "string" ? alias.model : (ref.modelOverride ?? alias.model));

const statsFor = (model, provider, modelStats) => modelStats.find((row) => row.model === `${provider}/${model}`) ?? null;

const sumStats = (rows) => {
  const total = {
    seats: 0,
    findings: 0,
    kept: 0,
    located: 0,
    unlocated: 0,
    uncheckable: 0,
    reportedUsd: 0,
    pricedSeats: 0,
    listUsd: 0,
    estimatedUsd: 0,
    noRate: 0,
    seatMs: 0,
    lastSeatAt: null,
    attempts: {},
  };
  for (const row of rows) {
    if (!row) continue;
    total.seats += row.seats;
    total.findings += row.findings;
    total.kept += row.kept;
    total.located += row.located;
    total.unlocated += row.unlocated;
    total.uncheckable += row.uncheckable;
    total.reportedUsd += row.cost.reported;
    total.pricedSeats += row.cost.priced;
    total.listUsd += row.cost.list;
    total.estimatedUsd += row.cost.estimated;
    total.noRate += row.cost.noRate;
    total.seatMs += row.seatMs;
    if (row.lastSeatAt && (!total.lastSeatAt || row.lastSeatAt > total.lastSeatAt)) total.lastSeatAt = row.lastSeatAt;
    for (const [reason, n] of Object.entries(row.attempts ?? {})) total.attempts[reason] = (total.attempts[reason] ?? 0) + n;
  }
  return total;
};

/**
 * The aliases tab: what each alias names, the routes it may walk, and what the store saw it do.
 * The money columns keep their basis in the label — reported and list are different questions and a
 * single `$` column would silently mix them.
 */
export function aliasRows({ config, modelStats }) {
  const rows = [];
  for (const [alias, spec] of Object.entries(config.aliases ?? {})) {
    const stats = sumStats(
      (spec.providers ?? []).map((ref) => statsFor(effectiveModel(spec, ref), typeof ref === "string" ? ref : (ref.id ?? "?"), modelStats)),
    );
    rows.push({
      alias,
      model: spec.model,
      routes: routeNames(spec).length,
      routeDetail: routeDetail(spec),
      seats: stats.seats,
      raised: stats.findings,
      kept: stats.kept,
      located: stats.located,
      unlocated: stats.unlocated,
      reportedUsd: stats.pricedSeats > 0 ? stats.reportedUsd : null,
      pricedSeats: stats.pricedSeats,
      listUsd: stats.listUsd + stats.estimatedUsd,
      noRate: stats.noRate,
      refusals: Object.entries(stats.attempts)
        .map(([reason, n]) => `${reason}×${n}`)
        .join(" "),
      last: stats.lastSeatAt ? String(stats.lastSeatAt).slice(0, 16).replace("T", " ") : "—",
    });
  }
  return rows.sort((a, b) => b.seats - a.seats || a.alias.localeCompare(b.alias));
}

/** The fusions tab: how each rung runs, how it ended, what it cost, and what its reviews produced. */
export function fusionRows({ config, fusionStats, seatStats }) {
  const rows = [];
  const byFusion = new Map(fusionStats.map((row) => [row.fusion, row]));
  for (const [fusion, spec] of Object.entries(config.fusions ?? {})) {
    const stats = byFusion.get(fusion) ?? null;
    const seats = seatStats.filter((row) => row.fusion === fusion);
    const degraded = seats.reduce((n, row) => n + row.degraded, 0);
    rows.push({
      fusion,
      mode: spec.mode ?? "?",
      face: spec.proxy ? `proxy→${spec.proxy.alias}` : spec.route ? "routes" : spec.execute ? "answers" : "deliberates",
      runs: stats?.runs ?? 0,
      failures: stats?.failures ?? 0,
      seats: stats?.seats ?? 0,
      degraded,
      sufficient: stats ? `${stats.cascades.sufficient}/${stats.cascades.total}` : "—",
      verify: stats?.verifyChecks ?? 0,
      malformed: stats?.malformed ?? 0,
      located: stats?.marked.located ?? 0,
      unlocated: stats?.marked.unlocated ?? 0,
      reportedUsd: stats ? stats.cost.reported : null,
      listUsd: stats ? stats.cost.list + stats.cost.estimated : 0,
      last: stats?.lastRunAt ? String(stats.lastRunAt).slice(0, 16).replace("T", " ") : "—",
    });
  }
  return rows.sort((a, b) => b.runs - a.runs || a.fusion.localeCompare(b.fusion));
}

/** The seat names a mode actually runs, in stage order — the seats a fusion's candidates must cover. */
export function modeSeats(mode) {
  const names = [];
  for (const stage of mode?.stages ?? []) {
    for (const name of stage.parallel ?? []) names.push(name);
    if (stage.single) names.push(stage.single);
  }
  return names;
}

/**
 * The routes tab: per fusion and seat, what the config offers and what the store saw. `candidates`
 * is the ordered list the seat walks; `answered` and `refusals` come from the store, so a seat whose
 * first candidate never runs is visible as such.
 */
export function routeRows({ config, seatStats }) {
  const rows = [];
  for (const [fusion, spec] of Object.entries(config.fusions ?? {})) {
    const mode = config.modes?.[spec.mode];
    const names = [...new Set([...modeSeats(mode), ...Object.keys(spec.candidates ?? {})])].sort();
    for (const seat of names) {
      const candidates = (spec.candidates?.[seat] ?? []).map((candidate) =>
        typeof candidate === "string" ? candidate : candidate?.decide ? "decision" : "?",
      );
      const stat = seatStats.find((row) => row.fusion === fusion && row.persona === seat) ?? null;
      const refusals = stat
        ? Object.entries(stat.refusals)
            .map(
              ([route, reasons]) =>
                `${route}:${Object.entries(reasons)
                  .map(([reason, n]) => `${reason}×${n}`)
                  .join("+")}`,
            )
            .join(" ")
        : "";
      rows.push({
        fusion,
        seat,
        candidates: candidates.join(" → ") || "—",
        answered: stat
          ? Object.entries(stat.answered)
              .map(([alias, n]) => `${alias}×${n}`)
              .join(" ")
          : "",
        refusals,
        seats: stat?.seats ?? 0,
        degraded: stat?.degraded ?? 0,
        tokens: stat?.tokens ?? 0,
        reportedUsd: stat && stat.unpricedSeats < stat.seats ? stat.reportedUsd : stat ? null : null,
      });
    }
  }
  return rows.sort((a, b) => a.fusion.localeCompare(b.fusion) || a.seat.localeCompare(b.seat));
}

/** The columns each tab shows. Every one carries a number the store answered. */
export function columnsFor(tab) {
  if (tab === "aliases")
    return [
      { key: "alias", label: "alias", min: 8, max: 18 },
      { key: "model", label: "model", min: 12, max: 34 },
      { key: "routes", label: "routes", align: "right", min: 6 },
      { key: "seats", label: "seats", align: "right", min: 5 },
      { key: "kept", label: "kept/raised", align: "right", min: 11, format: (row) => `${row.kept}/${row.raised}` },
      { key: "located", label: "located", align: "right", min: 7 },
      { key: "reportedUsd", label: "$report", align: "right", min: 8, format: (row) => money(row.reportedUsd) },
      { key: "pricedSeats", label: "n", align: "right", min: 3 },
      { key: "listUsd", label: "$list", align: "right", min: 8, format: (row) => (row.listUsd ? money(row.listUsd) : "—") },
      { key: "refusals", label: "refused", min: 8, max: 22 },
      { key: "last", label: "last seat", min: 10, max: 16 },
    ];
  if (tab === "fusions")
    return [
      { key: "fusion", label: "fusion", min: 10, max: 16 },
      { key: "mode", label: "mode", min: 10, max: 18 },
      { key: "face", label: "face", min: 9, max: 16 },
      { key: "runs", label: "runs", align: "right", min: 4 },
      { key: "failures", label: "fail", align: "right", min: 4 },
      { key: "seats", label: "seats", align: "right", min: 5 },
      { key: "degraded", label: "degr", align: "right", min: 4 },
      { key: "sufficient", label: "casc", align: "right", min: 5 },
      { key: "verify", label: "verify", align: "right", min: 6 },
      { key: "malformed", label: "malf", align: "right", min: 4 },
      { key: "located", label: "loc", align: "right", min: 3 },
      { key: "unlocated", label: "unloc", align: "right", min: 5 },
      { key: "reportedUsd", label: "$report", align: "right", min: 8, format: (row) => money(row.reportedUsd) },
      { key: "listUsd", label: "$list", align: "right", min: 8, format: (row) => (row.listUsd ? money(row.listUsd) : "—") },
      { key: "last", label: "last run", min: 10, max: 16 },
    ];
  return [
    { key: "fusion", label: "fusion", min: 10, max: 16 },
    { key: "seat", label: "seat", min: 10, max: 18 },
    { key: "candidates", label: "walks (config)", min: 14, max: 34 },
    { key: "answered", label: "answered (store)", min: 10, max: 26 },
    { key: "refusals", label: "refused (route:reason×n)", min: 12, max: 34 },
    { key: "seats", label: "seats", align: "right", min: 5 },
    { key: "degraded", label: "degr", align: "right", min: 4 },
    { key: "tokens", label: "tokens", align: "right", min: 6, format: (row) => (row.tokens ? compact(row.tokens) : "—") },
  ];
}
