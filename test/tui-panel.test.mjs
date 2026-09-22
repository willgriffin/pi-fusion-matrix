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

const ESC = String.fromCharCode(27);
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

/** A panel over its own store and layer file, mounted with a fake host that records the close. */
async function mountPanel(t, tab) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tui-panel-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const layerFile = path.join(dir, "layer.json");
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
    cwd: process.cwd(),
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

/** The first alias row whose alias carries more than one route, or less than one. */
function findRow(panel, predicate) {
  for (let i = 0; i < panel.state.rows.aliases.length; i += 1) {
    panel.handleInput("g");
    for (let step = 0; step < i; step += 1) panel.handleInput("j");
    const row = panel.state.rows.aliases[panel.state.cursors.aliases];
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
  assert.ok(shows(lines, "FUSION MATRIX"), `the header renders — row 0: ${JSON.stringify(visible(lines[0]))}`);
  assert.ok(
    shows(lines, "absent.db"),
    `a missing store is a named state, not an empty table — notes: ${JSON.stringify(lines.map(visible).filter((row) => row.includes("store")))}`,
  );
  panel.dispose();
});

test("keys move the reader and the toggles; unknown keys are inert", async (t) => {
  const { panel, calls } = await mountPanel(t);
  const before = JSON.stringify([panel.state.tab, panel.state.cursors, panel.state.rain, panel.state.color]);
  panel.handleInput("\t");
  assert.equal(panel.state.tab, "fusions", "tab cycles forward");
  assert.ok(shows(panel.render(100), "fusions —"), "the tab is visible in the frame");
  panel.handleInput("\u001b[Z");
  assert.equal(panel.state.tab, "aliases", "shift-tab cycles back");
  panel.handleInput("3");
  assert.equal(panel.state.tab, "routes", "a number keys the tab directly");
  panel.handleInput("1");
  assert.equal(panel.state.tab, "aliases", "…and one returns to the first");
  panel.handleInput("a");
  assert.equal(panel.state.rain, false, "rain toggles");
  panel.handleInput("a");
  panel.handleInput("c");
  assert.equal(panel.state.color, false, "colour toggles");
  panel.handleInput("c");
  const after = JSON.stringify([panel.state.tab, panel.state.cursors, panel.state.rain, panel.state.color]);
  assert.equal(after, before, "the display state returns to where it started");
  panel.handleInput("x");
  assert.equal(
    JSON.stringify([panel.state.tab, panel.state.cursors, panel.state.rain, panel.state.color]),
    before,
    "an unbound key does nothing",
  );
  assert.equal(calls.done, 0, "and none of it closes the panel");
  panel.dispose();
});

test("a one-route alias's edit is a named refusal, and save writes nothing", async (t) => {
  const { panel, layerFile } = await mountPanel(t);
  const found = findRow(panel, (providers) => providers.length === 1);
  assert.ok(found, "the config carries an alias with a single route");
  panel.handleInput("e");
  assert.ok(panel.state.pending, "the reader is told something");
  assert.equal(panel.state.pending.saveable, false, "…and it is a refusal, not a proposal");
  panel.handleInput("s");
  assert.ok(panel.state.pending, "the refusal stays visible rather than being spent");
  assert.ok(!fs.existsSync(layerFile), "and no layer file is created to hold the state it already has");
  assert.ok(shows(panel.render(100), found.row.alias), "the refusal names the alias");
  panel.dispose();
});

test("a proposal names its layer file, and save writes the rotated routes through to disk", async (t) => {
  const { panel, layerFile } = await mountPanel(t);
  const found = findRow(panel, (providers) => providers.length >= 2);
  assert.ok(found, "the config carries an alias with two routes to rotate");
  panel.handleInput("e");
  assert.ok(panel.state.pending, "a proposal is pending");
  assert.notEqual(panel.state.pending.saveable, false, "…and it is saveable");
  assert.ok(shows(panel.render(100), path.basename(layerFile)), "the proposal names the file it would write");
  panel.handleInput("s");
  await until(() => panel.state.pending === null, "the proposal to be spent");
  assert.ok(fs.existsSync(layerFile), "the layer file was written");
  const written = JSON.parse(fs.readFileSync(layerFile, "utf8"));
  const providers = written.aliases?.[found.row.alias]?.providers ?? [];
  assert.deepEqual(providers, [...found.providers.slice(1), found.providers[0]], "the route order is rotated on disk");
  panel.dispose();
});

test("a named tab opens there, and both close paths close exactly once", async (t) => {
  const { panel, calls } = await mountPanel(t, "routes");
  assert.equal(panel.state.tab, "routes", "/matrix routes opens on routes");
  panel.handleInput("\t");
  assert.equal(panel.state.tab, "aliases", "…and the reader is not leashed to it");
  panel.handleInput("\u0007");
  assert.equal(calls.done, 1, "the interrupt action closes the panel once");
  assert.equal(calls.value, undefined, "…with nothing to report");
  panel.handleInput("q");
  assert.equal(calls.done, 1, "a closed panel ignores further keys");
  panel.dispose();
  panel.dispose();

  const second = await mountPanel(t);
  second.panel.handleInput("q");
  assert.equal(second.calls.done, 1, "q closes the panel once");
  second.panel.dispose();
});
