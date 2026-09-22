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

import { promptPath } from "../extensions/pi-fusion-matrix/config.js";

/** The closed tab list, in display order. */
export const TABS = ["aliases", "fusions", "routes", "personas"];

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
    head: fg(140, 235, 150),
    body: fg(0, 150, 70),
    tail: fg(0, 70, 32),
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
 * What one store aggregate becomes on a row: the counters, the two money bases kept apart, and the
 * refusal tally. Shared by alias and route rows so both answer with the same fields — the parent is
 * just the aggregate over exactly the store rows its children each hold one of.
 */
const statFields = (stats) => ({
  seats: stats.seats,
  raised: stats.findings,
  kept: stats.kept,
  located: stats.located,
  unlocated: stats.unlocated,
  reportedUsd: stats.pricedSeats > 0 ? stats.reportedUsd : null,
  pricedSeats: stats.pricedSeats,
  // One basis per field: a column that added `estimated` into `list` would overstate list-basis money
  // with no denominator for the folded part, and no reader could tell the two apart afterwards.
  listUsd: stats.listUsd,
  estimatedUsd: stats.estimatedUsd,
  noRate: stats.noRate,
  refusals: Object.entries(stats.attempts)
    .map(([reason, n]) => `${reason}×${n}`)
    .join(" "),
  last: stats.lastSeatAt ? String(stats.lastSeatAt).slice(0, 16).replace("T", " ") : "—",
});

/**
 * The aliases tab: what each alias names, the routes it may walk, and what the store saw it do.
 * The money columns keep their basis in the label — reported and list are different questions and a
 * single `$` column would silently mix them.
 *
 * The list is flat — every expanded alias is followed by its route rows — so the cursor walks one
 * index range and the painter still sees ordinary rows. Route rows keep config order and never join
 * the parent sort: that order IS the data being edited (K/J moves a route within it), so a sorted
 * child list would display a position no key could reproduce.
 */
export function aliasRows({ config, modelStats, expanded = {} }) {
  const groups = [];
  for (const [alias, spec] of Object.entries(config.aliases ?? {})) {
    const providers = spec.providers ?? [];
    const stats = sumStats(
      providers.map((ref) => statsFor(effectiveModel(spec, ref), typeof ref === "string" ? ref : (ref.id ?? "?"), modelStats)),
    );
    // An alias with no providers has nothing to show, so it never claims to be expanded.
    const open = providers.length > 0 && Boolean(expanded[alias]);
    const children = open
      ? providers.map((ref, index) => {
          const provider = typeof ref === "string" ? ref : (ref.id ?? "?");
          const model = effectiveModel(spec, ref);
          return {
            kind: "route",
            parent: alias,
            index,
            count: providers.length,
            provider,
            model,
            alias: `  ${index === providers.length - 1 ? "└" : "├"} ${provider}`,
            routes: `${index + 1}/${providers.length}`,
            ...statFields(sumStats([statsFor(model, provider, modelStats)])),
          };
        })
      : [];
    groups.push({
      parent: {
        kind: "alias",
        alias,
        model: spec.model,
        routes: routeNames(spec).length,
        routeDetail: routeDetail(spec),
        ...statFields(stats),
        expanded: open,
        childCount: providers.length,
      },
      children,
    });
  }
  groups.sort((a, b) => b.parent.seats - a.parent.seats || a.parent.alias.localeCompare(b.parent.alias));
  return groups.flatMap(({ parent, children }) => [parent, ...children]);
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
      listUsd: stats ? stats.cost.list : 0,
      estimatedUsd: stats ? stats.cost.estimated : 0,
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
    const configured = [...new Set([...modeSeats(mode), ...Object.keys(spec.candidates ?? {})])];
    // A seat that *ran* is shown whether or not the config still names it: a roster edited (or a seat
    // renamed) leaves store rows behind, and a routes tab that silently dropped them would report a
    // history it cannot place as no history at all.
    const stored = seatStats.filter((row) => row.fusion === fusion).map((row) => row.persona);
    const names = [...new Set([...configured, ...stored])].sort();
    for (const seat of names) {
      const unconfigured = !configured.includes(seat);
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
        unconfigured,
        answered: stat
          ? Object.entries(stat.answered)
              .map(([alias, n]) => `${alias}×${n}`)
              .join(" ")
          : "",
        refusals,
        seats: stat?.seats ?? 0,
        degraded: stat?.degraded ?? 0,
        tokens: stat?.tokens ?? 0,
      });
    }
  }
  return rows.sort((a, b) => a.fusion.localeCompare(b.fusion) || a.seat.localeCompare(b.seat));
}

/**
 * The latest `lastSeatAt` a set of seat rows holds, stamped and trimmed the way `statFields` reads `last` — a
 * parent's "when did this last sit" over however many rows its aggregates summed.
 */
const lastStamp = (rows) => {
  let at = null;
  for (const row of rows) {
    if (row.lastSeatAt && (!at || row.lastSeatAt > at)) at = row.lastSeatAt;
  }
  return at ? String(at).slice(0, 16).replace("T", " ") : "—";
};

/**
 * How the prompt column reads a persona's prompt: the loader's own rule (`promptPath` says path) names the file,
 * and inline text reports its line count — empty text is 0 lines, the count the editor's rows use.
 */
const promptKindFor = (prompt, source) => {
  if (prompt && promptPath(prompt, source)) return `file ${prompt}`;
  return `inline · ${prompt ? prompt.split("\n").length : 0} lines`;
};

/**
 * The personas tab: what each persona is prompted to be beside what the store saw its seats do. Under an open
 * persona sit the fusions that place it — the same (fusion, seat) rows the routes tab draws, `e` pointing one at
 * an alias exactly as it does there — in the route rows' own order, the tree closing at the last. Parents sort by
 * name: this list is edited (n/e/d), not ranked by traffic.
 *
 * A child's first column is its tree label (as an alias's routes are) and its `promptKind` holds the walk string
 * beside the parent's prompt; its numbers are the one matching store row's own, never the parent's totals again.
 */
export function personaRows({ config, seatStats = [], sources = {}, expanded = {} }) {
  const rows = [];
  const seats = routeRows({ config, seatStats });
  for (const name of Object.keys(config.personas ?? {}).sort((a, b) => a.localeCompare(b))) {
    const persona = config.personas[name] ?? {};
    const prompt = typeof persona.prompt === "string" ? persona.prompt : "";
    const mine = seatStats.filter((stat) => stat.persona === name);
    const under = seats.filter((row) => row.seat === name && !row.unconfigured);
    // Like an alias with no providers, a persona no fusion places cannot be opened, whatever the map says.
    const open = under.length > 0 && Boolean(expanded[name]);
    const children = open
      ? under.map((row, index) => {
          const slice = seatStats.filter((stat) => stat.fusion === row.fusion && stat.persona === name);
          return {
            kind: "seat",
            persona: `  ${index === under.length - 1 ? "└" : "├"} ${row.fusion}`,
            parent: name,
            fusion: row.fusion,
            seat: name,
            candidates: row.candidates,
            promptKind: row.candidates,
            walks: (config.fusions?.[row.fusion]?.candidates?.[name] ?? []).length,
            refusals: row.refusals,
            temperature: "—",
            thinking: "—",
            output: "—",
            runs: slice.length,
            seats: row.seats,
            degraded: row.degraded,
            tokens: row.tokens,
            last: lastStamp(slice),
          };
        })
      : [];
    rows.push(
      {
        kind: "persona",
        persona: name,
        promptKind: promptKindFor(prompt, sources.personas?.[name]),
        temperature: persona.temperature ?? "—",
        thinking: persona.thinking ?? "—",
        output: persona.output ?? "—",
        runs: mine.length,
        seats: mine.reduce((n, stat) => n + stat.seats, 0),
        degraded: mine.reduce((n, stat) => n + stat.degraded, 0),
        tokens: mine.reduce((n, stat) => n + stat.tokens, 0),
        last: lastStamp(mine),
        expanded: open,
        childCount: under.length,
      },
      ...children,
    );
  }
  return rows;
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
      { key: "estimatedUsd", label: "$est", align: "right", min: 7, format: (row) => (row.estimatedUsd ? money(row.estimatedUsd) : "—") },
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
      { key: "estimatedUsd", label: "$est", align: "right", min: 7, format: (row) => (row.estimatedUsd ? money(row.estimatedUsd) : "—") },
      { key: "listUsd", label: "$list", align: "right", min: 8, format: (row) => (row.listUsd ? money(row.listUsd) : "—") },
      { key: "last", label: "last run", min: 10, max: 16 },
    ];
  if (tab === "personas")
    return [
      { key: "persona", label: "persona", min: 10, max: 20 },
      { key: "promptKind", label: "prompt", min: 12, max: 34 },
      { key: "temperature", label: "temperature", align: "right", min: 5 },
      { key: "thinking", label: "thinking", min: 4 },
      { key: "output", label: "output", min: 4 },
      { key: "runs", label: "runs", align: "right", min: 4 },
      { key: "seats", label: "seats", align: "right", min: 5 },
      { key: "degraded", label: "degraded", align: "right", min: 4 },
      { key: "tokens", label: "tokens", align: "right", min: 6, format: (row) => (row.tokens ? compact(row.tokens) : "—") },
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
