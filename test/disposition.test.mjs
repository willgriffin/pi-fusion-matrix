/**
 * A JSON seat's answer, and the one contract that judges it.
 *
 * The schema belongs to the *rung*, not to the shape of an answer: a fusion declares which of its seats answer
 * findings as data, and only those are judged — a classifier's label is a valid answer to a different promise,
 * and an answer that omits `findings` from the seat that promised them is a failure nothing else would see.
 * These use the exported unit directly, so a schema change is a failing test rather than a broken review rung
 * discovered live.
 *
 *   node --test test/
 */
import test from "node:test";
import assert from "node:assert/strict";
import { dispositionOf } from "../extensions/pi-fusion-matrix/pipeline.js";

const jsonSeat = { output: "json" };
const finding = {
  severity: "blocking",
  path: "extensions/pi-fusion-matrix/pipeline.js",
  line: 42,
  criterion: "c1",
  claim: "the refusal is swallowed",
};
/** The same answer, read twice: as a seat its fusion declared, and as one it did not. */
const declared = (value) => dispositionOf(jsonSeat, typeof value === "string" ? value : JSON.stringify(value), { declared: true });
const undeclared = (value) => dispositionOf(jsonSeat, typeof value === "string" ? value : JSON.stringify(value));
const answer = declared;

test("a well-formed disposition is recorded, and its text is the object", () => {
  const result = answer({
    verdict: "findings",
    summary: "one boundary is unhandled",
    findings: [finding, { ...finding, severity: "editorial", line: null }],
  });
  assert.equal(result.malformed, undefined);
  assert.equal(result.disposition.verdict, "findings");
  assert.equal(result.disposition.findings.length, 2);
  assert.equal(result.disposition.findings[1].line, null, "a null line is kept, not dropped");
  assert.match(result.text, /"verdict": "findings"/);
});

test("a declared seat's answer is judged by the schema", () => {
  const flawed = [
    [{ verdict: "clean" }, /findings is not an array/],
    [{ verdict: "banana", findings: [] }, /verdict is not one of clean\|findings/],
    [{ verdict: "findings", findings: "oops" }, /findings is not an array/],
    [{ verdict: "findings", findings: [{ ...finding, severity: "invented" }] }, /severity is not one of/],
    [{ verdict: "findings", findings: [{ ...finding, claim: "" }] }, /claim is missing/],
    [{ verdict: "clean", findings: [finding] }, /clean but findings is not empty/],
    [{ verdict: "findings", findings: [] }, /findings but findings is empty/],
  ];
  for (const [payload, expected] of flawed) {
    const result = answer(payload);
    assert.ok(result.malformed, `expected a flaw for ${JSON.stringify(payload)}`);
    assert.equal(result.disposition, undefined, "a flawed answer records no disposition");
    assert.match(result.malformed, expected);
  }
});

test("a declared seat that answers something else fails its declared contract", () => {
  // The failure an inference could never see: the seat promised findings and answered without them. Its answer
  // is still recovered as text for the next stage, and the flaw is what the record carries.
  for (const payload of [{ summary: "no findings worth reporting" }, {}, { label: "mechanical" }, { verdict: "clean" }]) {
    const result = answer(payload);
    assert.ok(result.malformed, `${JSON.stringify(payload)} fails the contract the fusion declared`);
    assert.equal(result.disposition, undefined);
  }
  assert.equal(answer({ verdict: "clean", findings: [] }).malformed, undefined, "the minimal valid disposition holds");
});

test("a seat its fusion did not declare is left alone, whatever it answers", () => {
  // The case that made the schema global: a JSON persona answering a *different* contract. Its answer is
  // recovered for the next stage and nothing is recorded against it — even an answer using the schema's own keys.
  for (const payload of [
    { label: "mechanical", confidence: 0.95 },
    {},
    { summary: "no findings worth reporting" },
    { items: [1, 2] },
    { verdict: "banana", findings: "oops" },
  ]) {
    const result = undeclared(payload);
    assert.equal(result.malformed, undefined, `${JSON.stringify(payload)} must not be judged`);
    assert.equal(result.disposition, undefined);
    // Recovered verbatim, so the next stage sees exactly what the seat answered.
    assert.equal(result.text, JSON.stringify(payload, null, 2));
  }
});

test("an answer that is not a JSON object is malformed, and says what was asked for", () => {
  for (const [payload, text] of [
    ["I could not read the diff, sorry.", "prose"],
    ["[1, 2, 3]", "a top-level array"],
    ['"a string"', "a bare string"],
  ]) {
    const result = dispositionOf(jsonSeat, payload);
    assert.equal(result.malformed, "the answer was not a JSON object", `${text} must be reported`);
    assert.equal(result.disposition, undefined);
  }
  const prose = dispositionOf(jsonSeat, "I could not read the diff, sorry.");
  assert.match(prose.text, /unique_insights|I could not read the diff/, "the text is still recovered for the next stage");

  // A seat that was not asked for JSON is not judged at all, whatever it said.
  assert.deepEqual(dispositionOf({ output: "text" }, "prose"), { text: "prose" });
});
