/**
 * Configuration: the loader is the repository's rule book, and every rule in it exists because breaking it
 * would degrade a run silently. These assert each rule is a *named* load error, plus the two derivations that
 * decide who answers — which model an executor resolves to, and what thinking level a proxied turn runs at.
 *
 * Moved here from `scripts/interp-check.mjs`, which keeps the cross-module contracts; the rules are this
 * module's own behaviour and belong to its own test.
 *
 *   node --test test/
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  loadMatrixConfig,
  mergeConfig,
  validateConfig,
  executorOf,
  executorThinking,
  nodeParent,
  optionThen,
} from "../extensions/pi-fusion-matrix/config.js";

const { config: packaged } = loadMatrixConfig({ cwd: process.cwd(), layers: ["packaged"] });
const deep = (value) => JSON.parse(JSON.stringify(value));
/** The packaged config with a patch merged in: the way an operator's project layer changes it. */
const errorsFor = (patch) => validateConfig(mergeConfig(deep(packaged), patch), {});

test("the packaged config is valid as it ships", () => {
  assert.deepEqual(errorsFor({}), []);
});

test("a verify question's warning bar is a number between 0 and 1, or a named load error", () => {
  const withBar = (warnBelow) =>
    errorsFor({
      fusions: {
        "review-quick": {
          verify: [{ state: "{{synthesis}}", questions: { addresses_question: { type: "noul", instructions: "x", warnBelow } } }],
        },
      },
    }).join("\n");
  assert.equal(withBar(0.35), "", "a calibrated bar is legal");
  for (const bad of [2, -1, "0.5", null]) {
    assert.match(withBar(bad), /warnBelow must be a number between 0 and 1/, `${JSON.stringify(bad)} must be refused`);
  }
});

test("the packaged review rungs declare their disposition seats", () => {
  // The declaration is what makes the schema the *rung's*: these seats answer findings as data, and the mode's
  // last stage seat is one of them, because that answer is the one the run records.
  for (const rung of ["review-quick", "review-check", "smrt-review"]) {
    const declared = packaged.fusions[rung].disposition?.personas ?? [];
    const stages = packaged.modes[packaged.fusions[rung].mode].stages;
    const lastSeat = stages[stages.length - 1].single;
    assert.ok(declared.length > 0, `${rung} declares a disposition`);
    assert.ok(declared.includes(lastSeat), `${rung} includes its last stage seat "${lastSeat}"`);
    assert.ok(
      declared.every((name) => packaged.personas[name]?.output === "json"),
      `${rung}'s declared seats answer JSON`,
    );
  }
});

test("every disposition rule is a named load error", () => {
  const rules = [
    [
      "an empty declaration",
      { fusions: { "review-quick": { disposition: { personas: [] } } } },
      /disposition needs a non-empty personas list/,
    ],
    // `mergeConfig` deep-merges and ignores `undefined`, so a rule that needs a key *gone* is expressed as a
    // fusion that never had it rather than as a patch that tries to remove one.
    [
      "no personas key",
      { fusions: { "review-quick": { disposition: { personas: null } } } },
      /disposition needs a non-empty personas list/,
    ],
    // A *list* of names, not a name: a string would iterate its own letters. The issue's own spelling
    // (`persona`) has to fail with the key that is read rather than pass as an unknown extra key.
    [
      "a names value that is not a list",
      { fusions: { "review-quick": { disposition: { personas: "review-synth" } } } },
      /disposition needs a non-empty personas list/,
    ],
    [
      "the singular spelling",
      { fusions: { quick: { disposition: { persona: "technical" } } } },
      /disposition needs a non-empty personas list/,
    ],
    [
      "a persona the mode does not run",
      { fusions: { "review-quick": { disposition: { personas: ["review-skeptic", "review-synth", "judge"] } } } },
      /disposition names "judge", which mode "review-single" does not run/,
    ],
    [
      "a persona whose answer is not JSON",
      // `best`'s mode runs `synth`, and `synth` is the non-JSON seat the rule is about — patching the fusion under
      // test rather than a *different* fusion's persona, which would make the row pass on the wrong error.
      { fusions: { best: { disposition: { personas: ["synth"] } } } },
      /disposition names "synth", whose answer is not JSON/,
    ],
    [
      "a declaration that leaves out the last stage seat",
      { fusions: { "review-quick": { disposition: { personas: ["review-skeptic"] } } } },
      /disposition must name the mode's last stage seat "review-synth"/,
    ],
    [
      "a declaration on a mode that writes no single answer",
      { fusions: { debate: { disposition: { personas: ["technical"] } } } },
      /disposition needs a writing seat — mode "debate" ends in no single seat/,
    ],
    [
      "a review rung with no declaration",
      { fusions: { quick: { review: true, route: { criteria: { mechanical: { description: "x", then: "review-quick" } } } } } },
      /review requires disposition/,
    ],
    [
      "a review route to a rung that declares none",
      {
        fusions: {
          "smrt-review": {
            disposition: { personas: ["review-technical", "review-skeptic", "review-systems", "review-synth"] },
            route: { criteria: { mechanical: { description: "x", then: "quick" }, high: { description: "y" } } },
          },
        },
      },
      /routes to "quick", which declares no disposition/,
    ],
  ];
  const failed = rules.filter(([, patch, expected]) => !expected.test(errorsFor(patch).join("\n")));
  assert.deepEqual(
    failed.map(([name]) => name),
    [],
    `each rule must fire: ${rules.length} checked`,
  );
});

test("the review rungs are calibrated and answer findings as data", () => {
  // Two config facts a reader depends on: the bar a warning is raised at (measured across eight review runs —
  // clean 0.23, real reviews 0.44–0.76 — so 0.35 separates the suspicious case instead of flagging everything),
  // and the panels answering findings as *data*, which is what puts a model and its findings on one record.
  for (const rung of ["review-quick", "review-check", "smrt-review"]) {
    assert.equal(packaged.fusions[rung].verify[0].questions.addresses_question.warnBelow, 0.35, `${rung} carries the calibrated bar`);
  }
  for (const persona of ["review-skeptic", "review-technical", "review-systems"]) {
    assert.equal(packaged.personas[persona]?.output, "json", `${persona} answers findings as data`);
  }
  assert.deepEqual(packaged.modes["review-single"].stages[0].parallel, ["review-skeptic"]);
  assert.deepEqual(packaged.modes["review-committee"].stages[0].parallel, ["review-technical", "review-skeptic", "review-systems"]);
});

test("every proxy rule is a named load error", () => {
  const rules = [
    ["an unknown alias", { fusions: { best: { proxy: { alias: "no-such-alias" } } } }, /proxy alias "no-such-alias" is not an alias/],
    ["an empty proxy block", { fusions: { best: { proxy: {} } } }, /proxy needs an alias/],
    ["a null proxy block", { fusions: { best: { proxy: null } } }, /proxy is not an object/],
    ["proxy with route", { fusions: { "default-smrt": { proxy: { alias: "qwen-flash" } } } }, /proxy and route cannot both be declared/],
    [
      "a thinking level declared for a seat that is not the writer",
      { fusions: { best: { thinking: { judge: "harness" } } } },
      /"harness" is only legal for the writing seat "synth"/,
    ],
    ["proxy on a mode that writes nothing", { fusions: { opinions: { proxy: { alias: "kimi" } } } }, /proxy needs a writing seat/],
    ["a non-positive alias contextWindow", { aliases: { "glm-flash": { contextWindow: 0 } } }, /contextWindow must be a positive integer/],
  ];
  const failed = rules.filter(([, patch, expected]) => !expected.test(errorsFor(patch).join("\n")));
  assert.deepEqual(
    failed.map(([name]) => name),
    [],
    `each rule must fire: ${rules.length} checked`,
  );
});

test("every review-route rule is a named load error", () => {
  const rules = [
    [
      "execute: false with a proxy block",
      { fusions: { best: { execute: false, proxy: { alias: "glm-flash" } } } },
      /proxy and execute: false cannot both be declared/,
    ],
    // `best` is an ordinary work rung — it has an executor — so these exercise the rule rather than merging
    // into a rung that already declares `execute: false`.
    ["review without execute: false", { fusions: { best: { review: true } } }, /review requires execute: false/],
    ["review without a route", { fusions: { best: { review: true, execute: false } } }, /review requires route/],
    [
      "a review route to an executor",
      {
        fusions: {
          "smrt-review": { route: { criteria: { mechanical: { description: "x", then: "quick" }, high: { description: "y" } } } },
        },
      },
      /declares no execute: false/,
    ],
    [
      "a JSON-writing seat that is not declared never a session model",
      { fusions: { "review-check": { execute: true } } },
      /the writing seat "review-synth" answers in JSON, so this fusion must declare execute: false/,
    ],
  ];
  const failed = rules.filter(([, patch, expected]) => !expected.test(errorsFor(patch).join("\n")));
  assert.deepEqual(
    failed.map(([name]) => name),
    [],
    `each rule must fire: ${rules.length} checked`,
  );
});

test("an executor is the writing seat's first candidate, and `proxy.alias` re-points what answers", () => {
  const fusion = deep(packaged.fusions.best);
  const writer = executorOf(packaged, fusion);
  assert.equal(writer.persona, "synth", "the last stage's single seat is the writer");
  assert.equal(writer.alias, "glm-flash", "no declaration means the writer's own first candidate");
  assert.equal(writer.declared, null);
  // `route` and `candidate` differ exactly when the alias is overridden: the override brings its own providers.
  assert.equal(writer.route, writer.candidate);

  const overridden = executorOf(packaged, { ...fusion, proxy: { alias: "kimi" } });
  assert.equal(overridden.alias, "kimi");
  assert.equal(overridden.declared, "kimi");
  assert.equal(overridden.route, "kimi");
  assert.notEqual(overridden.candidate, "kimi", "the writing seat's declaration is untouched, so its level still governs");
});

test("a fusion that declares `execute: false` has no executor, whatever tools a turn carries", () => {
  assert.equal(executorOf(packaged, packaged.fusions["review-check"]), null);
  assert.equal(executorOf(packaged, packaged.fusions["smrt-review"]), null);
});

test("a mode that writes nothing has no executor, even with an alias declared", () => {
  assert.equal(executorOf(packaged, { mode: "opinion" }), null);
  assert.equal(executorOf(packaged, { mode: "opinion", proxy: { alias: "kimi" } }), null);
});

test("the thinking level a proxied turn runs at is decided by declaration, then candidate, then persona", () => {
  const fusion = deep(packaged.fusions.best);
  assert.equal(executorThinking(packaged, fusion), "high", "the packaged `best` declares a level for its writer");

  // A fusion-level declaration wins over the persona's default.
  assert.equal(executorThinking(packaged, { ...fusion, thinking: { synth: "low" } }), "low");
  // Nothing declared falls to the writing seat's persona level — `quick`'s writer is `technical`, which declares
  // `medium`; `best`'s is `synth`, which declares none, and an absent level stays absent rather than defaulting.
  assert.equal(executorThinking(packaged, { ...deep(packaged.fusions.quick), thinking: {} }), "medium");
  assert.equal(executorThinking(packaged, { ...fusion, thinking: {} }), undefined);
  // `harness` means "run at whatever the harness sent", which is expressed by asking for no level at all: the
  // literal is not a level name and must never reach a provider as one.
  assert.equal(executorThinking(packaged, { ...fusion, thinking: { synth: "harness" } }), undefined);
  // No executor, no level to resolve.
  assert.equal(executorThinking(packaged, packaged.fusions["review-check"]), undefined);
});

test("a route nests decisions in routes in decisions, and the walk stays acyclic", () => {
  // A branch is a fusion id, {run: <fusion>}, or a nested decision whose own options branch again.
  const nested = {
    fusions: {
      "default-smrt": {
        route: {
          criteria: {
            cheap: {
              description: "small",
              then: {
                decide: {
                  instructions: "how much room does the answer need?",
                  criteria: {
                    brief: { description: "one line", then: { run: "cheap" } },
                    full: { description: "an essay", then: "good" },
                  },
                },
                otherwise: { run: "quick" },
              },
            },
          },
        },
      },
    },
  };
  assert.deepEqual(errorsFor(nested), [], "a nested decision is legal, and options without then stay legal");

  // The same shape closing a loop is refused by name — here the cycle runs *through* an inline node.
  const cyclical = {
    fusions: {
      quick: {
        route: {
          instructions: "how deep?",
          criteria: {
            deeper: {
              description: "d",
              then: {
                decide: { instructions: "again?", criteria: { x: { description: "x", then: "default-smrt" }, y: { description: "y" } } },
              },
            },
            stop: { description: "s", then: "cheap" },
          },
        },
      },
    },
  };
  assert.match(
    errorsFor(cyclical).join("\n"),
    /route cycle: (quick → default-smrt → quick|default-smrt → quick → default-smrt)/,
    "the error names the cycle it found",
  );

  // A route targeting itself keeps its own name.
  const selfish = {
    fusions: { "default-smrt": { route: { criteria: { cheap: { description: "x", then: "default-smrt" } } } } },
  };
  assert.match(errorsFor(selfish).join("\n"), /routes to this fusion/);

  // A branch that is neither a fusion name nor a decision node says so.
  const shapeless = {
    fusions: { "default-smrt": { route: { criteria: { cheap: { description: "x", then: { alias: "kimi" } } } } } },
  };
  assert.match(errorsFor(shapeless).join("\n"), /must be a fusion id, \{run: <fusion>\}, or a decision node/);
});

test("a cascade's decision names where the chain continues — an alias or another decision", () => {
  const patch = {
    fusions: {
      quick: {
        candidates: {
          technical: [
            {
              decide: {
                instructions: "is it mechanical?",
                criteria: {
                  yes: { description: "y", then: "kimi" },
                  deeper: {
                    description: "d",
                    then: {
                      decide: { instructions: "again?", criteria: { a: { description: "a" }, b: { description: "b", then: "glm-flash" } } },
                      otherwise: "kimi",
                    },
                  },
                },
              },
            },
            "deepseek-flash",
          ],
        },
      },
    },
  };
  assert.deepEqual(errorsFor(patch), [], "continuations may nest decisions and may fall through to the next entry");

  // A chain branch is looked up among aliases: a bare fusion name is not a candidate.
  const wrongLevel = {
    fusions: {
      quick: {
        candidates: {
          technical: [
            { decide: { instructions: "x", criteria: { a: { description: "a", then: "default-smrt" }, b: { description: "b" } } } },
            "deepseek-flash",
          ],
        },
      },
    },
  };
  assert.match(errorsFor(wrongLevel).join("\n"), /unknown alias "default-smrt"/);
  const wrongShape = {
    fusions: {
      quick: {
        candidates: {
          technical: [
            { decide: { instructions: "x", criteria: { a: { description: "a", then: { run: "quick" } }, b: { description: "b" } } } },
            "deepseek-flash",
          ],
        },
      },
    },
  };
  assert.match(errorsFor(wrongShape).join("\n"), /must set exactly one of alias\/decide/);
});

test("nothing is required of a map — except that it can fire at all", () => {
  // Options without `then`, a node without `otherwise`, implicit leaves that decline to this fusion: all legal.
  const leafy = {
    fusions: {
      probe: {
        mode: "single",
        candidates: { technical: ["kimi"] },
        route: { instructions: "x", criteria: { a: { description: "a" }, b: { description: "b", then: "cheap" } } },
      },
    },
  };
  assert.deepEqual(errorsFor(leafy), []);
  // …but a route that can never fire is dead config, and says so.
  const dead = {
    fusions: {
      probe: {
        mode: "single",
        candidates: { technical: ["kimi"] },
        route: { instructions: "x", criteria: { a: { description: "a" }, b: { description: "b" } } },
      },
    },
  };
  assert.match(errorsFor(dead).join("\n"), /no option carries then and there is no otherwise, so the route can never fire/);
  // An `otherwise` alone is enough to fire.
  const rescued = {
    fusions: {
      probe: {
        mode: "single",
        candidates: { technical: ["kimi"] },
        route: { instructions: "x", criteria: { a: { description: "a" }, b: { description: "b" } }, otherwise: "cheap" },
      },
    },
  };
  assert.deepEqual(errorsFor(rescued), []);
});

test("optionThen reads the branch an option leads to, and nodeParent derives a recorded parent", () => {
  const spec = { criteria: { a: { description: "a", then: { run: "cheap" } }, b: { description: "b" } }, otherwise: { run: "quick" } };
  assert.deepEqual(optionThen(spec, "a"), { run: "cheap" });
  assert.deepEqual(optionThen(spec, "b"), { run: "quick" }, "an option without then falls to otherwise");
  assert.equal(nodeParent("default-smrt.route"), "default-smrt", "the route root belongs to its fusion");
  assert.equal(nodeParent("default-smrt.route/cheap"), "default-smrt.route");
  assert.equal(nodeParent("review.skeptic#0"), "review.skeptic", "a chain entry belongs to its chain");
  assert.equal(nodeParent("review.skeptic#0/unclear"), "review.skeptic#0");
});
