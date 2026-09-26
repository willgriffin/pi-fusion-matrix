/**
 * The interface as a host component (`scripts/tui-panel.mjs`), through the contract its host mounts
 * it with: a render that returns lines, keys that arrive as chunks, a `done` that closes it. What is
 * asserted is what a host and a reader observe — rendered lines, the layer file on disk, the close —
 * never the wiring between them.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { MatrixPanel, styledLine } from "../scripts/tui-panel.mjs";
import { createRain } from "../scripts/tui-rain.mjs";

const ESC = String.fromCharCode(27);
const CTRL_C = String.fromCharCode(3);
// The loader reads its machine layer from the agent directory. A suite may not depend on whose
// laptop it runs on, so for this file's process the loader's own isolation hook points at nothing:
// the machine layer is the operator's, not the subject under test.
process.env.PI_CODING_AGENT_DIR = path.join(os.tmpdir(), "tui-panel-test-no-machine-layer");
/** SGR sequences carry style and zero width. Stripped by scan rather than regex: the repo guard bans
 * control characters in patterns, and this shape is stricter — anything a strip leaves behind is an
 * escape the host never sanctioned (a cursor move has no place in a component line). */
const visible = (line) => {
  let out = "";
  let i = 0;
  while (i < line.length) {
    const at = line.indexOf(ESC + "[", i);
    if (at === -1) {
      out += line.slice(i);
      break;
    }
    out += line.slice(i, at);
    let end = at + 2;
    while (end < line.length && line[end] !== "m") end += 1;
    i = end + 1;
  }
  return out;
};
const shows = (lines, text) => lines.some((line) => visible(line).includes(text));

/** Poll a condition with its own deadline; a deadline that fires is a failed check, never a hang. */
async function until(condition, label, deadlineMs = 2000) {
  const stop = Date.now() + deadlineMs;
  while (Date.now() < stop) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`deadline waiting for: ${label}`);
}

/** A panel over its own store and layer file, mounted with a fake host that records the close.
 * Two files by design: `seed` is the scratch `cwd`'s own project layer — part of the base the panel
 * loads — while the layer file is the one the panel writes, which a persona it creates may then be
 * dropped from (a base-declared persona can only ever be overridden). */
async function mountPanel(t, tab, seed = null) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tui-panel-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const layerFile = path.join(dir, "layer.json");
  if (seed) {
    fs.mkdirSync(path.join(dir, ".pi"), { recursive: true });
    fs.writeFileSync(path.join(dir, ".pi", "pi-fusion-matrix.json"), `${JSON.stringify(seed, null, 2)}\n`);
  }
  const calls = { done: 0, value: Symbol("unset"), invalidations: 0 };
  const panel = new MatrixPanel({
    tui: {
      invalidate() {
        calls.invalidations += 1;
      },
    },
    keybindings: { matches: (data, action) => action === "app.interrupt" && data === "\u0007" },
    done(value) {
      calls.done += 1;
      calls.value = value;
    },
    dbPath: path.join(dir, "absent.db"),
    cwd: dir,
    layerFile,
    tab,
  });
  await panel.ready;
  // Disposal belongs in the fixture's after-hook: a failing assertion must not leak the panel's
  // repaint timer into the runner — it held the process open once, and a suite that will not exit is
  // indistinguishable from a suite that found a deadlock.
  t.after(() => panel.dispose());
  return { panel, calls, layerFile, dir };
}

/** The first parent alias row whose provider list satisfies the predicate. A route child is never
 * the row found — it is reached through its parent — so `row.alias` is always a name to look up. */
function findRow(panel, predicate) {
  for (let i = 0; i < panel.state.rows.aliases.length; i += 1) {
    panel.handleInput("g");
    for (let step = 0; step < i; step += 1) panel.handleInput("j");
    const row = panel.state.rows.aliases[panel.state.cursors.aliases];
    if (row.kind === "route") continue;
    const providers = panel.state.config.aliases?.[row.alias]?.providers ?? [];
    if (predicate(providers)) return { row, providers };
  }
  return null;
}

test("styledLine groups cell styles and leaves cursor placement to the host", () => {
  const palette = { reset: "\x1b[0m" };
  const grid = { width: 4, height: 1, ch: ["a", "b", "c", "d"], fg: ["\x1b[31m", "\x1b[31m", "", "\x1b[32m"] };
  assert.equal(styledLine(grid, 0, palette), "\x1b[31mab\x1b[0mc\x1b[32md\x1b[0m");
});

test("a render is width-safe, cursor-move-free, and names a missing store", async (t) => {
  const { panel } = await mountPanel(t);
  const lines = panel.render(100);
  assert.ok(lines.length >= 12, "a frame of rows, not a single line");
  for (const line of lines) {
    const text = visible(line);
    assert.ok(text.length <= 100, `line is width-safe (${text.length})`);
    assert.ok(!text.includes(ESC), "a component line carries style and nothing else — never a cursor move");
  }
  assert.ok(
    visible(lines[0]).includes("FUSION") && visible(lines[0]).includes("MATRIX"),
    `the header renders — row 0: ${JSON.stringify(visible(lines[0]))}`,
  ); // rain may sit in the space between the words: it shows through every blank cell, by design
  assert.ok(
    shows(lines, "absent.db"),
    `a missing store is a named state, not an empty table — notes: ${JSON.stringify(lines.map(visible).filter((row) => row.includes("store")))}`,
  );
  panel.dispose();
});

test("keys move the reader and the toggles; unknown keys are inert", async (t) => {
  const { panel, calls } = await mountPanel(t);
  const startTab = panel.state.tab;
  const display = () => JSON.stringify([panel.state.tab, panel.state.rain, panel.state.color]);
  const before = display();
  // These walk the rows *within* the tab (arrows and h/l move and open rows, tab/shift-tab with
  // them); the tab itself is keyed by number and nothing else.
  for (const key of ["\t", "\u001b[Z", "\u001b[D", "\u001b[C", "h", "l"]) {
    panel.handleInput(key);
    assert.equal(panel.state.tab, startTab, `${JSON.stringify(key)} moves within the tab — it never switches`);
  }
  panel.handleInput("3");
  assert.equal(panel.state.tab, "personas", "a number keys the tab directly");
  assert.ok(shows(panel.render(100), "personas"), "the tab is visible in the frame");
  panel.handleInput("1");
  assert.equal(panel.state.tab, "fusions", "…and one goes to the first");
  panel.handleInput("a");
  assert.equal(panel.state.rain, true, "rain toggles on");
  panel.handleInput("a");
  panel.handleInput("c");
  assert.equal(panel.state.color, false, "colour toggles");
  panel.handleInput("c");
  assert.equal(display(), before, "the display state returns to where it started");
  const settled = JSON.stringify([panel.state.tab, panel.state.cursors, panel.state.rain, panel.state.color]);
  panel.handleInput("x");
  assert.equal(
    JSON.stringify([panel.state.tab, panel.state.cursors, panel.state.rain, panel.state.color]),
    settled,
    "an unbound key does nothing",
  );
  assert.equal(calls.done, 0, "and none of it closes the panel");
  panel.dispose();
});

test("moving a one-route alias's only route is a named refusal, and save writes nothing", async (t) => {
  const { panel, layerFile } = await mountPanel(t, "aliases");
  const found = findRow(panel, (providers) => providers.length === 1);
  assert.ok(found, "the config carries an alias with a single route");
  panel.handleInput("\r"); // expand it
  panel.handleInput("j");
  const route = panel.state.rows.aliases[panel.state.cursors.aliases];
  assert.equal(route.parent, found.row.alias, "the cursor is on the alias's only route");
  panel.handleInput("K"); // the only route is already first
  assert.ok(panel.state.pending, "the reader is told something");
  assert.equal(panel.state.pending.saveable, false, "…and it is a refusal, not a proposal");
  assert.ok(panel.state.pending.summary.includes(found.row.alias), "the refusal names the alias");
  panel.handleInput("s");
  assert.ok(panel.state.pending, "the refusal stays visible rather than being spent");
  assert.ok(!fs.existsSync(layerFile), "and no layer file is created to hold the state it already has");
  panel.dispose();
});

test("a proposal names its layer file, and save writes the reordered routes through to disk", async (t) => {
  const { panel, layerFile } = await mountPanel(t, "aliases");
  const found = findRow(panel, (providers) => providers.length >= 2);
  assert.ok(found, "the config carries an alias with two routes to reorder");
  panel.handleInput("\r"); // expand it
  panel.handleInput("j");
  const route = panel.state.rows.aliases[panel.state.cursors.aliases];
  assert.equal(route.parent, found.row.alias, "the cursor is on the alias's first route");
  panel.handleInput("J"); // …and that route now tries second
  assert.ok(panel.state.pending, "a proposal is pending");
  assert.notEqual(panel.state.pending.saveable, false, "…and it is saveable");
  assert.ok(shows(panel.render(100), path.basename(layerFile)), "the proposal names the file it would write");
  panel.handleInput("s");
  await until(() => panel.state.pending === null, "the proposal to be spent");
  assert.ok(fs.existsSync(layerFile), "the layer file was written");
  const written = JSON.parse(fs.readFileSync(layerFile, "utf8"));
  const providers = written.aliases?.[found.row.alias]?.providers ?? [];
  assert.deepEqual(providers, [found.providers[1], found.providers[0], ...found.providers.slice(2)], "the reordered routes are on disk");
  panel.dispose();
});

test("a host ctx without timer hooks still disposes cleanly", async (t) => {
  // schedule/unschedule come as a pair: once a fallback timer is scheduled, `dispose` must clear it
  // through the same fallback — the unpaired shape threw from dispose and leaked the repaint timer.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tui-nopair-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const panel = new MatrixPanel({
    tui: { invalidate() {} },
    keybindings: { matches: () => false },
    done: () => {},
    ctx: {},
    dbPath: path.join(dir, "absent.db"),
    cwd: dir,
    layerFile: path.join(dir, "layer.json"),
  });
  t.after(() => panel.dispose());
  await panel.ready;
  assert.doesNotThrow(() => panel.dispose());
});

test("a named tab opens there, and both close paths close exactly once", async (t) => {
  const { panel, calls } = await mountPanel(t, "personas");
  assert.equal(panel.state.tab, "personas", "/matrix personas opens on personas");
  panel.handleInput("1");
  assert.equal(panel.state.tab, "fusions", "…and a number walks it to the first tab");
  panel.handleInput(ESC);
  assert.equal(calls.done, 1, "at the root, esc is out — it closes the matrix");
  assert.equal(calls.value, undefined, "…with nothing to report");
  panel.handleInput(ESC);
  assert.equal(calls.done, 1, "a closed panel ignores further keys");
  panel.dispose();

  const second = await mountPanel(t);
  second.panel.handleInput(CTRL_C);
  assert.equal(second.calls.done, 1, "ctrl-c is the other way out — and it too closes once");
  second.panel.handleInput(CTRL_C);
  assert.equal(second.calls.done, 1, "…and a closed panel ignores it too");
  second.panel.dispose();
});

test("esc is back through the modals — and at the root it is out", async (t) => {
  const { panel, calls } = await mountPanel(t);
  panel.handleInput("1");
  panel.handleInput("e");
  assert.ok(panel.state.picker, "e opens a fusion row's editor dropdown");
  panel.handleInput(ESC);
  assert.equal(panel.state.picker, null, "esc closes the modal it is in");
  assert.equal(calls.done, 0, "…and leaves the matrix standing");
  panel.handleInput("g");
  panel.handleInput("\r");
  panel.handleInput(ESC);
  assert.equal(calls.done, 0, "esc steps back first — the collapse, not the close");
  panel.handleInput(ESC);
  assert.equal(calls.done, 1, "and at the root, back is out — esc closes the matrix");
  panel.dispose();
});

test("n opens the route builder — the tree picks the pairs, the list beside it keeps them, and s writes through", async (t) => {
  const { panel, calls, layerFile } = await mountPanel(t, "aliases");
  // The tree is whatever this machine's catalogue actually holds — the registry's models, the rate card's rows, and the pairs the config
  // already names, merged. Nothing in it is named here: the walk finds a provider with models at runtime, and an empty catalogue is a
  // named refusal instead of a walk — so the suite means the same thing on every machine.
  const catalogue = panel.state.catalogue ?? [];
  const pairs = (routes) => routes.map((pair) => ({ id: pair.id, model: pair.model }));
  const normalize = (routes, model) => routes.map((pair) => (pair.model === model ? pair.id : { id: pair.id, modelOverride: pair.model }));
  if (catalogue.length === 0) {
    assert.ok(
      findRow(panel, () => true),
      "the config carries an alias row to sit the cursor on",
    );
    panel.handleInput("n");
    assert.equal(panel.state.input, null, "no name ask opens");
    assert.equal(panel.state.builder ?? null, null, "…and no builder either");
    assert.equal(panel.state.message, "no provider/model list to choose from", "the refusal names why");
    assert.ok(shows(panel.render(100), "no provider/model list to choose from"), "…and says so on screen");
    assert.equal(calls.done, 0, "a refusal is not a close");
    return;
  }
  const found = findRow(panel, () => true);
  assert.ok(found, "the config carries an alias row to sit the cursor on");
  // A probe at the name ask first: a reader's esc arrives as an escape-sequence chunk, and it is never text to type into the field.
  panel.handleInput("n");
  assert.ok(panel.state.input, "n on an alias row starts the chain");
  assert.ok(shows(panel.render(100), "new alias"), "and the ask is on screen — the reader sees something happen");
  panel.handleInput("za"); // keys arrive as chunks: a multi-key chunk — a paste — appends whole
  panel.handleInput("x"); // …and a single key appends its one character
  assert.ok(shows(panel.render(100), "zax"), "the typed name is visible in the frame as it is typed");
  const sequence = String.fromCharCode(27) + "[27~";
  panel.handleInput(sequence);
  assert.equal(panel.state.input, null, "an escape sequence backs out of the ask — it is never typed text");
  const tail = "[27~";
  assert.ok(!JSON.stringify(panel.state).includes(tail), "the sequence's tail is nowhere in the state");
  assert.ok(!panel.render(100).some((line) => line.includes(tail)), "…nor anywhere in the frame");
  assert.equal(calls.done, 0, "back is never out");
  // Alias level: the chain is name → builder. The typed model step is gone — a new alias's model is its first route's.
  panel.handleInput("n");
  panel.handleInput("za");
  panel.handleInput("x");
  panel.handleInput("\r"); // the name is answered; the routes are built
  assert.ok(panel.state.builder, "enter continues to the builder");
  assert.equal(panel.state.builder.title, "zax: routes", "…which names the list it builds");
  assert.equal(panel.state.builder.focus, "tree", "it starts on the tree pane");
  assert.deepEqual(pairs(panel.state.builder.routes), [], "with an empty list to build into");
  assert.ok(panel.state.builder.back, "the name step waits behind it");
  // The tree comes from the builder's own view of the catalogue — discovered here, named by nothing.
  // Both panes scroll with their cursor, so a frame claim is only made with the cursor on the row it is
  // about, and the pick favours short names so no column can truncate one away.
  const tree = panel.state.builder.tree;
  const usable = tree.filter((entry) => (entry.models ?? []).length > 0);
  assert.ok(usable.length > 0, "every tree entry carries its models");
  const pool = usable.filter((entry) => entry.models.length >= 2);
  const rank = (entry) => entry.provider.length + entry.models.slice(0, 2).reduce((sum, id) => sum + id.length, 0);
  const chosen = [...(pool.length ? pool : usable)].sort((a, b) => rank(a) - rank(b))[0];
  const at = tree.indexOf(chosen);
  const two = chosen.models.length >= 2;
  const first = { id: chosen.provider, model: chosen.models[0] };
  const second = { id: chosen.provider, model: chosen.models[two ? 1 : 0] };
  assert.ok(shows(panel.render(100), "zax: routes"), "the builder is on screen");
  assert.ok(shows(panel.render(100), "zax = "), "…with the identity line as it stands");
  assert.ok(shows(panel.render(100), "no routes yet"), "and the routes pane names the empty list it starts from");
  // Esc in the chain is one step back, not out of it: the name ask comes back with its typing intact.
  panel.handleInput(ESC);
  assert.ok(shows(panel.render(100), "new alias"), "esc at the builder steps back — the name ask is the one on screen again");
  assert.ok(shows(panel.render(100), "zax"), "…and the typed name it kept is still in the frame");
  assert.equal(calls.done, 0, "…and the matrix lives");
  panel.handleInput("\r"); // …and answering it again resumes at a fresh builder
  assert.ok(panel.state.builder, "the chain is not lost");
  assert.deepEqual(pairs(panel.state.builder.routes), [], "…and the list starts empty again");
  // The walk: reach the chosen provider in the flattened tree, open it, pick two models from beneath.
  for (let i = 0; i < at; i += 1) panel.handleInput("j");
  assert.equal(panel.state.builder.left, at, "the cursor walks the tree to the provider");
  assert.ok(shows(panel.render(100), `▸ ${chosen.provider}`), "…and the provider is on screen under it");
  panel.handleInput("\r");
  assert.ok(panel.state.builder.expanded[chosen.provider], "enter opens the provider");
  assert.ok(shows(panel.render(100), `▾ ${chosen.provider}`), "…and the frame shows it open");
  panel.handleInput("j");
  assert.equal(panel.state.builder.left, at + 1, "the cursor steps onto the first model row");
  assert.ok(shows(panel.render(100), `  ${chosen.models[0]}`), "with its models indented beneath");
  panel.handleInput("\r"); // enter on a model adds that (provider, model) pair
  assert.deepEqual(pairs(panel.state.builder.routes), [first], "the first pick lands in the routes list");
  assert.equal(panel.state.builder.right, 0, "…and the routes cursor follows it");
  if (two) {
    panel.handleInput("j");
    assert.equal(panel.state.builder.left, at + 2, "the cursor steps onto the second model row");
    assert.ok(shows(panel.render(100), `  ${chosen.models[1]}`), "each model row in turn");
  }
  panel.handleInput("\r");
  assert.deepEqual(pairs(panel.state.builder.routes), [first, second], "the second pick appends");
  assert.equal(panel.state.builder.right, 1, "…and the cursor follows that one too");
  assert.ok(shows(panel.render(100), `${chosen.provider} → ${first.model}`), "the list renders its rows as provider → model");
  // The routes pane is where the list is ordered and trimmed.
  panel.handleInput("\t");
  assert.equal(panel.state.builder.focus, "routes", "tab moves to the routes pane");
  panel.handleInput("K");
  assert.deepEqual(pairs(panel.state.builder.routes), [second, first], "K moves the focused pair up");
  assert.equal(panel.state.builder.right, 0, "…and the cursor rides along");
  panel.handleInput("J");
  assert.deepEqual(pairs(panel.state.builder.routes), [first, second], "J moves it back down");
  assert.equal(panel.state.builder.right, 1, "…following it again");
  panel.handleInput("K");
  assert.deepEqual(pairs(panel.state.builder.routes), [second, first], "…and up once more");
  panel.handleInput("d");
  assert.deepEqual(pairs(panel.state.builder.routes), [first], "d drops the focused pair");
  // `s` is create *and* save both — no separate write to land it.
  panel.handleInput("s");
  assert.equal(panel.state.builder ?? null, null, "the commit closes the builder");
  await until(() => panel.state.pending === null, "the create to be written through");
  const written = JSON.parse(fs.readFileSync(layerFile, "utf8"));
  assert.deepEqual(
    written.aliases?.zax,
    { model: first.model, providers: normalize([first], first.model) },
    "the new alias is on disk — the model is the first pair's, the providers exactly per the picking rule",
  );
  assert.ok(shows(panel.render(100), "zax"), "and the new alias's name is visible in the frame");
  assert.equal(calls.done, 0, "the chain walked its whole length without closing the matrix");
  // Route level: the same builder opens over the alias's current list and rewrites it wholesale — the alias's model is never re-pointed.
  const listed = findRow(panel, (providers) => providers.length >= 2);
  assert.ok(listed, "the config carries an alias with two routes to open");
  const alias = listed.row.alias;
  const entry = panel.state.config.aliases[alias];
  const model = entry.model;
  const seeded = (entry.providers ?? []).map((ref) => ({
    id: typeof ref === "string" ? ref : ref.id,
    model: typeof ref === "object" && ref.modelOverride ? ref.modelOverride : model,
  }));
  panel.handleInput("\r"); // expand it
  panel.handleInput("j");
  const route = panel.state.rows.aliases[panel.state.cursors.aliases];
  assert.equal(route.parent, alias, "the cursor is on the alias's first route");
  panel.handleInput("n");
  assert.ok(panel.state.builder, "n on a route row opens the builder over that list");
  assert.equal(panel.state.builder.title, `${alias}: routes`, "…named for the list it edits");
  assert.equal(panel.state.builder.back ?? null, null, "it opens straight in — there is nowhere back");
  assert.ok(shows(panel.render(100), `${alias}: routes`), "and it is on screen");
  assert.deepEqual(pairs(panel.state.builder.routes), seeded, "seeded from the alias's current list — the effective model each");
  panel.handleInput("s");
  await until(() => panel.state.pending === null, "the wholesale rewrite to be written through");
  const after = JSON.parse(fs.readFileSync(layerFile, "utf8"));
  assert.deepEqual(after.aliases?.[alias]?.providers ?? [], normalize(seeded, model), "the whole list is on disk exactly as picked");
  assert.equal(after.aliases?.[alias]?.model ?? model, model, "the layer never re-points the alias's model");
  assert.equal(panel.state.config.aliases[alias].model, model, "…and the alias still answers with its own model");
  assert.equal(calls.done, 0, "and none of it closed the matrix");
  panel.dispose();
});

test("the rain moves on a clock: renders apart in time differ with nothing driving them", async (t) => {
  const { panel } = await mountPanel(t);
  panel.render(80); // settle the field's dimensions
  panel.handleInput("a"); // the rain starts off now — this check is about its motion, so ask for it
  // Its own seeded field: the motion must be observable no matter when the check runs.
  panel.rainField = createRain({ width: 80, height: panel.height, seed: 7, density: 0.8 });
  panel.dispose(); // the repaint driver is gone — any motion now owes to time alone
  const frame = () => panel.render(80).slice(1, -1).join("\n"); // header and clock are not the rain
  const before = frame();
  await new Promise((resolve) => setTimeout(resolve, 140));
  assert.notEqual(frame(), before, "the field fell between two renders with no input and no timer");
});

test("the clock asks the host for frames through its scheduler", async (t) => {
  let frames = 0;
  const panel = new MatrixPanel({
    tui: {
      requestRender: () => {
        frames += 1;
      },
      invalidate() {},
    },
    keybindings: { matches: () => false },
    done: () => {},
  });
  t.after(() => panel.dispose());
  await until(() => frames > 0, "the host to be asked for a frame", 1000);
  assert.ok(frames >= 1, "requestRender is what wakes the renderer — a cache flush does not");
});

test("the personas tab makes, retunes and drops one end to end — and a seat's e points it at an alias", async (t) => {
  const { panel, calls, layerFile } = await mountPanel(t);
  panel.handleInput("3");
  assert.equal(panel.state.tab, "personas", "the number keys reach the personas tab");

  // Walk the personas rows to a target parent and leave the cursor on it. Nothing here names a
  // persona, a fusion or an alias — the rows are whatever this repo's own config holds — so the walk
  // means the same thing wherever the suite runs.
  const findPersona = (predicate) => {
    panel.handleInput("g");
    for (let i = 0; i < panel.state.rows.personas.length; i += 1) {
      const row = panel.state.rows.personas[panel.state.cursors.personas];
      if (predicate(row)) return row;
      panel.handleInput("j");
    }
    return null;
  };

  const name = "aether"; // the name the reader types: it names no model and no alias, only this one new persona

  // Make: the name chains into the editor, the prompt field opens a textarea, esc applies the text
  // back, and the editor's `s` is make *and* write both — there is no second key to land it.
  panel.handleInput("n");
  assert.ok(panel.state.input, "n opens the name ask");
  panel.handleInput(name);
  panel.handleInput("\r"); // the name is answered and the editor opens over an empty draft
  assert.ok(panel.state.editor, "the name chains into the persona editor");
  panel.handleInput("\r"); // the prompt field, first in the list, opens the textarea
  assert.ok(panel.state.textarea, "the prompt is edited in a textarea");
  panel.handleInput("alpha"); // a chunk types as one run — a paste arrives whole
  panel.handleInput("\r"); // return splits the line
  panel.handleInput("beta");
  panel.handleInput(ESC); // esc is 'done with this field': it applies the text and steps back
  assert.equal(panel.state.textarea ?? null, null, "esc closes the textarea");
  const promptText = panel.state.editor.draft.text;
  assert.ok(promptText.includes("alpha") && promptText.includes("beta"), "esc applied the typed lines");
  assert.ok(promptText.includes("\n"), "…as an inline (multi-line) prompt, not a path");
  panel.handleInput("s");
  assert.equal(panel.state.editor ?? null, null, "the commit closes the editor");
  await until(() => panel.state.pending === null, "the create to be written through");
  const created = JSON.parse(fs.readFileSync(layerFile, "utf8"));
  assert.equal(created.personas?.[name]?.prompt, promptText, "the layer carries the inline prompt text");
  assert.ok(shows(panel.render(100), name), "and the frame lists the new persona");

  // Retune: `e` reopens the editor seeded from the persona, and the thinking row opens a level
  // dropdown. A picker choice is a field edit stepping back to the editor (whose `s` is the write) —
  // or, where the choice is itself the change, the write already happened on the spot. Land whichever
  // this is, and read the level back off disk so the assertion holds under either.
  assert.ok(
    findPersona((row) => row.kind === "persona" && row.persona === name),
    "the new persona is a row to sit the cursor on",
  );
  panel.handleInput("e");
  assert.ok(panel.state.editor, "e on a persona opens the editor seeded with it");
  assert.ok(String(panel.state.editor.draft.text ?? "").includes("alpha"), "…seeded from its current prompt");
  for (let i = 0; i < 3; i += 1) panel.handleInput("j"); // down to the thinking row: prompt · prompt file · temperature · thinking
  panel.handleInput("\r");
  assert.ok(panel.state.picker, "the thinking field opens a level dropdown");
  const concrete = panel.state.picker.options.findIndex((option) => option && option !== "(inherit)");
  assert.ok(concrete > 0, "the dropdown offers concrete thinking levels beyond inherit");
  const level = panel.state.picker.options[concrete];
  while (panel.state.picker.cursor < concrete) panel.handleInput("j");
  while (panel.state.picker.cursor > concrete) panel.handleInput("k");
  panel.handleInput("\r"); // choose that level
  assert.equal(panel.state.picker ?? null, null, "choosing closes the dropdown");
  if (panel.state.editor) {
    assert.equal(panel.state.editor.draft.thinking, level, "choosing sets the draft's thinking level");
    panel.handleInput("s"); // the editor's submit is the write
  }
  await until(() => panel.state.pending === null, "the retune to be written through");
  const retuned = JSON.parse(fs.readFileSync(layerFile, "utf8"));
  assert.equal(retuned.personas?.[name]?.thinking, level, "the layer carries the picked thinking level");
  assert.equal(retuned.personas?.[name]?.prompt, promptText, "…and the prompt it already had");

  // Drop: `d` stages the removal and `s` writes it — the persona is gone again.
  assert.ok(
    findPersona((row) => row.kind === "persona" && row.persona === name),
    "the persona is still a row to drop",
  );
  panel.handleInput("d");
  assert.ok(panel.state.pending, "d stages the drop as a proposal");
  panel.handleInput("s");
  await until(() => panel.state.pending === null, "the drop to be written through");
  const dropped = JSON.parse(fs.readFileSync(layerFile, "utf8"));
  assert.equal(dropped.personas?.[name], undefined, "the layer no longer carries the persona");

  // A seat child reuses the routes tab's alias dropdown: `e` opens it over that fusion and seat, and
  // esc closes it with nothing staged — none of the whole walk closes the matrix.
  const host = findPersona((row) => row.kind === "persona" && (row.childCount ?? 0) > 0);
  assert.ok(host, "some persona has a seat to point at an alias");
  panel.handleInput("\r"); // expand it into its seat rows
  panel.handleInput("j"); // …and step onto the first one
  const seat = panel.state.rows.personas[panel.state.cursors.personas];
  assert.equal(seat.kind, "seat", "the cursor is on a seat child");
  panel.handleInput("e");
  assert.ok(panel.state.picker, "e on a seat opens the alias dropdown");
  assert.ok(
    panel.state.picker.title.includes(seat.fusion) && panel.state.picker.title.includes(seat.seat),
    "titled with the fusion and seat",
  );
  panel.handleInput(ESC);
  assert.equal(panel.state.picker ?? null, null, "esc closes the dropdown");
  assert.equal(panel.state.pending ?? null, null, "…and stages nothing");
  assert.equal(calls.done, 0, "…and the whole walk never closed the matrix");
  panel.dispose();
});

test("the fusion tree opens its decision and takes a nested branch", async (t) => {
  // The six paths ship no router, so this check's routed fusion is its own layer — like every other
  // fixture here it is found at runtime, never hardcoded beyond its own file.
  const { panel, calls, layerFile } = await mountPanel(t, "fusions", {
    fusions: {
      routed: {
        mode: "single",
        candidates: { technical: ["mimo"] },
        route: {
          instructions: "how deep does this go?",
          criteria: {
            deeper: { description: "ask again" },
            stop: { description: "stay here", then: "cheap" },
          },
        },
      },
    },
  });
  const goto = (pred) => {
    panel.handleInput("g");
    for (let i = 0; i < panel.state.rows.fusions.length; i += 1) {
      const row = panel.state.rows.fusions[panel.state.cursors.fusions];
      if (pred(row)) return row;
      panel.handleInput("j");
    }
    return null;
  };
  // Whatever routed fusion this machine's config carries — found at runtime, never hardcoded.
  const fusion = goto((row) => row.kind === "fusion" && panel.state.config.fusions?.[row.fusionId]?.route);
  assert.ok(fusion, "the config carries a fusion with a route");
  panel.handleInput("\r");
  const decision = goto((row) => row.kind === "decision");
  assert.ok(decision, "its route opens to a decision");
  panel.handleInput("\r");
  const choice = goto((row) => row.kind === "choice");
  panel.handleInput("e");
  assert.ok(panel.state.picker, "the branch dropdown opens");
  for (let i = 0; i < panel.state.picker.options.length - 1; i += 1) panel.handleInput("j");
  panel.handleInput("\r");
  assert.ok(panel.state.textarea, "another decision asks its question before it exists");
  panel.handleInput("and is it risky?");
  panel.handleInput(ESC); // esc is done with the question — and the submit writes it
  await until(() => panel.state.pending === null, "the nested branch to be written");
  const written = JSON.parse(fs.readFileSync(layerFile, "utf8"));
  const then = written.fusions[choice.fusionId].route.criteria[choice.option].then;
  assert.equal(then.decide.instructions, "and is it risky?", "the nested decision is on disk");
  assert.equal(calls.done, 0, "and the matrix never closed");
  panel.dispose();
});
