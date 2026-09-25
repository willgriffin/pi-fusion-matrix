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
  fusionTree,
  SCHEMES,
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
  personaRows,
  put,
  routeRows,
  fusionRows,
  truncate,
} from "../scripts/tui-view.mjs";
import {
  adopt,
  aliasesView,
  applyKey,
  resolveScheme,
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
  proposeFor,
  proposePersonaDelete,
  proposePersonaSave,
  proposeRouteDrop,
  proposeRouteList,
  proposeRouteMove,
  proposeSeatAlias,
  proposeFusionEdit,
  proposeFusionDelete,
  selected,
  validateAgainst,
} from "../scripts/matrix-tui.mjs";
import { THINKING_LEVELS, loadMatrixConfig } from "../extensions/pi-fusion-matrix/config.js";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
// The write-path checks drive `commitProposal`, which asks the loader again — machine layer and all.
// A suite may not depend on whose laptop it runs on, so for this file's process the loader's own
// isolation hook (`PI_CODING_AGENT_DIR`) points at nothing: the machine layer is the operator's, not
// the subject under test.
process.env.PI_CODING_AGENT_DIR = path.join(os.tmpdir(), "tui-test-no-machine-layer");

/* ------------------------------------------------------------------ fixture */

/** A small, self-contained world: two aliases (one with a modelOverride route) and two fusions. */
const config = {
  aliases: {
    kimi: { model: "kimi-k3", providers: ["opencode-go", "kimi-code"] },
    muse: { model: "muse-spark-1.3-contributor", providers: ["opencode-go", { id: "cline-pass", modelOverride: "cline-free/muse" }] },
    kimiAlias: { model: "kimi-k3", providers: ["cline-pass"] },
  },
  personas: {
    // Every prompt kind the editor walks: a path in the declaring layer's directory, and inline text —
    // the single line reads as a path and the multi-line one as text, which is the loader's own rule.
    // The JSON knob sits on a parallel seat: a writing seat that answers in JSON is a different rule.
    technical: { prompt: "prompts/technical.md", temperature: 0.2 },
    skeptic: { prompt: "find the flaw in it\nand name it plainly", thinking: "high", output: "json" },
    judge: { prompt: "pick the better answer\nand say why" },
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

const stateWorld = () =>
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
    technical: { prompt: "reason about the change\nand what it can break" },
    skeptic: { prompt: "find the flaw in it\nand name it plainly" },
    judge: { prompt: "pick the better answer\nand say why" },
  },
  decide: { defaultBackend: "local" },
  backends: { local: { kind: "typesafe", url: "http://127.0.0.1:8080", apiKeyEnv: "TYPESAFE_API_KEY", model: "judge-1" } },
  aliases: { ...config.aliases, trio: { model: "kimi-k3", providers: ["opencode-go", "kimi-code", "cline-pass"] } },
};

const state = () => ({ ...stateWorld(), tab: "aliases" });

const editStateWorld = () =>
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

const soloStateWorld = () =>
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

const soloState = () => ({ ...soloStateWorld(), tab: "aliases" });

const editState = () => ({ ...editStateWorld(), tab: "aliases" });

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

/**
 * The persona-editing world: the base layers name one persona and the layer file the other two — so
 * both ownership rules have a subject — with every prompt kind and knob the editor walks, over the
 * fixture's modes and fusions so a persona's seats are the routes tab's own rows. `sources` is where
 * each persona's winning declaration lives, which is what a prompt path resolves against.
 */
const personaLayerFile = "/tmp/persona-layer/pi-fusion-matrix.json";
// The prompt file the layer's path-backed persona points at — beside the layer, as an earlier save
// would have left it: the loader resolves a layer persona's prompt against the layer's own directory.
fs.mkdirSync(path.join(path.dirname(personaLayerFile), "prompts"), { recursive: true });
fs.writeFileSync(path.join(path.dirname(personaLayerFile), "prompts", "technical.md"), "");
const personaConfig = {
  ...editConfig,
  personas: {
    technical: { prompt: "prompts/technical.md", temperature: 0.2 },
    skeptic: { prompt: "find the flaw in it\nand name it plainly", thinking: "high", output: "json" },
    judge: { prompt: "pick the better answer\nand say why" },
  },
};
const personaLayer = { personas: { technical: personaConfig.personas.technical, skeptic: personaConfig.personas.skeptic } };
const personaBase = { ...personaConfig, personas: { judge: personaConfig.personas.judge } };
const personaSources = {
  personas: {
    technical: { dir: "/tmp/persona-layer", kind: "machine", file: personaLayerFile, trusted: true },
    skeptic: { dir: "/tmp/persona-layer", kind: "machine", file: personaLayerFile, trusted: true },
    judge: { dir: "/base", kind: "packaged", file: "/base/pi-fusion-matrix.json", trusted: true },
  },
};

const personaState = (over = {}) =>
  buildState({
    config: personaConfig,
    baseConfig: personaBase,
    layerConfig: personaLayer,
    layerFile: personaLayerFile,
    sources: personaSources,
    modelStats,
    fusionStats,
    seatStats,
    catalogue,
    ...over,
  });

/** A persona editor's draft as the field keys read it: no knobs set, an inline prompt of two lines. */
const draftFor = (name, over = {}) => ({
  name,
  promptFile: "",
  text: "one\ntwo",
  temperature: undefined,
  thinking: undefined,
  output: undefined,
  ...over,
});

/** An editor over the fixture's skeptic, its commit standing in — the shape the field keys read. */
const editorOn = (world, over = {}) => ({
  ...world,
  editor: {
    title: "skeptic",
    draft: draftFor("skeptic"),
    originalText: "one\ntwo",
    cursor: 0,
    commit: () => ({ error: "never reached" }),
    back: null,
    ...over,
  },
});

/** A textarea over two short lines, its caret at the end of the first — the shape the text keys read. */
const textareaOn = (world, over = {}) => ({
  ...world,
  textarea: {
    title: "prompt",
    lines: ["one", "two"],
    row: 0,
    col: 3,
    apply: () => ({ error: "never reached" }),
    back: null,
    hint: "",
    ...over,
  },
});

/** The cursor onto one exact row of the personas list. */
const personaCursorOn = (world, row) => ({ ...world, cursors: { ...world.cursors, personas: world.rows.personas.indexOf(row) } });

/** A persona's parent row by name, and the seat row under it for one fusion. */
const personaParent = (world, name) => world.rows.personas.find((row) => row.kind === "persona" && row.persona === name);
const personaSeat = (world, name, fusion) =>
  world.rows.personas.find((row) => row.kind === "seat" && row.parent === name && row.fusion === fusion);

/** Walk a picker to one exact option and choose it: wherever it opened, `k` holds at the top first. */
const pick = (world, option) => {
  let next = world;
  for (let i = 0; i < 30; i += 1) next = applyKey(next, "k").state;
  const index = next.picker.options.indexOf(option);
  for (let i = 0; i < index; i += 1) next = applyKey(next, "j").state;
  return applyKey(next, "return");
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

test("every primitive wears its own colour, and the schemes are swappable", () => {
  const ESC = String.fromCharCode(27);
  const palette = paletteFor({ color: true });
  for (const [name, scheme] of Object.entries(SCHEMES)) {
    assert.deepEqual(Object.keys(scheme).sort(), Object.keys(SCHEMES.matrix).sort(), `${name} names the same primitives`);
    assert.equal(
      new Set(Object.values(scheme).map((rgb) => rgb.join())).size,
      Object.keys(scheme).length,
      `${name} gives each primitive its own hue`,
    );
  }
  for (const style of Object.values(palette.kinds)) {
    assert.ok(style.startsWith(ESC + "[38;2;") && style.endsWith("m"), "a tint is truecolour");
  }
  // A custom scheme lays over the default: the keys it names change, the rest keep the default.
  const custom = paletteFor({ color: true, scheme: { parallel: [255, 0, 0] } });
  assert.equal(custom.kinds.parallel, ESC + "[38;2;255;0;0m");
  assert.equal(custom.kinds.single, palette.kinds.single);
  // A name nobody knows is refused with the names it could have chosen, and NO_COLOR drops the map.
  assert.throws(() => paletteFor({ color: true, scheme: "nope" }), /unknown scheme "nope"/);
  assert.deepEqual(paletteFor({ color: false }).kinds, {});
});

test("a scheme is a name or a file, and a name nobody knows is refused at startup", () => {
  assert.equal(resolveScheme(undefined), "matrix");
  assert.equal(resolveScheme("ember"), "ember");
  assert.throws(() => resolveScheme("nope"), /unknown scheme "nope"/);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tui-scheme-"));
  const file = path.join(dir, "mine.json");
  fs.writeFileSync(file, JSON.stringify({ parallel: [255, 0, 0] }));
  assert.deepEqual(resolveScheme(file), { parallel: [255, 0, 0] });
});

test("the tree paints every primitive in its scheme's colour", () => {
  // A shape with every stage kind, a route to walk and a candidate chain — so every row the tree can
  // tint is on screen at once, and the rows that name no primitive keep the interface's ink.
  const config = {
    aliases: { alpha: { model: "m", providers: ["p"] } },
    personas: { a: { prompt: "x" }, b: { prompt: "y" } },
    fusions: {
      one: {
        mode: "shape",
        route: { type: "noul", criteria: { yes: { then: "alpha" }, no: { then: "alpha" } } },
        candidates: { a: ["alpha"], b: ["alpha"] },
      },
    },
    modes: {
      shape: {
        stages: [
          { parallel: ["a", "b"], input: "prompt" },
          { single: "a", input: "previous" },
          { decide: { type: "noul", criteria: { yes: { then: "a" } } }, input: "previous" },
          { score: { type: "score", criteria: { low: {}, high: {} } }, input: "previous" },
          { render: "a", input: "previous" },
        ],
      },
    },
  };
  const palette = paletteFor({ color: true });
  const build = (expanded) => fusionTree({ config, fusionStats: [], seatStats: [], decideRows: [], expanded, hasStore: false });
  // Open every row the tree can open, keyed by its own ids — one pass per level of nesting
  // (fusion → stage → seat → candidates), so the deepest rows are on screen too.
  const expand = (rows) => Object.fromEntries(rows.map((row) => [row.id, true]));
  let rows = build({});
  for (let pass = 0; pass < 4; pass += 1) rows = build(expand(rows));
  const grid = createGrid(160, rows.length + 4);
  const at = paintTable(grid, {
    columns: columnsFor("fusions"),
    rows,
    row: 1,
    col: 0,
    width: 160,
    height: rows.length + 2,
    cursor: 1,
    palette,
  });
  rows.forEach((row, i) => {
    if (i === 1) return; // the cursor row wears the selection, whatever it is
    const style = grid.fg[at[i] * 160];
    if (row.tint) assert.equal(style, palette.kinds[row.tint], `${row.tint} wears its scheme colour`);
    else assert.equal(style, palette.ink, "a row that names no primitive keeps the ink");
  });
  for (const kind of ["parallel", "single", "decide", "score", "render"]) {
    assert.ok(
      rows.some((row) => row.tint === kind),
      `the fixture shows a ${kind} stage`,
    );
  }
  assert.ok(
    rows.some((row) => row.tint === "alias"),
    "and a candidate under its seat",
  );
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

test("a rung the store saw but the config does not declare is named in the rows, never dropped", () => {
  // The rule the seats already followed, at rung level: the review route's own rungs (smrt-review,
  // review-quick, quick) live in the store, and a table built from the config alone reported their
  // history as no history at all.
  const stats = {
    fusion: "smrt-review",
    runs: 2,
    failures: 0,
    seats: 4,
    cascades: { total: 2, sufficient: 0, advanced: 2 },
    verifyChecks: 0,
    malformed: 0,
    marked: { located: 1, unlocated: 1 },
    cost: { reported: null, list: 0, estimated: 0 },
    lastRunAt: "2026-09-20T18:52:46",
  };
  const seat = { fusion: "smrt-review", persona: "judge", answered: {}, refusals: {}, degraded: 1, seats: 2, tokens: 10 };
  const config = { fusions: {}, modes: {}, aliases: {}, personas: {} };
  const rows = fusionRows({ config, fusionStats: [stats], seatStats: [], hasStore: true });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].fusion, "smrt-review");
  assert.equal(rows[0].runs, 2, "its numbers are its numbers");
  assert.equal(rows[0].unconfigured, true, "and the row says it is history, not a rung to run");

  // The tree shows it as a parent like any other, and its seats ride the seat rows' own rule.
  const tree = fusionTree({ config, fusionStats: [stats], seatStats: [seat], decideRows: [], hasStore: true });
  const parent = tree.find((row) => row.kind === "fusion");
  assert.equal(parent.runs, 2);
  assert.equal(parent.unconfigured, true);
  const seatRow = routeRows({ config, seatStats: [seat], hasStore: true }).find((row) => row.seat === "judge");
  assert.ok(seatRow, "the seats under an undeclared rung are shown too");
  assert.equal(seatRow.unconfigured, true);
});

test("a store that cannot load is named in the rows, never zeroed", () => {
  // The doctrine the store columns exist to keep: a rung the store saw zero times is `0`; a store
  // that could not load at all is `—`. omp's Bun has no node:sqlite, and the rows used to read 0.
  const rows = fusionRows({ config, fusionStats: [], seatStats: [], hasStore: false });
  assert.equal(rows[0].runs, "—");
  assert.equal(rows[0].seats, "—");
  assert.equal(rows[0].reportedUsd, null);
  const loaded = fusionRows({ config, fusionStats: [], seatStats: [] });
  assert.equal(loaded[0].runs, 0, "a loaded store that never saw the rung is an honest zero");

  // The whole surface, not one tab: the aliases rows name it, a structural tree row names it, and the
  // money/compact formatters read the marker as a marker (they guard non-finite — pinned here so a
  // formatter rewrite cannot quietly print $NaN in exactly the missing-store case).
  const alias = aliasRows({ config, modelStats: [], hasStore: false })[0];
  assert.equal(alias.seats, "—", "the aliases tab names it too");
  assert.equal(alias.refusals, "—");
  const folded = fusionTree({ config, fusionStats: [], seatStats: [], decideRows: [], hasStore: false });
  const expanded = Object.fromEntries(folded.filter((row) => row.kind === "fusion").map((row) => [row.id, true]));
  const open = fusionTree({ config, fusionStats: [], seatStats: [], decideRows: [], expanded, hasStore: false });
  const stageRow = open.find((row) => row.kind === "stage");
  assert.equal(stageRow.runs, "—", "a structural row cannot disagree with its fusion parent");
  const moneyColumn = columnsFor("fusions").find((column) => column.key === "listUsd");
  assert.equal(moneyColumn.format(rows[0]), "—", "the money formatter reads the marker as a marker");
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

test("the persona table joins each persona to its prompt, its knobs and the store — and opens into the seats it runs", () => {
  // Parents in name order, each prompt read the loader's way: one line is a path in its declaring
  // layer's directory, a run of lines is the text itself.
  const rows = personaRows({ config, seatStats, sources: {} });
  assert.deepEqual(
    rows.map((row) => row.persona),
    ["judge", "skeptic", "technical"],
    "parents in name order, and nothing open means no rows under them",
  );
  const [judge, skeptic, technical] = rows;
  assert.equal(judge.kind, "persona");
  assert.equal(judge.promptKind, "inline · 2 lines");
  assert.equal(judge.temperature, "—", "an unset knob is a dash on the row, never a missing field");
  assert.equal(judge.thinking, "—");
  assert.equal(judge.output, "—");
  assert.equal(judge.childCount, 1);
  assert.equal(judge.expanded, false);
  assert.equal(skeptic.promptKind, "inline · 2 lines");
  assert.equal(skeptic.thinking, "high");
  assert.equal(skeptic.temperature, "—");
  assert.equal(skeptic.output, "json");
  assert.equal(technical.promptKind, "file prompts/technical.md");
  assert.equal(technical.temperature, 0.2);
  assert.equal(technical.childCount, 2, "both fusions run this persona");

  // The store's numbers land on the persona as the sum over exactly the rows named for it.
  assert.equal(skeptic.runs, 1, "one store row ran this persona");
  assert.equal(skeptic.seats, 1);
  assert.equal(skeptic.degraded, 0);
  assert.equal(skeptic.tokens, 60, "raw on the row — compacting is the column's job");
  assert.equal(skeptic.last, "—", "a store row with no stamp reports none");
  assert.equal(judge.runs, 0);
  assert.equal(judge.seats, 0);
  assert.equal(judge.tokens, 0);
  assert.equal(judge.last, "—");

  // An empty prompt is empty text, not a file called nothing.
  assert.equal(personaRows({ config: { personas: { blank: { prompt: "" } } }, seatStats: [] })[0].promptKind, "inline · 0 lines");

  // Open one and its seats are rows under it: one per fusion that places the persona or names it.
  const open = personaRows({ config, seatStats, sources: {}, expanded: { technical: true, skeptic: true } });
  assert.deepEqual(
    open.map((row) => row.persona),
    ["judge", "skeptic", "  └ review", "technical", "  ├ quick", "  └ review"],
    "children follow their parent in fusion order, and the last one closes the tree",
  );
  const quick = open.find((row) => row.kind === "seat" && row.fusion === "quick");
  assert.equal(quick.kind, "seat");
  assert.equal(quick.parent, "technical");
  assert.equal(quick.seat, "technical", "the seat name is the persona — the alias picker's identity");
  assert.equal(quick.candidates, "kimi");
  assert.equal(quick.promptKind, "kimi", "a child's prompt column is what the seat walks");
  assert.equal(quick.walks, 1, "and the count beside the list");
  assert.equal(quick.refusals, "");
  for (const knob of ["temperature", "thinking", "output"]) assert.equal(quick[knob], "—", `a seat row claims no ${knob}`);
  assert.equal(quick.runs, 0, "no store row ran this seat");
  assert.equal(quick.seats, 0);
  assert.equal(quick.tokens, 0);
  assert.equal(quick.last, "—");

  const skepticSeat = open.find((row) => row.kind === "seat" && row.seat === "skeptic");
  assert.equal(skepticSeat.persona, "  └ review", "the first column carries the tree mark");
  assert.equal(skepticSeat.candidates, "muse");
  assert.equal(skepticSeat.promptKind, "muse");
  assert.equal(skepticSeat.walks, 1);
  assert.equal(skepticSeat.refusals, "opencode-go:quota×1 zai:transient×1");
  assert.equal(skepticSeat.runs, 1);
  assert.equal(skepticSeat.seats, 1);
  assert.equal(skepticSeat.degraded, 0);
  assert.equal(skepticSeat.tokens, 60);

  // A seat that walks several aliases reads the walk whole — the ordered list, arrowed — because
  // these are the routes tab's own rows seen from the persona.
  const twoWalk = personaRows({
    config: {
      ...config,
      fusions: {
        ...config.fusions,
        review: { ...config.fusions.review, candidates: { ...config.fusions.review.candidates, skeptic: ["kimi", "muse"] } },
      },
    },
    seatStats,
    sources: {},
    expanded: { skeptic: true },
  }).find((row) => row.kind === "seat");
  assert.equal(twoWalk.candidates, "kimi → muse");
  assert.equal(twoWalk.walks, 2);

  // Every column draws from every row, parents and children alike.
  for (const row of open) {
    for (const column of columnsFor("personas")) {
      const value = column.format ? column.format(row) : row[column.key];
      assert.notEqual(value, undefined, `${row.persona} carries ${column.key}`);
    }
  }
  assert.deepEqual(
    columnsFor("personas").map((column) => column.label),
    ["persona", "prompt", "temperature", "thinking", "output", "runs", "seats", "degraded", "tokens"],
  );
  assert.deepEqual(
    columnsFor("personas").map((column) => column.key),
    ["persona", "promptKind", "temperature", "thinking", "output", "runs", "seats", "degraded", "tokens"],
  );
  assert.equal(
    columnsFor("personas")
      .find((column) => column.key === "tokens")
      .format({ tokens: 2500 }),
    "2.5k",
    "the column compacts what the row keeps raw",
  );

  // A persona in two fusions: the parent is the sum of the store rows its children each hold a slice
  // of, and the stamp it carries is the newest of them.
  const stamp = [
    {
      fusion: "quick",
      persona: "technical",
      seats: 2,
      degraded: 1,
      tokens: 60,
      seatMs: 100,
      reportedUsd: 0,
      unpricedSeats: 0,
      answered: {},
      refusals: {},
      lastSeatAt: "2026-09-21T03:05:41.427Z",
    },
    {
      fusion: "review",
      persona: "technical",
      seats: 3,
      degraded: 0,
      tokens: 40,
      seatMs: 100,
      reportedUsd: 0,
      unpricedSeats: 0,
      answered: {},
      refusals: {},
      lastSeatAt: "2026-09-20T19:31:00.000Z",
    },
  ];
  const summed = personaRows({ config, seatStats: stamp, sources: {}, expanded: { technical: true } });
  const parent = summed.find((row) => row.kind === "persona" && row.persona === "technical");
  assert.equal(parent.runs, 2);
  assert.equal(parent.seats, 5);
  assert.equal(parent.degraded, 1);
  assert.equal(parent.tokens, 100);
  assert.equal(parent.last, "2026-09-21 03:05", "the newest stamp, cut to the minute");
  const [quickSlice, reviewSlice] = summed.filter((row) => row.kind === "seat");
  assert.equal(quickSlice.fusion, "quick");
  assert.equal(quickSlice.seats, 2, "a child is its own slice, never the parent's totals again");
  assert.equal(quickSlice.degraded, 1);
  assert.equal(quickSlice.tokens, 60);
  assert.equal(quickSlice.runs, 1);
  assert.equal(quickSlice.last, "2026-09-21 03:05");
  assert.deepEqual(
    [reviewSlice.fusion, reviewSlice.seats, reviewSlice.degraded, reviewSlice.tokens, reviewSlice.last],
    ["review", 3, 0, 40, "2026-09-20 19:31"],
  );
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
  assert.equal(applyKey(world, "1").state.tab, "fusions");
  assert.equal(applyKey(world, "2").state.tab, "aliases");
  assert.equal(applyKey(world, "3").state.tab, "personas");
  assert.equal(applyKey(applyKey(world, "3").state, "2").state.tab, "aliases", "and back to the first");
  for (const key of ["tab", "shift-tab", "h", "l", "left", "right"]) {
    assert.equal(applyKey(world, key).state.tab, "aliases", `${key} walks the rows, not the tabs`);
  }

  assert.equal(applyKey(world, "a").state.rain, false, "the rain toggles off");
  assert.equal(applyKey(applyKey(world, "a").state, "a").state.rain, true, "and on again");
  assert.equal(applyKey(world, "c").state.color, false);
  assert.equal(applyKey(world, "?").state.help, true);
  assert.equal(applyKey(world, "q").effect, "quit");
  assert.equal(applyKey(world, "escape").effect, "quit", "escape at the root is the way out");
  assert.equal(applyKey(world, "r").effect, "reload");
  assert.equal(applyKey(world, "R").effect, "reingest");
  const treeEdit = applyKey({ ...state(), tab: "fusions" }, "e");
  assert.equal(treeEdit.effect, "none", "the fusions tab opens its row's editor");
  assert.ok(treeEdit.state.picker, "a fusion row edits through its own dropdown");
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
  const elsewhere = applyKey(open, "3").state;
  for (const key of ["tab", "shift-tab", "h", "l", "left", "right"]) {
    const same = applyKey(elsewhere, key).state;
    assert.equal(same.tab, "personas", `${key} keeps its hands off the tab`);
    assert.equal(same.cursors.personas, elsewhere.cursors.personas, "and the persona rows stay put");
  }
});

test("the numbers 1-3 name the three tabs, and the row keys never hop between them", () => {
  assert.deepEqual(TABS, ["fusions", "aliases", "personas"]);
  const world = editState();
  assert.equal(treeState().tab, "fusions", "the reader starts on the first tab");
  for (const [index, tab] of TABS.entries()) {
    assert.equal(applyKey(world, String(index + 1)).state.tab, tab, `${index + 1} opens ${tab}`);
  }
  assert.equal(applyKey(applyKey(world, "3").state, "2").state.tab, "aliases", "and back to the second");

  // The personas tab takes its own row keys and nothing that walks between tabs.
  const personas = { ...world, tab: "personas" };
  assert.equal(applyKey(personas, "j").state.cursors.personas, 1, "j walks the persona rows");
  assert.equal(applyKey(personas, "4").state.tab, "personas", "there is no fourth tab");
  for (const key of ["tab", "shift-tab", "h", "l", "left", "right"]) {
    assert.equal(applyKey(personas, key).state.tab, "personas", `${key} walks the rows, not the tabs`);
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

test("escape is the way back — a picker, a proposal, a child row, an open list — and at the root it is the way out", () => {
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

  // (4) an open list under the cursor is closed; (5) a closed one has nothing left to step back
  // through — so at the root, back is out.
  const closed = applyKey(open, "escape").state;
  assert.equal(selected(closed).expanded, false);
  assert.equal(closed.cursors.aliases, open.cursors.aliases, "the cursor stays on the alias");
  assert.equal(applyKey(closed, "escape").effect, "quit", "at the root, back is out");

  // Whatever else it means, escape never means quit — and `q`, outside a picker, still does.
  // Somewhere to go is never a quit — and at the root, back is out.
  for (const s of [open, proposed, climbed, picker, { ...editState(), help: true }]) {
    assert.notEqual(applyKey(s, "escape").effect, "quit", "a step back is not a quit");
  }
  for (const s of [editState(), closed]) {
    assert.equal(applyKey(s, "escape").effect, "quit", "at the root, back is out");
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
  const row = { fusion: "review-check", seat: "review-skeptic", candidates: "glm" };
  const pending = proposeSeatAlias({ state: world, row, alias: "mimo" });
  assert.deepEqual(
    pending.patch,
    { fusions: { "review-check": { candidates: { "review-skeptic": ["mimo"] } } } },
    "only the changed path is written",
  );
  assert.equal(pending.layerFile, "/tmp/nowhere/pi-fusion-matrix.json");
  assert.match(pending.summary, /review-check\.review-skeptic walks mimo/);
  assert.deepEqual(pending.errors, [], "a real alias is a valid change");

  // A change the loader refuses is refused here, with the loader's own message, before any write.
  const invalid = proposeSeatAlias({ state: world, row, alias: "no-such-alias" });
  assert.ok(invalid.errors.length > 0, "an unknown alias is refused");
  assert.match(invalid.errors.join("\n"), /no-such-alias/);

  // And the validation is the loader's, not a second opinion: a patch that breaks a rule reports it.
  assert.ok(validateAgainst(world, { fusions: { "review-check": { candidates: { "review-skeptic": ["ghost"] } } } }).length > 0);
  assert.deepEqual(validateAgainst(world, {}), []);
});

test("a prompt that reads as a bad path is refused by the loader's own rule", () => {
  // A single-line prompt is path-shaped; one that resolves to nothing is a load error the editor must
  // surface — before this, both TUI gates dropped the loader's `sources` and the rule never ran, so a
  // poison layer wrote clean and broke every later load.
  const world = { ...state(), layerFile: "/tmp/tui-prompt/pi-fusion-matrix.json" };
  const errors = validateAgainst(world, { personas: { ghost: { prompt: "does-not-exist.md" } } });
  assert.ok(
    errors.some((error) => /ghost/.test(error) && /does-not-exist\.md/.test(error)),
    JSON.stringify(errors),
  );
  // Multi-line is inline text and stays legal (the fixture config carries unrelated gaps of its own,
  // so the assertion is about this persona's errors only).
  const inline = validateAgainst(world, { personas: { ghost: { prompt: "line one\nline two" } } });
  assert.ok(!inline.some((error) => /ghost/.test(error)), JSON.stringify(inline));
});

test("a base persona's prompt file lands beside the layer it saves, and the save validates it there", () => {
  // The write and the validation resolve one directory: the layer being written is the persona's new
  // declaring layer, so its prompt path resolves beside it — and a planned write counts as existing.
  // A knob-only restatement plans the write too (the file is not there yet), so it is saveable.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tui-base-persona-"));
  const world = {
    ...personaState({ layerFile: path.join(dir, "pi-fusion-matrix.json"), layerConfig: {}, baseConfig: personaConfig }),
    sources: { personas: { technical: { file: "/packaged/matrix.json", dir: "/packaged", kind: "packaged", trusted: true } } },
  };
  const moved = proposePersonaSave({
    state: world,
    name: "technical",
    draft: draftFor("technical", { promptFile: "prompts/technical.md", text: "moved\nhere" }),
    originalText: "as loaded",
  });
  assert.deepEqual(moved.promptWrites, [{ file: path.join(dir, "prompts", "technical.md"), text: "moved\nhere" }]);
  assert.deepEqual(moved.errors, [], JSON.stringify(moved.errors));

  const knobbed = proposePersonaSave({
    state: world,
    name: "technical",
    draft: draftFor("technical", { promptFile: "prompts/technical.md", text: "as loaded" }),
    originalText: "as loaded",
  });
  assert.deepEqual(
    knobbed.promptWrites,
    [{ file: path.join(dir, "prompts", "technical.md"), text: "as loaded" }],
    "a knob-only restatement still lands the file beside the layer",
  );
  assert.deepEqual(knobbed.errors, [], JSON.stringify(knobbed.errors));
  fs.rmSync(dir, { recursive: true, force: true });
});

test("the picker proposes, and escape or q steps back out of it", () => {
  const world = { ...state(), tab: "fusions" };
  const opened = { ...world, picker: { title: "t", options: ["a", "b"], cursor: 0, pending: (alias) => ({ summary: alias, patch: {} }) } };
  const moved = applyKey(opened, "j").state;
  assert.equal(moved.picker.cursor, 1);
  const chosen = applyKey(moved, "return");
  assert.equal(chosen.state.picker, null);
  assert.equal(chosen.state.pending.summary, "b", "the highlighted option is the proposal");
  assert.equal(chosen.effect, "save", "choosing is the modal's submit: it stages and asks for the write");
  assert.equal(applyKey(opened, "escape").state.picker, null, "escape closes the picker and nothing more");
  assert.equal(applyKey(opened, "escape").state.pending, null, "…with nothing staged");
  const backedOut = applyKey(opened, "q");
  assert.equal(backedOut.state.picker, null, "q is a way back while a picker is open");
  assert.notEqual(backedOut.effect, "quit", "…not a quit");
  const untouched = applyKey(opened, "2");
  assert.equal(untouched.state.picker.cursor, 0, "nothing else is handled while the picker is open");
  assert.equal(untouched.state.tab, "fusions", "not even the tab keys");
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
  const flatWorld = (() => {
    const base = applyKey({ ...editState(), tab: "fusions" }, "return").state;
    const at = base.rows.fusions.findIndex((row) => row.id !== undefined && !["candidate", "fusion", "choice"].includes(row.kind));
    return { ...base, cursors: { ...base.cursors, fusions: at } };
  })();
  for (const world of [expandedOn(editState(), "trio"), flatWorld]) {
    for (const key of ["K", "J", "d"]) {
      const result = applyKey(world, key);
      assert.equal(result.effect, "none", `${key} proposes nothing here`);
      assert.equal(result.state.pending, null);
      assert.equal(result.state.picker, null);
      assert.match(result.state.message, /K\/J/);
      assert.match(result.state.message, /\bd\b/);
    }
  }

  // On a tree row with nothing to add, `n` is just the words — and no prompt opens.
  const flat = applyKey(flatWorld, "n");
  assert.equal(flat.effect, "none");
  assert.equal(flat.state.input, null, "a stage row has no name prompt");
  assert.equal(flat.state.pending, null);
  assert.match(flat.state.message, /adds a fusion, a choice, or a candidate/);
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
  const defaultless = {
    ...buildState({
      config: editConfig,
      baseConfig: editConfig,
      layerConfig: {},
      layerFile: "/tmp/nowhere/pi-fusion-matrix.json",
    }),
    tab: "aliases",
  };
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
  // a refusal and a loader complaint — are walked the way the picker fixtures walk their choices, each
  // commit handing back the proposal itself (an outcome is a proposal when it has its patch).
  const building = (commit) => builderOn(editState(), { routes: [{ id: "zai", model: "glm-5" }], commit });

  const refused = applyKey(
    building(() => ({
      listOf: "kimi",
      layerFile: "/tmp/nowhere/x.json",
      patch: {},
      summary: "kimi changes nothing",
      errors: [],
      saveable: false,
    })),
    "s",
  );
  assert.equal(refused.effect, "save", "a submitted proposal is a save request whatever its verdict");
  assert.equal(refused.state.pending.saveable, false, "even a refusal is kept pending");
  assert.equal(refused.state.builder, null);
  assert.equal(refused.state.message, "kimi changes nothing", "and its summary is the message");

  const complained = applyKey(
    building(() => ({ listOf: "kimi", layerFile: "/tmp/nowhere/x.json", patch: {}, summary: "kimi now tries zai", errors: ["boom"] })),
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

/* ---------------------------------------------------------------- personas */

test("n names a new persona: the prompt refuses a blank and a collision, and a fresh name opens the editor", () => {
  const world = personaState();
  const asked = applyKey({ ...world, tab: "personas" }, "n");
  assert.equal(asked.effect, "none");
  assert.ok(asked.state.input, "the chain starts with a name prompt");
  assert.equal(asked.state.input.title, "new persona");
  assert.equal(asked.state.input.value, "");
  assert.equal(asked.state.input.hint, "type the persona name · enter continues · esc back");
  assert.equal(asked.state.input.back, null, "the first step has nowhere to go back to");
  assert.equal(asked.state.editor, null);
  assert.equal(asked.state.pending, null, "asking is not yet proposing");

  // A blank name is refused, and a name that exists is never clobbered — both times the prompt stays
  // open over its typing with the refusal for a message.
  const blank = applyKey(asked.state, "return");
  assert.equal(blank.effect, "none", "a blank name writes nothing");
  assert.ok(blank.state.input, "the prompt stays open");
  assert.equal(blank.state.message, "a persona needs a name");
  assert.equal(blank.state.pending, null, "a refusal stages nothing");
  const collide = applyKey(applyKey(asked.state, "technical").state, "return");
  assert.equal(collide.effect, "none");
  assert.ok(collide.state.input, "the prompt stays open");
  assert.equal(collide.state.message, "technical already exists");
  assert.equal(collide.state.input.value, "technical", "the typing survives the refusal");
  assert.equal(collide.state.pending, null);

  // A fresh name walks into the editor — and lands in the editor's slot, never another modal's.
  const named = applyKey(applyKey(asked.state, "nova").state, "return");
  assert.equal(named.effect, "none");
  assert.equal(named.state.input, null, "the name step is done");
  assert.equal(named.state.builder, null, "an editor is not a builder whatever functions it carries");
  assert.equal(named.state.textarea, null);
  const editor = named.state.editor;
  assert.ok(editor, "the chain continues into the editor");
  assert.equal(editor.title, "new persona", "the create chain's editor carries the name step's own title");
  assert.equal(editor.draft.name, "nova");
  assert.equal(editor.draft.promptFile, "", "a fresh persona starts as inline text");
  assert.equal(editor.draft.text, "");
  assert.equal(editor.draft.temperature, undefined);
  assert.equal(editor.draft.thinking, undefined);
  assert.equal(editor.draft.output, undefined);
  assert.equal(editor.originalText, "");
  assert.equal(editor.cursor, 0);
  assert.equal(typeof editor.commit, "function", "`s` knows what to submit");

  // `s` on the editor is the write: the draft becomes the proposal and is saved in the same breath.
  const saved = applyKey(named.state, "s");
  assert.equal(saved.effect, "save", "submit-saves");
  assert.equal(saved.state.editor, null);
  assert.equal(saved.state.pending.listOf, "personas:nova");
  assert.deepEqual(saved.state.pending.patch.personas.nova, { prompt: "" }, "the inline text is the prompt; unset knobs stay unset");
  assert.equal(saved.state.pending.summary, "nova saved (inline prompt · 0 lines)");

  // Esc from the editor is back to the step that opened it, its typing intact — the draft is simply
  // gone, because nothing was written.
  const back = applyKey(named.state, "escape");
  assert.equal(back.effect, "none", "escape is back, never a way out");
  assert.equal(back.state.editor, null);
  assert.equal(back.state.input.title, "new persona", "back is the name step it opened over");
  assert.equal(back.state.input.value, "nova", "typed and all");
  assert.equal(back.state.pending, null, "stepping back stages nothing");
});

test("the editor walks its five field rows and paints them, and every other key in it is inert", () => {
  const world = editorOn(personaState());
  // j/k and the arrows walk the field rows and hold at either end.
  assert.equal(world.editor.cursor, 0);
  assert.equal(applyKey(world, "j").state.editor.cursor, 1);
  assert.equal(applyKey(world, "down").state.editor.cursor, 1, "`down` walks with `j`");
  const walked = ["j", "j", "j", "j"].reduce((next, key) => applyKey(next, key).state, world);
  assert.equal(walked.editor.cursor, 4, "five fields, and the bottom holds");
  assert.equal(applyKey(applyKey(world, "j").state, "k").state.editor.cursor, 0, "and so does the top");
  assert.equal(applyKey(world, "up").state.editor.cursor, 0);

  // `s` hands over the draft exactly as it stands, and an error outcome is the refusal: the editor
  // stays open over its draft with the refusal for a message.
  let submitted = null;
  const refusing = editorOn(personaState(), {
    commit: (draft) => {
      submitted = draft;
      return { error: "not today" };
    },
  });
  const refused = applyKey(refusing, "s");
  assert.equal(refused.effect, "none");
  assert.equal(refused.state.editor.title, "skeptic", "the editor stays open");
  assert.equal(refused.state.message, "not today");
  assert.equal(submitted.text, "one\ntwo", "`s` submits the draft as it stands");
  assert.equal(submitted.name, "skeptic");

  // Esc is back — a directly opened editor has nowhere to step back to — and ctrl-c is the way out.
  const back = applyKey(world, "escape");
  assert.equal(back.effect, "none", "escape is back, never a way out");
  assert.equal(back.state.editor, null);
  assert.equal(back.state.input, null, "a directly opened editor has nowhere to step back to");
  assert.equal(applyKey(world, "ctrl-c").effect, "quit");

  // Every other key is the outside world trying to leak in — `q` included, and the tab numbers too.
  for (const key of ["q", "1", "2", "3", "4", "n", "e", "d", "J", "K", "g", "G", "?", "a", "c", "r", "R"]) {
    const same = applyKey(world, key);
    assert.equal(same.effect, "none", `${key} leaks nothing into the editor`);
    assert.deepEqual({ ...same.state, message: "" }, { ...world, message: "" }, `${key} changes nothing`);
  }

  // And the frame names the five fields and what the draft holds on each.
  const frame = frameFor({ width: 120, height: 24, state: world, palette: paletteFor({ color: false }), clock: "" });
  const text = Array.from({ length: 24 }, (_, row) => gridLine(frame, row)).join("\n");
  assert.match(text, /prompt file/, "the five fields name themselves");
  assert.match(text, /inline · 2 lines/, "the prompt row reads its draft");
  assert.match(text, /\(inline\)/, "and the file row says there is no file");
  assert.match(text, /temperature/);
  assert.match(text, /thinking/);
  assert.match(text, /output/);
});

test("the prompt field opens the textarea, and esc applies its text back into the draft", () => {
  const world = editorOn(personaState());
  const opened = applyKey(world, "return"); // the cursor is on "prompt"
  assert.equal(opened.effect, "none");
  assert.ok(opened.state.textarea, "the prompt is edited as text");
  assert.equal(opened.state.editor, null, "the editor waits in the textarea's back");
  assert.deepEqual(opened.state.textarea.lines, ["one", "two"], "seeded from the draft text");
  assert.equal(opened.state.textarea.back.draft.text, "one\ntwo", "back is the editor state it opened over");

  // The caret walks to the front deterministically — up holds at row 0, left at column 0 — and the
  // typing lands there. Esc is "done with this field": the lines join back into the draft.
  const at = ["up", "up", "left", "left", "left", "left"].reduce((next, key) => applyKey(next, key).state, opened.state);
  assert.deepEqual([at.textarea.row, at.textarea.col], [0, 0]);
  const applied = applyKey(applyKey(at, "zai").state, "escape");
  assert.equal(applied.effect, "none");
  assert.equal(applied.state.textarea, null);
  const editor = applied.state.editor;
  assert.equal(editor.draft.text, "zaione\ntwo", "the run was inserted at the caret and the lines joined back");
  assert.equal(editor.originalText, "one\ntwo", "change detection keeps what was loaded");
  assert.equal(editor.cursor, 0, "the editor is back on the field it opened");
  assert.equal(typeof editor.commit, "function", "…with its commit intact");
  assert.equal(editor.title, "skeptic");
});

test("the textarea types runs, splits and joins its lines, clamps its caret — and esc is done", () => {
  const world = personaState();
  const base = () => textareaOn(world);

  // Typing inserts at the caret; a paste arrives as one chunk and lands as one run.
  const typed = applyKey(base(), "zai").state.textarea;
  assert.deepEqual(typed.lines, ["onezai", "two"]);
  assert.deepEqual([typed.row, typed.col], [0, 6]);
  assert.deepEqual(applyKey(base(), "cline-pass").state.textarea.lines, ["onecline-pass", "two"], "a paste arrives whole and lands whole");
  assert.deepEqual(applyKey(base(), "q").state.textarea.lines, ["oneq", "two"], "`q` is text in here, like every other printable");

  // Return splits the line at the caret, and the caret goes to the start of what it left behind.
  const split = applyKey(base(), "return").state.textarea;
  assert.deepEqual(split.lines, ["one", "", "two"]);
  assert.deepEqual([split.row, split.col], [1, 0]);
  const midSplit = applyKey(textareaOn(world, { row: 0, col: 1 }), "return").state.textarea;
  assert.deepEqual(midSplit.lines, ["o", "ne", "two"]);
  assert.deepEqual([midSplit.row, midSplit.col], [1, 0]);

  // Backspace deletes left, and at column 0 it joins the line to the one above it.
  const deleted = applyKey(base(), "backspace").state.textarea;
  assert.deepEqual(deleted.lines, ["on", "two"]);
  assert.deepEqual([deleted.row, deleted.col], [0, 2]);
  const joined = applyKey(textareaOn(world, { row: 1, col: 0 }), "backspace").state.textarea;
  assert.deepEqual(joined.lines, ["onetwo"], "the join is the newline's deletion");
  assert.deepEqual([joined.row, joined.col], [0, 3], "the caret sits where the two lines met");
  const nothing = applyKey(textareaOn(world, { row: 0, col: 0 }), "backspace").state.textarea;
  assert.deepEqual(nothing.lines, ["one", "two"], "a caret at the very start has nothing to take");
  assert.deepEqual([nothing.row, nothing.col], [0, 0]);

  // The caret moves and clamps: never off a line, never off the text.
  const up = applyKey(textareaOn(world, { lines: ["a", "longer"], row: 1, col: 7 }), "up").state.textarea;
  assert.deepEqual([up.row, up.col], [0, 1], "a longer column clamps to the shorter line");
  const down = applyKey(textareaOn(world, { lines: ["ab", "xy"], row: 0, col: 1 }), "down").state.textarea;
  assert.deepEqual([down.row, down.col], [1, 1]);
  assert.deepEqual(
    [applyKey(base(), "down").state.textarea.row, applyKey(base(), "down").state.textarea.col],
    [1, 3],
    "the column clamps to the line below",
  );
  assert.deepEqual(
    [applyKey(base(), "down").state.textarea.row, applyKey(textareaOn(world, { row: 1 }), "down").state.textarea.row],
    [1, 1],
    "the bottom holds",
  );
  assert.deepEqual(
    [applyKey(base(), "right").state.textarea.row, applyKey(base(), "right").state.textarea.col],
    [0, 3],
    "the end of a line holds",
  );
  assert.deepEqual([applyKey(textareaOn(world, { row: 0, col: 0 }), "left").state.textarea.col], [0], "and the start");

  // Tab stands still while text is being typed.
  for (const key of ["tab", "shift-tab"]) {
    const same = applyKey(base(), key).state.textarea;
    assert.deepEqual(same.lines, ["one", "two"], `${key} types nothing`);
    assert.deepEqual([same.row, same.col], [0, 3], `${key} moves nothing`);
  }

  // Esc is "done with this field": it applies the lines joined back through the usual outcome
  // routing — and ctrl-c is still the one way out of everything.
  let appliedText = null;
  const done = textareaOn(world, {
    apply: (text) => {
      appliedText = text;
      return { error: "stop there" };
    },
  });
  const escaped = applyKey(applyKey(done, "zai").state, "escape");
  assert.equal(appliedText, "onezai\ntwo", "what the lines hold, joined");
  assert.equal(escaped.state.message, "stop there", "and its outcome travels the usual routing");
  assert.ok(escaped.state.textarea, "an error outcome keeps the field open");
  assert.equal(applyKey(base(), "ctrl-c").effect, "quit");
});

test("the temperature field takes a number in 0..2, refuses the rest, and an empty answer clears it", () => {
  // Open the field's input, empty whatever it was seeded with, then type the answer whole.
  const answer = (world, text) => {
    const opened = applyKey(world, "return");
    assert.ok(opened.state.input, "the number is typed, not picked");
    assert.equal(opened.state.editor, null);
    let next = opened.state;
    for (let i = 0; i < 8; i += 1) next = applyKey(next, "backspace").state;
    return text === "" ? applyKey(next, "return") : applyKey(applyKey(next, text).state, "return");
  };
  const at = () => editorOn(personaState(), { cursor: 2 });

  for (const text of ["3", "-1", "2.5", "many"]) {
    const refused = answer(at(), text);
    assert.equal(refused.effect, "none");
    assert.equal(refused.state.message, "temperature must be a number in 0..2", `${text} is not in 0..2`);
    assert.ok(refused.state.input, "the prompt stays open over its typing");
    assert.equal(refused.state.editor, null, "and nothing lands in the draft");
  }
  for (const [text, value] of [
    ["0.7", 0.7],
    ["0", 0],
    ["2", 2],
  ]) {
    const set = answer(at(), text);
    assert.equal(set.state.input, null);
    assert.equal(set.state.editor.draft.temperature, value, `${text} is in 0..2`);
    assert.equal(set.state.editor.cursor, 2, "the editor is back on the field it opened");
    assert.equal(set.state.editor.draft.name, "skeptic", "and it is the same editor");
  }

  // An empty answer is not a zero — it is "no temperature", and the knob leaves the draft.
  const cleared = answer(editorOn(personaState(), { cursor: 2, draft: draftFor("skeptic", { temperature: 0.7 }) }), "");
  assert.equal(cleared.state.input, null);
  assert.equal(cleared.state.editor.draft.temperature, undefined, "an empty answer clears the knob back out");
});

test("the thinking and output fields pick from a dropdown that sets the draft and clears it back", () => {
  // The thinking levels are the loader's own under an empty first option labelled `(inherit)`, and
  // output is the same dropdown over its two values: choosing sets the knob, choosing the first
  // option clears it.
  const opened = applyKey(editorOn(personaState(), { cursor: 3 }), "return");
  assert.ok(opened.state.picker, "thinking is picked, never typed");
  assert.equal(opened.state.editor, null);
  assert.deepEqual(opened.state.picker.options, ["", ...THINKING_LEVELS]);

  const set = pick(opened.state, "high");
  assert.equal(set.state.picker, null);
  assert.equal(set.state.editor.draft.thinking, "high");
  assert.equal(set.state.editor.cursor, 3, "the editor is back on the field it opened");
  assert.equal(set.state.editor.draft.name, "skeptic");
  const seeded = applyKey(editorOn(personaState(), { cursor: 3, draft: draftFor("skeptic", { thinking: "high" }) }), "return");
  const cleared = pick(seeded.state, "");
  assert.equal(cleared.state.picker, null);
  assert.equal(cleared.state.editor.draft.thinking, undefined, "the first option is (inherit): it clears");

  const output = applyKey(editorOn(personaState(), { cursor: 4 }), "return");
  assert.ok(output.state.picker);
  assert.deepEqual(output.state.picker.options, ["", "text", "json"]);
  assert.equal(pick(output.state, "json").state.editor.draft.output, "json");
  assert.equal(pick(output.state, "").state.editor.draft.output, undefined, "and clears the same way");
});

test("a chained outcome lands in the slot its shape names — an editor is an editor, never a builder", () => {
  // The chain outcome says `{ modal: … }` now (it used to say `{ input: … }`, and anything carrying
  // a `commit` fell into the builder's slot): each modal is routed by its own shape.
  const world = personaState();
  const through = (modal) =>
    applyKey({ ...world, input: { title: "new persona", value: "nova", hint: "", back: null, submit: () => ({ modal }) } }, "return");
  const routed = through(editorOn(world).editor);
  assert.equal(routed.effect, "none", "a chained step is not a save");
  assert.equal(routed.state.input, null, "the typing step is done");
  assert.equal(routed.state.editor.title, "skeptic", "an editor outcome is routed to the editor");
  assert.equal(routed.state.builder, null, "its commit does not make it a builder any more");
  assert.equal(routed.state.textarea, null);

  const builderModal = through(builderOn(world).builder).state;
  assert.ok(builderModal.builder, "commit and a tree is a builder");
  assert.equal(builderModal.editor, null);
  const inputModal = through({ title: "second", value: "x", hint: "", back: null, submit: () => ({ error: "never reached" }) }).state;
  assert.equal(inputModal.input.title, "second", "submit and a value is another input");
  assert.equal(inputModal.editor, null);

  // The refusal outcome keeps the modal open over its typing with the refusal for a message.
  const refused = applyKey(
    { ...world, input: { title: "new persona", value: "nova", hint: "", back: null, submit: () => ({ error: "not this name" }) } },
    "return",
  );
  assert.equal(refused.effect, "none");
  assert.equal(refused.state.message, "not this name");
  assert.equal(refused.state.input.title, "new persona", "the prompt stays open");
  assert.equal(refused.state.input.value, "nova", "over its typing");
});

test("on the personas tab enter opens a persona's seats, e edits it, and a seat re-points through the routes picker", () => {
  const world = { ...personaState(), tab: "personas" };
  const labels = (result) => result.state.rows.personas.map((row) => row.persona);

  // Enter toggles the seats open under the cursor's persona, and the cursor stays on the parent.
  const parent = personaParent(world, "technical");
  assert.equal(parent.childCount, 2);
  const opened = applyKey(personaCursorOn(world, parent), "return");
  assert.equal(opened.effect, "none");
  assert.deepEqual(labels(opened), ["judge", "skeptic", "technical", "  ├ quick", "  └ review"]);
  assert.equal(selected(opened.state).persona, "technical", "the cursor stays on the parent it opened");
  assert.equal(selected(opened.state).expanded, true);
  const closed = applyKey(opened.state, "return");
  assert.deepEqual(labels(closed), ["judge", "skeptic", "technical"], "and enter shuts it again");
  assert.equal(selected(closed.state).persona, "technical");

  // `e` on a parent is the edit: the editor seeded from the persona — its prompt file where the
  // prompt is a path, its text what that file holds.
  const edited = applyKey(personaCursorOn(world, parent), "e");
  assert.equal(edited.effect, "none", "the editor opens over the table, proposing nothing yet");
  assert.equal(edited.state.pending, null);
  const seeded = edited.state.editor;
  assert.equal(seeded.title, "technical");
  assert.equal(seeded.draft.promptFile, "prompts/technical.md", "a path prompt is its file");
  assert.equal(seeded.draft.text, "", "and its text is what the file holds — nothing, here");
  assert.equal(seeded.originalText, "");
  assert.equal(seeded.draft.temperature, 0.2);
  assert.equal(seeded.draft.thinking, undefined);

  // An inline prompt seeds its text whole and knows it has no file.
  const inline = applyKey(personaCursorOn(world, personaParent(world, "skeptic")), "e");
  assert.equal(inline.state.editor.draft.promptFile, "");
  assert.equal(inline.state.editor.draft.text, "find the flaw in it\nand name it plainly");
  assert.equal(inline.state.editor.originalText, inline.state.editor.draft.text);
  assert.equal(inline.state.editor.draft.thinking, "high");

  // A seat row's `e` (and its enter) re-points it through the routes tab's own picker and proposer —
  // never a second one — and choosing is the modal's submit.
  const seat = personaSeat(opened.state, "technical", "quick");
  for (const key of ["e", "enter"]) {
    const asked = applyKey(personaCursorOn(opened.state, seat), key);
    assert.equal(asked.effect, "propose", "the driver opens the picker, as on the routes tab");
    assert.equal(asked.state.pending, null, "asking is not yet proposing");
  }
  const viaChild = proposeFor(applyKey(personaCursorOn(opened.state, seat), "e").state);
  assert.equal(viaChild.picker.title, "quick.technical: point at");
  assert.deepEqual(viaChild.picker.options, ["kimi", "kimiAlias", "muse", "trio"], "the alias dropdown, and only that");
  const chosen = pick(viaChild, "muse");
  assert.equal(chosen.effect, "save", "choosing is the modal's submit");
  assert.deepEqual(chosen.state.pending.patch, {
    personas: personaLayer.personas,
    fusions: { quick: { candidates: { technical: ["muse"] } } },
  });
  assert.match(chosen.state.pending.summary, /quick\.technical walks muse \(was kimi\)/);

  // …and it is exactly the proposal the seat's own proposer stages for the same seat.
  const direct = proposeSeatAlias({
    state: personaState(),
    row: { fusion: "quick", seat: "technical", candidates: "kimi" },
    alias: "muse",
  });
  assert.deepEqual(chosen.state.pending.patch, direct.patch, "the same proposal — the seats re-use the proposer whole");

  // `d` on a parent stages its removal — the two-step, gated by the loader's verdict — and on a seat
  // row it names `e` instead.
  const dropped = applyKey(personaCursorOn(world, personaParent(world, "technical")), "d");
  assert.equal(dropped.state.pending.listOf, "personas:technical");
  assert.equal(dropped.state.pending.summary, "persona technical dropped");
  assert.equal(applyKey(dropped.state, "s").effect, "none", "the modes still name the persona, so the loader refuses the write");
  assert.match(applyKey(dropped.state, "s").state.message, /refused: .*unknown persona "technical"/);
  const refused = applyKey(personaCursorOn(world, personaParent(world, "judge")), "d");
  assert.equal(refused.state.pending.saveable, false, "a base persona is a named refusal, never a silent no-op");
  assert.equal(refused.state.message, refused.state.pending.summary);
  const onSeat = applyKey(personaCursorOn(opened.state, seat), "d");
  assert.equal(onSeat.effect, "none");
  assert.equal(onSeat.state.pending, null, "a seat is not a thing to drop");
  assert.match(onSeat.state.message, /\be\b/);
  assert.match(onSeat.state.message, /alias/, "the message names the key that does something here");

  // A removal the loader does accept is staged by `d` and written by `s`.
  const withScratch = {
    ...personaState({
      config: { ...personaConfig, personas: { ...personaConfig.personas, scratch: { prompt: "an itch\nand its scratch" } } },
    }),
    tab: "personas",
  };
  const staged = applyKey(personaCursorOn(withScratch, personaParent(withScratch, "scratch")), "d");
  assert.equal(staged.state.pending.summary, "persona scratch dropped");
  assert.deepEqual(staged.state.pending.errors, [], "nothing names it, so the loader has nothing to say");
  assert.equal(applyKey(staged.state, "s").effect, "save", "s writes the staged removal");
});

test("proposePersonaSave restates the persona in its layer, and names a prompt file only when its text moved", () => {
  const world = personaState();

  // CREATE: a name the display config does not hold yet — the inline text is the prompt, and unset
  // knobs stay unset rather than being written as anything.
  const created = proposePersonaSave({ state: world, name: "nova", draft: draftFor("nova"), originalText: "" });
  assert.equal(created.listOf, "personas:nova");
  assert.equal(created.layerFile, personaLayerFile);
  assert.deepEqual(created.patch.personas.nova, { prompt: "one\ntwo" });
  assert.deepEqual(created.patch.personas.technical, personaLayer.personas.technical, "the layer's other personas travel with the patch");
  assert.deepEqual(created.errors, [], "the loader accepts it");
  assert.equal(created.summary, "nova saved (inline prompt · 2 lines)");
  assert.equal(created.promptWrites, undefined, "an inline prompt has no file to write");

  const knobs = proposePersonaSave({
    state: world,
    name: "nova",
    draft: draftFor("nova", { text: "x", temperature: 0.7, thinking: "high", output: "json" }),
    originalText: "",
  });
  assert.deepEqual(knobs.patch.personas.nova, { prompt: "x", temperature: 0.7, thinking: "high", output: "json" });

  // UPDATE: a layer persona is restated whole — a knob the draft dropped is gone, not left behind.
  const updated = proposePersonaSave({
    state: world,
    name: "technical",
    draft: draftFor("technical", { promptFile: "prompts/technical.md", text: "line one\nline two" }),
    originalText: "as loaded",
  });
  assert.deepEqual(
    updated.patch.personas.technical,
    { prompt: "prompts/technical.md" },
    "the cleared temperature does not survive the restatement",
  );
  assert.equal(updated.summary, "technical saved (prompt file prompts/technical.md · 2 lines)");
  assert.deepEqual(
    updated.promptWrites,
    [{ file: "/tmp/persona-layer/prompts/technical.md", text: "line one\nline two" }],
    "the path-backed text moved, so the file is written",
  );

  // …and a base persona is an override, with the declaration it overrides named in the summary.
  const based = proposePersonaSave({
    state: world,
    name: "judge",
    draft: draftFor("judge", { text: "pick\nbetter" }),
    originalText: "pick\nbetter",
  });
  assert.equal(based.summary, "judge saved (inline prompt · 2 lines) · overrides the declaration in /base/pi-fusion-matrix.json");
  assert.equal(based.promptWrites, undefined, "text that did not move writes no file");

  // The change-detection baseline is the editor's when one is open — the argument is its shortcut.
  const fromEditor = proposePersonaSave({
    state: { ...world, editor: { originalText: "line one\nline two" } },
    name: "technical",
    draft: draftFor("technical", { promptFile: "prompts/technical.md", text: "line one\nline two" }),
  });
  assert.equal(fromEditor.promptWrites, undefined, "an unchanged prompt file is not rewritten");

  // A prompt path this layer may not write is a named refusal — never a write plan.
  const refused = proposePersonaSave({
    state: personaState({ sources: { personas: { technical: { dir: "/tmp/persona-layer", trusted: false, file: personaLayerFile } } } }),
    name: "technical",
    draft: draftFor("technical", { promptFile: "../escape.md", text: "x" }),
    originalText: "as loaded",
  });
  assert.equal(refused.saveable, false);
  assert.match(refused.summary, /prompt path cannot be written/);
  assert.equal(refused.promptWrites, undefined, "and plans no write");

  // A pending for the same persona in the same layer is the baseline the new patch is drawn over —
  // persona edits accumulate like route lists — and any other pending is not this name's baseline.
  const carried = {
    listOf: "personas:technical",
    layerFile: personaLayerFile,
    patch: { personas: { technical: { prompt: "old" }, kept: { prompt: "kept\nhere" }, skeptic: personaConfig.personas.skeptic }, note: 1 },
    summary: "technical saved (inline prompt · 1 line)",
    errors: [],
  };
  const again = proposePersonaSave({
    state: { ...world, pending: carried },
    name: "technical",
    draft: draftFor("technical"),
    originalText: "old",
  });
  assert.deepEqual(
    again.patch,
    { personas: { technical: { prompt: "one\ntwo" }, kept: { prompt: "kept\nhere" }, skeptic: personaConfig.personas.skeptic }, note: 1 },
    "the pending it builds over is kept",
  );
  assert.deepEqual(again.errors, [], "and the accumulated patch still loads");
  const fresh = proposePersonaSave({
    state: { ...world, pending: { ...carried, listOf: "personas:other" } },
    name: "technical",
    draft: draftFor("technical"),
    originalText: "old",
  });
  assert.deepEqual(
    fresh.patch,
    { personas: { technical: { prompt: "one\ntwo" }, skeptic: personaConfig.personas.skeptic } },
    "another name's pending is not carried — the baseline is the layer again",
  );
});

test("proposePersonaDelete drops a layer persona and names the base file it cannot drop one from", () => {
  const world = personaState();

  // Layer-owned: the removal is expressible — the layer simply stops declaring the persona.
  const dropped = proposePersonaDelete({ state: world, name: "technical" });
  assert.equal(dropped.listOf, "personas:technical");
  assert.equal(dropped.layerFile, personaLayerFile);
  assert.deepEqual(
    dropped.patch,
    { personas: { skeptic: personaConfig.personas.skeptic } },
    "the layer as it would stand without the persona",
  );
  assert.equal(dropped.summary, "persona technical dropped");
  assert.notEqual(dropped.saveable, false, "no self-authored refusal stands in for the loader's");
  assert.ok(dropped.errors.length > 0, "the loader refuses a mode whose persona just went away");
  assert.match(dropped.errors.join("\n"), /unknown persona "technical"/);

  // Base-owned: the layer may only override, and the refusal names the declaring file.
  const refused = proposePersonaDelete({ state: world, name: "judge" });
  assert.equal(refused.listOf, "personas:judge");
  assert.equal(refused.saveable, false);
  assert.equal(refused.summary, "judge is declared in /base/pi-fusion-matrix.json; this layer can only override it");

  // …or the base layer it has no file for.
  const anonymous = proposePersonaDelete({ state: personaState({ sources: {} }), name: "judge" });
  assert.equal(anonymous.summary, "judge is declared in a base layer; this layer can only override it");
});

test("a persona save writes its prompt file before the layer, and a prompt file it cannot write stops both", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tui-persona-"));
  const layerFile = path.join(dir, "pi-fusion-matrix.json");
  const opts = { dbPath: path.join(dir, "no-store.db") };
  const sources = { personas: { technical: { dir, kind: "machine", file: layerFile, trusted: true } } };
  // The base layers hold the whole roster here and the layer file starts empty: what lands in the
  // layer is exactly the restatement being saved.
  const world = personaState({ layerFile, layerConfig: {}, sources, baseConfig: personaConfig });
  fs.mkdirSync(path.join(dir, "prompts"));
  fs.writeFileSync(path.join(dir, "prompts", "technical.md"), "line one\nline two\n");

  // A path-backed edit whose text moved writes the file — and the layer after it.
  const pending = proposePersonaSave({
    state: { ...world, editor: { originalText: "line one\nline two" } },
    name: "technical",
    draft: draftFor("technical", { promptFile: "prompts/technical.md", text: "line one\nline two\nline three" }),
  });
  assert.deepEqual(pending.promptWrites, [{ file: path.join(dir, "prompts", "technical.md"), text: "line one\nline two\nline three" }]);
  const saved = await commitProposal({ ...world, pending }, opts);
  assert.equal(saved.wrote, true, `a clean proposal is written — or names why not: ${saved.state.message}`);
  assert.equal(
    fs.readFileSync(path.join(dir, "prompts", "technical.md"), "utf8"),
    "line one\nline two\nline three",
    "the prompt file holds the new text",
  );
  assert.deepEqual(JSON.parse(fs.readFileSync(layerFile, "utf8")), pending.patch, "and the layer holds the patch");
  assert.match(saved.state.message, /^saved: technical saved \(prompt file prompts\/technical\.md · 3 lines\)/);
  assert.match(saved.state.message, /wrote/, "the success message names both halves of the write");

  // A prompt file this write cannot create stops the whole save — so the layer never appears behind
  // a prompt file that failed, which is what makes the file-first order observable.
  fs.writeFileSync(path.join(dir, "blocked"), "a file where a directory must go");
  const blocked = proposePersonaSave({
    state: { ...world, editor: { originalText: "as loaded" } },
    name: "technical",
    draft: draftFor("technical", { promptFile: "blocked/technical.md", text: "line one\nline two" }),
  });
  assert.deepEqual(blocked.promptWrites, [{ file: path.join(dir, "blocked", "technical.md"), text: "line one\nline two" }]);
  fs.rmSync(layerFile, { force: true });
  const refused = await commitProposal({ ...world, pending: blocked }, opts);
  assert.equal(refused.wrote, false);
  assert.match(refused.state.message, /^refused: the prompt file could not be written/);
  assert.equal(fs.existsSync(layerFile), false, "no layer is written after a prompt file that could not be");
  assert.equal(fs.existsSync(path.join(dir, "blocked", "technical.md")), false);

  fs.rmSync(dir, { recursive: true, force: true });
});

/* ------------------------------------------------------------ frame and diff */

test("a frame keeps the table inside its panel and the detail under it", () => {
  const world = state();
  const width = 100;
  const height = 20;
  const frame = frameFor({ width, height, state: world, palette: paletteFor({ color: false }), clock: "00:00:00" });
  const lines = Array.from({ length: height }, (_, row) => gridLine(frame, row));
  assert.match(lines[0], /FUSION MATRIX/);
  assert.match(lines[0], /2:aliases\*/);
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
  const helpText = Array.from({ length: height }, (_, row) => gridLine(withHelp, row)).join("\n");
  assert.match(helpText, /aliases — the alias/);
  assert.match(helpText, /fusions — mode and face/);
  assert.match(helpText, /personas — the prompt/);
  assert.doesNotMatch(helpText, /routes {2}—/, "the help names the three tabs it has");
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
    world.rows.fusions.find((row) => row.kind === "fusion" && row.fusionId === "review"),
  );
  assert.match(fusions, /verdicts clean×1 findings×4/);
  assert.match(fusions, /work items #25/);
  const seatDetail = detailFor({ ...personaState(), tab: "personas" }, { kind: "seat", fusion: "review", seat: "skeptic" });
  assert.match(seatDetail, /review\.skeptic/);
  assert.match(seatDetail, /refused: opencode-go quota×1/);
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
    tab: "personas",
    cursors: { aliases: 0, fusions: 1, personas: 4 },
    rain: false,
    color: false,
    picker: { title: "open", options: [] },
    input: { title: "new alias", value: "zai", hint: "", back: null, submit: () => ({ error: "never reached" }) },
    builder: { title: "zai: routes", tree: [], expanded: {}, left: 0, routes: [], right: 0, focus: "tree", commit: () => ({}), back: null },
    catalogue: [{ provider: "session-known", models: ["kept-from-the-session"] }],
  };
  const after = adopt(before, { state: state() });
  assert.equal(after.tab, "personas", "the tab is the view's, not the world's");
  const people = after.rows.personas.length;
  assert.deepEqual(
    after.cursors,
    { aliases: 0, fusions: 1, personas: Math.min(4, people - 1) },
    "a cursor past the reloaded rows is clamped onto the last one",
  );
  assert.equal(selected(after) !== undefined, true, "so the selection still points at a row");
  assert.equal(after.rain, false);
  assert.equal(after.color, false);
  assert.equal(after.picker, null, "but a picker open across a reload is closed");
  assert.equal(after.input, null, "and so is the half-typed name prompt");
  assert.equal(after.builder, null, "and the route builder with it");
  assert.deepEqual(after.catalogue, before.catalogue, "the provider/model list is session-known: the session's, not the reloaded world's");
  assert.equal(after.rows.personas.length, before.rows.personas.length, "the rows are the reloaded world's");
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
    { ...world, pending: proposal({ fusions: { cheap: { candidates: { technical: ["ghost"] } } } }) },
    opts,
  );
  assert.equal(invalid.wrote, false, "a change the loader refuses writes nothing");
  assert.match(invalid.state.message, /^refused: /);
  assert.equal(fs.existsSync(file), false, "and no directory or file is created for it");

  // (4) a proposal the loader accepts writes exactly the proposal, and spends the pending one.
  const patch = { fusions: { cheap: { candidates: { technical: ["mimo"] } } } };
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
  const row = { fusion: "quick", seat: "technical", candidates: "kimi" };
  const pending = proposeSeatAlias({ state: world, row, alias: "muse" });
  fs.writeFileSync(file, `${JSON.stringify(pending.patch, null, 2)}\n`);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), { fusions: { quick: { candidates: { technical: ["muse"] } } } });
  fs.rmSync(dir, { recursive: true, force: true });
});

test("a moved, dropped or rebuilt route list is what the layer file comes to hold", async () => {
  // The same proposals the keys build, through the writer to real files: what is asserted is the
  // bytes on disk, and the loader is asked again at the moment of writing. The packaged config is a
  // base it accepts, so its `glm` is a route list worth editing.
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
  const onGlm = expandedOn({ ...world(), tab: "aliases" }, "glm");
  const route = (provider) => routeRow(onGlm, "glm", provider);

  // Reordered: the first route becomes the second, and the layer holds exactly that.
  const moved = applyKey(cursorOn(onGlm, route("opencode-go")), "J").state;
  const wroteMoved = await commitProposal(moved, opts);
  assert.equal(wroteMoved.wrote, true, "the moved order is written");
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), {
    aliases: { glm: { providers: ["zai", "opencode-go"] } },
  });

  // Dropped: what remains is what the file says.
  fs.rmSync(file);
  const dropped = applyKey(cursorOn(onGlm, route("zai")), "d").state;
  const wroteDropped = await commitProposal(dropped, opts);
  assert.equal(wroteDropped.wrote, true);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), { aliases: { glm: { providers: ["opencode-go"] } } });

  // Rebuilt wholesale: what the route builder picked is what the file says — a plain ref where the
  // pair names the alias's model, an override where it names another.
  fs.rmSync(file);
  const rebuilt = proposeRouteList({
    state: onGlm,
    row: route("opencode-go"),
    routes: [
      { id: "opencode-go", model: "glm-5.3" },
      { id: "zai", model: "glm-5.3" },
      { id: "alibaba-token-plan", model: "glm-5" },
    ],
  });
  const wroteRebuilt = await commitProposal({ ...onGlm, pending: rebuilt }, opts);
  assert.equal(wroteRebuilt.wrote, true);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), {
    aliases: {
      glm: { providers: ["opencode-go", "zai", { id: "alibaba-token-plan", modelOverride: "glm-5" }] },
    },
  });

  fs.rmSync(dir, { recursive: true, force: true });
});

/* ---------------------------------------------------------------- the fusion tree */

/** A fusion whose route branches into a nested decision — the map the tree is made of. */
const treeConfig = {
  personas: { technical: { prompt: "x\ny" } },
  aliases: { kimi: { model: "kimi-k3", providers: ["opencode-go"] }, muse: { model: "m", providers: ["zai"] } },
  backends: { stub: { kind: "typesafe", url: "http://127.0.0.1:1/v1/systemone", apiKeyEnv: "TYPESAFE_API_KEY", model: "stub-model" } },
  decide: { defaultBackend: "stub" },
  modes: { single: { stages: [{ single: "technical", input: "prompt" }] } },
  fusions: {
    quickish: { mode: "single", candidates: { technical: ["kimi"] } },
    routed: {
      mode: "single",
      candidates: { technical: ["kimi"] },
      route: {
        instructions: "how much?",
        sufficientWhen: { minConfidence: 0.4 },
        criteria: { cheap: { description: "c", then: "quickish" }, high: { description: "h" } },
      },
    },
  },
};

const treeState = (over = {}) =>
  buildState({
    config: treeConfig,
    baseConfig: {},
    layerConfig: treeConfig,
    layerFile: "/tmp/tree-layer.json",
    decideRows: [
      {
        fusion: "routed",
        path: "routed.route",
        parent: "routed",
        total: 2,
        sufficient: 1,
        tallies: { cheap: 1, high: 1 },
        latest: { at: "2026-09-22T10:00:00Z", choice: "cheap", confidence: 0.9 },
      },
    ],
    ...over,
  });
const walkKeys = (state, keys) => keys.reduce((s, k) => applyKey(s, k).state, state);
const cursorRow = (state) => state.rows.fusions[state.cursors.fusions];
const toRow = (state, pred) => ({ ...state, cursors: { ...state.cursors, fusions: state.rows.fusions.findIndex(pred) } });

test("the fusion tree opens its decision with its choices, its gate and its result underneath", () => {
  let s = toRow({ ...treeState(), tab: "fusions" }, (r) => r.kind === "fusion" && r.fusionId === "routed");
  s = walkKeys(s, ["return"]);
  s = toRow(s, (r) => r.kind === "decision");
  assert.match(cursorRow(s).label, /◆ route/);
  assert.equal(cursorRow(s).result.total, 2, "the store's row binds by the node's own path");
  s = walkKeys(s, ["return"]);
  const subtree = s.rows.fusions.filter((r) => r.depth === 2).map((r) => r.kind);
  assert.deepEqual(subtree, ["choice", "choice", "gate", "result"]);
  const result = s.rows.fusions.find((r) => r.kind === "result");
  assert.match(result.label, /result: cheap conf 0\.9/);
  assert.equal(result.result.parent, "routed", "and it carries the context it was used in");
});

test("a choice's branch is a dropdown, and 'another decision' asks its question", () => {
  let s = toRow({ ...treeState(), tab: "fusions" }, (r) => r.kind === "fusion" && r.fusionId === "routed");
  s = walkKeys(s, ["return"]);
  s = toRow(s, (r) => r.kind === "decision");
  s = walkKeys(s, ["return"]);
  s = toRow(s, (r) => r.kind === "choice" && r.option === "cheap");
  s = walkKeys(s, ["e"]);
  assert.deepEqual(s.picker.options, ["(no branch)", "quickish", "routed", "another decision"], "fusions are the branches at route level");
  const chained = s.picker.pending("another decision");
  assert.ok(chained.modal, "another decision chains into the question it must ask");
  assert.deepEqual(chained.modal.apply("and is it risky?").errors, [], "the loader takes the nested map");
  assert.equal(
    chained.modal.apply("and is it risky?").patch.fusions.routed.route.criteria.cheap.then.decide.instructions,
    "and is it risky?",
  );
  assert.equal(s.picker.pending("(no branch)").patch.fusions.routed.route.criteria.cheap.then, undefined, "(no branch) drops the branch");
});

test("tree edits are one proposer: set, insert, move, delete — and a named refusal", () => {
  const owned = treeState({ baseConfig: {}, layerConfig: { fusions: treeConfig.fusions } });
  assert.equal(
    proposeFusionEdit({ state: owned, row: { fusionId: "routed", editPath: ["maxAdvance"] }, value: 2, summary: "…" }).patch.fusions.routed
      .maxAdvance,
    2,
  );
  const list = { fusionId: "routed", editPath: ["candidates", "technical"] };
  assert.equal(
    proposeFusionEdit({ state: owned, row: list, action: "insert", offset: 1, value: "muse", summary: "…" }).patch.fusions.routed.candidates
      .technical[1],
    "muse",
  );
  assert.equal(
    proposeFusionEdit({ state: owned, row: list, action: "move", offset: 1, to: 0, summary: "…" }).patch.fusions.routed.candidates
      .technical[0],
    "kimi",
  );
  assert.equal(
    proposeFusionEdit({ state: owned, row: list, action: "delete", offset: 0, summary: "…" }).patch.fusions.routed.candidates.technical
      .length,
    0,
  );
  const refused = proposeFusionEdit({
    state: treeState({ baseConfig: treeConfig }),
    row: { fusionId: "routed", editPath: ["mode"] },
    action: "delete",
    offset: 0,
    summary: "…",
  });
  assert.equal(refused.saveable, false, "what a base layer declares is not this layer's to drop");
  assert.match(refused.summary, /this layer can only override it/);
  assert.equal(proposeFusionDelete({ state: treeState(), row: { fusionId: "routed" } }).patch.fusions.routed, undefined);
  assert.equal(proposeFusionDelete({ state: treeState({ baseConfig: treeConfig }), row: { fusionId: "routed" } }).saveable, false);
});

test("the tree's keys act at the cursor's level", () => {
  let s = toRow({ ...treeState(), tab: "fusions" }, (r) => r.kind === "fusion" && r.fusionId === "routed");
  const asked = walkKeys(s, ["n"]);
  assert.equal(asked.input.title, "new fusion", "n on a fusion is a sibling fusion");
  const staged = asked.input.submit("fresh");
  assert.ok(staged.modal, "a name chains into its mode");
  assert.equal(staged.modal.pending("single").patch.fusions.fresh.mode, "single");
  const backedOut = walkKeys(asked, ["escape"]); // back out of the name ask — nothing staged
  assert.equal(backedOut.pending, null, "backing out stages nothing");
  s = toRow({ ...treeState(), tab: "fusions" }, (r) => r.kind === "fusion" && r.fusionId === "routed");
  s = walkKeys(s, ["return"]);
  s = toRow(s, (r) => r.kind === "stage");
  s = walkKeys(s, ["return"]);
  s = toRow(s, (r) => r.kind === "seat");
  s = walkKeys(s, ["return"]);
  s = toRow(s, (r) => r.kind === "candidate");
  s = walkKeys(s, ["K"]);
  assert.match(s.pending?.summary ?? "", /moves/, "K stages the move");
  s = walkKeys(s, ["d"]);
  assert.match(s.pending?.summary ?? "", /drops/, "d stages the drop");
});

test("every tree editor speaks through one modal, and every path one proposer", () => {
  const s0 = { ...treeState(), tab: "fusions" };
  const edit = (s, pred) => walkKeys(toRow(s, pred), ["e"]);
  const at = (outcome) => outcome.patch.fusions.routed;

  // A fusion row's knobs: two dropdowns, two prompts — all four land at their own path.
  const fusion = edit(s0, (r) => r.kind === "fusion" && r.fusionId === "routed");
  assert.equal(at(fusion.picker.pending("mode…").modal.pending("single")).mode, "single");
  assert.equal(at(fusion.picker.pending("name…").modal.submit("Faster")).name, "Faster");
  assert.equal(at(fusion.picker.pending("execute…").modal.pending("false")).execute, false);
  assert.equal(at(fusion.picker.pending("maxAdvance…").modal.submit("2")).maxAdvance, 2);
  assert.match(fusion.picker.pending("maxAdvance…").modal.submit("two").error, /positive integer/);

  // A seat row: its thinking knob, its prompt override, and clearing it again.
  let open = walkKeys(
    toRow(s0, (r) => r.kind === "fusion" && r.fusionId === "routed"),
    ["return"],
  );
  open = walkKeys(
    toRow(open, (r) => r.kind === "stage"),
    ["return"],
  );
  const seat = edit(open, (r) => r.kind === "seat");
  assert.equal(at(seat.picker.pending("thinking…").modal.pending("low")).thinking.technical, "low");
  assert.equal(at(seat.picker.pending("prompt override…").modal.apply("be brief")).prompts.technical, "be brief");
  assert.equal(at(seat.picker.pending("clear the prompt")).prompts?.technical, undefined);

  // A decision row: its question, a new choice — and the gate beneath it, set or cleared.
  const expanded = walkKeys(
    toRow(s0, (r) => r.kind === "fusion" && r.fusionId === "routed"),
    ["return"],
  );
  const wide = walkKeys(
    toRow(expanded, (r) => r.kind === "decision"),
    ["return"],
  );
  const decision = edit(expanded, (r) => r.kind === "decision");
  assert.equal(at(decision.picker.pending("instructions…").modal.apply("less?")).route.instructions, "less?");
  assert.equal(at(decision.picker.pending("add a choice…").modal.submit("extra")).route.criteria.extra.description, "");
  const gate = edit(wide, (r) => r.kind === "gate");
  assert.deepEqual(at(gate.picker.pending("gate: choiceIs…").modal.pending("cheap")).route.sufficientWhen.choiceIs, ["cheap"]);
  assert.equal(at(gate.picker.pending("gate: minConfidence…").modal.submit("0.7")).route.sufficientWhen.minConfidence, 0.7);
  assert.equal(at(gate.picker.pending("clear the gate")).route.sufficientWhen, undefined);

  // A choice row leads somewhere concrete: a fusion as a {run} node, or nothing at all.
  const choice = edit(wide, (r) => r.kind === "choice" && r.option === "high");
  assert.equal(at(choice.picker.pending("quickish")).route.criteria.high.then.run, "quickish");
  assert.equal(at(choice.picker.pending("(no branch)")).route.criteria.high.then, undefined);

  // And n adds at each level it names: a seat's chain gains an alias from the dropdown.
  const add = walkKeys(
    toRow({ ...s0, ...{ rows: open.rows } }, (r) => r.kind === "seat"),
    ["n"],
  );
  assert.equal(at(add.picker.pending("muse")).candidates.technical[1], "muse");
});

test("the frame paints the editor and the textarea over the table", () => {
  const world = treeState();
  const editor = {
    ...world,
    editor: {
      title: "nova",
      fields: [],
      draft: { text: "hi", promptFile: "", temperature: 0.5, thinking: "low", output: "text" },
      originalText: "hi",
      cursor: 0,
      commit: () => ({}),
      back: null,
    },
  };
  const painted = Array.from({ length: 20 }, (_, i) =>
    gridLine(frameFor({ width: 100, height: 20, state: { ...editor, tab: "fusions" }, palette: paletteFor({ color: false }) }), i),
  ).join("\n");
  assert.match(painted, /nova/, "the editor's title is over the table");
  const typing = {
    ...world,
    textarea: { title: "nova: prompt", lines: ["alpha", "beta"], row: 1, col: 4, hint: "esc done", back: null, apply: () => ({}) },
  };
  const text = Array.from({ length: 20 }, (_, i) =>
    gridLine(frameFor({ width: 100, height: 20, state: { ...typing, tab: "fusions" }, palette: paletteFor({ color: false }) }), i),
  ).join("\n");
  assert.match(text, /alpha/);
  assert.match(text, /beta▌/, "and the caret sits where the typing is");
});
