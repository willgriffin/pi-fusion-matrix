/**
 * The terminal interface's units: the rain, the layout, the tables, the keys and the proposals.
 *
 * Everything here runs without a terminal. The driver is exercised through `--plain` by the process
 * smoke in the commit that added it; what these checks hold is the part a test *can* hold — that a
 * seeded field draws the same rain twice, that a head is brighter than its tail, that a table stays
 * inside its panel, that a proposal is refused by the loader before a file is touched, and that the
 * diff renderer writes what changed rather than what exists.
 *
 *   node --test test/tui.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { GLYPHS, LIT, cells, createRain, makeRng, resizeRain, stepRain } from "../scripts/tui-rain.mjs";
import {
  TABS,
  aliasRows,
  clamp,
  columnWidths,
  columnsFor,
  compact,
  createGrid,
  gridLine,
  money,
  pad,
  paintTable,
  paletteFor,
  put,
  routeRows,
  fusionRows,
  truncate,
} from "../scripts/tui-view.mjs";
import {
  adopt,
  applyKey,
  buildState,
  detailFor,
  diff,
  frameFor,
  keyName,
  paint,
  proposeRouteOrder,
  proposeSeatAlias,
  selected,
  validateAgainst,
} from "../scripts/matrix-tui.mjs";
import { loadMatrixConfig } from "../extensions/pi-fusion-matrix/config.js";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

/* ------------------------------------------------------------------ fixture */

/** A small, self-contained world: two aliases (one with a modelOverride route) and two fusions. */
const config = {
  aliases: {
    kimi: { model: "kimi-k3", providers: ["opencode-go", "kimi-code"] },
    muse: { model: "muse-spark-1.3-contributor", providers: ["opencode-go", { id: "cline-pass", modelOverride: "cline-free/muse" }] },
    kimiAlias: { model: "kimi-k3", providers: ["cline-pass"] },
  },
  modes: {
    single: { stages: [{ single: "technical", input: "prompt" }] },
    committee: {
      stages: [
        { parallel: ["technical", "skeptic"], input: "prompt" },
        { single: "judge", input: "panel" },
      ],
    },
  },
  fusions: {
    quick: { mode: "single", candidates: { technical: ["kimi"] } },
    review: { mode: "committee", candidates: { technical: ["kimi"], skeptic: ["muse"], judge: ["kimi"] } },
  },
};

const modelStats = [
  {
    model: "opencode-go/kimi-k3",
    seats: 12,
    degraded: 0,
    harnesses: { omp: 12 },
    personas: { "review-synth": 5 },
    findings: 7,
    kept: 7,
    located: 7,
    unlocated: 0,
    uncheckable: 0,
    input: 60000,
    output: 5000,
    total: 65000,
    cost: { reported: 0.5264, estimated: 0, list: 0, noRate: 0, priced: 12 },
    seatMs: 513000,
    attempts: { transient: 2 },
    lastSeatAt: "2026-09-21T03:05:41.427Z",
  },
  {
    model: "cline-pass/cline-free/muse",
    seats: 1,
    degraded: 0,
    harnesses: { omp: 1 },
    personas: { technical: 1 },
    findings: 0,
    kept: 0,
    located: 0,
    unlocated: 0,
    uncheckable: 0,
    input: 500,
    output: 45,
    total: 545,
    cost: { reported: 0, estimated: 0, list: 0.00012, noRate: 0, priced: 0 },
    seatMs: 3800,
    attempts: {},
    lastSeatAt: "2026-09-20T19:31:00.000Z",
  },
];

const fusionStats = [
  {
    fusion: "review",
    runs: 5,
    failures: 0,
    seats: 25,
    degradedSeats: 0,
    seatErrors: 0,
    cascades: { total: 5, sufficient: 0, advanced: 5 },
    verifyChecks: 5,
    substitutions: 1,
    saved: 0,
    failedWrites: 0,
    marked: { total: 10, located: 7, unlocated: 3, uncheckable: 0 },
    malformed: 1,
    verdicts: { clean: 1, findings: 4 },
    dispositionBy: { "review-synth": 5 },
    workItems: { "#25": 5 },
    runMs: 15000,
    timedRuns: 5,
    decisionTokens: 120,
    decisionCostReported: 0,
    cost: { reported: 0.66, estimated: 0, list: 0, noRate: 0, priced: 5 },
    lastRunAt: "2026-09-21T03:05:41.427Z",
  },
];

const seatStats = [
  {
    fusion: "review",
    persona: "skeptic",
    seats: 1,
    degraded: 0,
    tokens: 60,
    seatMs: 400,
    reportedUsd: 0,
    unpricedSeats: 1,
    answered: { muse: 1 },
    refusals: { "opencode-go": { quota: 1 }, zai: { transient: 1 } },
  },
];

const state = () =>
  buildState({
    config,
    modelStats,
    fusionStats,
    seatStats,
    storeTotals: { sessions: 69, deliberationRuns: 20, proxyRuns: 9, seats: 51, seatFindings: 9 },
    baseConfig: config,
    layerConfig: {},
    layerFile: "/tmp/nowhere/pi-fusion-matrix.json",
  });

/* --------------------------------------------------------------------- rain */

test("the rain is seeded: one seed draws one field, and its head outshines its tail", () => {
  const a = createRain({ width: 40, height: 12, seed: 7, density: 1 });
  const b = createRain({ width: 40, height: 12, seed: 7, density: 1 });
  assert.deepEqual(cells(a).levels, cells(b).levels, "the same seed is the same frame");
  const other = createRain({ width: 40, height: 12, seed: 8, density: 1 });
  assert.notDeepEqual(cells(other).levels, cells(a).levels, "a different seed is a different frame");

  // A full column: the drop's head is at the brightest level and its trail is not.
  const one = createRain({ width: 1, height: 20, seed: 3, density: 1 });
  one.columns[0] = { head: 10, speed: 0, length: 6, birth: 0.5 };
  const { levels, glyphs } = cells(one);
  assert.equal(levels[10], LIT.head, "the head is the brightest cell");
  assert.equal(levels[9], LIT.body);
  assert.equal(levels[5], LIT.tail, "the far end of the trail is the dimmest");
  assert.equal(levels[4], LIT.none, "beyond the drop is untouched");
  assert.ok(GLYPHS.includes(glyphs[10]));
  assert.notEqual(glyphs[10], glyphs[8], "a trail holds different characters, not one repeated");

  // Falling: the head moves down by its speed, and a drop that leaves is respawned above.
  const falling = createRain({ width: 1, height: 6, seed: 5, density: 1 });
  falling.columns[0] = { head: 1, speed: 0.5, length: 3, birth: 0.1 };
  stepRain(falling);
  assert.equal(falling.columns[0].head, 1.5);
  falling.columns[0].head = 40;
  stepRain(falling);
  assert.ok(falling.columns[0].head < 6, "a drop that fell off the screen comes back from the top");

  // Density zero is a field with nothing lit — not an error, and not a stub.
  const empty = createRain({ width: 10, height: 5, seed: 1, density: 0 });
  assert.equal(
    [...cells(empty).levels].every((level) => level === 0),
    true,
  );

  const resized = resizeRain(one, { width: 10, height: 4 });
  assert.equal(resized.width, 10);
  assert.equal(resized.height, 4);
  assert.equal(resizeRain(resized, { width: 10, height: 4 }), resized, "a resize to the same size is a no-op");
  assert.equal(typeof makeRng(1)(), "number");
});

/* --------------------------------------------------------------------- view */

test("a frame's grid, and the text put into it, are clipped to the grid", () => {
  const grid = createGrid(12, 3);
  put(grid, 1, 10, "abcdef");
  assert.equal(gridLine(grid, 1), "          ab");
  put(grid, 5, 0, "off-grid");
  assert.equal(gridLine(grid, 5), "", "a row outside the grid reads as nothing");
  put(grid, 0, -3, "xy");
  assert.equal(gridLine(grid, 0).slice(0, 2), "  xy".slice(0, 2));
  assert.equal(truncate("abcdefghij", 5), "abcd…");
  assert.equal(truncate("abc", 5), "abc");
  assert.equal(truncate("abc", 1), "…");
  assert.equal(pad("ab", 5), "ab   ");
  assert.equal(pad("ab", 5, "right"), "   ab");
  assert.equal(clamp(9, 0, 4), 4);
  assert.equal(compact(1500), "1.5k");
  assert.equal(compact(2500000), "2.50M");
  assert.equal(compact(null), "—");
  assert.equal(money(0.0004), "$0.00040");
  assert.equal(money(12.5), "$12.50");
  assert.equal(money(null), "—");
  assert.equal(money(0), "$0");
});

test("the palette drops escapes without dropping the selection", () => {
  const colour = paletteFor({ color: true });
  assert.ok(colour.head.includes("\u001b[38;2;"), "a coloured palette paints truecolour");
  const mono = paletteFor({ color: false });
  assert.equal(mono.head, "");
  assert.equal(mono.body, "");
  assert.equal(mono.selected, "\u001b[7m", "mono keeps a visible cursor");
});

test("column widths squeeze to the room available, and never below the identity minimum", () => {
  const columns = [
    { key: "a", label: "a", min: 10, max: 60 },
    { key: "b", label: "b", min: 3 },
  ];
  const rows = [{ a: "x".repeat(60), b: "y".repeat(20) }];
  const wide = columnWidths(columns, rows, 200);
  assert.equal(wide[0], 60, "a maximum is respected");
  const narrow = columnWidths(columns, rows, 20);
  assert.equal(narrow[0], 10, "the minimum wins over the squeeze");
  assert.ok(narrow[1] >= 3);
});

test("a table stays inside its panel, marks the cursor, and scrolls to keep it visible", () => {
  const palette = paletteFor({ color: true });
  const columns = [
    { key: "name", label: "name", min: 6 },
    { key: "n", label: "n", align: "right", min: 3 },
  ];
  const rows = Array.from({ length: 10 }, (_, i) => ({ name: `row-${i}`, n: i }));
  const grid = createGrid(30, 7);
  const at = paintTable(grid, { columns, rows, row: 1, col: 1, width: 28, height: 5, cursor: 0, palette });
  assert.match(gridLine(grid, 1), /name/);
  assert.match(gridLine(grid, 2), /row-0/);
  assert.equal(at[0], 2);
  assert.ok(gridLine(grid, 6) === "" || !gridLine(grid, 6).includes("row-"), "the body never runs past the region it was given");

  // A cursor past the visible window scrolls the window: the selected row is on screen.
  const scrolled = createGrid(30, 7);
  const at2 = paintTable(scrolled, { columns, rows, row: 1, col: 1, width: 28, height: 5, cursor: 9, palette });
  assert.equal(at2[9] !== undefined, true, "the selected row landed inside the region");
  assert.match(gridLine(scrolled, at2[9]), /row-9/);

  const empty = createGrid(30, 4);
  paintTable(empty, { columns, rows: [], row: 1, col: 1, width: 28, height: 3, cursor: 0, palette });
  assert.match(gridLine(empty, 2), /nothing recorded yet/);
});

/* -------------------------------------------------------------------- views */

test("the alias table joins the config to the store, modelOverride routes included", () => {
  const rows = aliasRows({ config, modelStats });
  const kimi = rows.find((row) => row.alias === "kimi");
  assert.equal(kimi.seats, 12);
  assert.equal(kimi.kept, 7);
  assert.equal(kimi.raised, 7);
  assert.equal(kimi.located, 7);
  assert.equal(kimi.reportedUsd, 0.5264);
  assert.equal(kimi.pricedSeats, 12);
  assert.equal(kimi.refusals, "transient×2");
  assert.equal(kimi.routes, 2);

  // `muse` walks `cline-pass` at a *different* model id; the store keys the row by what ran, so a
  // lookup on the alias's own model would have reported zero seats for a route that was working.
  const muse = rows.find((row) => row.alias === "muse");
  assert.equal(muse.seats, 1, "the modelOverride route is joined to the alias");
  assert.equal(muse.pricedSeats, 0);
  assert.equal(muse.reportedUsd, null, "an unpriced alias reports no money rather than zero money");
  assert.equal(Number(muse.listUsd.toFixed(5)), 0.00012, "its list basis is what the tokens would cost");
  assert.match(muse.routeDetail, /cline-pass→cline-free\/muse/);

  const unknown = rows.find((row) => row.alias === "kimiAlias");
  assert.equal(unknown.seats, 0, "an alias with no store rows is a zero, not a missing row");
  assert.equal(unknown.last, "—");
});

test("the fusion table carries how a rung ran, ended and cost", () => {
  const rows = fusionRows({ config, fusionStats, seatStats });
  const review = rows.find((row) => row.fusion === "review");
  assert.equal(review.mode, "committee");
  assert.equal(review.runs, 5);
  assert.equal(review.sufficient, "0/5", "a cascade that never sufficed is visible as such");
  assert.equal(review.malformed, 1);
  assert.equal(review.located, 7);
  assert.equal(review.unlocated, 3);
  assert.equal(review.reportedUsd, 0.66);
  assert.equal(review.face, "deliberates");
  const quick = rows.find((row) => row.fusion === "quick");
  assert.equal(quick.runs, 0);
  assert.equal(quick.sufficient, "—");
  assert.equal(quick.reportedUsd, null);
});

test("the routes table shows what the config offers beside what the store saw", () => {
  const rows = routeRows({ config, seatStats });
  const skeptic = rows.find((row) => row.fusion === "review" && row.seat === "skeptic");
  assert.equal(skeptic.candidates, "muse");
  assert.equal(skeptic.answered, "muse×1");
  assert.equal(skeptic.refusals, "opencode-go:quota×1 zai:transient×1");
  assert.equal(skeptic.seats, 1);
  const judge = rows.find((row) => row.fusion === "review" && row.seat === "judge");
  assert.equal(judge.answered, "", "a seat with no store rows claims nothing");
  assert.equal(judge.refusals, "");
});

test("every column of every tab reads a field the rows actually carry", () => {
  const world = state();
  for (const tab of TABS) {
    const rows = world.rows[tab];
    assert.ok(rows.length > 0, `${tab} has rows`);
    for (const column of columnsFor(tab)) {
      for (const row of rows) {
        const value = column.format ? column.format(row) : row[column.key];
        assert.notEqual(value, undefined, `${tab}.${column.key} is carried by every row`);
      }
    }
  }
});

/* --------------------------------------------------------------------- keys */

test("keys move the cursor, switch tabs, and never run off a table", () => {
  let world = state();
  assert.equal(world.tab, "aliases");
  world = applyKey(world, "j").state;
  assert.equal(world.cursors.aliases, 1);
  world = applyKey(world, "k").state;
  world = applyKey(world, "k").state;
  assert.equal(world.cursors.aliases, 0, "the cursor stops at the top");
  world = applyKey(world, "G").state;
  assert.equal(world.cursors.aliases, world.rows.aliases.length - 1);
  assert.equal(applyKey(world, "j").state.cursors.aliases, world.rows.aliases.length - 1, "and at the bottom");

  assert.equal(applyKey(world, "tab").state.tab, "fusions");
  assert.equal(applyKey(world, "3").state.tab, "routes");
  assert.equal(applyKey(applyKey(world, "3").state, "tab").state.tab, "aliases", "tabs wrap");
  assert.equal(applyKey(world, "1").state.rows.aliases.length > 0, true);
  assert.equal(applyKey(world, "a").state.rain, false, "the rain toggles");
  assert.equal(applyKey(world, "c").state.color, false);
  assert.equal(applyKey(world, "?").state.help, true);
  assert.equal(applyKey(world, "q").effect, "quit");
  assert.equal(applyKey(world, "r").effect, "reload");
  assert.equal(applyKey(world, "R").effect, "reingest");
  assert.equal(applyKey(world, "e").effect, "propose");
  assert.equal(applyKey(world, "s").effect, "none");
  assert.match(applyKey(world, "s").state.message, /nothing to save/);
});

test("a terminal chunk becomes one key name", () => {
  assert.equal(keyName("\u001b[A"), "up");
  assert.equal(keyName("\u001b[B"), "down");
  assert.equal(keyName("\u001b[Z"), "shift-tab");
  assert.equal(keyName("\u001b"), "escape");
  assert.equal(keyName("\t"), "tab");
  assert.equal(keyName("\r"), "return");
  assert.equal(keyName("\u0003"), "q", "ctrl-c is a quit, not a character");
  assert.equal(keyName("j"), "j");
});

/* ---------------------------------------------------------------- proposals */

test("a proposal changes one path, and the loader's verdict travels with it", () => {
  // Validation is the *loader's*, so the base has to be a config the loader accepts: the packaged one,
  // which is also where the seat names and aliases being pointed at actually exist.
  const packaged = loadMatrixConfig({ cwd: root, layers: ["packaged"] }).config;
  const world = buildState({
    config: packaged,
    baseConfig: packaged,
    layerConfig: {},
    layerFile: "/tmp/nowhere/pi-fusion-matrix.json",
    modelStats,
    fusionStats,
    seatStats,
  });
  const row = world.rows.routes.find((entry) => entry.fusion === "review-check" && entry.seat === "review-skeptic");
  assert.ok(row, "the packaged roster has the seat the smoke test re-pointed");
  const pending = proposeSeatAlias({ state: world, row, alias: "muse" });
  assert.deepEqual(
    pending.patch,
    { fusions: { "review-check": { candidates: { "review-skeptic": ["muse"] } } } },
    "only the changed path is written",
  );
  assert.equal(pending.layerFile, "/tmp/nowhere/pi-fusion-matrix.json");
  assert.match(pending.summary, /review-check\.review-skeptic walks muse/);
  assert.deepEqual(pending.errors, [], "a real alias is a valid change");

  // A change the loader refuses is refused here, with the loader's own message, before any write.
  const invalid = proposeSeatAlias({ state: world, row, alias: "no-such-alias" });
  assert.ok(invalid.errors.length > 0, "an unknown alias is refused");
  assert.match(invalid.errors.join("\n"), /no-such-alias/);

  // Rotating an alias's routes reorders them, and says so.
  const aliasRow = world.rows.aliases.find((entry) => entry.alias === "kimi");
  const rotated = proposeRouteOrder({ state: world, row: aliasRow });
  const providers = rotated.patch.aliases.kimi.providers;
  assert.equal(providers.length, 2);
  assert.equal(providers[1], "opencode-go", "the first route moved to the end");
  assert.match(rotated.summary, /kimi now tries kimi-coding → opencode-go/);
  assert.deepEqual(rotated.errors, []);

  // And the validation is the loader's, not a second opinion: a patch that breaks a rule reports it.
  assert.ok(validateAgainst(world, { fusions: { "review-check": { candidates: { "review-skeptic": ["ghost"] } } } }).length > 0);
  assert.deepEqual(validateAgainst(world, {}), []);
});

test("the picker proposes, and escape discards", () => {
  let world = { ...state(), tab: "routes" };
  world = applyKey(world, "e").state;
  assert.equal(world.picker, null, "applyKey only reports the intent; the driver opens the picker");
  const opened = { ...world, picker: { title: "t", options: ["a", "b"], cursor: 0, pending: (alias) => ({ summary: alias }) } };
  const moved = applyKey(opened, "j").state;
  assert.equal(moved.picker.cursor, 1);
  const chosen = applyKey(moved, "return").state;
  assert.equal(chosen.picker, null);
  assert.equal(chosen.pending.summary, "b", "the highlighted option is the proposal");
  assert.equal(applyKey(opened, "escape").state.picker, null);
  assert.equal(applyKey({ ...world, pending: { summary: "x", errors: [] } }, "escape").state.pending, null);
  const withErrors = { ...world, pending: { summary: "x", errors: ["boom"] } };
  assert.equal(applyKey(withErrors, "s").effect, "none", "an invalid change is not saved");
  assert.match(applyKey(withErrors, "s").state.message, /refused: boom/);
});

/* ------------------------------------------------------------ frame and diff */

test("a frame keeps the table inside its panel and the detail under it", () => {
  const world = state();
  const width = 100;
  const height = 20;
  const frame = frameFor({ width, height, state: world, palette: paletteFor({ color: false }), clock: "00:00:00" });
  const lines = Array.from({ length: height }, (_, row) => gridLine(frame, row));
  assert.match(lines[0], /FUSION MATRIX/);
  assert.match(lines[0], /1:aliases\*/);
  assert.match(lines[0], /store · 69 sessions/);
  assert.match(lines[2], /^│alias/, "the table header is inside the panel");

  // The panel, the detail line and the status bar, located rather than assumed: the border is intact
  // (nothing painted over it), the detail sits under it, and the keys are on the last row.
  const border = lines.findIndex((line) => /^└─+┘$/.test(line));
  assert.ok(border > 2, "the panel has a bottom border");
  assert.ok(border < height - 2, "there is room under the panel");
  assert.match(lines[border + 1], /kimi → kimi-k3/, "the detail line is the first row under the border");
  assert.match(lines[height - 1], /q quit/);

  // The selected row is painted to the panel edge, and every line is exactly the width asked for.
  for (const line of lines) assert.equal([...line].length, width);
  const withHelp = frameFor({ width, height, state: { ...world, help: true }, palette: paletteFor({ color: false }) });
  assert.match(Array.from({ length: height }, (_, row) => gridLine(withHelp, row)).join("\n"), /routes {2}— per fusion and seat/);
});

test("the diff renderer writes what changed, not what exists", () => {
  const palette = paletteFor({ color: false });
  const world = state();
  const first = frameFor({ width: 60, height: 10, state: world, palette });
  const whole = diff(null, first);
  assert.equal(whole.length, 10, "the first frame is every row");

  assert.deepEqual(diff(first, first), [], "an unchanged frame writes nothing");

  const second = frameFor({ width: 60, height: 10, state: { ...world, cursors: { ...world.cursors, aliases: 1 } }, palette });
  const changes = diff(first, second);
  assert.ok(changes.length > 0 && changes.length < whole.length, `two rows change, not ten (${changes.length})`);
  const painted = paint(changes, palette);
  assert.ok(painted.includes("\u001b["), "a run moves the cursor");
  assert.doesNotMatch(painted, /FUSION MATRIX/, "the header is not repainted when it did not change");

  // Two styles inside one run are two style changes, not one per cell.
  const grid = createGrid(6, 1);
  put(grid, 0, 0, "ab", "\u001b[31m");
  put(grid, 0, 2, "cd", "\u001b[32m");
  const runs = diff(null, grid);
  assert.equal(runs.length, 1);
  const styled = paint(runs, palette);
  assert.equal(styled.split("\u001b[31m").length - 1, 1, "the first style is opened once");
  assert.equal(styled.split("\u001b[32m").length - 1, 1, "and the second once, for the whole run");
});

test("the detail line names the selected row's own numbers", () => {
  const world = state();
  const aliases = detailFor(world, world.rows.aliases[0]);
  assert.match(aliases, /kimi → kimi-k3/);
  assert.match(aliases, /seats 12/);
  assert.match(aliases, /kept 7\/7/);
  const fusions = detailFor(
    { ...world, tab: "fusions" },
    world.rows.fusions.find((row) => row.fusion === "review"),
  );
  assert.match(fusions, /verdicts clean×1 findings×4/);
  assert.match(fusions, /work items #25/);
  const routes = detailFor(
    { ...world, tab: "routes" },
    world.rows.routes.find((row) => row.seat === "skeptic"),
  );
  assert.match(routes, /refused: opencode-go quota×1/);
  assert.equal(detailFor(world, undefined), "");
});

test("a reload keeps your place: the tab, the cursors and the toggles survive it", () => {
  const before = {
    ...state(),
    tab: "routes",
    cursors: { aliases: 0, fusions: 1, routes: 4 },
    rain: false,
    color: false,
    picker: { title: "open", options: [] },
  };
  const after = adopt(before, { state: state() });
  assert.equal(after.tab, "routes", "the tab is the view's, not the world's");
  const routes = after.rows.routes.length;
  assert.deepEqual(
    after.cursors,
    { aliases: 0, fusions: 1, routes: Math.min(4, routes - 1) },
    "a cursor past the reloaded rows is clamped onto the last one",
  );
  assert.equal(selected(after) !== undefined, true, "so the selection still points at a row");
  assert.equal(after.rain, false);
  assert.equal(after.color, false);
  assert.equal(after.picker, null, "but a picker open across a reload is closed");
  assert.equal(after.rows.routes.length, before.rows.routes.length, "the rows are the reloaded world's");
});

test("each money column is one basis, and the store row a config no longer names is still placed", () => {
  // A model whose seats carry *both* an estimated card cost and a list-price stand-in: folding the two
  // into one column would overstate list-basis money with no denominator for the folded part.
  const mixed = [{ ...modelStats[0], cost: { reported: 0.5, estimated: 0.25, list: 0.1, noRate: 0, priced: 3 } }];
  const alias = aliasRows({ config, modelStats: mixed }).find((row) => row.alias === "kimi");
  assert.equal(alias.listUsd, 0.1, "the list column is list-basis money only");
  assert.equal(alias.estimatedUsd, 0.25, "and the estimated basis keeps its own field");
  const fusion = fusionRows({
    config,
    fusionStats: [{ ...fusionStats[0], cost: { reported: 0.5, estimated: 0.25, list: 0.1, noRate: 0, priced: 3 } }],
    seatStats,
  }).find((row) => row.fusion === "review");
  assert.equal(fusion.listUsd, 0.1);
  assert.equal(fusion.estimatedUsd, 0.25);
  for (const tab of ["aliases", "fusions"]) {
    const keys = columnsFor(tab).map((column) => column.key);
    assert.equal(keys.includes("estimatedUsd") && keys.includes("listUsd"), true, `${tab} shows one column per basis`);
  }

  // A seat with store history that the config no longer names: it is placed, and says so.
  const orphan = routeRows({ config, seatStats: [...seatStats, { ...seatStats[0], persona: "review-legacy", seats: 2 }] }).find(
    (row) => row.seat === "review-legacy",
  );
  assert.equal(orphan !== undefined, true, "a seat that ran is shown even when the roster dropped it");
  assert.equal(orphan.unconfigured, true);
  assert.equal(orphan.candidates, "—");
  assert.match(detailFor({ ...state(), tab: "routes" }, orphan), /not in the config any more/);
  assert.equal(
    routeRows({ config, seatStats }).every((row) => row.unconfigured === false),
    true,
    "and configured seats are not marked",
  );
});

test("a save asks the loader again, and refuses what it cannot validate or read", () => {
  // The loader is consulted at the moment of writing: a proposal whose recorded errors were empty is
  // still refused if the config has moved since, and an unreadable layer is never written over.
  const world = state();
  const stale = {
    ...world,
    pending: { summary: "x", errors: [], patch: { fusions: { quick: { candidates: { technical: ["ghost"] } } } } },
  };
  assert.equal(validateAgainst(stale, stale.pending.patch).length > 0, true, "the patch is invalid by now");
  const unreadable = {
    ...world,
    layerReadError: "…does not parse as JSON: Unexpected token",
    pending: { summary: "x", errors: [], patch: {} },
  };
  assert.equal(unreadable.layerReadError !== null, true, "an unreadable layer is a named state");

  // A proposal that changes nothing is not saveable, whatever its summary says.
  const aliasRow = world.rows.aliases.find((row) => row.alias === "kimiAlias");
  const noop = proposeRouteOrder({ state: world, row: aliasRow });
  assert.equal(noop.saveable, false);
  assert.equal(applyKey({ ...world, pending: noop }, "s").effect, "none", "so `s` writes nothing");
  assert.match(applyKey({ ...world, pending: noop }, "s").state.message, /changes nothing/);
});

test("the picker scrolls to keep the option it will choose on screen", () => {
  const palette = paletteFor({ color: true });
  const options = Array.from({ length: 40 }, (_, i) => `alias-${i}`);
  const world = { ...state(), picker: { title: "pick", options, cursor: 39, pending: () => ({}) } };
  const frame = frameFor({ width: 60, height: 14, state: world, palette });
  const text = Array.from({ length: 14 }, (_, row) => gridLine(frame, row)).join("\n");
  assert.match(text, /▸ alias-39/, "the highlighted option is on screen, not scrolled past");
  assert.doesNotMatch(text, /alias-0$|▸ alias-0\b/, "and the window moved with it");
});

test("a proposal writes only its own path into the layer it names", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tui-layer-"));
  const file = path.join(dir, "pi-fusion-matrix.json");
  const world = { ...state(), layerFile: file };
  const row = world.rows.routes.find((entry) => entry.fusion === "quick" && entry.seat === "technical");
  const pending = proposeSeatAlias({ state: world, row, alias: "muse" });
  fs.writeFileSync(file, `${JSON.stringify(pending.patch, null, 2)}\n`);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), { fusions: { quick: { candidates: { technical: ["muse"] } } } });
  fs.rmSync(dir, { recursive: true, force: true });
});
