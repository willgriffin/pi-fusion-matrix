/**
 * The `/matrix` dispatch rules, as a unit: bare or a tab opens the interface, a named id dispatches
 * its run, and anything else is a free-text prompt for the default rung — with a *named* notice, so a
 * retired or mistyped id is never swallowed into a billed run silently.
 *
 *   node --test test/
 */
import test from "node:test";
import assert from "node:assert/strict";
import { dispatchPlan } from "../extensions/pi-fusion-matrix/dispatch.js";

const board = {
  fusions: { cheap: {}, good: {}, smart: {}, genius: {}, plan: {}, "review-check": {} },
  tabs: ["fusions", "aliases", "personas"],
  defaultFusion: "smart",
};

test("bare and a tab name ask for the interface", () => {
  assert.deepEqual(dispatchPlan("", board), { kind: "interface", tab: undefined });
  assert.deepEqual(dispatchPlan("  ", board), { kind: "interface", tab: undefined });
  assert.deepEqual(dispatchPlan("personas", board), { kind: "interface", tab: "personas" });
});

test("a named id dispatches its run, and the id is not part of the prompt", () => {
  assert.deepEqual(dispatchPlan("genius fix the bug", board), { kind: "run", fusion: "genius", prompt: "fix the bug" });
  assert.deepEqual(dispatchPlan("review-check", board), { kind: "usage" });
});

test("an unknown first token falls back by name, never silently", () => {
  // The free-text spelling is deliberate (`/matrix fix my bug`), so the run proceeds — but the token
  // that matched no fusion is named before it is billed. This is the named trigger's mitigation on
  // the command path: `/matrix best fix this` must say "best" is gone, not quietly run `smart`.
  const plan = dispatchPlan("best fix this", board);
  assert.equal(plan.kind, "run");
  assert.equal(plan.fusion, "smart");
  assert.equal(plan.prompt, "best fix this");
  assert.match(plan.notice, /no fusion "best"/);
  assert.match(plan.notice, /known: cheap, good, smart, genius, plan, review-check/);
  assert.match(plan.notice, /smart runs with the line as the prompt/);

  // A `routes` spelling — the tab this interface folded away — is named the same way.
  const routes = dispatchPlan("routes", board);
  assert.equal(routes.kind, "run");
  assert.match(routes.notice, /no fusion "routes"/);

  // A named run carries no notice.
  assert.equal(dispatchPlan("cheap x", board).notice, undefined);
});
