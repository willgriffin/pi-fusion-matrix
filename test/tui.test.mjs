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
  catalogueFor,
  commitProposal,
  composeOverRain,
  detailFor,
  diff,
  frameFor,
  keyName,
  paint,
  proposeAliasCreate,
  proposeRouteDrop,
  proposeRouteList,
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

/**
 * The provider/model list the route builder picks from: pi's catalogue and the rate card merged with
 * the pairs the config itself names (the merge is `catalogueFor`'s own test) — providers sorted, each
 * one's models sorted.
 */
const catalogue = [
  { provider: "cline-pass", models: ["cline-free/muse"] },
  { provider: "kimi-code", models: ["kimi-k3"] },
  { provider: "opencode-go", models: ["glm-5", "kimi-k3"] },
];

const state = () =>
  buildState({
    config,
    modelStats,
    fusionStats,
    seatStats,
    catalogue,
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
    catalogue,
    baseConfig: editConfig,
    layerConfig: {},
    layerFile: "/tmp/nowhere/pi-fusion-matrix.json",
  });

/**
 * The editing world plus one alias that walks no providers at all: it sits at the alias level with
 * no route row under it, so the sibling `n` names there is another alias — and, the route builder
 * opening only from a route row, never its route list.
 */
const soloConfig = { ...editConfig, aliases: { ...editConfig.aliases, solo: { model: "kimi-k3", providers: [] } } };

const soloState = () =>
  buildState({
    config: soloConfig,
    modelStats,
    fusionStats,
    seatStats,
    catalogue,
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

/** A route builder over the fixture tree, its commit standing in — the shape the builder keys read. */
const builderOn = (world, over = {}) => ({
  ...world,
  builder: {
    title: "kimi: routes",
    tree: world.catalogue,
    expanded: {},
    left: 0,
    routes: [],
    right: 0,
    focus: "tree",
    commit: () => ({ error: "never reached" }),
    back: null,
    ...over,
  },
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
  const typing = { ...editState(), input: { title: "t", value: "x", hint: "", back: null, submit: () => ({ error: "never reached" }) } };
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
  // `n` left this company: on the aliases tab it names a sibling at the cursor's own level — the name
  // prompt and then the route builder (its own tests are below). K, J and d still need a route row —
  // and name themselves when the cursor is not on one.
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

  // The flat tabs have no route list to name a route for, so there `n` is still just the words — and
  // neither half of the route builder opens.
  for (const tab of ["fusions", "routes"]) {
    const flat = applyKey({ ...editState(), tab }, "n");
    assert.equal(flat.effect, "none");
    assert.equal(flat.state.input, null, `${tab} has no name prompt`);
    assert.equal(flat.state.builder, null, `${tab} has no route builder`);
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

test("n names a sibling at the cursor's level: a name prompt on an alias row, the route builder on a route row", () => {
  // The reader's report: `n` under an alias grew that alias's list. It names a *sibling* instead —
  // at the alias level another alias, at the route level the row's own list, opened in the builder.
  const closed = applyKey(editState(), "n"); // kimi's parent — the alias level
  assert.equal(closed.effect, "none");
  assert.ok(closed.state.input, "an alias row answers with the prompt, not a hint");
  assert.equal(closed.state.input.title, "new alias");
  assert.equal(closed.state.input.value, "", "it starts empty");
  assert.equal(closed.state.input.hint, "type the alias name · enter continues · esc back");
  assert.equal(closed.state.input.back, null, "the first step has nowhere to go back to");
  assert.equal(closed.state.pending, null, "asking is not yet proposing");

  // A route-less alias is still on the alias level: its sibling is another alias.
  const solo = soloState();
  const parent = solo.rows.aliases.find((row) => row.kind === "alias" && row.alias === "solo");
  assert.equal(parent.childCount, 0, "the fixture stands: there is no route row at that level");
  assert.equal(applyKey(cursorOn(solo, parent), "n").state.input.title, "new alias");

  // On a route row `n` opens the row's own list in the route builder — straight over the table, with
  // nothing typed first and nothing staged.
  const open = expandedOn(editState(), "kimi");
  const onRoute = applyKey(cursorOn(open, routeRow(open, "kimi", "opencode-go")), "n");
  assert.equal(onRoute.state.input, null, "there is no typed prompt left in the chain");
  assert.equal(onRoute.state.builder.title, "kimi: routes");
  assert.equal(onRoute.state.builder.back, null, "a direct-open builder has nowhere to step back to");
  assert.equal(onRoute.state.pending, null, "asking is not yet proposing");
});

test("n adds a sibling, not a child: a new alias grows no rows, a route row keeps its list on screen", () => {
  // The reader's report: the added entry never showed up — because it is not an entry of the row `n`
  // was pressed on. On an alias row the result is a new ROW beside it, so nothing under the cursor
  // changes while the chain runs.
  const closed = editState();
  const parent = closed.rows.aliases.find((row) => row.kind === "alias" && row.alias === "kimi");
  assert.equal(parent.expanded, false, "the fixture stands: the list is shut");
  const before = closed.rows.aliases.length;

  const asked = applyKey(cursorOn(closed, parent), "n").state;
  assert.ok(asked.input, "the chain starts over the table as it is");
  assert.equal(asked.input.title, "new alias");
  assert.equal(asked.rows.aliases.length, before, "no rows grow — a new alias is a sibling row, when it lands");
  assert.deepEqual(asked.expanded, closed.expanded, "and the cursor's row is not opened as a side effect");
  assert.equal(asked.cursors.aliases, closed.cursors.aliases, "the cursor stays on the row `n` was pressed on");
  assert.equal(asked.rows.aliases[asked.cursors.aliases].alias, "kimi", "which is still the parent");

  // On a route row the list is already open and stays on screen untouched while the builder is over
  // it — what lands is the committed list, one wholesale rewrite of the row's parent.
  const open = expandedOn(editState(), "kimi");
  const onRoute = applyKey(cursorOn(open, routeRow(open, "kimi", "opencode-go")), "n").state;
  assert.ok(onRoute.builder, "the builder opens over the table");
  assert.equal(onRoute.expanded.kimi, true);
  assert.deepEqual(
    onRoute.rows.aliases.filter((row) => row.kind === "route" && row.parent === "kimi").map((row) => row.provider),
    ["opencode-go", "kimi-code"],
    "the routes stay on screen, unedited, under it",
  );
  const landed = applyKey(applyKey(applyKey(onRoute, "tab").state, "d").state, "s");
  assert.equal(landed.effect, "save");
  assert.deepEqual(
    landed.state.rows.aliases.filter((row) => row.kind === "route" && row.parent === "kimi").map((row) => row.provider),
    ["kimi-code"],
    "and the rows say the committed list",
  );
});

test("catalogueFor merges pi's catalogue, the rate card and the config into one provider → models tree", () => {
  // Three sources, one tree: pi's registry entries (provider + id), the harness rate card's rows
  // (provider + model), and every pair the config itself names — an alias's model under each of its
  // providers, and a ref's override under that ref's id. Sorted, duplicates collapsed.
  const registry = {
    getAll: () => [
      { provider: "zai", id: "glm-5" },
      { provider: "clo", id: "clo-mini" },
    ],
  };
  const priceCard = {
    rows: [
      { provider: "opencode-go", model: "kimi-k3" },
      { provider: "zai", model: "glm-5" },
    ],
  };
  const from = {
    aliases: { muse: { model: "muse-1", providers: ["opencode-go", { id: "cline-pass", modelOverride: "cline-free/muse" }] } },
  };
  assert.deepEqual(catalogueFor({ registry, priceCard, config: from }), [
    { provider: "cline-pass", models: ["cline-free/muse", "muse-1"] },
    { provider: "clo", models: ["clo-mini"] },
    { provider: "opencode-go", models: ["kimi-k3", "muse-1"] },
    { provider: "zai", models: ["glm-5"] },
  ]);

  // A source that is not there contributes nothing — a named degradation, not an error.
  assert.deepEqual(catalogueFor({ config: from }), [
    { provider: "cline-pass", models: ["cline-free/muse", "muse-1"] },
    { provider: "opencode-go", models: ["muse-1"] },
  ]);
  assert.deepEqual(catalogueFor({ registry }), [
    { provider: "clo", models: ["clo-mini"] },
    { provider: "zai", models: ["glm-5"] },
  ]);
  assert.deepEqual(catalogueFor({ priceCard }), [
    { provider: "opencode-go", models: ["kimi-k3"] },
    { provider: "zai", models: ["glm-5"] },
  ]);
  assert.deepEqual(catalogueFor({ config: { aliases: { solo: { model: "m" } } } }), [], "an alias with no providers names no pair");
  assert.deepEqual(catalogueFor({}), [], "and no source at all is an empty tree, not a failure");
  assert.deepEqual(catalogueFor({ registry: {}, priceCard: {}, config: {} }), [], "sources without the fields say nothing too");
});

test("the new-alias chain becomes name → route builder: the typed model step is gone", () => {
  const step1 = applyKey(editState(), "n").state;
  assert.equal(step1.input.title, "new alias");
  assert.equal(step1.input.hint, "type the alias name · enter continues · esc back");
  assert.equal(step1.input.value, "");
  assert.equal(step1.input.back, null);

  // A name moves the chain on — to the route builder over the list to pick from: nothing staged,
  // nothing saved, and no typed model step anywhere between the two.
  const named = applyKey(applyKey(step1, "nova").state, "return");
  assert.equal(named.effect, "none", "the chain continues");
  assert.equal(named.state.input, null, "the name step is done — and there is no model step after it");
  const builder = named.state.builder;
  assert.equal(builder.title, "nova: routes");
  assert.deepEqual(builder.tree, named.state.catalogue, "the tree is the state's provider/model list");
  assert.deepEqual(builder.expanded, {}, "the tree starts collapsed");
  assert.equal(builder.left, 0);
  assert.deepEqual(builder.routes, [], "nothing is picked yet");
  assert.equal(builder.right, 0);
  assert.equal(builder.focus, "tree");
  assert.equal(typeof builder.commit, "function", "`s` knows what to submit");
  assert.deepEqual(
    { title: builder.back.title, value: builder.back.value },
    { title: "new alias", value: "nova" },
    "and it steps back to the name, typed and all",
  );
  assert.equal(named.state.pending, null, "still just asking");
});

test("the builder's tree pane walks its flattened rows, opens a provider, and adds a model's pair on enter", () => {
  const world = builderOn(editState()); // tree rows: cline-pass, kimi-code, opencode-go — all shut
  const cursor = (state) => state.builder.left;
  const expanded = (state) => state.builder.expanded;

  // The cursor walks the visible rows — the providers while the tree is shut — and holds at either end.
  assert.equal(cursor(applyKey(world, "j").state), 1);
  assert.equal(cursor(applyKey(world, "down").state), 1, "`down` walks with `j`");
  assert.equal(cursor(applyKey(applyKey(applyKey(world, "j").state, "j").state, "j").state), 2, "the bottom holds");
  assert.equal(cursor(applyKey(world, "k").state), 0, "and so does the top");
  assert.equal(cursor(applyKey(world, "up").state), 0, "`up` walks with `k`");

  // Enter toggles the provider under the cursor open and shut, and the cursor stays on its row.
  const opened = applyKey(world, "enter");
  assert.deepEqual(expanded(opened.state), { "cline-pass": true });
  assert.equal(cursor(opened.state), 0, "the row does not move as its children appear under it");
  assert.deepEqual(expanded(applyKey(opened.state, "return").state), { "cline-pass": false }, "and enter shuts it again");

  // `right`/`l` opens the provider and steps onto its first model; `left`/`h` steps back off a model
  // to its provider, and shuts a provider that is open.
  const l = applyKey({ ...world, builder: { ...world.builder, left: 2 } }, "l").state.builder;
  assert.deepEqual(l.expanded, { "opencode-go": true });
  assert.equal(l.left, 3, "onto its first model");
  const h = applyKey({ ...world, builder: l }, "h").state.builder;
  assert.equal(h.left, 2, "a model steps back to its provider");
  const shut = applyKey({ ...world, builder: { ...h, left: 2 } }, "left").state.builder;
  assert.deepEqual(shut.expanded, { "opencode-go": false }, "and the provider shuts");
  assert.equal(shut.left, 2);
  const right = applyKey({ ...world, builder: { ...shut, expanded: { "opencode-go": true } } }, "right").state.builder;
  assert.equal(right.left, 3, "an open provider steps onto its first model too");

  // Enter on a model adds the pair it names — provider and picked model — and the routes cursor
  // follows the new entry.
  const picked = applyKey({ ...world, builder: { ...world.builder, expanded: { "opencode-go": true }, left: 4 } }, "return").state.builder;
  assert.deepEqual(picked.routes, [{ id: "opencode-go", model: "kimi-k3" }]);
  assert.equal(picked.right, 0, "the routes cursor is on the entry it just added");
  const twice = applyKey(
    { ...world, builder: { ...world.builder, expanded: { "cline-pass": true }, left: 1, routes: picked.routes, right: 0 } },
    "enter",
  ).state.builder;
  assert.deepEqual(twice.routes, [
    { id: "opencode-go", model: "kimi-k3" },
    { id: "cline-pass", model: "cline-free/muse" },
  ]);
  assert.equal(twice.right, 1, "following the second one down");
});

test("the builder's routes pane reorders and drops what it holds, and its cursor rides with the route", () => {
  const world = builderOn(editState(), {
    routes: [
      { id: "opencode-go", model: "kimi-k3" },
      { id: "kimi-code", model: "kimi-k3" },
      { id: "cline-pass", model: "cline-free/muse" },
    ],
    right: 1,
    focus: "routes",
  });

  // J walks the focused route one place down and the cursor rides with it; K walks it back.
  const down = applyKey(world, "J").state.builder;
  assert.deepEqual(
    down.routes.map((pair) => pair.id),
    ["opencode-go", "cline-pass", "kimi-code"],
  );
  assert.equal(down.right, 2, "the cursor rides with the route");
  const up = applyKey({ ...world, builder: down }, "K").state.builder;
  assert.deepEqual(
    up.routes.map((pair) => pair.id),
    ["opencode-go", "kimi-code", "cline-pass"],
  );
  assert.equal(up.right, 1);

  // At either end there is nowhere to move: the list and the cursor stay exactly as they are.
  const top = applyKey({ ...world, builder: { ...world.builder, right: 0 } }, "K").state.builder;
  assert.deepEqual(top.routes, world.builder.routes);
  assert.equal(top.right, 0);
  const bottom = applyKey({ ...world, builder: { ...world.builder, right: 2 } }, "J").state.builder;
  assert.deepEqual(bottom.routes, world.builder.routes);
  assert.equal(bottom.right, 2);

  // `d` drops the focused route, and the cursor stays on a row that exists.
  const dropped = applyKey({ ...world, builder: { ...world.builder, right: 1 } }, "d").state.builder;
  assert.deepEqual(
    dropped.routes.map((pair) => pair.id),
    ["opencode-go", "cline-pass"],
  );
  assert.equal(dropped.right <= dropped.routes.length - 1, true);

  // And an empty list takes its own keys without a row being invented for it.
  const empty = { ...world, builder: { ...world.builder, routes: [], right: 0 } };
  for (const key of ["J", "K", "d"]) {
    assert.deepEqual(applyKey(empty, key).state.builder.routes, [], `${key} invents no route`);
  }
});

test("inside the builder every other key is inert: the world cannot leak in and `q` cannot quit", () => {
  const open = builderOn(editState(), { routes: [{ id: "kimi-code", model: "kimi-k3" }], focus: "routes" });

  // The tree pane holds no list to reorder or drop, and the routes pane adds nothing.
  const tree = builderOn(editState());
  for (const key of ["K", "J", "d"]) {
    const same = applyKey(tree, key);
    assert.equal(same.effect, "none", `${key} does nothing in the tree pane`);
    assert.deepEqual(same.state.builder.routes, []);
    assert.equal(same.state.pending, null);
  }
  assert.deepEqual(applyKey(open, "return").state.builder.routes, open.builder.routes, "enter adds nothing from the routes pane");

  // And the keys that own the interface outside are just keys in here — `q` included.
  for (const key of ["q", "1", "2", "3", "?", "a", "c", "r", "R", "e"]) {
    const same = applyKey(open, key);
    assert.equal(same.effect, "none", `${key} leaks nothing`);
    assert.deepEqual({ ...same.state, message: "" }, { ...open, message: "" }, `${key} changes nothing`);
  }
  assert.equal(applyKey(open, "ctrl-c").effect, "quit", "but the one way out of everything still works");

  // The builder is the top of the stack: a name step parked beneath it is not where the keys go.
  const parked = builderOn(
    { ...editState(), input: { title: "new alias", value: "nova", hint: "", back: null, submit: () => ({ error: "never reached" }) } },
    { focus: "tree" },
  );
  const flipped = applyKey(parked, "tab");
  assert.equal(flipped.state.builder.focus, "routes", "the builder took the key");
  assert.equal(flipped.state.input.value, "nova", "and the prompt beneath it did not");
});

test("with no provider/model list to choose from, `n` names it and opens nothing", () => {
  // The builder's tree is the catalogue; with none there is nothing to pick from, and both of `n`'s
  // openers say so instead of opening.
  const noList = { ...editState(), catalogue: [] };
  const onAlias = applyKey(noList, "n");
  assert.equal(onAlias.effect, "none");
  assert.equal(onAlias.state.message, "no provider/model list to choose from");
  assert.equal(onAlias.state.input, null, "no name prompt");
  assert.equal(onAlias.state.builder, null, "and no builder");

  const open = expandedOn(noList, "kimi");
  const onRoute = applyKey(cursorOn(open, routeRow(open, "kimi", "opencode-go")), "n");
  assert.equal(onRoute.state.message, "no provider/model list to choose from");
  assert.equal(onRoute.state.input, null);
  assert.equal(onRoute.state.builder, null);

  // A state built without the field at all is the same empty: the default catalogue is no catalogue.
  const defaultless = buildState({
    config: editConfig,
    baseConfig: editConfig,
    layerConfig: {},
    layerFile: "/tmp/nowhere/pi-fusion-matrix.json",
  });
  assert.deepEqual(defaultless.catalogue, []);
  assert.equal(applyKey(defaultless, "n").state.message, "no provider/model list to choose from");
});

test("s in the builder creates the alias: its model is its first route's picked model", () => {
  // The chain the keys walk: name, then the builder — kimi-code's kimi-k3 picked first, opencode-go's
  // glm-5 beside it.
  const named = applyKey(applyKey(applyKey(editState(), "n").state, "nova").state, "return").state;
  const picked = ["j", "right", "return", "j", "l", "return"].reduce((world, key) => applyKey(world, key).state, named);
  assert.deepEqual(picked.builder.routes, [
    { id: "kimi-code", model: "kimi-k3" },
    { id: "opencode-go", model: "glm-5" },
  ]);

  const saved = applyKey(picked, "s");
  assert.equal(saved.effect, "save", "`s` stages the proposal and asks for the write");
  assert.equal(saved.state.builder, null, "the builder is done");
  const pending = saved.state.pending;
  assert.equal(pending.listOf, "nova");
  assert.equal(pending.layerFile, editState().layerFile);
  assert.deepEqual(
    pending.patch,
    { aliases: { nova: { model: "kimi-k3", providers: ["kimi-code", { id: "opencode-go", modelOverride: "glm-5" }] } } },
    "the model is the FIRST pair's, and each ref is stored exactly as picked: a plain name where the pair names that model, an override where it does not",
  );
  assert.deepEqual(pending.errors, [], "the loader's verdict travels with the proposal");
  assert.match(pending.summary, /^nova = kimi-k3 @ kimi-code → opencode-go/);
});

test("s in the builder rewrites one alias's route list wholesale — and never its model", () => {
  // The builder a route row opens is seeded from the alias's current refs, each pair the effective
  // model it walks: muse's override ref comes in as the override, not as the alias's model.
  const onMuse = expandedOn(editState(), "muse");
  const open = applyKey(cursorOn(onMuse, routeRow(onMuse, "muse", "cline-pass")), "n").state;
  assert.equal(open.builder.title, "muse: routes");
  assert.deepEqual(open.builder.routes, [
    { id: "opencode-go", model: "muse-spark-1.3-contributor" },
    { id: "cline-pass", model: "cline-free/muse" },
  ]);

  // What is picked is what the list becomes — one dropped, one picked over from the tree.
  const rebuilt = ["tab", "d", "shift-tab", "j", "right", "return"].reduce((world, key) => applyKey(world, key).state, open);
  const saved = applyKey(rebuilt, "s");
  assert.equal(saved.effect, "save");
  assert.equal(saved.state.builder, null);
  const pending = saved.state.pending;
  assert.equal(pending.listOf, "muse");
  assert.deepEqual(
    pending.patch.aliases.muse,
    {
      providers: [
        { id: "cline-pass", modelOverride: "cline-free/muse" },
        { id: "kimi-code", modelOverride: "kimi-k3" },
      ],
    },
    "the list wholesale, each ref exactly as picked, and no model key beside it to re-point the alias",
  );
  assert.deepEqual(pending.errors, [], "the loader's verdict travels with the proposal");
  assert.match(pending.summary, /muse now tries/);
  assert.match(pending.summary, /cline-pass.*kimi-code/);

  // And a commit over a pending for the same alias builds on it: whatever that pending staged
  // travels with the rewritten list.
  const carried = {
    listOf: "muse",
    layerFile: editState().layerFile,
    patch: { aliases: { muse: { providers: ["zai"] }, kept: { model: "kimi-k3", providers: ["b"] } } },
    summary: "muse now tries zai",
    errors: [],
  };
  const overCarried = expandedOn({ ...editState(), pending: carried }, "muse");
  const reopened = applyKey(cursorOn(overCarried, routeRow(overCarried, "muse", "zai")), "n").state;
  assert.deepEqual(reopened.builder.routes, [{ id: "zai", model: "muse-spark-1.3-contributor" }], "seeded from the pending list");
  const over = ["tab", "d", "shift-tab", "j", "right", "return"].reduce((world, key) => applyKey(world, key).state, reopened);
  const built = applyKey(over, "s").state.pending;
  assert.deepEqual(
    built.patch,
    { aliases: { muse: { providers: [{ id: "kimi-code", modelOverride: "kimi-k3" }] }, kept: { model: "kimi-k3", providers: ["b"] } } },
    "the new list wholesale — and the pending it builds over is kept",
  );
});

test("an empty route list is refused by name, with the builder still open over it", () => {
  // Creation: the chain's builder has nothing to make an alias out of.
  const fresh = applyKey(applyKey(applyKey(editState(), "n").state, "nova").state, "return").state;
  const blankCreate = applyKey(fresh, "s");
  assert.equal(blankCreate.effect, "none", "a refusal writes nothing");
  assert.equal(blankCreate.state.message, "an alias needs at least one route");
  assert.equal(blankCreate.state.builder.title, "nova: routes", "the builder stays open");
  assert.deepEqual(blankCreate.state.builder.routes, [], "over the list it refused");
  assert.equal(blankCreate.state.pending, null, "and nothing is staged");

  // Editing: dropping every route leaves the same named refusal, never a write of an empty list.
  const onTrio = expandedOn(editState(), "trio");
  const open = applyKey(cursorOn(onTrio, routeRow(onTrio, "trio", "cline-pass")), "n").state;
  assert.equal(open.builder.routes.length, 3, "the fixture stands: three routes to drop");
  const emptied = ["tab", "d", "d", "d"].reduce((world, key) => applyKey(world, key).state, open);
  assert.deepEqual(emptied.builder.routes, []);
  const blankEdit = applyKey(emptied, "s");
  assert.equal(blankEdit.effect, "none");
  assert.equal(blankEdit.state.message, "a route list cannot be empty");
  assert.equal(blankEdit.state.builder.title, "trio: routes", "the builder stays open");
  assert.equal(blankEdit.state.pending, null);
});

test("escape steps back out of the chain and closes a direct builder — never a quit", () => {
  // From the chain's builder, back is the name it opened over — typed and all — and re-submitting it
  // walks into a fresh builder.
  const named = applyKey(applyKey(applyKey(editState(), "n").state, "nova").state, "return").state;
  const toName = applyKey(named, "escape");
  assert.equal(toName.effect, "none", "escape is back — never a way out");
  assert.equal(toName.state.builder, null);
  assert.equal(toName.state.input.title, "new alias");
  assert.equal(toName.state.input.value, "nova", "the typed name is intact");
  assert.equal(toName.state.pending, null, "stepping back stages nothing");
  const reopened = applyKey(toName.state, "return");
  assert.equal(reopened.state.builder.title, "nova: routes", "the name still submits");
  assert.deepEqual(reopened.state.builder.routes, [], "to a fresh builder");

  // At the first step back is out of the chain entirely.
  const out = applyKey(toName.state, "escape");
  assert.equal(out.state.input, null, "the first step is the way out");
  assert.equal(out.state.builder, null);
  assert.equal(out.effect, "none");
  assert.equal(out.state.pending, null);

  // A builder opened straight from a route row has no step behind it: escape closes it.
  const onKimi = expandedOn(editState(), "kimi");
  const direct = applyKey(cursorOn(onKimi, routeRow(onKimi, "kimi", "opencode-go")), "n").state;
  const closed = applyKey(direct, "escape");
  assert.equal(closed.state.builder, null);
  assert.equal(closed.state.input, null);
  assert.equal(closed.effect, "none", "and closing is not quitting");

  // And ctrl-c is still the one way out of everything, from inside the builder.
  assert.equal(applyKey(direct, "ctrl-c").effect, "quit");
});

test("the name step refuses what it cannot take: the prompt stays open, the typing stays in it", () => {
  const step1 = applyKey(editState(), "n").state;

  // A blank name is not a name.
  const blank = applyKey(step1, "return");
  assert.equal(blank.effect, "none", "a blank name writes nothing");
  assert.ok(blank.state.input, "the prompt stays open");
  assert.equal(blank.state.input.title, "new alias");
  assert.equal(blank.state.message, "an alias needs a name");
  assert.equal(blank.state.pending, null, "a refusal stages nothing");

  // Whitespace is not a name either, and what was typed stays to be fixed.
  const spaces = [" ", " ", " "].reduce((world, key) => applyKey(world, key).state, step1);
  assert.equal(spaces.input.value, "   ");
  const refusedSpaces = applyKey(spaces, "return");
  assert.equal(refusedSpaces.effect, "none");
  assert.ok(refusedSpaces.state.input);
  assert.equal(refusedSpaces.state.message, "an alias needs a name");
  assert.equal(refusedSpaces.state.input.value, "   ", "and what was typed is still there to fix");
  assert.equal(refusedSpaces.state.pending, null);

  // A name that exists is never clobbered — and there is no patch staged to clobber it with.
  const typed = applyKey(step1, "kimi").state;
  const collide = applyKey(typed, "return");
  assert.equal(collide.effect, "none");
  assert.ok(collide.state.input, "the prompt stays open");
  assert.equal(collide.state.message, "kimi already exists");
  assert.equal(collide.state.input.value, "kimi", "the typing survives the refusal");
  assert.equal(collide.state.pending, null, "the patch carries nothing");
});

test("the proposers build over the same-name pending, and start clean over any other", () => {
  const world = editState();
  // The rule both route-list proposers share: a pending for the same list in the same layer file is
  // the baseline the new patch is drawn over — whatever else it staged travels with it.
  const carried = {
    listOf: "nova",
    layerFile: world.layerFile,
    patch: { aliases: { nova: { model: "kimi-k3", providers: ["a"] }, kept: { model: "kimi-k3", providers: ["b"] } } },
    summary: "nova = kimi-k3 @ a",
    errors: [],
  };
  const again = proposeAliasCreate({
    state: { ...world, pending: carried },
    name: "nova",
    model: "muse-spark-1.3-contributor",
    routes: [{ id: "clo", model: "muse-spark-1.3-contributor" }],
  });
  assert.equal(again.listOf, "nova");
  assert.equal(again.layerFile, world.layerFile);
  assert.deepEqual(again.patch.aliases.nova, { model: "muse-spark-1.3-contributor", providers: ["clo"] });
  assert.deepEqual(again.patch.aliases.kept, { model: "kimi-k3", providers: ["b"] }, "the pending it builds over is kept");
  assert.deepEqual(again.errors, [], "the loader accepts the accumulated patch");
  assert.equal(again.summary, "nova = muse-spark-1.3-contributor @ clo");

  // Any other pending is not this name's baseline: the patch is just the alias being made.
  const clean = { aliases: { nova: { model: "kimi-k3", providers: ["clo"] } } };
  for (const pending of [
    { ...carried, listOf: "elsewhere" },
    { ...carried, layerFile: "/tmp/elsewhere/x.json" },
  ]) {
    const fresh = proposeAliasCreate({
      state: { ...world, pending },
      name: "nova",
      model: "kimi-k3",
      routes: [{ id: "clo", model: "kimi-k3" }],
    });
    assert.deepEqual(fresh.patch, clean, "another name's or another layer's pending is not carried");
  }

  // The route-list proposer keeps the same rule, over whichever row names its list.
  const listCarried = {
    listOf: "trio",
    layerFile: world.layerFile,
    patch: { aliases: { trio: { providers: ["zai"] }, kept: { model: "kimi-k3", providers: ["b"] } } },
    summary: "trio now tries zai",
    errors: [],
  };
  const open = expandedOn({ ...world, pending: listCarried }, "trio");
  const rebuilt = proposeRouteList({
    state: { ...world, pending: listCarried },
    row: routeRow(open, "trio", "zai"),
    routes: [
      { id: "kimi-code", model: "kimi-k3" },
      { id: "zai", model: "glm-5" },
    ],
  });
  assert.equal(rebuilt.listOf, "trio");
  assert.deepEqual(
    rebuilt.patch.aliases.trio,
    { providers: ["kimi-code", { id: "zai", modelOverride: "glm-5" }] },
    "the list wholesale, each ref exactly as picked, and no model key beside it",
  );
  assert.deepEqual(rebuilt.patch.aliases.kept, { model: "kimi-k3", providers: ["b"] }, "the rule holds here too");
  assert.deepEqual(rebuilt.errors, []);
  assert.match(rebuilt.summary, /trio now tries/);
  assert.match(rebuilt.summary, /kimi-code.*zai/);

  // …and a pending for another list is not its baseline.
  const listClean = proposeRouteList({
    state: { ...world, pending: { ...listCarried, listOf: "elsewhere" } },
    row: routeRow(open, "trio", "zai"),
    routes: [{ id: "kimi-code", model: "kimi-k3" }],
  });
  assert.deepEqual(listClean.patch, { aliases: { trio: { providers: ["kimi-code"] } } });

  // The row's own shape does not matter: its parent names the list, parent row or route row alike.
  const parent = open.rows.aliases.find((row) => row.kind === "alias" && row.alias === "trio");
  const viaParent = proposeRouteList({ state: world, row: parent, routes: [{ id: "clo", model: "kimi-k3" }] });
  assert.equal(viaParent.listOf, "trio");
  assert.deepEqual(viaParent.patch.aliases.trio, { providers: ["clo"] });
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

test("the staging keeps the verdict it is handed: a refusal's summary, a complaint's silence", () => {
  // The builder's `commit` is its own to build, so the two verdicts the real commits never hand back —
  // a refusal and a loader complaint — are walked the way the picker fixtures walk their choices.
  const building = (commit) => builderOn(editState(), { routes: [{ id: "zai", model: "glm-5" }], commit });

  const refused = applyKey(
    building(() => ({
      proposal: {
        listOf: "kimi",
        layerFile: "/tmp/nowhere/x.json",
        patch: {},
        summary: "kimi changes nothing",
        errors: [],
        saveable: false,
      },
    })),
    "s",
  );
  assert.equal(refused.effect, "save", "a submitted proposal is a save request whatever its verdict");
  assert.equal(refused.state.pending.saveable, false, "even a refusal is kept pending");
  assert.equal(refused.state.builder, null);
  assert.equal(refused.state.message, "kimi changes nothing", "and its summary is the message");

  const complained = applyKey(
    building(() => ({
      proposal: { listOf: "kimi", layerFile: "/tmp/nowhere/x.json", patch: {}, summary: "kimi now tries zai", errors: ["boom"] },
    })),
    "s",
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
    input: { title: "new alias", value: "zai", hint: "", back: null, submit: () => ({ error: "never reached" }) },
    builder: { title: "zai: routes", tree: [], expanded: {}, left: 0, routes: [], right: 0, focus: "tree", commit: () => ({}), back: null },
    catalogue: [{ provider: "session-known", models: ["kept-from-the-session"] }],
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
  assert.equal(after.builder, null, "and the route builder with it");
  assert.deepEqual(after.catalogue, before.catalogue, "the provider/model list is session-known: the session's, not the reloaded world's");
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

test("the frame paints the prompt: its title, its own hint, the typed name and the caret", () => {
  // The reader's report as a frame: with the prompt open the screen has to say so — the title it
  // opened under and the name typed so far, the caret sitting after it.
  const typed = applyKey(applyKey(editState(), "n").state, "zai").state;
  const lines = (world) => {
    const frame = frameFor({ width: 60, height: 14, state: world, palette: paletteFor({ color: false }), clock: "" });
    return Array.from({ length: 14 }, (_, row) => gridLine(frame, row)).join("\n");
  };
  const text = lines(typed);
  assert.match(text, /new alias/);
  assert.match(text, /zai▌/);
  assert.match(text, /type the alias name/, "the second line is the prompt's own hint");

  // A name longer than the box is cut to the box rather than running past the panel.
  const long = { ...typed, input: { ...typed.input, value: "cline-".repeat(20) } };
  assert.match(lines(long), /…/);
});

test("the frame paints the route builder: the tree and the routes beside it, and its identity line", () => {
  const lines = (world) => {
    const frame = frameFor({ width: 110, height: 20, state: world, palette: paletteFor({ color: false }), clock: "" });
    return Array.from({ length: 20 }, (_, row) => gridLine(frame, row));
  };

  // Fresh from the chain: the tree all shut, nothing picked, and an identity line that knows it.
  const fresh = lines(builderOn(editState(), { title: "nova: routes" })).join("\n");
  assert.match(fresh, /nova: routes/, "the box wears the alias it is building");
  assert.match(fresh, /▸ cline-pass/, "the tree's providers, shut");
  assert.match(fresh, /no routes yet/);
  assert.match(fresh, /nova = —/, "the model is the first pick's, and there is none yet");

  // Walked: an open provider is a ▾ with its models indented under it, and each pick is a row on the
  // other side — provider → model, the model picked, not the alias's.
  const walked = lines(
    builderOn(editState(), {
      title: "nova: routes",
      expanded: { "opencode-go": true },
      left: 3,
      routes: [
        { id: "kimi-code", model: "kimi-k3" },
        { id: "opencode-go", model: "glm-5" },
      ],
    }),
  );
  const text = walked.join("\n");
  assert.match(text, /▾ opencode-go/);
  assert.match(text, / {2}glm-5/, "the models sit indented under their provider");
  assert.match(text, /kimi-code → kimi-k3/);
  assert.match(text, /opencode-go → glm-5/);
  assert.match(text, /nova = kimi-k3 @ kimi-code/, "the identity line is the matrix-info one: the model is the first pick's");

  // The hint is the second footer line, under the identity — whatever its wording, `esc` is how it
  // names the way back.
  const identity = walked.findIndex((line) => line.includes("nova = "));
  assert.match(walked[identity + 1] ?? "", /esc/, "the hint sits right under the identity line");
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

test("a moved, dropped or rebuilt route list is what the layer file comes to hold", async () => {
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

  // Rebuilt wholesale: what the route builder picked is what the file says — a plain ref where the
  // pair names the alias's model, an override where it names another.
  fs.rmSync(file);
  const rebuilt = proposeRouteList({
    state: onKimi,
    row: route("opencode-go"),
    routes: [
      { id: "opencode-go", model: "kimi-k3" },
      { id: "zai", model: "glm-5" },
      { id: "kimi-coding", model: "k3" },
    ],
  });
  const wroteRebuilt = await commitProposal({ ...onKimi, pending: rebuilt }, opts);
  assert.equal(wroteRebuilt.wrote, true);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), {
    aliases: {
      kimi: { providers: ["opencode-go", { id: "zai", modelOverride: "glm-5" }, { id: "kimi-coding", modelOverride: "k3" }] },
    },
  });

  fs.rmSync(dir, { recursive: true, force: true });
});
