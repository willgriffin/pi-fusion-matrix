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
 * Editing is deliberate. `⏎` expands an alias into the routes it walks, where `K`/`J` reorder them and
 * `d` drops one — each staged as a two-step *proposal*: the status bar shows it, the layer it would be
 * written to, *and whether the config still validates*; `s` writes it. `n` opens the *route builder* —
 * a provider → models tree beside the routes being built, in place of typed prompts: no provider id is
 * ever typed, `⏎` on a model adds that (provider, model) pair whole, `K`/`J`/`d` move and drop it in
 * the list beside the tree, and `s` writes the picked list through that same validated write. At alias
 * level `n` builds a new alias — its name is the one prompt left, and the alias's `model` is its first
 * route's picked model; at route level the builder holds that alias's whole list, seeded with what it
 * walks now. `e` re-points a seat on the routes tab. `esc` goes back (a builder step, then a prompt
 * step, then discarding a proposal, then leaving a route, then collapsing an alias) and only `q` quits.
 * A change that would not load is refused with the loader's own message before the file is touched —
 * the same rule the loader enforces, not a second opinion about it.
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
import {
  DEFAULT_CATALOGUE,
  DEFAULT_DB,
  byFusion,
  byFusionSeat,
  byModel,
  ingest,
  loadSqlite,
  openStore,
  readPriceCard,
  totals,
} from "./metrics-store.mjs";
import { configPaths, loadMatrixConfig, mergeConfig, validateConfig } from "../extensions/pi-fusion-matrix/config.js";

const args = process.argv.slice(2);
const has = (flag) => args.includes(`--${flag}`);
const value = (name, fallback) => {
  const at = args.lastIndexOf(`--${name}`);
  return at === -1 ? fallback : (args[at + 1] ?? fallback);
};

/* ------------------------------------------------------------------- state */

/**
 * The provider → models tree the route builder picks from, merged from everything that knows a pair:
 * pi's own registry (`registry.getAll()`, the catalogue the doctor checks against), the harness rate
 * card (`readPriceCard` over `DEFAULT_CATALOGUE`), and the pairs the config already names — an
 * alias's `model` under each of its providers, and a ref's `modelOverride` under its own id. Sorted
 * by provider, models sorted, duplicates collapsed. A source that is not there contributes nothing:
 * no registry is a smaller tree, never an error.
 */
export function catalogueFor({ registry, priceCard, config } = {}) {
  const byProvider = new Map();
  const add = (provider, model) => {
    if (typeof provider !== "string" || !provider || typeof model !== "string" || !model) return;
    const models = byProvider.get(provider) ?? new Set();
    models.add(model);
    byProvider.set(provider, models);
  };
  for (const entry of registry?.getAll?.() ?? []) add(entry?.provider, entry?.id);
  for (const row of priceCard?.rows ?? []) add(row?.provider, row?.model);
  for (const alias of Object.values(config?.aliases ?? {})) {
    for (const ref of alias?.providers ?? []) {
      add(typeof ref === "string" ? ref : ref?.id, alias?.model);
      if (ref && typeof ref === "object") add(ref.id, ref.modelOverride);
    }
  }
  return [...byProvider.keys()].sort().map((provider) => ({ provider, models: [...byProvider.get(provider)].sort() }));
}

/**
 * The whole interface state, built from the config and the store. `rows` is rebuilt on every reload;
 * `cursors` remembers where each tab was and `expanded` which aliases are open, so switching tabs or
 * reloading does not lose your place. The layer paths ride along because a proposal has to say which
 * file it would write.
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
  catalogue = [],
} = {}) {
  const state = {
    tab: "aliases",
    cursors: { aliases: 0, fusions: 0, routes: 0 },
    expanded: {},
    rows: {
      aliases: [],
      fusions: fusionRows({ config, fusionStats, seatStats }),
      routes: routeRows({ config, seatStats }),
    },
    stats: { modelStats, fusionStats, seatStats },
    config,
    catalogue,
    baseConfig,
    layerConfig,
    layerFile,
    storeTotals,
    pending: null,
    picker: null,
    input: null,
    builder: null,
    help: false,
    rain: true,
    color: true,
    message: source,
    layerReadError,
  };
  state.rows.aliases = aliasesView(state);
  return state;
}

/**
 * The config as the reader currently sees it: while a proposal names an alias's routes, that alias
 * shows the *proposed* list — what you see while editing is the proposal, not the disk.
 */
export function displayConfig(state) {
  const patch = state.pending?.patch?.aliases;
  if (!patch) return state.config;
  const aliases = {};
  for (const [alias, spec] of Object.entries(state.config.aliases ?? {})) {
    const providers = patch[alias]?.providers;
    aliases[alias] = Array.isArray(providers) ? { ...spec, providers } : spec;
  }
  return { ...state.config, aliases };
}

/** The aliases tab as its flat row list: parents in view order, each open one followed by its routes. */
export const aliasesView = (state) =>
  aliasRows({ config: displayConfig(state), modelStats: state.stats.modelStats, expanded: state.expanded });

/** The row the cursor is on, or undefined on an empty tab. */
export const selected = (state) => state.rows[state.tab][state.cursors[state.tab]];

/** The hints `e` answers with where it proposes nothing itself — the aliases list has its own keys. */
const EDIT_HINT = "enter expands · K/J move · n add · d drop · s saves · esc discards";
const LIST_KEYS = "K/J move · d drop need a route row — ⏎ expands an alias into its routes";
const READ_ONLY = "the fusions tab is read-only for now";

/**
 * The builder's tree as its visible rows — every provider in catalogue order, and the models under
 * exactly the ones that are open. `left` counts these: provider rows and their indented models.
 */
const treeRows = (tree, expanded) =>
  (tree ?? []).flatMap((entry) => [
    { kind: "provider", provider: entry.provider, models: entry.models ?? [] },
    ...(expanded?.[entry.provider] ? (entry.models ?? []).map((model) => ({ kind: "model", provider: entry.provider, model })) : []),
  ]);

/**
 * A key into a new state. No terminal, no I/O: the driver applies the effect, and the tests drive
 * this directly. Effects: `quit`, `reload`, `reingest`, `propose`, `save`, `none`.
 *
 * `1`/`2`/`3` are the only keys that switch tabs; `tab`/`shift-tab`, the arrows and `h`/`l` walk the
 * rows *inside* one — a tree on the aliases tab, where `enter` expands an alias into its routes and
 * the arrows move between a route and its parent. `K`/`J`/`d` reshape the route list under the cursor
 * as staged proposals `s` writes, while `n` opens the route builder — a provider → models tree beside
 * the routes being built, where `enter` adds a pair and `s` writes the picked list whole. At alias
 * level that builder defines a new alias (one name prompt first; the alias's `model` is its first
 * route's picked model), at route level it edits the cursor's alias's whole list. `esc` is back (the
 * builder first, then a prompt step, then a pending change, then a route, then an expansion), and only
 * `q` ever quits.
 */
export function applyKey(state, key) {
  const next = { ...state, cursors: { ...state.cursors }, message: state.message };
  const tab = state.tab;
  const rows = state.rows[tab];
  const row = rows[state.cursors[tab]];
  const move = (delta) => {
    next.cursors[tab] = clamp(state.cursors[tab] + delta, 0, Math.max(0, rows.length - 1));
  };
  // A change to `expanded` or `pending` changes which aliases-tab rows exist at all, so the view is
  // rebuilt through the same function the tests read it through, and the cursor clamped into it.
  const refresh = () => {
    next.rows = { ...next.rows, aliases: aliasesView(next) };
    next.cursors.aliases = clamp(next.cursors.aliases ?? 0, 0, Math.max(0, next.rows.aliases.length - 1));
  };
  const setExpanded = (alias, open) => {
    next.expanded = { ...state.expanded, [alias]: open };
    refresh();
  };
  const toParent = () => {
    const at = rows.findIndex((entry) => entry.kind === "alias" && entry.alias === row.parent);
    if (at >= 0) next.cursors[tab] = at;
  };
  const accept = (proposal) => {
    // Every proposal is a pending change — a boundary move's refusal too, whose summary is its
    // message and which `s` refuses to write rather than spend. INVALID or not, the bar already
    // shows the loader's verdict, so an invalid one needs no shout.
    next.pending = proposal;
    if (proposal.saveable === false) next.message = proposal.summary;
    else next.message = proposal.errors?.length ? "" : "proposed — s saves, esc discards";
    refresh();
  };

  // The route builder, asked before every other surface while it is open: the providers-and-models
  // tree on the left, the routes being built on the right. Only its own keys mean anything — `q`
  // included, everything else is inert — and ctrl-c is still the way out. `s` is the whole write: the
  // builder's `commit` either names its refusal (and the builder stays open over the list) or hands
  // back the proposal, staged exactly like a prompt's and saved in the same breath.
  if (state.builder) {
    const builder = state.builder;
    const flat = treeRows(builder.tree, builder.expanded);
    const node = flat[builder.left];
    const edited = (patch) => ({ state: { ...next, builder: { ...builder, ...patch } }, effect: "none" });
    if (key === "ctrl-c") return { state: next, effect: "quit" };
    if (key === "tab") return edited({ focus: "routes" });
    if (key === "shift-tab") return edited({ focus: "tree" });
    if (key === "j" || key === "down" || key === "k" || key === "up") {
      const delta = key === "j" || key === "down" ? 1 : -1;
      return builder.focus === "routes"
        ? edited({ right: clamp(builder.right + delta, 0, Math.max(0, builder.routes.length - 1)) })
        : edited({ left: clamp(builder.left + delta, 0, Math.max(0, flat.length - 1)) });
    }
    if (key === "return" || key === "enter") {
      if (builder.focus !== "tree" || !node) return { state: next, effect: "none" };
      if (node.kind === "provider") return edited({ expanded: { ...builder.expanded, [node.provider]: !builder.expanded[node.provider] } });
      // A model is picked whole — the pair it names is appended exactly, and the routes cursor sits
      // on it without dragging focus over, so a few can be picked in a row.
      const routes = [...builder.routes, { id: node.provider, model: node.model }];
      return edited({ routes, right: routes.length - 1 });
    }
    if (key === "right" || key === "l") {
      if (builder.focus !== "tree" || !node) return { state: next, effect: "none" };
      const open = treeRows(builder.tree, { ...builder.expanded, [node.provider]: true });
      const first = open.findIndex((entry) => entry.kind === "model" && entry.provider === node.provider);
      return edited({ expanded: { ...builder.expanded, [node.provider]: true }, left: first >= 0 ? first : builder.left });
    }
    if (key === "left" || key === "h") {
      if (builder.focus !== "tree" || !node) return { state: next, effect: "none" };
      if (node.kind === "provider") return edited({ expanded: { ...builder.expanded, [node.provider]: false } });
      return edited({ left: flat.findIndex((entry) => entry.kind === "provider" && entry.provider === node.provider) });
    }
    if (key === "K" || key === "J") {
      const to = builder.right + (key === "K" ? -1 : 1);
      if (builder.focus !== "routes" || to < 0 || to >= builder.routes.length) return { state: next, effect: "none" };
      const routes = [...builder.routes];
      [routes[builder.right], routes[to]] = [routes[to], routes[builder.right]];
      return edited({ routes, right: to });
    }
    if (key === "d") {
      if (builder.focus !== "routes" || builder.routes.length === 0) return { state: next, effect: "none" };
      const routes = builder.routes.filter((_, at) => at !== builder.right);
      return edited({ routes, right: clamp(builder.right, 0, Math.max(0, routes.length - 1)) });
    }
    if (key === "s") {
      const out = builder.commit(builder.routes);
      if (out.error !== undefined) {
        next.message = out.error;
        return { state: next, effect: "none" };
      }
      if (out.proposal !== undefined) {
        next.builder = null;
        accept(out.proposal);
        return { state: next, effect: "save" };
      }
      return { state: next, effect: "none" };
    }
    if (key === "escape") {
      // Back, to the modal that opened this one: an earlier builder takes the builder slot again, the
      // alias chain's name step comes back over its typing, and a directly opened builder just closes.
      const back = builder.back ?? null;
      if (typeof back?.commit === "function") next.builder = back;
      else {
        next.builder = null;
        next.input = back;
      }
      return { state: next, effect: "none" };
    }
    return { state: next, effect: "none" };
  }

  // The typing surface, asked next while it is open: an answer is going in, so every printable key
  // is text — `q` types a q rather than quitting — and only these named keys mean anything else. A
  // step's `submit` answers with one of three outcomes: an error names the refusal and keeps the
  // prompt over its typing, an input is the chain's next step (another prompt, or the route builder
  // that ends the alias chain), a proposal is the change itself.
  if (state.input) {
    const input = state.input;
    if (key === "backspace") next.input = { ...input, value: input.value.slice(0, -1) };
    else if (key === "return" || key === "enter") {
      const out = input.submit(input.value.trim());
      if (out.error !== undefined) next.message = out.error;
      else if (out.input !== undefined) {
        // The chain's next step: another prompt, or — the end of the alias chain — the route builder,
        // which takes the builder slot over the typing rather than the input one.
        if (typeof out.input.commit === "function") {
          next.input = null;
          next.builder = out.input;
        } else next.input = out.input;
      } else if (out.proposal !== undefined) {
        next.input = null;
        accept(out.proposal);
        // Submitting the prompt is create *and* save: the staged proposal goes through the same
        // loader-validated write `s` runs, so what was just typed lands without a second key.
        return { state: next, effect: "save" };
      }
    } else if (key === "escape") next.input = input.back ?? null;
    else if (key === "ctrl-c") return { state: next, effect: "quit" };
    else if (key === "tab" || key === "shift-tab" || key === "up" || key === "down" || key === "left" || key === "right") {
      // The row-walking keys stand still while a name is being typed.
    } else {
      // Anything else is typed text — a paste arrives as one multi-character key and appends whole.
      const typed = key.replace(/\p{Cc}/gu, "");
      if (typed) next.input = { ...input, value: input.value + typed };
    }
    return { state: next, effect: "none" };
  }

  // And ctrl-c quits from outside the typing surface too — the safety valve in every modal.
  if (key === "ctrl-c") return { state: next, effect: "quit" };

  if (state.picker) {
    if (key === "escape" || key === "q") return { state: { ...next, picker: null }, effect: "none" };
    if (key === "j" || key === "down")
      next.picker = { ...state.picker, cursor: clamp(state.picker.cursor + 1, 0, state.picker.options.length - 1) };
    else if (key === "k" || key === "up")
      next.picker = { ...state.picker, cursor: clamp(state.picker.cursor - 1, 0, state.picker.options.length - 1) };
    else if (key === "return" || key === "enter") {
      const chosen = state.picker.options[state.picker.cursor];
      next.picker = null;
      accept(state.picker.pending(chosen));
      return { state: next, effect: "none" };
    }
    return { state: next, effect: "none" };
  }

  if (state.help && (key === "?" || key === "escape")) return { state: { ...next, help: false }, effect: "none" };

  if (key === "q") return { state: next, effect: "quit" };
  if (key === "escape") {
    // Back, in the order that gets you out: a proposal first, then a route, then an expansion.
    if (state.pending) {
      next.pending = null;
      next.message = "change discarded";
      refresh();
    } else if (row?.kind === "route") toParent();
    else if (row?.kind === "alias" && row.expanded) setExpanded(row.alias, false);
  } else if (key === "j" || key === "down") move(1);
  else if (key === "k" || key === "up") move(-1);
  else if (key === "g") next.cursors[tab] = 0;
  else if (key === "G") next.cursors[tab] = Math.max(0, rows.length - 1);
  else if (key === "1" || key === "2" || key === "3") next.tab = TABS[Number(key) - 1];
  else if (key === "return" || key === "enter") {
    if (row?.kind === "route") {
      toParent();
      setExpanded(row.parent, false);
    } else if (row?.kind === "alias" && row.childCount > 0) setExpanded(row.alias, !row.expanded);
  } else if (key === "left" || key === "h" || key === "shift-tab") {
    if (row?.kind === "route") toParent();
    else if (row?.kind === "alias" && row.expanded) setExpanded(row.alias, false);
  } else if (key === "right" || key === "l" || key === "tab") {
    if (row?.kind === "alias" && !row.expanded && row.childCount > 0) setExpanded(row.alias, true);
    else if (row?.kind === "alias" && row.expanded) {
      const at = rows.findIndex((entry) => entry.kind === "route" && entry.parent === row.alias);
      if (at >= 0) next.cursors[tab] = at;
    } else if (row?.kind === "route") {
      const sibling = rows[state.cursors[tab] + 1];
      if (sibling?.kind === "route" && sibling.parent === row.parent) move(1);
    }
  } else if (key === "K" || key === "J") {
    if (row?.kind !== "route") next.message = LIST_KEYS;
    else {
      const delta = key === "K" ? -1 : 1;
      const proposal = proposeRouteMove({ state, row, delta });
      // The route moved one place over in the same flat list, and the cursor follows it there; at a
      // boundary nothing moved, so the cursor stays where the reader put it.
      if (proposal.saveable !== false) next.cursors[tab] = state.cursors[tab] + delta;
      accept(proposal);
    }
  } else if (key === "d") {
    if (row?.kind !== "route") next.message = LIST_KEYS;
    else accept(proposeRouteDrop({ state, row }));
  } else if (key === "n") {
    if (tab !== "aliases" || !row) next.message = LIST_KEYS;
    else if (!state.catalogue?.length) next.message = "no provider/model list to choose from";
    else if (row.kind === "route") {
      // A route row's `n` edits its alias's WHOLE list in the route builder, seeded with the current
      // refs at their effective models — reordered, dropped and picked again there, then written
      // wholesale by `s`. The alias's own model never moves.
      const owner = listOwner(row);
      const spec = displayConfig(state).aliases?.[owner] ?? {};
      next.builder = {
        title: `${owner}: routes`,
        tree: state.catalogue,
        expanded: {},
        left: 0,
        routes: (spec.providers ?? []).map((ref) => ({ id: refName(ref), model: effectiveModel(ref, spec) })),
        right: 0,
        focus: "tree",
        commit: (routes) =>
          routes.length ? { proposal: proposeRouteList({ state, row, routes }) } : { error: "a route list cannot be empty" },
        back: null,
      };
    } else {
      // An alias's sibling is a whole alias, and the builder is what defines it: the name prompt
      // chains straight into the route builder over its typing, `esc` steps back to the name with its
      // typing, and the new alias's `model` is simply its first route's picked model.
      const nameStep = {
        title: "new alias",
        value: "",
        hint: "type the alias name · enter continues · esc back",
        back: null,
        submit: (name) => {
          if (!name) return { error: "an alias needs a name" };
          if (Object.keys(displayConfig(state).aliases ?? {}).includes(name)) return { error: `${name} already exists` };
          return { input: builderStep(name) };
        },
      };
      const builderStep = (name) => ({
        title: `${name}: routes`,
        tree: state.catalogue,
        expanded: {},
        left: 0,
        routes: [],
        right: 0,
        focus: "tree",
        commit: (routes) =>
          routes.length
            ? { proposal: proposeAliasCreate({ state, name, model: routes[0].model, routes }) }
            : { error: "an alias needs at least one route" },
        // Back is the step before, as it was left — its typing comes back with it.
        back: { ...nameStep, value: name },
      });
      next.input = nameStep;
    }
  } else if (key === "e") {
    // Only the aliases tab answers with a hint instead of a proposal: its list has its own keys.
    if (tab === "aliases") next.message = EDIT_HINT;
    else return { state: next, effect: "propose" };
  } else if (key === "a") next.rain = !state.rain;
  else if (key === "c") next.color = !state.color;
  else if (key === "?") next.help = !state.help;
  else if (key === "r") return { state: next, effect: "reload" };
  else if (key === "R") return { state: next, effect: "reingest" };
  else if (key === "s") {
    if (!state.pending) next.message = "nothing to save — e proposes a change";
    else if (state.pending.saveable === false) next.message = "nothing to write — that proposal changes nothing";
    else if (state.pending.errors.length > 0) next.message = `refused: ${state.pending.errors[0]}`;
    else return { state: next, effect: "save" };
  }
  return { state: next, effect: "none" };
}

/**
 * A terminal chunk into a key name. Arrows and shift-tab arrive as escape sequences in one chunk, and
 * an escape-prefixed chunk is never text: what is not a sequence this knows is `escape`, so nothing the
 * terminal sent as a sequence can end up typed into a field. Hosts that spell key names instead of
 * sending bytes map to the same ones; anything else arrives verbatim, a paste whole.
 */
export function keyName(chunk) {
  if (chunk === "\t") return "tab";
  if (chunk === "\r" || chunk === "\n") return "return";
  if (chunk === "\u007f" || chunk === "\b") return "backspace";
  if (chunk === "\u0003") return "ctrl-c";
  if (chunk === "\u001b") return "escape";
  if (chunk.startsWith("\u001b[")) {
    const code = chunk.slice(2);
    if (code === "A") return "up";
    if (code === "B") return "down";
    if (code === "C") return "right";
    if (code === "D") return "left";
    if (code === "Z") return "shift-tab";
    return "escape";
  }
  if (chunk.startsWith("\x1b")) return "escape";
  if (chunk === "Escape" || chunk === "escape" || chunk === "ESC") return "escape";
  if (chunk === "Enter" || chunk === "Return") return "return";
  if (chunk === "Backspace") return "backspace";
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

/** A provider entry as its id: the config takes a plain name or an object carrying overrides. */
const refName = (ref) => (typeof ref === "string" ? ref : (ref.id ?? "?"));

/** A route's effective model: the alias's own `model`, or the ref's `modelOverride` where it names one. */
const effectiveModel = (ref, alias) => (typeof ref === "string" ? alias.model : (ref.modelOverride ?? alias.model));

/**
 * A picked pair the way `matrix-info` prints a route: the provider alone where the pair walks
 * `model`, and `provider:model` where it names another one.
 */
const pairLabel = (pair, model) => (pair.model === model ? pair.id : `${pair.id}:${pair.model}`);

/** The alias a route-list row belongs to — its parent, or the row itself when it is the parent. */
const listOwner = (row) => (row.kind === "route" ? row.parent : row.alias);

/**
 * The baseline a route-list proposal builds over: the pending one for the same alias when there is
 * one — a refusal's unchanged list as much as a move's net order, so `J` presses on either side of a
 * boundary are still one pending change — and the layer on disk otherwise, which stays the baseline
 * `commitProposal` re-checks against.
 */
const routeBaseline = (state, owner) =>
  state.pending?.listOf === owner && state.pending.layerFile === state.layerFile
    ? deepClone(state.pending.patch)
    : deepClone(state.layerConfig);

/** The baseline with one alias's route list replaced: the patch every route-list change writes. */
const routePatch = (state, row, providers) => {
  const owner = listOwner(row);
  const patch = routeBaseline(state, owner);
  patch.aliases = patch.aliases ?? {};
  patch.aliases[owner] = patch.aliases[owner] ?? {};
  patch.aliases[owner].providers = providers;
  return patch;
};

/** The summary every route-list change shares: the alias and the FULL list it would end up walking. */
const triesSummary = (owner, providers) => `${owner} now tries ${providers.map(refName).join(" → ") || "nothing"}`;

/**
 * The change moving a route proposes: the alias's list with the cursor's route one place up or down.
 * At either end there is nothing to move, and the proposal says so (`saveable: false`) rather than
 * letting `s` write the order the file already has.
 */
export function proposeRouteMove({ state, row, delta }) {
  const owner = listOwner(row);
  const providers = [...(displayConfig(state).aliases?.[owner]?.providers ?? [])];
  const to = row.index + delta;
  if (to < 0 || to >= providers.length) {
    return {
      listOf: owner,
      layerFile: state.layerFile,
      patch: routeBaseline(state, owner),
      summary: `${owner}: that route is already ${to < 0 ? "first" : "last"}`,
      errors: [],
      saveable: false,
    };
  }
  [providers[row.index], providers[to]] = [providers[to], providers[row.index]];
  const patch = routePatch(state, row, providers);
  return {
    listOf: owner,
    layerFile: state.layerFile,
    patch,
    summary: triesSummary(owner, providers),
    errors: validateAgainst(state, patch),
  };
}

/**
 * The change dropping a route proposes: the alias's list without the cursor's route. Dropping the
 * last one leaves the list empty, and the loader is what refuses that — not this function.
 */
export function proposeRouteDrop({ state, row }) {
  const owner = listOwner(row);
  const providers = [...(displayConfig(state).aliases?.[owner]?.providers ?? [])];
  providers.splice(row.index, 1);
  const patch = routePatch(state, row, providers);
  return {
    listOf: owner,
    layerFile: state.layerFile,
    patch,
    summary: triesSummary(owner, providers),
    errors: validateAgainst(state, patch),
  };
}

/**
 * Picked pairs as provider refs: the plain id where the pair walks the alias's `model`, and an
 * explicit `modelOverride` where it names another model. A pair is stored exactly as picked — never
 * substituted toward the alias's model, and never away from it.
 */
const normalizeRefs = (routes, model) =>
  routes.map((pair) => (pair.model === model ? pair.id : { id: pair.id, modelOverride: pair.model }));

/**
 * The change the route builder commits over an existing alias: its list, WHOLESALE, exactly as
 * picked. What was there is replaced rather than spliced — the only honest write for a list that was
 * seeded, reordered and re-picked in one sitting — and the alias's own `model` never moves here:
 * editing the routes must not re-point the alias, so each pair is stored against it (`modelOverride`
 * only where a pair names a different model).
 */
export function proposeRouteList({ state, row, routes }) {
  const owner = listOwner(row);
  const refs = normalizeRefs(routes, displayConfig(state).aliases?.[owner]?.model);
  const patch = routePatch(state, row, refs);
  return {
    listOf: owner,
    layerFile: state.layerFile,
    patch,
    summary: triesSummary(owner, refs),
    errors: validateAgainst(state, patch),
  };
}

/**
 * The change creating an alias proposes: the alias the route builder's picked list defines — its
 * `model` is the first route's picked model, and the list is stored exactly as picked. It is the end
 * of the name → builder chain. It builds over the same baseline the route-list changes do, so it
 * accumulates into a pending change for the same name rather than starting again from the layer on
 * disk, and the alias it names replaces whatever entry was there.
 */
export function proposeAliasCreate({ state, name, model, routes }) {
  const patch = routeBaseline(state, name);
  patch.aliases = patch.aliases ?? {};
  patch.aliases[name] = { model, providers: normalizeRefs(routes, model) };
  return {
    listOf: name,
    layerFile: state.layerFile,
    patch,
    summary: `${name} = ${model} @ ${routes.map((pair) => pairLabel(pair, model)).join(" → ")}`,
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

/**
 * The interactive `e`: a proposal for the selected row, through a picker where one is needed. The
 * aliases tab never comes here — its tree is edited with `K`/`J`/`n`/`d`, `n` opening the route
 * builder — and the fusions tab has nothing to propose yet.
 */
export function proposeFor(state) {
  const row = selected(state);
  if (!row) return { ...state, message: "nothing selected" };
  if (state.tab !== "routes") return { ...state, message: state.tab === "aliases" ? EDIT_HINT : READ_ONLY };
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

  // The key map, as much of it as fits. Even the short form names the tabs and the rain toggle — the
  // two things a reader would otherwise never discover (`1`-`3`, and that `a` is a toggle at all).
  const rainState = state.rain ? "rain:ON" : "rain:OFF";
  const keys =
    "1/2/3 tabs · j/k or ↓/↑ rows · enter expand/collapse · ← back · → forward · tab/shift-tab same · K/J move route · n route builder · " +
    `d drop route · e edit (routes) · s save · esc back/discard · R reingest · r reload · a ${rainState} · c colour · ? help · q quit`;
  const keysShort = `1-3 tabs · j/k rows · ⏎ open · K/J move · n builder · d drop · a ${rainState} · ? help · q quit`;
  const hint = width > keys.length + 12 ? keys : keysShort;
  put(grid, height - 1, Math.max(1, width - hint.length - 1), truncate(hint, width - 2), palette.dim);
  put(grid, height - 1, 1, clock, palette.dim);

  if (state.help) {
    const helpRows = [
      "aliases — the alias, the model it names, its routes, and what the store saw it do",
      "fusions — mode and face, then runs, failures, degraded seats, cascades, verify, findings, cost",
      "routes  — per fusion and seat: the ordered candidates from config, which alias answered, what refused",
      "keys — 1/2/3 tabs · j/k or ↓/↑ rows · enter expand/collapse · ← back · → forward · tab/shift-tab same",
      "       K/J move route · n route builder · d drop route · e edit (routes) · s save · esc back/discard · R reingest",
      "       r reload · a rain · c colour · q quit",
      "e re-points a seat (routes tab); ⏎ expands an alias into the routes K/J and d reshape",
      "K/J/d stage a proposal: the bar shows it and whether it still validates, s writes it to the",
      "layer named under it once the loader accepts it; n opens the route builder — a provider/model",
      "tree beside the routes being built, where ⏎ adds a pick and J/K/d move and drop the list;",
      "s writes the picked list whole, a new alias's model is its first route's model, and esc backs out",
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

  // The answer being typed, over the same centre the picker uses: the value with its caret, and the
  // step's own second line — what it asks for, and the keys that continue or step back.
  if (state.input) {
    const line = `${state.input.value}▌`;
    const hint = state.input.hint ?? "";
    const boxWidth = Math.min(width - 6, Math.max(24, line.length + 4, hint.length + 4));
    const boxHeight = 4;
    const top = Math.max(2, Math.floor((height - boxHeight) / 2));
    const inner = drawPanel(
      grid,
      { row: top, col: Math.floor((width - boxWidth) / 2), width: boxWidth, height: boxHeight, title: state.input.title },
      palette,
    );
    put(grid, inner.row, inner.col, truncate(line, inner.width), palette.ink);
    put(grid, inner.row + 1, inner.col, truncate(hint, inner.width), palette.dim);
  }

  // The route builder, over everything else: a box that sizes itself to its content and fills most of
  // the width when there is width to fill. The provider → models tree on the left, the routes being
  // built on the right, and under both the alias's identity line and the keys that finish or back out.
  if (state.builder) {
    const builder = state.builder;
    const flat = treeRows(builder.tree, builder.expanded);
    const treeLines = flat.map((entry) =>
      entry.kind === "provider" ? `${builder.expanded[entry.provider] ? "▾" : "▸"} ${entry.provider}` : `  ${entry.model}`,
    );
    const routeLines = builder.routes.map((pair) => `${pair.id} → ${pair.model}`);
    const shown = routeLines.length ? routeLines : ["no routes yet"];
    const want = (lines, title) => Math.max(10, title.length + 2, ...lines.map((line) => line.length + 2));
    const contentWidth = want(treeLines, "models") + 3 + want(shown, "routes");
    const boxWidth = Math.min(width - 4, Math.max(contentWidth, Math.floor((width - 4) * 0.8), 28));
    const boxHeight = Math.min(height - 4, Math.max(treeLines.length, routeLines.length, 1) + 5);
    const top = Math.max(2, Math.floor((height - boxHeight) / 2));
    const inner = drawPanel(
      grid,
      { row: top, col: Math.floor((width - boxWidth) / 2), width: boxWidth, height: boxHeight, title: builder.title },
      palette,
    );
    const leftCol = Math.min(want(treeLines, "models"), Math.max(10, Math.floor((inner.width - 3) / 2)));
    const at = inner.col + leftCol + 3;
    const rightCol = Math.max(0, inner.width - leftCol - 3);
    const body = Math.max(0, inner.height - 3);
    // Both panes keep their cursor on screen the way the picker does — a cursor scrolled out of its
    // own box is a blind commit.
    const view = (count, cursor) => {
      const first = clamp(cursor - body + 1, 0, Math.max(0, count - body));
      return { first, last: Math.min(count, first + body) };
    };
    put(grid, inner.row, inner.col, truncate("models", leftCol), builder.focus === "tree" ? palette.accent : palette.dim);
    put(grid, inner.row, at, truncate("routes", rightCol), builder.focus === "routes" ? palette.accent : palette.dim);
    for (let row = inner.row; row < inner.row + inner.height; row += 1) put(grid, row, inner.col + leftCol + 1, "│", palette.box);
    const treeView = view(treeLines.length, builder.left);
    for (let i = treeView.first; i < treeView.last; i += 1) {
      put(
        grid,
        inner.row + 1 + (i - treeView.first),
        inner.col,
        truncate(treeLines[i], leftCol),
        i === builder.left ? (builder.focus === "tree" ? palette.selected : palette.accent) : palette.ink,
      );
    }
    const routeView = view(shown.length, builder.right);
    for (let i = routeView.first; i < routeView.last; i += 1) {
      const style = !routeLines.length
        ? palette.dim
        : i === builder.right
          ? builder.focus === "routes"
            ? palette.selected
            : palette.accent
          : palette.ink;
      put(grid, inner.row + 1 + (i - routeView.first), at, truncate(shown[i], rightCol), style);
    }
    // The identity line is `matrix-info`'s own line, live: the name, the model the alias carries (the
    // existing one at route-edit time — the `commit` closure is the authority here, never this line —
    // and the first route's model only while a new alias is being picked), then the routes as picked.
    const name = builder.title.replace(/: routes$/, "");
    const model = displayConfig(state).aliases?.[name]?.model ?? builder.routes[0]?.model ?? "—";
    const picked = builder.routes.map((pair) => pairLabel(pair, model)).join(" → ") || "—";
    const identity = `${name} = ${model} @ ${picked}`;
    put(grid, inner.row + inner.height - 2, inner.col, truncate(identity, inner.width), palette.ink);
    const hintLine = "tab pane · ⏎ open/add · J/K move · d drop · s writes · esc back";
    put(grid, inner.row + inner.height - 1, inner.col, truncate(hintLine, inner.width), palette.dim);
  }

  return grid;
}

/** The line under the table: the selected row's own detail, so a truncated cell stays readable. */
export function detailFor(state, row) {
  if (!row) return "";
  if (row.kind === "route") {
    return `${row.parent} · route ${row.index + 1}/${row.count}: ${row.provider} → ${row.model} · seats ${row.seats} · kept ${row.kept}/${row.raised} · located ${row.located}, unlocated ${row.unlocated}`;
  }
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

/**
 * The rain under the interface: interface cells win — including a styled blank, which is a row's own
 * background (the selection paints to the panel edge) and must not be eaten by rain passing through
 * its padding. Untouched cells are windows.
 */
export function composeOverRain(grid, rainField, palette, { width, height }) {
  const { levels, glyphs } = cells(rainField);
  const composed = createGrid(width, height);
  const colors = { 1: palette.tail, 2: palette.body, 3: palette.head };
  for (let i = 0; i < composed.ch.length; i += 1) {
    const level = levels[i] ?? 0;
    if (level > 0 && grid.ch[i] === " " && !grid.fg[i]) {
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

/**
 * Load the config and the store's stats. A missing store is a named state, not an empty table. The
 * same read collects the route builder's tree: pi's `registry`, the rate card at `catalogue`, and the
 * pairs the config names, merged by `catalogueFor`.
 */
export async function loadWorld({
  dbPath = DEFAULT_DB,
  cwd = process.cwd(),
  layerFile,
  registry = null,
  catalogue = DEFAULT_CATALOGUE,
} = {}) {
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
    catalogue: catalogueFor({ registry, priceCard: readPriceCard(catalogue), config: loaded.config }),
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
 * tab every time a change was saved. The catalogue the route builder picks from belongs to the view
 * too — session knowledge (registry, rate card, config pairs), not layer state. Cursors are clamped to
 * what the reloaded tabs actually hold — a reload can shrink a table (a store that emptied, a fusion
 * that went away), and a stale cursor reads as "nothing selected" with a blank detail line rather than
 * as the move it was. Every modal closes: the layer was re-read under it.
 */
export const adopt = (current, reloaded) => {
  const state = {
    ...current,
    ...reloaded.state,
    tab: TABS.includes(current.tab) && reloaded.state.rows[current.tab] ? current.tab : "aliases",
    cursors: { ...current.cursors },
    expanded: current.expanded ?? {},
    help: current.help,
    picker: null,
    input: null,
    builder: null,
    rain: current.rain,
    color: current.color,
    catalogue: current.catalogue ?? reloaded.state.catalogue,
  };
  // Which aliases are open is view state too, so the aliases rows are rebuilt around it exactly as a
  // key that changes it rebuilds them — before the cursors are clamped into what is actually there.
  state.rows = { ...state.rows, aliases: aliasesView(state) };
  for (const tab of TABS) state.cursors[tab] = clamp(state.cursors[tab] ?? 0, 0, Math.max(0, state.rows[tab].length - 1));
  return state;
};

/**
 * The one path that touches the filesystem: a proposal, written. Kept small, free of terminal
 * concerns, and deliberately paranoid — because every guard here has to hold *at the moment of
 * writing*, not at the moment of proposing:
 *
 * - the layer file is re-read from disk (an operator may have edited, corrupted or replaced it since
 *   the interface loaded), and its content must still be the content the proposal was built over;
 * - the base config is re-loaded (a checkout changing under us changes what the loader accepts);
 * - the loader gives its verdict on the merged result — the same `validateConfig` that decides
 *   whether the change is legal, not a second opinion;
 * - only then does the write happen, and it writes the proposal, never a merge of what we just read.
 *
 * Each refusal returns the state it refuses with its message and `wrote: false`, so a caller — and a
 * test — can assert that nothing was written.
 */
export async function commitProposal(state, { dbPath, cwd = process.cwd() } = {}) {
  const pending = state.pending;
  if (!pending) return { state, wrote: false };
  if (!pending.layerFile) return { state: { ...state, message: "refused: this proposal names no layer file to write" }, wrote: false };
  if (pending.saveable === false) return { state: { ...state, message: "nothing to write — that proposal changes nothing" }, wrote: false };
  if (pending.errors.length > 0) return { state: { ...state, message: `refused: ${pending.errors[0]}` }, wrote: false };

  const fresh = readLayer(pending.layerFile);
  if (!fresh.ok) return { state: { ...state, message: `refused: ${fresh.reason}` }, wrote: false };
  if (JSON.stringify(fresh.config) !== JSON.stringify(state.layerConfig)) {
    return {
      state: { ...state, message: "refused: the layer changed since this proposal was built — reload and propose again" },
      wrote: false,
    };
  }

  let base;
  try {
    base = loadMatrixConfig({ cwd, layers: ["packaged", "cwd"] }).config;
  } catch (error) {
    return { state: { ...state, message: `refused: the base config no longer loads: ${error?.message ?? String(error)}` }, wrote: false };
  }
  const errors = validateConfig(mergeConfig(base, pending.patch), {}).map((error) =>
    typeof error === "string" ? error : JSON.stringify(error),
  );
  if (errors.length > 0) return { state: { ...state, message: `refused: ${errors[0]}` }, wrote: false };

  try {
    fs.mkdirSync(path.dirname(pending.layerFile), { recursive: true });
    fs.writeFileSync(pending.layerFile, `${JSON.stringify(pending.patch, null, 2)}\n`);
  } catch (error) {
    return { state: { ...state, message: `the change could not be written: ${error?.message ?? String(error)}` }, wrote: false };
  }

  try {
    const reloaded = await loadWorld({ dbPath, layerFile: pending.layerFile, cwd });
    return { state: { ...adopt(state, reloaded), pending: null, message: `saved: ${pending.summary}` }, wrote: true };
  } catch (error) {
    return {
      state: { ...state, pending: null, message: `saved, but the view could not be reloaded: ${error?.message ?? String(error)}` },
      wrote: true,
    };
  }
}

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
  const world = await loadWorld({ dbPath, layerFile, catalogue });
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
    // The write itself lives in `commitProposal`: it re-reads the layer and the base config from disk
    // immediately before writing, so this call cannot carry a stale verdict to the filesystem.
    state = (await commitProposal(state, { dbPath })).state;
  };

  const reload = async (note) => {
    const reloaded = await loadWorld({ dbPath, layerFile, catalogue });
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
