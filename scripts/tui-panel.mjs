/**
 * The interface as a host component: the same frames the standalone `matrix-tui.mjs` draws, mounted
 * inside a full-screen host that owns the terminal.
 *
 * This exists because a full-screen program run under another full-screen program fights it for the
 * screen. The standalone driver takes the alternate screen, hides the cursor and puts stdin in raw
 * mode — run it inside a harness and the harness is the one that comes out garbled. A component has
 * none of that: it returns lines and answers keys, and the host does every byte of terminal I/O.
 *
 * Nothing here is a second renderer. The interface's own modules stay the single source of frames
 * and key handling: `frameFor` builds the grid, `applyKey` is the state transition, `proposeFor` and
 * `commitProposal` are the two-step editor (which re-reads the layer from disk at write time). The
 * only thing this module translates is the last inch: a grid row into styled text, and the host's
 * key chunks into the key names `applyKey` already speaks.
 */
import { createRain, resizeRain, stepRain } from "./tui-rain.mjs";
import { paletteFor } from "./tui-view.mjs";
import { DEFAULT_CATALOGUE, DEFAULT_DB, ingest, loadSqlite } from "./metrics-store.mjs";
import { adopt, applyKey, commitProposal, composeOverRain, frameFor, keyName, loadWorld, proposeFor } from "./matrix-tui.mjs";

/** A grid row as styled text: `paint`'s per-cell style grouping without the cursor moves a
 * component never issues — the host positions the lines it is handed. */
export function styledLine(grid, row, palette) {
  let out = "";
  let style = null;
  let open = false;
  for (let col = 0; col < grid.width; col += 1) {
    const at = row * grid.width + col;
    const cellStyle = grid.fg[at] ?? "";
    if (cellStyle !== style) {
      if (open) out += palette.reset;
      out += cellStyle;
      style = cellStyle;
      open = cellStyle !== "";
    }
    out += grid.ch[at];
  }
  return open ? out + palette.reset : out;
}

/** The three tabs, in display order — the set `/matrix <tab>` accepts. */
export const TAB_NAMES = ["aliases", "fusions", "routes"];

/**
 * The interface as a `Component`: `render(width)` gives width-safe lines, `handleInput(data)` takes
 * host key chunks, `dispose()` stops the rain clock (twice if it has to be).
 */
export class MatrixPanel {
  constructor({ tui, keybindings, done, ctx = null, dbPath = DEFAULT_DB, cwd = process.cwd(), layerFile, tab } = {}) {
    this.tui = tui;
    this.keybindings = keybindings;
    this.done = done;
    this.dbPath = dbPath;
    this.cwd = cwd;
    this.layerFile = layerFile;
    this.state = null;
    this.palette = paletteFor({ color: true });
    this.rainField = null;
    this.width = 0;
    this.height = 0;
    this.closed = false;
    // A tab named by the caller is an opening position, not a leash: applied once on the first load,
    // then the reader moves freely.
    this.tab = TAB_NAMES.includes(tab) ? tab : undefined;
    // The clock's only job is to ask for repaints — through the host's own managed interval when it
    // offers one (it isolates the callback and clears it on shutdown). The *falling* is time-based
    // inside `render`, so the motion is right at any repaint cadence: an animation stepped by
    // whatever happens to repaint reads as "one step per keypress", which is what it read as.
    this.lastStep = Date.now();
    const schedule = ctx?.setInterval ?? setInterval;
    this.unschedule = ctx ? (handle) => ctx.clearTimer(handle) : (handle) => clearInterval(handle);
    this.timer = schedule(() => {
      if (this.closed) return;
      try {
        this.repaint();
      } catch {
        /* a missed frame is not a torn-down session */
      }
    }, 50);
    this.ready = this.reload(null);
  }

  /** Ask the host for a frame. `requestRender` is its scheduler — the call its own async components
   * make when their state changes between inputs; `invalidate` only flushes caches and never woke
   * the renderer. `invalidate` stays as the fallback for a host that offers nothing better. */
  repaint() {
    if (this.tui.requestRender) this.tui.requestRender();
    else this.tui.invalidate?.();
  }

  async reload(note) {
    const world = await loadWorld({ dbPath: this.dbPath, cwd: this.cwd, layerFile: this.layerFile });
    if (this.closed) return;
    this.state = note === null ? world.state : { ...adopt(this.state, world), message: note };
    if (this.tab) {
      this.state = { ...this.state, tab: this.tab };
      this.tab = undefined;
    }
    this.repaint();
  }

  render(width) {
    const height = Math.max(12, Math.min((process.stdout.rows ?? 40) - 4, 48));
    if (width !== this.width || height !== this.height || !this.rainField) {
      this.width = width;
      this.height = height;
      this.rainField = this.rainField
        ? resizeRain(this.rainField, { width, height })
        : createRain({ width, height, seed: Date.now() % 100000, density: 0.5 });
    }
    // Time-based falling: however often anyone repaints, the field advances by the wall clock it
    // owes — bounded, so a long tab-out cannot fast-forward the rain across the screen.
    const now = Date.now();
    if (this.lastStep === undefined) this.lastStep = now;
    const steps = Math.min(4, Math.floor((now - this.lastStep) / 50));
    if (steps > 0) {
      this.lastStep += steps * 50;
      if (this.state?.rain && this.rainField) for (let i = 0; i < steps; i += 1) stepRain(this.rainField);
    }
    if (!this.state) return ["  loading the matrix…"];
    this.palette = paletteFor({ color: this.state.color });
    const grid = frameFor({
      width,
      height,
      state: this.state,
      palette: this.palette,
      clock: new Date().toISOString().slice(11, 19),
    });
    const composed = this.state.rain ? composeOverRain(grid, this.rainField, this.palette, { width, height }) : grid;
    const lines = [];
    for (let row = 0; row < height; row += 1) lines.push(styledLine(composed, row, this.palette));
    return lines;
  }

  handleInput(data) {
    if (this.closed) return;
    // No `app.interrupt` shortcut to the exit: the host binds it to Esc, and Esc is *back* — it
    // closes the modal the reader is in (see `applyKey`) and never the matrix. `q` (and Ctrl-C,
    // which `keyName` names `ctrl-c`) is the way out.
    if (!this.state) return;
    const { state, effect } = applyKey(this.state, keyName(data));
    this.state = state;
    if (effect === "quit") return this.close();
    if (effect === "propose") this.state = proposeFor(this.state);
    else if (effect === "save") void this.save();
    else if (effect === "reload") void this.reload("");
    else if (effect === "reingest") void this.reingest();
    this.repaint();
  }

  async save() {
    // The write itself lives in `commitProposal`: it re-reads the layer and the base config from disk
    // immediately before writing, so this call cannot carry a stale verdict to the filesystem.
    const result = await commitProposal(this.state, { dbPath: this.dbPath, cwd: this.cwd });
    this.state = result.state;
    this.repaint();
  }

  /** The same ingest the standalone `R` runs, through the store's own `ingest`. */
  async reingest() {
    this.state = { ...this.state, message: "ingesting…" };
    this.repaint();
    const sqlite = await loadSqlite();
    let note = "no node:sqlite: nothing was ingested";
    if (sqlite) {
      try {
        const result = await ingest({ dbPath: this.dbPath, catalogue: DEFAULT_CATALOGUE });
        note = result.ok
          ? `ingested: ${result.filesRead} read, ${result.filesSkipped} skipped, ${result.totals.runs} run(s) now in the store`
          : `ingest failed: ${result.reason}`;
      } catch (error) {
        note = `ingest failed: ${error?.message ?? String(error)}`;
      }
    }
    await this.reload(note);
  }

  close() {
    this.dispose();
    this.done(undefined);
  }

  dispose() {
    if (this.closed) return;
    this.closed = true;
    this.unschedule(this.timer);
  }
}
