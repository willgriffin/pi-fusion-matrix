/**
 * A JSON seat's answer, and the one contract that judges it.
 *
 * The schema belongs to the *answer that claims to be a disposition*, not to every JSON persona: a classifier's
 * label or a summariser's object is a valid answer to a different promise, and failing it here would be one
 * seat's schema applied to somebody else's contract. These use the exported unit directly, so a schema change is
 * a failing test rather than a broken review rung discovered live.
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
const answer = (value) => dispositionOf(jsonSeat, typeof value === "string" ? value : JSON.stringify(value));

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

test("an answer that claims to be a disposition is judged by its schema", () => {
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

test("an answer that does not claim to be a disposition is left alone", () => {
  // The case that made the schema global: a JSON persona answering a *different* contract. Its answer is
  // recovered for the next stage and nothing is recorded against it.
  const classifier = answer({ label: "mechanical", confidence: 0.95 });
  assert.equal(classifier.malformed, undefined);
  assert.equal(classifier.disposition, undefined);
  assert.match(classifier.text, /"label": "mechanical"/);

  // An empty object is a valid answer to some other question, and so is one with unrelated keys.
  for (const payload of [{}, { summary: "no findings worth reporting" }, { items: [1, 2] }]) {
    const result = answer(payload);
    assert.equal(result.malformed, undefined, `${JSON.stringify(payload)} must not be judged by the review schema`);
  }
  // …but an answer that *mentions* the keys has claimed the contract, even in an otherwise empty object.
  assert.ok(answer({ verdict: "clean", findings: [] }).disposition, "the minimal valid disposition is a disposition");
  assert.ok(answer({ findings: [] }).malformed, "findings without a verdict has claimed the contract and failed it");
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
