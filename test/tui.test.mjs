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
  fillRow,
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
  aliasesView,
  applyKey,
  buildState,
  commitProposal,
  composeOverRain,
  detailFor,
  diff,
  frameFor,
  keyName,
  paint,
  proposeRouteAdd,
  proposeRouteDrop,
  proposeRouteMove,
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

/**
 * The editing world: the fixture above, plus the personas its modes name and a decision backend (so
 * the loader accepts it) and one alias with three routes to reorder. Every proposal made against this
 * config has to leave `validateConfig` with nothing to say — the fixture itself may not be what it
 * complains about.
 */
const editConfig = {
  ...config,
  personas: {
    technical: { prompt: "reason about the change" },
    skeptic: { prompt: "find the flaw in it" },
    judge: { prompt: "pick the better answer" },
  },
  decide: { defaultBackend: "local" },
  backends: { local: { kind: "typesafe", url: "http://127.0.0.1:8080", apiKeyEnv: "TYPESAFE_API_KEY", model: "judge-1" } },
  aliases: { ...config.aliases, trio: { model: "kimi-k3", providers: ["opencode-go", "kimi-code", "cline-pass"] } },
};

const editState = () =>
  buildState({
    config: editConfig,
    modelStats,
    fusionStats,
    seatStats,
    baseConfig: editConfig,
    layerConfig: {},
    layerFile: "/tmp/nowhere/pi-fusion-matrix.json",
  });

/**
 * The editing world plus one alias that walks no providers at all: `n` names its first route with
 * no route row to insert after.
 */
const soloConfig = { ...editConfig, aliases: { ...editConfig.aliases, solo: { model: "kimi-k3", providers: [] } } };

const soloState = () =>
  buildState({
    config: soloConfig,
    modelStats,
    fusionStats,
    seatStats,
    baseConfig: soloConfig,
    layerConfig: {},
    layerFile: "/tmp/nowhere/pi-fusion-matrix.json",
  });

/** The cursor onto one exact row of the aliases list. */
const cursorOn = (world, row) => ({ ...world, cursors: { ...world.cursors, aliases: world.rows.aliases.indexOf(row) } });

/** One route row: the child of `alias`'s list that walks `provider`. */
const routeRow = (world, alias, provider) =>
  world.rows.aliases.find((row) => row.kind === "route" && row.parent === alias && row.provider === provider);

/** The state after opening `alias`'s route list with the keyboard: expanded, the cursor on its parent. */
const expandedOn = (world, alias) => {
  const parent = world.rows.aliases.findIndex((row) => row.kind === "alias" && row.alias === alias);
  return applyKey({ ...world, cursors: { ...world.cursors, aliases: parent } }, "return").state;
};

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

test("the rain keeps falling: a raining column never goes quiet", () => {
  const field = createRain({ width: 30, height: 20, seed: 42, density: 0.5 });
  const raining = field.columns.map(Boolean);
  assert.ok(raining.some(Boolean), "the fixture rains somewhere");
  for (let tick = 0; tick < 2000; tick += 1) stepRain(field);
  const after = field.columns.map(Boolean);
  assert.ok(
    raining.every((rains, x) => !rains || after[x]),
    "a column that rains keeps raining — the field must not empty out",
  );
  assert.ok(
    [...cells(field).levels].some((level) => level > 0),
    "and the field is still lit",
  );
});

test("the trail fades, and the rain reads darker than the interface behind it", () => {
  const colour = paletteFor({ color: true });
  const lum = (style) => {
    const m = style.match(/38;2;(\d+);(\d+);(\d+)/);
    return m ? 0.2126 * Number(m[1]) + 0.7152 * Number(m[2]) + 0.0722 * Number(m[3]) : -1;
  };
  assert.ok(lum(colour.head) > lum(colour.body) && lum(colour.body) > lum(colour.tail), "head outshines body outshines tail");
  assert.ok(lum(colour.body) < lum(colour.dim), "even the rain's body is darker than the dimmest interface ink");
});

test("the rain sits behind the interface: a styled blank is the row's own background", () => {
  const palette = paletteFor({ color: true });
  const grid = createGrid(4, 1);
  put(grid, 0, 0, "ab", palette.selected);
  fillRow(grid, 0, 2, 1, " ", palette.selected); // the selection's padding
  const rain = createRain({ width: 4, height: 1, seed: 9, density: 1 });
  for (let x = 0; x < 4; x += 1) rain.columns[x] = { head: 0, speed: 0, length: 1, birth: 0 };
  const composed = composeOverRain(grid, rain, palette, { width: 4, height: 1 });
  assert.equal(composed.ch[0], "a", "ink keeps its cell");
  assert.equal(composed.ch[2], " ", "the styled blank keeps the row's background");
  assert.equal(composed.fg[2], palette.selected, "…and its colour — the rain falls behind it");
  assert.notEqual(composed.ch[3], " ", "an untouched cell is a window onto the rain");
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

test("an expanded alias carries its routes as rows: config order, tree marks, and each route's own numbers", () => {
  const rows = aliasRows({ config, modelStats, expanded: { kimi: true, muse: true } });
  assert.deepEqual(
    rows.map((row) => row.alias),
    ["kimi", "  ├ opencode-go", "  └ kimi-code", "muse", "  ├ opencode-go", "  └ cline-pass", "kimiAlias"],
    "parents keep their order and each open alias's routes follow it, in config order",
  );

  const parent = rows[0];
  assert.equal(parent.kind, "alias");
  assert.equal(parent.expanded, true);
  assert.equal(parent.childCount, 2);
  const closed = aliasRows({ config, modelStats });
  assert.equal(closed.length, 3, "without the expanded map nothing is open");
  assert.deepEqual(
    closed.map((row) => ({ alias: row.alias, kind: row.kind, expanded: row.expanded, childCount: row.childCount })),
    [
      { alias: "kimi", kind: "alias", expanded: false, childCount: 2 },
      { alias: "muse", kind: "alias", expanded: false, childCount: 2 },
      { alias: "kimiAlias", kind: "alias", expanded: false, childCount: 1 },
    ],
    "and a parent row still carries its own shape",
  );
  assert.equal(closed[0].routes, 2, "a parent's own fields are untouched");
  assert.equal(closed[0].seats, 12);

  // A route row is one store row's worth of numbers — never the parent's totals repeated.
  const [go, code] = rows.filter((row) => row.kind === "route" && row.parent === "kimi");
  assert.deepEqual(
    [go.kind, go.parent, go.index, go.count, go.provider, go.model, go.routes],
    ["route", "kimi", 0, 2, "opencode-go", "kimi-k3", "1/2"],
  );
  assert.equal(go.seats, 12);
  assert.equal(go.kept, 7);
  assert.equal(go.raised, 7);
  assert.equal(go.located, 7);
  assert.equal(go.reportedUsd, 0.5264);
  assert.equal(go.pricedSeats, 12);
  assert.equal(go.refusals, "transient×2");
  assert.deepEqual([code.index, code.routes], [1, "2/2"]);
  assert.equal(code.seats, 0, "the route with no store row is a zero, not its sibling's numbers again");
  assert.equal(code.kept, 0);
  assert.equal(code.reportedUsd, null);
  assert.equal(code.last, "—");

  // The modelOverride route reads as the model that ran: its numbers live under that id in the store.
  const override = rows.find((row) => row.kind === "route" && row.parent === "muse" && row.provider === "cline-pass");
  assert.equal(override.alias, "  └ cline-pass", "the last child closes the tree");
  assert.equal(override.model, "cline-free/muse");
  assert.equal(override.seats, 1);
  assert.equal(override.kept, 0);
  assert.equal(override.located, 0);
  assert.equal(override.pricedSeats, 0);
  assert.equal(override.reportedUsd, null, "an unpriced route reports no money, not zero money");
  assert.equal(Number(override.listUsd.toFixed(5)), 0.00012);

  // Children are ordinary rows: every column the table draws has something to draw.
  for (const row of rows) {
    for (const column of columnsFor("aliases")) {
      const value = column.format ? column.format(row) : row[column.key];
      assert.notEqual(value, undefined, `${row.alias} carries ${column.key}`);
    }
  }

  // An alias with no routes cannot be opened, whatever the map says.
  const bare = aliasRows({ config: { aliases: { bare: { model: "kimi-k3", providers: [] } } }, modelStats: [], expanded: { bare: true } });
  assert.equal(bare.length, 1);
  assert.equal(bare[0].expanded, false);
  assert.equal(bare[0].childCount, 0);
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

test("enter opens and closes the route list under the cursor, and a reload leaves it as it was", () => {
  const world = editState();
  assert.deepEqual(world.expanded, {}, "a fresh state starts closed");

  // Opening leaves the cursor on the parent it opened.
  const open = expandedOn(world, "trio");
  assert.deepEqual(
    open.rows.aliases.filter((row) => row.kind === "route" && row.parent === "trio").map((row) => row.provider),
    ["opencode-go", "kimi-code", "cline-pass"],
  );
  assert.equal(selected(open).alias, "trio");
  assert.equal(selected(open).expanded, true, "the cursor stays on the parent while it expands");

  // Closing from a child lands on the parent the child belongs to.
  const onChild = cursorOn(open, routeRow(open, "trio", "kimi-code"));
  const closed = applyKey(onChild, "return").state;
  assert.equal(
    closed.rows.aliases.some((row) => row.kind === "route"),
    false,
    "the children are out of the list",
  );
  assert.equal(selected(closed).alias, "trio", "the cursor lands on the parent");
  assert.equal(selected(closed).expanded, false);

  // What the reader sees while editing is the proposal: the staged move is already the row order.
  const staged = { ...open, pending: proposeRouteMove({ state: open, row: routeRow(open, "trio", "kimi-code"), delta: 1 }) };
  assert.deepEqual(
    aliasesView(staged)
      .filter((row) => row.kind === "route" && row.parent === "trio")
      .map((row) => row.provider),
    ["opencode-go", "cline-pass", "kimi-code"],
  );
  assert.deepEqual(
    open.rows.aliases.filter((row) => row.kind === "route" && row.parent === "trio").map((row) => row.provider),
    ["opencode-go", "kimi-code", "cline-pass"],
    "and the un-edited world still shows its own order",
  );
  assert.deepEqual(open.rows.aliases, aliasesView(open), "the rows are the view of the state, never their own thing");

  // A reload rebuilds the rows and keeps the reader's place in them.
  const after = adopt(open, { state: editState() });
  assert.equal(after.expanded.trio, true, "what was open stays open");
  assert.deepEqual(
    after.rows.aliases.filter((row) => row.kind === "route" && row.parent === "trio").map((row) => row.provider),
    ["opencode-go", "kimi-code", "cline-pass"],
    "and its rows say so",
  );
});

/* --------------------------------------------------------------------- keys */

test("keys move the cursor, switch tabs by number, and never run off a table", () => {
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

  // The numbers are the whole way between tabs; everything that looks like one walks the rows.
  assert.equal(applyKey(world, "1").state.tab, "aliases");
  assert.equal(applyKey(world, "2").state.tab, "fusions");
  assert.equal(applyKey(world, "3").state.tab, "routes");
  assert.equal(applyKey(applyKey(world, "3").state, "1").state.tab, "aliases", "and back to the first");
  for (const key of ["tab", "shift-tab", "h", "l", "left", "right"]) {
    assert.equal(applyKey(world, key).state.tab, "aliases", `${key} walks the rows, not the tabs`);
  }

  assert.equal(applyKey(world, "a").state.rain, false, "the rain toggles off");
  assert.equal(applyKey(applyKey(world, "a").state, "a").state.rain, true, "and on again");
  assert.equal(applyKey(world, "c").state.color, false);
  assert.equal(applyKey(world, "?").state.help, true);
  assert.equal(applyKey(world, "q").effect, "quit");
  assert.notEqual(applyKey(world, "escape").effect, "quit", "escape is a way back, never a way out");
  assert.equal(applyKey(world, "r").effect, "reload");
  assert.equal(applyKey(world, "R").effect, "reingest");
  assert.equal(applyKey({ ...state(), tab: "routes" }, "e").effect, "propose", "e still proposes on the routes tab");
  assert.equal(applyKey({ ...state(), tab: "fusions" }, "e").effect, "propose");
  const guided = applyKey(world, "e");
  assert.equal(guided.effect, "none", "on the aliases tab the list keys are their own instructions");
  assert.equal(guided.state.pending, null);
  assert.match(guided.state.message, /K\/J/);
  assert.match(guided.state.message, /\bn\b/);
  assert.match(guided.state.message, /\bd\b/);
  assert.equal(applyKey(world, "s").effect, "none");
  assert.match(applyKey(world, "s").state.message, /nothing to save/);
});

test("numbers switch tabs; arrows, h/l and the tab key walk one tab's rows", () => {
  const open = expandedOn(editState(), "trio"); // the cursor on trio, its three routes under it

  // Forward descends and walks: the list's first route, then the next, and it stops at the last.
  for (const key of ["right", "l", "tab"]) {
    assert.equal(applyKey(open, key).state.tab, "aliases", `${key} stays on its tab`);
    const first = applyKey(open, key).state;
    assert.equal(selected(first).kind, "route", `${key} descends into the open list`);
    assert.equal(selected(first).provider, "opencode-go");
    const next = applyKey(first, key).state;
    assert.equal(selected(next).provider, "kimi-code", `${key} walks to the next route`);
    const last = applyKey(applyKey(next, key).state, key).state;
    assert.equal(selected(last).provider, "cline-pass", `${key} stops at the last route`);
  }

  // Back climbs to the parent and closes the list; a closed list is nothing to do.
  for (const key of ["left", "h", "shift-tab"]) {
    const onChild = applyKey(open, "right").state;
    const parent = applyKey(onChild, key).state;
    assert.equal(parent.tab, "aliases");
    assert.equal(selected(parent).alias, "trio", `${key} climbs back to the parent`);
    const closed = applyKey(parent, key).state;
    assert.equal(selected(closed).expanded, false, `${key} closes the list under it`);
    const inert = applyKey(closed, key).state;
    assert.deepEqual(inert.rows.aliases, closed.rows.aliases, `${key} does nothing on a closed alias`);
    assert.equal(inert.cursors.aliases, closed.cursors.aliases);
  }

  // And none of them reach past the tab they are on.
  const routes = applyKey(open, "3").state;
  for (const key of ["tab", "shift-tab", "h", "l", "left", "right"]) {
    const same = applyKey(routes, key).state;
    assert.equal(same.tab, "routes", `${key} keeps its hands off the tab`);
    assert.equal(same.cursors.routes, routes.cursors.routes, "and the routes list is flat");
  }
});

test("a terminal chunk becomes one key name", () => {
  // The control bytes under test, built at runtime rather than spelled as source escapes.
  const esc = String.fromCharCode(27);
  const tab = String.fromCharCode(9);
  const cr = String.fromCharCode(13);
  const lf = String.fromCharCode(10);
  const bs = String.fromCharCode(8);
  const del = String.fromCharCode(127);
  const etx = String.fromCharCode(3);

  // Arrows and shift-tab are the only escape sequences that name a key of their own.
  assert.equal(keyName(esc + "[A"), "up");
  assert.equal(keyName(esc + "[B"), "down");
  assert.equal(keyName(esc + "[C"), "right");
  assert.equal(keyName(esc + "[D"), "left");
  assert.equal(keyName(esc + "[Z"), "shift-tab");

  // Every other chunk carrying an escape byte is the escape key — an escape sequence is never
  // text, whatever tail the terminal coalesced onto it.
  assert.equal(keyName(esc), "escape", "the bare byte");
  assert.equal(keyName(esc + "[27~"), "escape", "an unknown CSI sequence is escape, not typing");
  assert.equal(keyName(esc + "O"), "escape", "and an unknown SS3 one");
  assert.equal(keyName(esc + "zai"), "escape", "even with text coalesced onto it");
  assert.equal(keyName(esc + esc + "zai"), "escape", "or a second escape dragged along");

  // Hosts that deliver key names rather than bytes spell some of them out.
  for (const name of ["Escape", "escape", "ESC"]) assert.equal(keyName(name), "escape", `${name} names the escape key`);
  assert.equal(keyName("Enter"), "return", "enter by name");
  assert.equal(keyName("Return"), "return");
  assert.equal(keyName("Backspace"), "backspace");

  assert.equal(keyName(tab), "tab");
  assert.equal(keyName(cr), "return");
  assert.equal(keyName(lf), "return", "the line feed is enter too");
  assert.equal(keyName(etx), "ctrl-c", "ctrl-c is its own name now: `q` must stay typeable text");
  assert.equal(keyName("j"), "j");
  assert.equal(keyName(del), "backspace");
  assert.equal(keyName(bs), "backspace", "the terminal's delete and its backspace are one key");

  // A paste is text whatever it looks like — it arrives whole and stays whole.
  assert.equal(keyName("cline-pass"), "cline-pass", "a paste is not chopped into keys");

  // And that name quits wherever it lands: out in the open, under a picker, inside the name prompt.
  assert.equal(applyKey(editState(), "ctrl-c").effect, "quit");
  const picker = { ...editState(), picker: { title: "t", options: ["a"], cursor: 0, pending: () => ({}) } };
  assert.equal(applyKey(picker, "ctrl-c").effect, "quit");
  const typing = { ...editState(), input: { title: "t", value: "x", pending: () => ({}) } };
  assert.equal(applyKey(typing, "ctrl-c").effect, "quit");
});

test("escape is the way back — a picker, a proposal, a child row, an open list — and never a way out", () => {
  const open = expandedOn(editState(), "trio");

  // (1) a picker is closed and nothing else happens: the ladder is not reached past it.
  const picker = { ...editState(), picker: { title: "t", options: ["a"], cursor: 0, pending: () => ({ summary: "x" }) } };
  const closedPicker = applyKey(picker, "escape");
  assert.equal(closedPicker.state.picker, null);
  assert.equal(closedPicker.state.pending, null);

  // (2) a pending proposal is dropped before anything further down the ladder.
  const proposed = applyKey(cursorOn(open, routeRow(open, "trio", "opencode-go")), "J").state;
  assert.ok(proposed.pending, "the fixture stands: there is a proposal to discard");
  const discarded = applyKey(proposed, "escape");
  assert.equal(discarded.state.pending, null);
  assert.equal(discarded.state.message, "change discarded");

  // (3) a route row hands the cursor back to its parent.
  const climbed = applyKey(cursorOn(open, routeRow(open, "trio", "kimi-code")), "escape").state;
  assert.equal(selected(climbed).kind, "alias");
  assert.equal(selected(climbed).alias, "trio");

  // (4) an open list under the cursor is closed; (5) a closed one has nothing to escape from.
  const closed = applyKey(open, "escape").state;
  assert.equal(selected(closed).expanded, false);
  assert.equal(closed.cursors.aliases, open.cursors.aliases, "the cursor stays on the alias");
  const inert = applyKey(closed, "escape").state;
  assert.deepEqual(inert.rows.aliases, closed.rows.aliases);
  assert.deepEqual(inert.expanded, closed.expanded);
  assert.equal(inert.message, closed.message);

  // Whatever else it means, escape never means quit — and `q`, outside a picker, still does.
  for (const s of [editState(), open, proposed, climbed, closed, picker, { ...editState(), help: true }]) {
    assert.notEqual(applyKey(s, "escape").effect, "quit");
  }
  assert.equal(applyKey(editState(), "q").effect, "quit", "q is still the way out");

  // And the help box closes itself first, by either of its keys, before the ladder below it — the
  // ladder does not run behind it.
  const helped = applyKey({ ...editState(), help: true, pending: { summary: "x", errors: [], patch: {} } }, "escape").state;
  assert.equal(helped.help, false);
  assert.ok(helped.pending, "closing the help is not also discarding the proposal beneath it");
  assert.equal(applyKey({ ...editState(), help: true }, "?").state.help, false);
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

  // And the validation is the loader's, not a second opinion: a patch that breaks a rule reports it.
  assert.ok(validateAgainst(world, { fusions: { "review-check": { candidates: { "review-skeptic": ["ghost"] } } } }).length > 0);
  assert.deepEqual(validateAgainst(world, {}), []);
});

test("the picker proposes, and escape or q steps back out of it", () => {
  let world = { ...state(), tab: "routes" };
  world = applyKey(world, "e").state;
  assert.equal(world.picker, null, "applyKey only reports the intent; the driver opens the picker");
  const opened = { ...world, picker: { title: "t", options: ["a", "b"], cursor: 0, pending: (alias) => ({ summary: alias }) } };
  const moved = applyKey(opened, "j").state;
  assert.equal(moved.picker.cursor, 1);
  const chosen = applyKey(moved, "return").state;
  assert.equal(chosen.picker, null);
  assert.equal(chosen.pending.summary, "b", "the highlighted option is the proposal");
  assert.equal(applyKey(opened, "escape").state.picker, null, "escape closes the picker and nothing more");
  const backedOut = applyKey(opened, "q");
  assert.equal(backedOut.state.picker, null, "q is a way back while a picker is open");
  assert.notEqual(backedOut.effect, "quit", "…not a quit");
  const untouched = applyKey(opened, "2");
  assert.equal(untouched.state.picker.cursor, 0, "nothing else is handled while the picker is open");
  assert.equal(untouched.state.tab, "routes", "not even the tab keys");
  assert.equal(applyKey({ ...world, pending: { summary: "x", errors: [] } }, "escape").state.pending, null);
  assert.equal(applyKey({ ...world, pending: { summary: "x", errors: [] } }, "escape").state.message, "change discarded");
  const withErrors = { ...world, pending: { summary: "x", errors: ["boom"] } };
  assert.equal(applyKey(withErrors, "s").effect, "none", "an invalid change is not saved");
  assert.match(applyKey(withErrors, "s").state.message, /refused: boom/);
});

test("K and J walk a route through its alias's list, and the presses add up to one proposal", () => {
  const open = expandedOn(editState(), "trio");

  const first = applyKey(cursorOn(open, routeRow(open, "trio", "opencode-go")), "J").state;
  assert.equal(first.message, "proposed — s saves, esc discards");
  assert.equal(first.pending.listOf, "trio");
  assert.deepEqual(first.pending.patch.aliases.trio.providers, ["kimi-code", "opencode-go", "cline-pass"]);
  assert.deepEqual(first.pending.errors, [], "the loader accepts the moved order");
  assert.deepEqual(
    first.rows.aliases.filter((row) => row.kind === "route" && row.parent === "trio").map((row) => row.provider),
    ["kimi-code", "opencode-go", "cline-pass"],
    "the order on screen is the proposal",
  );

  // Whichever row the move left the cursor on, the next press walks the same route again — and the two
  // presses are one pending proposal holding the net order, not two proposals stacked up.
  const second = applyKey(cursorOn(first, routeRow(first, "trio", "opencode-go")), "J").state;
  assert.deepEqual(second.pending.patch.aliases.trio.providers, ["kimi-code", "cline-pass", "opencode-go"]);
  assert.equal(second.pending.listOf, "trio", "one proposal, carrying both presses");
  assert.match(second.pending.summary, /trio/);
  assert.match(second.pending.summary, /kimi-code → cline-pass → opencode-go/, "its summary is the full resulting order");

  const back = applyKey(cursorOn(second, routeRow(second, "trio", "opencode-go")), "K").state;
  assert.deepEqual(back.pending.patch.aliases.trio.providers, ["kimi-code", "opencode-go", "cline-pass"]);
  assert.deepEqual(back.pending.errors, []);

  // At either end of the list a move is refused as the non-change it is, and the refusal is the message.
  const atFirst = applyKey(cursorOn(open, routeRow(open, "trio", "opencode-go")), "K").state;
  assert.equal(atFirst.pending.saveable, false);
  assert.match(atFirst.pending.summary, /already first/);
  assert.match(atFirst.pending.summary, /trio/);
  assert.equal(atFirst.message, atFirst.pending.summary);
  const atLast = applyKey(cursorOn(open, routeRow(open, "trio", "cline-pass")), "J").state;
  assert.equal(atLast.pending.saveable, false);
  assert.match(atLast.pending.summary, /already last/);
});

test("the route keys name themselves and do nothing when the cursor is not on a route", () => {
  // `n` left this company: anywhere on the aliases tab it opens the name prompt (its own tests are
  // below). K, J and d still need a route row — and name themselves when the cursor is not on one.
  for (const world of [expandedOn(editState(), "trio"), { ...editState(), tab: "routes" }]) {
    for (const key of ["K", "J", "d"]) {
      const result = applyKey(world, key);
      assert.equal(result.effect, "none", `${key} proposes nothing here`);
      assert.equal(result.state.pending, null);
      assert.equal(result.state.picker, null);
      assert.match(result.state.message, /K\/J/);
      assert.match(result.state.message, /\bd\b/);
    }
  }

  // The flat tabs have no route list to name a route for, so there `n` is still just the words.
  for (const tab of ["fusions", "routes"]) {
    const flat = applyKey({ ...editState(), tab }, "n");
    assert.equal(flat.effect, "none");
    assert.equal(flat.state.input, null, `${tab} has no name prompt`);
    assert.equal(flat.state.pending, null);
    assert.match(flat.state.message, /K\/J/);
  }
});

test("d drops the cursor's route, and the loader refuses the alias it would empty", () => {
  const open = expandedOn(editState(), "trio");
  const dropped = applyKey(cursorOn(open, routeRow(open, "trio", "kimi-code")), "d").state;
  assert.equal(dropped.pending.listOf, "trio");
  assert.deepEqual(dropped.pending.patch.aliases.trio.providers, ["opencode-go", "cline-pass"]);
  assert.deepEqual(dropped.pending.errors, []);
  assert.match(dropped.pending.summary, /trio/);
  assert.match(dropped.pending.summary, /opencode-go → cline-pass/, "the summary names what is left");
  assert.deepEqual(
    dropped.rows.aliases.filter((row) => row.kind === "route" && row.parent === "trio").map((row) => row.provider),
    ["opencode-go", "cline-pass"],
  );

  // The proposal itself drops exactly the route it is handed.
  const droppedFirst = proposeRouteDrop({ state: open, row: routeRow(open, "trio", "opencode-go") });
  assert.deepEqual(droppedFirst.patch.aliases.trio.providers, ["kimi-code", "cline-pass"]);
  assert.equal(droppedFirst.listOf, "trio");

  // Dropping an alias's only route is not refused here: the empty list goes to the loader, and the
  // loader's own complaint is what comes back.
  const only = expandedOn(editState(), "kimiAlias");
  const emptied = applyKey(cursorOn(only, routeRow(only, "kimiAlias", "cline-pass")), "d").state;
  assert.deepEqual(emptied.pending.patch.aliases.kimiAlias.providers, [], "the drop is the empty list");
  assert.notEqual(emptied.pending.saveable, false, "no self-authored refusal stands in for the loader's");
  assert.ok(emptied.pending.errors.length > 0);
  assert.match(emptied.pending.errors.join("\n"), /has no providers/);
  assert.match(emptied.pending.summary, /kimiAlias/);
  assert.match(emptied.pending.summary, /nothing/, "the summary names the empty order it is left with");
  assert.equal(emptied.message, "", "an invalid change leaves the status line to the verdict bar");
});

test("n asks for the route's name from any row of the aliases list", () => {
  // The reader's report: `n` on an alias row answered with a shrug. Asking is what should happen —
  // and asking is visible: the state carries the prompt, wherever on this tab the cursor sits.
  const closed = applyKey(editState(), "n"); // kimi's parent, its route list shut — no route row in sight
  assert.equal(closed.effect, "none");
  assert.ok(closed.state.input, "a parent row answers with the prompt, not a hint");
  assert.equal(closed.state.input.title, "kimi: add route");
  assert.equal(closed.state.input.value, "", "it starts empty");
  assert.equal(closed.state.pending, null, "asking is not yet proposing");

  const open = expandedOn(editState(), "kimi");
  const onRoute = applyKey(cursorOn(open, routeRow(open, "kimi", "opencode-go")), "n");
  assert.equal(onRoute.state.input.title, "kimi: add route");

  // An alias that walks no providers at all has no route row to sit after — adding the first route
  // has to ask the same question.
  const solo = soloState();
  const parent = solo.rows.aliases.find((row) => row.kind === "alias" && row.alias === "solo");
  assert.equal(parent.childCount, 0, "the fixture stands: there is no route to insert after");
  assert.equal(applyKey(cursorOn(solo, parent), "n").state.input.title, "solo: add route");
});

test("n expands the row's list as it asks: the route being named is on screen", () => {
  // The reader's report: the added entry never showed up — its list stayed shut while the name was
  // asked for and after it landed. `n` opens the list it edits, so the row is in sight before,
  // during and after the prompt, the cursor staying on the row `n` was pressed on.
  const closed = editState();
  const parent = closed.rows.aliases.find((row) => row.kind === "alias" && row.alias === "kimi");
  assert.equal(parent.expanded, false, "the fixture stands: the list is shut");
  const before = closed.rows.aliases.length;

  const asked = applyKey(cursorOn(closed, parent), "n").state;
  assert.ok(asked.input, "the prompt opens over the visible list");
  assert.equal(asked.expanded.kimi, true, "the list it will edit is open");
  assert.equal(asked.rows.aliases.length, before + parent.childCount, "its routes are the rows the list grew by");
  assert.deepEqual(
    asked.rows.aliases.filter((row) => row.kind === "route" && row.parent === "kimi").map((row) => row.provider),
    ["opencode-go", "kimi-code"],
  );
  assert.equal(asked.cursors.aliases, closed.cursors.aliases, "the cursor stays on the row `n` was pressed on");
  assert.equal(asked.rows.aliases[asked.cursors.aliases].alias, "kimi", "which is still the parent");

  const named = applyKey(applyKey(asked, "zai").state, "return").state;
  assert.deepEqual(
    named.rows.aliases.filter((row) => row.kind === "route" && row.parent === "kimi").map((row) => row.provider),
    ["opencode-go", "kimi-code", "zai"],
    "and what it names lands in the list that is still open",
  );

  // On a route row the list is already open — `n` asks its parent's question and leaves it open.
  const open = expandedOn(editState(), "kimi");
  const onRoute = applyKey(cursorOn(open, routeRow(open, "kimi", "opencode-go")), "n").state;
  assert.ok(onRoute.input);
  assert.equal(onRoute.expanded.kimi, true);
  assert.deepEqual(
    onRoute.rows.aliases.filter((row) => row.kind === "route" && row.parent === "kimi").map((row) => row.provider),
    ["opencode-go", "kimi-code"],
    "and the routes stay on screen under it",
  );
});

test("the name prompt takes text: letters one key at a time, a paste whole, backspace takes it back", () => {
  const open = applyKey(expandedOn(editState(), "kimi"), "n").state;
  assert.equal(open.input.value, "");
  let world = open;
  for (const key of ["z", "a", "i"]) world = applyKey(world, key).state;
  assert.equal(world.input.value, "zai", "one key at a time");
  assert.equal(world.rain, true, "`a` is a letter in a name here, not the rain switch");
  assert.equal(applyKey(world, "backspace").state.input.value, "za", "backspace takes the last letter back");
  assert.equal(applyKey(open, "backspace").state.input.value, "", "and a blank name has nothing to take");

  // A paste arrives as one chunk and joins the name whole.
  assert.equal(applyKey(world, "cline-pass").state.input.value, "zaicline-pass");

  // The keys with meanings out here are letters in there: `q` does not quit, the digits do not hop
  // between the tabs, and the row keys sit still until the name is in.
  let typed = world;
  for (const key of ["q", "1", "2", "3"]) typed = applyKey(typed, key).state;
  assert.equal(typed.input.value, "zaiq123");
  assert.notEqual(applyKey(world, "q").effect, "quit", "`q` types; it does not quit");
  assert.equal(typed.tab, "aliases", "and the digits keep their hands off the tabs");
  assert.equal(typed.cursors.aliases, world.cursors.aliases);
  for (const key of ["tab", "shift-tab", "up", "down", "left", "right"]) {
    const same = applyKey(typed, key).state;
    assert.equal(same.input.value, "zaiq123", `${key} types nothing`);
    assert.equal(same.tab, "aliases", `${key} keeps its hands off the tabs and the rows`);
    assert.equal(same.cursors.aliases, typed.cursors.aliases);
  }

  // Even a paste dragging a stray control byte (0x01) contributes only its text.
  assert.equal(applyKey(open, String.fromCharCode(1) + "z").state.input.value, "z");
});

test("entering a name creates and saves the route after the cursor's, or at the end of its alias's list", () => {
  const open = expandedOn(editState(), "kimi");
  const type = (world, text) => applyKey(applyKey(world, "n").state, text).state;

  // On a route row the name lands right after it — what the table shows is the proposal, and the
  // submit is the save: one Enter is create and write both, with no second `s` to ask for.
  const staged = applyKey(type(cursorOn(open, routeRow(open, "kimi", "opencode-go")), "zai"), "return");
  assert.equal(staged.effect, "save", "submitting the name asks for the write");
  assert.equal(staged.state.input, null, "the prompt closes on the name");
  assert.equal(staged.state.pending.listOf, "kimi");
  assert.deepEqual(staged.state.pending.patch.aliases.kimi.providers, ["opencode-go", "zai", "kimi-code"]);
  assert.deepEqual(staged.state.pending.errors, [], "the loader's verdict travels with the proposal");
  assert.match(staged.state.pending.summary, /kimi/);
  assert.deepEqual(
    staged.state.rows.aliases.filter((row) => row.kind === "route" && row.parent === "kimi").map((row) => row.provider),
    ["opencode-go", "zai", "kimi-code"],
  );

  // On the parent row there is no route to sit after, so the name goes to the end of the list.
  const appended = applyKey(type(open, "zai"), "return");
  assert.equal(appended.effect, "save", "…and the submit saves it there");
  assert.equal(appended.state.pending.listOf, "kimi");
  assert.deepEqual(appended.state.pending.patch.aliases.kimi.providers, ["opencode-go", "kimi-code", "zai"]);
  assert.deepEqual(appended.state.pending.errors, []);

  // An alias walking no providers gets its first route the same way.
  const solo = soloState();
  const parent = solo.rows.aliases.find((row) => row.kind === "alias" && row.alias === "solo");
  const first = applyKey(type(cursorOn(solo, parent), "zai"), "return");
  assert.equal(first.effect, "save");
  assert.deepEqual(first.state.pending.patch.aliases.solo.providers, ["zai"], "the first route is the whole list");
  assert.deepEqual(first.state.pending.errors, []);

  // Two names typed in a row against one alias add up to one pending change holding the net list —
  // and each submit is a save over the one pending it accumulates into.
  const net = applyKey(type(cursorOn(staged.state, routeRow(staged.state, "kimi", "zai")), "cleo"), "return");
  assert.equal(net.effect, "save");
  assert.equal(net.state.pending.listOf, "kimi");
  assert.deepEqual(net.state.pending.patch.aliases.kimi.providers, ["opencode-go", "zai", "cleo", "kimi-code"], "both names, one proposal");
  assert.deepEqual(net.state.pending.errors, []);
});

test("a blank name is refused with the prompt still open and the typing intact", () => {
  const open = applyKey(expandedOn(editState(), "kimi"), "n").state;
  const blank = applyKey(open, "return");
  assert.equal(blank.effect, "none", "a blank name writes nothing");
  assert.ok(blank.state.input, "the prompt stays open");
  assert.equal(blank.state.message, "a route needs a name");
  assert.equal(blank.state.pending, null);

  const spaces = [" ", " ", " "].reduce((world, key) => applyKey(world, key).state, open);
  assert.equal(spaces.input.value, "   ");
  const refused = applyKey(spaces, "return");
  assert.equal(refused.effect, "none", "whitespace writes nothing either");
  assert.ok(refused.state.input, "whitespace is not a name either");
  assert.equal(refused.state.message, "a route needs a name");
  assert.equal(refused.state.input.value, "   ", "and what was typed is still there to fix");
  assert.equal(refused.state.pending, null);
});

test("the staging keeps the verdict it is handed: a refusal's summary, a complaint's silence", () => {
  // The prompt's `pending` is its own to build, so the two verdicts a route list never hands back —
  // a refusal and a loader complaint — are walked the way the picker fixtures walk their choices.
  const prompt = (pending) => ({ ...expandedOn(editState(), "kimi"), input: { title: "kimi: add route", value: "zai", pending } });

  const refused = applyKey(
    prompt((name) => ({
      listOf: "kimi",
      layerFile: "/tmp/nowhere/x.json",
      patch: {},
      summary: `${name} changes nothing`,
      errors: [],
      saveable: false,
    })),
    "return",
  );
  assert.equal(refused.state.pending.saveable, false, "even a refusal is kept pending");
  assert.equal(refused.state.input, null);
  assert.equal(refused.state.message, "zai changes nothing", "and its summary is the message");

  const complained = applyKey(
    prompt((name) => ({
      listOf: "kimi",
      layerFile: "/tmp/nowhere/x.json",
      patch: {},
      summary: `${name} now tries zai`,
      errors: ["boom"],
    })),
    "return",
  );
  assert.deepEqual(complained.state.pending.errors, ["boom"]);
  assert.equal(complained.state.message, "", "an invalid change leaves the status line to the verdict bar");
});

test("an escape sequence backs out of the name prompt and never lands in the typing", () => {
  // The reader's report: hitting escape typed the escape's own characters into the field. The
  // chunk a real escape key arrives in is built here at runtime — it is one key, never its bytes as
  // text — so it closes the prompt with nothing of itself left anywhere behind.
  const typed = applyKey(applyKey(expandedOn(editState(), "kimi"), "n").state, "zai").state;
  assert.equal(typed.input.value, "zai", "the fixture stands: there is typing to leave alone");

  const chunk = String.fromCharCode(27) + "[27~";
  assert.equal(keyName(chunk), "escape", "the terminal's chunk is the escape key");
  const closed = applyKey(typed, keyName(chunk));
  assert.equal(closed.state.input, null, "and escape is back");
  assert.notEqual(closed.effect, "quit", "…never a way out");
  const json = JSON.stringify(closed.state);
  assert.equal(json.includes("[27~"), false, "no fragment of the sequence was typed");
  // JSON spells a raw escape byte out as the six characters backslash-u001b; none of that is here.
  assert.equal(json.includes(String.fromCharCode(92) + "u001b"), false, "and no escape byte is left in the state");

  // The bare escape key closes the prompt just as cleanly, changing nothing else.
  const backed = applyKey(typed, "escape");
  assert.equal(backed.state.input, null);
  assert.deepEqual({ ...backed.state, input: "closed" }, { ...typed, input: "closed" }, "it closes the prompt and changes nothing else");
});

test("escape backs out of the name prompt and changes nothing else; ctrl-c quits from inside it", () => {
  const open = applyKey(applyKey(expandedOn(editState(), "kimi"), "n").state, "zai").state;
  const backed = applyKey(open, "escape");
  assert.equal(backed.state.input, null, "escape is back");
  assert.notEqual(backed.effect, "quit", "…and never a way out");
  assert.deepEqual({ ...backed.state, input: "closed" }, { ...open, input: "closed" }, "it closes the prompt and changes nothing else");

  // The one way out of everything still works with a prompt up.
  assert.equal(applyKey(open, "ctrl-c").effect, "quit");
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

test("the keys hint shows the rain state and that the numbers pick the tabs", () => {
  const palette = paletteFor({ color: false });
  const hint = (world) => gridLine(frameFor({ width: 150, height: 20, state: world, palette, clock: "" }), 19);
  const on = hint(state());
  assert.match(on, /rain:ON/);
  assert.match(hint({ ...state(), rain: false }), /rain:OFF/, "and says so when it is off");
  for (const digit of ["1", "3"]) assert.ok(on.includes(digit), `the hint names tab key ${digit}`);
  assert.ok(on.includes("tab"), "the numbers are named as tabs");
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

test("the detail line under a route names its parent, its place in the list, and the model it runs", () => {
  const world = expandedOn(state(), "muse");
  const detail = detailFor(world, routeRow(world, "muse", "cline-pass"));
  assert.match(detail, /muse/);
  assert.match(detail, /cline-pass/);
  assert.match(detail, /cline-free\/muse/);
  assert.match(detail, /2\/2/);
  assert.match(detail, /seats 1/);
});

test("a reload keeps your place: the tab, the cursors and the toggles survive it", () => {
  const before = {
    ...state(),
    tab: "routes",
    cursors: { aliases: 0, fusions: 1, routes: 4 },
    rain: false,
    color: false,
    picker: { title: "open", options: [] },
    input: { title: "kimi: add route", value: "zai", pending: () => ({}) },
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
  assert.equal(after.input, null, "and so is the half-typed name prompt");
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

  // A proposal that changes nothing is not saveable, whatever its summary says: moving an alias's only
  // route is refused as the non-change it is.
  const only = expandedOn(world, "kimiAlias");
  const noop = proposeRouteMove({ state: only, row: routeRow(only, "kimiAlias", "cline-pass"), delta: -1 });
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

test("the frame paints the name prompt: its title, the typed name and the caret", () => {
  // The reader's report as a frame: with the prompt open the screen has to say so — the title it
  // opened under and the name typed so far, the caret sitting after it.
  const typed = applyKey(applyKey(expandedOn(editState(), "kimi"), "n").state, "zai").state;
  const lines = (world) => {
    const frame = frameFor({ width: 60, height: 14, state: world, palette: paletteFor({ color: false }), clock: "" });
    return Array.from({ length: 14 }, (_, row) => gridLine(frame, row)).join("\n");
  };
  const text = lines(typed);
  assert.match(text, /kimi: add route/);
  assert.match(text, /zai▌/);

  // A name longer than the box is cut to the box rather than running past the panel.
  const long = { ...typed, input: { ...typed.input, value: "cline-".repeat(20) } };
  assert.match(lines(long), /…/);
});

test("the write path re-reads the layer and the base, and refuses what it cannot stand on", async () => {
  // The save branches were unexercised: the checks asserted the validator's return value but never
  // called the writer, so deleting either refusal would have left the suite green. This drives
  // `commitProposal` itself, against real files, and asserts the filesystem's state each time.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tui-save-"));
  const file = path.join(dir, "pi-fusion-matrix.json");
  const opts = { dbPath: path.join(dir, "no-store.db"), layerFile: file };
  const world = { ...state(), layerFile: file, layerConfig: {} };
  const proposal = (patch) => ({ summary: "test change", errors: [], patch, layerFile: file });

  // (1) a layer that will not parse: refused, and the operator's file untouched.
  fs.writeFileSync(file, "{ this is not json");
  const unreadable = await commitProposal({ ...world, pending: proposal({ note: 1 }) }, opts);
  assert.equal(unreadable.wrote, false, "an unreadable layer writes nothing");
  assert.match(unreadable.state.message, /refused: .*does not parse as JSON/);
  assert.equal(fs.readFileSync(file, "utf8"), "{ this is not json", "and leaves their file exactly as it was");

  // (2) the layer changed on disk after the proposal was built: refused, nothing overwritten.
  fs.writeFileSync(file, `${JSON.stringify({ aliases: { glm: { providers: ["opencode-go"] } } }, null, 2)}\n`);
  const moved = await commitProposal({ ...world, pending: proposal({ note: 1 }) }, opts);
  assert.equal(moved.wrote, false, "a proposal built over a layer that has since moved writes nothing");
  assert.match(moved.state.message, /refused: the layer changed since this proposal was built/);
  assert.equal(fs.readFileSync(file, "utf8").includes("note"), false, "so a concurrent edit is not clobbered");

  // (3) a patch the loader rejects: refused before mkdir, so no file appears at all.
  fs.rmSync(file);
  const invalid = await commitProposal(
    { ...world, pending: proposal({ fusions: { quick: { candidates: { technical: ["ghost"] } } } }) },
    opts,
  );
  assert.equal(invalid.wrote, false, "a change the loader refuses writes nothing");
  assert.match(invalid.state.message, /^refused: /);
  assert.equal(fs.existsSync(file), false, "and no directory or file is created for it");

  // (4) a proposal the loader accepts writes exactly the proposal, and spends the pending one.
  const patch = { fusions: { quick: { candidates: { technical: ["kimi"] } } } };
  const ok = await commitProposal({ ...world, pending: proposal(patch) }, opts);
  assert.equal(ok.wrote, true, "a clean proposal is written");
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), patch, "the file is the proposal, not a merge with what was read");
  assert.equal(ok.state.pending, null, "the pending proposal is spent");
  assert.match(ok.state.message, /^saved: /);

  // (5) a proposal that changes nothing never reaches the filesystem.
  fs.rmSync(file);
  const noop = await commitProposal({ ...world, pending: { ...proposal({}), saveable: false } }, opts);
  assert.equal(noop.wrote, false, "a no-op writes nothing");
  assert.equal(fs.existsSync(file), false, "and creates nothing");

  fs.rmSync(dir, { recursive: true, force: true });
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

test("a moved, dropped or added route is what the layer file comes to hold", async () => {
  // The same proposals the keys build, through the writer to real files: what is asserted is the
  // bytes on disk, and the loader is asked again at the moment of writing. The packaged config is a
  // base it accepts, so its `kimi` is a route list worth editing.
  const packaged = loadMatrixConfig({ cwd: root, layers: ["packaged"] }).config;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tui-routes-"));
  const file = path.join(dir, "pi-fusion-matrix.json");
  const opts = { dbPath: path.join(dir, "no-store.db") };
  const world = () =>
    buildState({
      config: packaged,
      baseConfig: packaged,
      layerConfig: {},
      layerFile: file,
      modelStats: [],
      fusionStats: [],
      seatStats: [],
    });
  const onKimi = expandedOn(world(), "kimi");
  const route = (provider) => routeRow(onKimi, "kimi", provider);

  // Reordered: the first route becomes the second, and the layer holds exactly that.
  const moved = applyKey(cursorOn(onKimi, route("opencode-go")), "J").state;
  const wroteMoved = await commitProposal(moved, opts);
  assert.equal(wroteMoved.wrote, true, "the moved order is written");
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), {
    aliases: { kimi: { providers: [{ id: "kimi-coding", modelOverride: "k3" }, "opencode-go"] } },
  });

  // Dropped: what remains is what the file says.
  fs.rmSync(file);
  const dropped = applyKey(cursorOn(onKimi, route("kimi-coding")), "d").state;
  const wroteDropped = await commitProposal(dropped, opts);
  assert.equal(wroteDropped.wrote, true);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), { aliases: { kimi: { providers: ["opencode-go"] } } });

  // Added: the new route lands after the cursor's, string ref and all.
  fs.rmSync(file);
  const added = proposeRouteAdd({ state: onKimi, row: route("opencode-go"), ref: "zai" });
  const wroteAdded = await commitProposal({ ...onKimi, pending: added }, opts);
  assert.equal(wroteAdded.wrote, true);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), {
    aliases: { kimi: { providers: ["opencode-go", "zai", { id: "kimi-coding", modelOverride: "k3" }] } },
  });

  fs.rmSync(dir, { recursive: true, force: true });
});
