#!/usr/bin/env node
/**
 * tui-rain.mjs — the falling-glyph field behind the interface.
 *
 * The matrix rain, as a *pure* unit: a field is created from a seed, stepped deterministically, and
 * rendered to a level per cell. Two runs from one seed draw the same frames, which is what makes the
 * animation testable at all — an assertion like "the head is brighter than its tail" has to be made
 * on a known frame, not on whatever the wall clock happened to produce.
 *
 * Stepping mutates the state it is given (a frame is a 60 Hz concern, and copying a few thousand
 * cells to satisfy immutability would be the wrong trade); reproducibility comes from the seeded
 * generator, not from copying. `cells()` is then a pure function of the state it reads.
 *
 * Levels, not colours: the field says how lit a cell is, and the driver decides what that looks like
 * on the terminal (a green palette, or nothing at all under `NO_COLOR`). The head of a drop is the
 * brightest cell in its column, the tail fades to the dimmest — the thing that makes rain read as
 * rain rather than as noise.
 */

/** Half-width katakana and digits: every glyph is one terminal cell wide, so the grid stays aligned. */
export const GLYPHS = "ｱｲｳｴｵｶｷｸｹｺｻｼｽｾｿﾀﾁﾂﾃﾄﾅﾆﾇﾈﾉﾊﾋﾌﾍﾎﾏﾐﾑﾒﾓﾔﾕﾖﾗﾘﾙﾚﾛﾜﾝ0123456789";

/** How lit a cell is: 0 untouched, 1 the tail, 2 the body, 3 the head of a drop. */
export const LIT = { none: 0, tail: 1, body: 2, head: 3 };

/** mulberry32 — a small seeded PRNG, so a field is reproducible from its seed and nothing else. */
export function makeRng(seed) {
  let a = seed >>> 0 || 1;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const between = (rng, low, high) => low + rng() * (high - low);

function drop(rng, height, { start = false } = {}) {
  const length = Math.round(between(rng, 4, Math.max(6, Math.min(height, 26))));
  return {
    // A fresh field starts its drops spread over the screen; a respawn starts above it, so the rain
    // does not appear all at once.
    head: start ? between(rng, -length, height) : between(rng, -length - 4, -1),
    speed: between(rng, 0.18, 0.85),
    length,
    birth: rng(),
  };
}

/** A field of `width` columns, each running a drop with probability `density`. */
export function createRain({ width, height, seed = 1, density = 0.5 } = {}) {
  const rng = makeRng(seed);
  const columns = [];
  for (let x = 0; x < width; x += 1) {
    columns.push(rng() < density ? drop(rng, height, { start: true }) : null);
  }
  return { width, height, seed, density, tick: 0, rng, columns };
}

/**
 * One frame's worth of falling: every drop's head advances by its own speed, a drop that has fully
 * left the screen is respawned above it, and glyphs mutate as they fall — the mutation is what keeps
 * a long trail from looking printed.
 */
export function stepRain(field, { mutate = 0.08 } = {}) {
  const { rng } = field;
  for (let x = 0; x < field.columns.length; x += 1) {
    const d = field.columns[x];
    if (!d) {
      if (rng() < field.density * 0.02) field.columns[x] = drop(rng, field.height);
      continue;
    }
    d.head += d.speed;
    if (d.head - d.length > field.height) {
      field.columns[x] = rng() < field.density ? drop(rng, field.height) : null;
      continue;
    }
    // A glyph mutates with the given probability per tick: read once per column, so a fast terminal
    // does not flicker every cell at once.
    if (rng() < mutate) d.birth = rng();
  }
  field.tick += 1;
  return field;
}

/** A field stretched to new dimensions: columns are added or dropped, and their drops start fresh. */
export function resizeRain(field, { width, height }) {
  if (field.width === width && field.height === height) return field;
  const next = createRain({
    width,
    height,
    seed: field.seed + field.tick,
    density: field.density,
  });
  next.tick = field.tick;
  return next;
}

/**
 * The lit level and the glyph for every cell, as flat arrays indexed `row * width + column`.
 *
 * Overlapping drops take the brightest level, not the last one drawn: a dim tail crossing a bright
 * body must not put a hole in the body.
 */
export function cells(field) {
  const { width, height } = field;
  const levels = new Uint8Array(width * height);
  const glyphs = new Array(width * height).fill(" ");
  for (let x = 0; x < width; x += 1) {
    const d = field.columns[x];
    if (!d) continue;
    const head = Math.floor(d.head);
    for (let i = 0; i < d.length; i += 1) {
      const row = head - i;
      if (row < 0 || row >= height) continue;
      const level = i === 0 ? LIT.head : i <= 1 ? LIT.body : LIT.tail;
      const at = row * width + x;
      if (level < levels[at]) continue;
      levels[at] = level;
      // The glyph is a function of the column, the drop's generation and the cell's distance from the
      // head, so a trail holds *different* characters and stays stable between mutations.
      const seedish = Math.floor(d.birth * 9973) + i * 7 + x * 13 + Math.floor(field.tick / 4);
      glyphs[at] = GLYPHS[seedish % GLYPHS.length];
    }
  }
  return { levels, glyphs };
}
