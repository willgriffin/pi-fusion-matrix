/**
 * The outcome vocabulary, in one place, because two readers depend on it: the `/matrix-label` command refuses
 * anything outside it, and the report refuses to *read* anything outside it. The store is editable by hand, and
 * a report that accepted `shipped` would count an outcome nobody defined.
 *
 *   node --test test/
 */
import test from "node:test";
import assert from "node:assert/strict";
import { LABEL_OUTCOMES, isOutcome } from "../extensions/pi-fusion-matrix/labels.js";

test("the vocabulary is the six the workflow uses", () => {
  assert.deepEqual(LABEL_OUTCOMES, ["landed", "review", "findings", "ci-red", "blocked", "abandoned"]);
});

test("an outcome outside the vocabulary is refused, including one that reads like a synonym", () => {
  for (const value of ["shipped", "done", "LANDED", "findings ", "", null, undefined, 7, {}]) {
    assert.equal(isOutcome(value), false, `${JSON.stringify(value)} must not be an outcome`);
  }
});

test("every outcome in the vocabulary is accepted", () => {
  for (const value of LABEL_OUTCOMES) assert.equal(isOutcome(value), true);
});
