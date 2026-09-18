/**
 * pipeline.js — the stage interpreter.
 *
 * Walks `config.modes[fusion.mode].stages`, runs seats, and assembles what each stage receives. It
 * imports no pi package: `callModel` is injected by run.js, which owns the pi-ai stream protocol. That
 * keeps orchestration testable from a bare node process and keeps this file free of a loader
 * dependency.
 *
 * Semantics fixed by the spec (docs/plan.md §Step 3, §Step 6):
 *   - `parallel` runs its seats concurrently; `rounds` re-runs them with `roundInput` (`peers`), each
 *     seat seeing every OTHER seat's previous-round output, and a failed seat is dropped from later
 *     rounds (rounds stop early below two survivors).
 *   - `single` runs one seat; `alsoSynthesize` is only legal on the last stage.
 *   - `decide` and `score` are backend calls, never model calls.
 *   - `render` assembles text without generating.
 *   - A mode ends in `single` or `render` — validated at load, so this file may assume it.
 *
 * Two fallback layers, each reported: inside an alias the providers in order (same vendor model,
 * another account — quality-preserving), across the candidate list the next alias (a different model —
 * a substitution).
 */

import { resolvePrompt } from "./config.js";
import { resolveCandidates, seatRequest, label } from "./resolve.js";

/** pi-ai rejects temperature on some models; learned per provider/model and reported once. */
const noTemperature = new Set();

const MODELS_REJECT_TEMPERATURE = /temperature/i;
const QUOTA = /\b429\b|usage limit|quota|balance/i;
const CREDENTIAL = /\b40[13]\b|unauthorized|invalid api key/i;
const MISSING_MODEL = /not found|unknown model|\b404\b/i;

export function loadPersonas(config, sources = { personas: {} }) {
  const personas = {};
  for (const [name, persona] of Object.entries(config.personas ?? {})) {
    const prompt = resolvePrompt(persona.prompt, sources.personas?.[name]);
    personas[name] = {
      name,
      prompt: prompt ?? "",
      temperature: persona.temperature ?? 0.7,
      thinking: persona.thinking,
      output: persona.output ?? "text",
    };
  }
  return personas;
}

export function renderPanel(seats) {
  return seats
    .map((seat) => {
      const heading = `## ${seat.persona} — ${seat.provider}/${seat.model}${seat.degraded ? ` (degraded: ${seat.reason ?? "unknown"})` : ""}`;
      return `${heading}\n\n${seat.text?.trim() || "[no output]"}`;
    })
    .join("\n\n");
}

/** `persona: score (confidence)` lines, best first, so a judge can weigh rather than guess. */
export function renderWeights(weights) {
  if (!weights?.length) return "";
  return [...weights]
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
    .map((w) => `${w.persona}: ${(w.score ?? 0).toFixed(2)} (confidence ${(w.confidence ?? 0).toFixed(2)})`)
    .join("\n");
}

/** A decision's contribution to later stages: options and probabilities, winner marked. */
export function renderDecision(answer) {
  const probabilities = answer?.probabilities ?? {};
  const entries = Object.entries(probabilities).sort((a, b) => b[1] - a[1]);
  if (entries.length === 0) {
    if (answer?.noul !== undefined) return `noul: ${answer.noul.toFixed(3)}`;
    if (answer?.score !== undefined) return `score: ${answer.score.toFixed(3)} (confidence ${(answer.confidence ?? 0).toFixed(2)})`;
    return "[decision returned no answer]";
  }
  const winner = answer.choice;
  return entries.map(([id, p]) => `${id}: ${p.toFixed(3)}${id === winner ? "  <- winner" : ""}`).join("\n");
}

function temperatureFor(persona, model, override) {
  const base = override ?? persona.temperature;
  return String(model).toLowerCase().includes("kimi") ? 1.0 : base;
}

function isSufficient(answer, sufficientWhen) {
  if (!sufficientWhen) return true;
  if (sufficientWhen.choiceIs !== undefined) {
    const wanted = [].concat(sufficientWhen.choiceIs);
    if (!wanted.includes(answer?.choice)) return false;
  }
  if (sufficientWhen.noulAbove !== undefined && !(answer?.noul >= sufficientWhen.noulAbove)) return false;
  if (sufficientWhen.scoreAbove !== undefined && !(answer?.score >= sufficientWhen.scoreAbove)) return false;
  if (sufficientWhen.scoreBelow !== undefined && !(answer?.score <= sufficientWhen.scoreBelow)) return false;
  if (sufficientWhen.minConfidence !== undefined && !((answer?.confidence ?? 0) >= sufficientWhen.minConfidence)) return false;
  return true;
}

function describeAnswer(answer, sufficientWhen) {
  const bits = [];
  if (answer?.choice !== undefined) bits.push(answer.choice);
  if (answer?.noul !== undefined) bits.push(`noul ${answer.noul.toFixed(2)}`);
  if (answer?.score !== undefined) bits.push(`score ${answer.score.toFixed(2)}`);
  if (answer?.confidence !== undefined) bits.push(`conf ${answer.confidence.toFixed(2)}`);
  if (sufficientWhen?.minConfidence !== undefined) bits.push(`needs >= ${sufficientWhen.minConfidence}`);
  return bits.join(", ");
}

function priorLine(answer) {
  const bits = [];
  if (answer?.choice !== undefined) bits.push(`choice=${answer.choice}`);
  if (answer?.noul !== undefined) bits.push(`noul=${answer.noul.toFixed(2)}`);
  if (answer?.score !== undefined) bits.push(`score=${answer.score.toFixed(2)}`);
  const confidence = answer?.confidence !== undefined ? ` (confidence ${answer.confidence.toFixed(2)})` : "";
  return `A fast classifier read this as ${bits.join(", ") || "an inconclusive answer"}${confidence}; treat the ambiguity explicitly.`;
}

const emptyUsage = () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, reasoning: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } });
export const freshUsage = emptyUsage;

export function accumulateUsage(total, extra) {
  if (!extra) return total;
  total.input += extra.input || 0;
  total.output += extra.output || 0;
  total.cacheRead += extra.cacheRead || 0;
  total.cacheWrite += extra.cacheWrite || 0;
  total.totalTokens += extra.totalTokens || 0;
  total.reasoning = (total.reasoning ?? 0) + (extra.reasoning || 0);
  if (extra.cost) {
    total.cost.input += extra.cost.input || 0;
    total.cost.output += extra.cost.output || 0;
    total.cost.cacheRead += extra.cost.cacheRead || 0;
    total.cost.cacheWrite += extra.cost.cacheWrite || 0;
    total.cost.total += extra.cost.total || 0;
  }
  return total;
}

/**
 * Run one seat: walk its candidate list, and inside each alias walk the provider chain.
 * Never throws for a call failure — a seat reports what happened and the pipeline continues.
 */
export async function runSeat({
  personaName, persona, candidates, fusion, config, registry, callModel, decide, emit, signal, vars, maxAdvance = 3,
  onDelta,
}) {
  const substitutions = [];
  const cascades = [];
  const attempts = [];
  let advances = 0;
  let prior = null;

  for (const candidate of candidates ?? []) {
    if (typeof candidate === "object" && candidate !== null && candidate.decide !== undefined) {
      let result;
      try {
        result = await decide(candidate.decide, vars, signal);
      } catch (error) {
        const reason = error?.message ?? String(error);
        substitutions.push({ seat: personaName, from: "decision", to: "next candidate", reason: "decision" });
        emit.substitution({ seat: personaName, from: "decision", to: "next candidate", reason: "decision", detail: reason });
        advances += 1;
        if (advances >= maxAdvance) break;
        continue;
      }
      const answer = Object.values(result.answers ?? {})[0] ?? null;
      const sufficient = isSufficient(answer, candidate.sufficientWhen);
      cascades.push({
        seat: personaName, kind: "decision", answer,
        sufficient, advancedTo: sufficient ? undefined : "next candidate",
        prior: sufficient ? undefined : priorLine(answer),
      });
      if (sufficient) {
        emit.delta(` ├─ ⚖️ ${personaName} via decision (${describeAnswer(answer, candidate.sufficientWhen)})\n`);
        return {
          persona: personaName, text: renderDecision(answer), usage: emptyUsage(), decisionUsage: result.usage,
          substitutions, cascades, attempts, degraded: false,
        };
      }
      emit.delta(` ├─  ${personaName} decision insufficient (${describeAnswer(answer, candidate.sufficientWhen)}) → next candidate\n`);
      prior = priorLine(answer);
      advances += 1;
      if (advances >= maxAdvance) break;
      continue;
    }

    let resolvedList;
    try {
      resolvedList = resolveCandidates(config, candidate);
    } catch (error) {
      emit.delta(` ├─ ️ ${personaName}: ${error.message}\n`);
      continue;
    }

    for (const resolved of resolvedList) {
      const seat = await seatRequest(registry, resolved);
      if (!seat.ok) {
        attempts.push({ seat: label(resolved), reason: seat.reason, detail: seat.detail });
        emit.substitution({ seat: personaName, from: label(resolved), to: "next", reason: seat.reason, detail: seat.detail });
        substitutions.push({ seat: personaName, from: label(resolved), to: "next", reason: seat.reason });
        continue;
      }

      const thinking = fusion.thinking?.[personaName] ?? resolved.thinking ?? persona.thinking;
      const key = `${resolved.provider}/${resolved.model}`;
      const messages = [];
      if (prior) messages.push({ role: "user", content: prior });
      messages.push({ role: "user", content: `${buildPrompt(persona, vars)}` });

      // Announced before the call, so the reader sees which seat is running rather than a line that
      // arrives after its own streamed answer.
      emit.delta(` ├─ ⏳ ${personaName}: ${resolved.provider}/${resolved.model}${thinking ? ` @${thinking}` : ""}\n`);
      let temperature = temperatureFor(persona, resolved.model, undefined);
      const call = async (withTemperature) => callModel({
        model: seat.model, apiKey: seat.apiKey, headers: seat.headers, messages,
        temperature: withTemperature ? temperature : undefined,
        reasoning: thinking, signal, persona, onDelta,
      });

      let message = await call(!noTemperature.has(key));
      if (message.stopReason === "error" && MODELS_REJECT_TEMPERATURE.test(message.errorMessage ?? "") && !noTemperature.has(key)) {
        noTemperature.add(key);
        emit.delta(` ├─ ⚠️ ${key} rejects a temperature override; retrying without it.\n`);
        message = await call(false);
      }

      if (message.stopReason === "error") {
        const text = message.errorMessage ?? "unknown error";
        const reason = QUOTA.test(text) ? "quota" : CREDENTIAL.test(text) ? "credential" : MISSING_MODEL.test(text) ? "missing model" : "transient";
        attempts.push({ seat: label(resolved), reason, detail: text });
        const isTransient = reason === "transient";
        if (isTransient) {
          await new Promise((resolve) => setTimeout(resolve, 2000));
          const retried = await call(!noTemperature.has(key));
          if (retried.stopReason !== "error") {
            return {
              persona: personaName, text: retried.text, provider: resolved.provider, model: resolved.model,
              template: seat.template, thinking, usage: retried.usage, substitutions, cascades, attempts,
              decisions: [], degraded: false,
            };
          }
        }
        emit.substitution({ seat: personaName, from: label(resolved), to: "next", reason, detail: text.slice(0, 140) });
        substitutions.push({ seat: personaName, from: label(resolved), to: "next", reason });
        continue;
      }

      return {
        persona: personaName, text: message.text, provider: resolved.provider, model: resolved.model,
        template: seat.template, thinking, usage: message.usage, substitutions, cascades, attempts,
        decisions: [], degraded: false,
      };
    }

    advances += 1;
    if (advances >= maxAdvance) break;
  }

  const detail = attempts.map((a) => `${a.seat} (${a.reason})`).join(", ") || "no candidates";
  emit.delta(` ├─ ⚠️ ${personaName} unavailable: ${detail}\n`);
  return {
    persona: personaName, text: "", provider: undefined, model: undefined, usage: emptyUsage(),
    substitutions, cascades, attempts, degraded: true, error: `all candidates failed: ${detail}`,
    reason: attempts[0]?.reason,
  };
}

function buildPrompt(persona, vars) {
  const parts = [];
  if (vars.prefix) parts.push(vars.prefix);
  parts.push(vars.input ?? vars.prompt ?? "");
  if (vars.alsoSynthesize) {
    parts.push("After your analysis above, write the final answer to the original request in this same message, resolving what you found. Do not restate the analysis verbatim.");
  }
  return parts.filter(Boolean).join("\n\n");
}

/** Resolve a stage's `input` connector against the vars map. */
export function resolveInput(input, vars) {
  if (input === undefined) return vars.prompt ?? "";
  if (input === "prompt") return vars.prompt ?? "";
  if (input === "panel") return vars.panel ?? "";
  if (input === "panel+judge") return [vars.panel, vars.judge].filter(Boolean).join("\n\n");
  if (input === "panel+weights") return [vars.weights, vars.panel].filter(Boolean).join("\n\n");
  if (input === "peers") return vars.peers ?? "";
  if (input === "previous") return vars.previous ?? "";
  if (/^\{\{.*\}\}$/.test(input)) return vars[input.slice(2, -2)] ?? "";
  return "";
}

/**
 * Walk a mode's stages. Returns the assistant text plus everything the run should report.
 */
export async function runPipeline({
  config, sources, fusion, prompt, registry, callModel, decide, emit, signal, cwd = process.cwd(),
}) {
  const personas = loadPersonas(config, sources);
  const mode = config.modes[fusion.mode];
  const vars = { prompt, cwd };
  const usage = emptyUsage();
  const decisionUsage = emptyUsage();
  const stages = [];
  const seatRecords = [];
  const rounds = [];
  const substitutions = [];
  const cascades = [];
  const cascadeRecords = [];
  let text = "";
  let stagesRun = 0;
  let panelSeats = [];

  const stageList = mode?.stages ?? [];
  const skipped = new Set();
  for (let index = 0; index < stageList.length; index += 1) {
    // A sufficient `decide` stage skips the stage it gates — the cascade pattern: the cheap read
    // decides whether the expensive step is needed at all.
    if (skipped.has(index)) {
      stages.push({ index, kind: "skipped", calls: 0 });
      emit.delta(` ├─ ⏭️ stage ${index} skipped\n`);
      continue;
    }
    const stage = stageList[index];
    const isLast = index === stageList.length - 1;
    const kind = ["parallel", "single", "decide", "score", "render"].find((k) => stage[k] !== undefined);
    const record = { index, kind, calls: 0 };
    if (stage.name) vars[stage.name] = vars.previous;

    if (kind === "parallel") {
      const names = stage.parallel;
      record.seats = [...names];
      let lastSeats = [];
      const roundCount = stage.rounds ?? 1;
      for (let round = 1; round <= roundCount; round += 1) {
        if (round > 1 && lastSeats.filter((s) => !s.degraded).length < 2) {
          emit.delta(` ├─ debate: fewer than two seats survive; stopping after round ${round - 1}\n`);
          break;
        }
        vars.peers = round === 1 ? undefined : renderPeers(lastSeats);
        vars.input = resolveInput(round === 1 ? stage.input : (stage.roundInput ?? stage.input), vars);
        const roundSeats = await Promise.all(names.map((name) => runSeat({
          personaName: name, persona: personas[name] ?? { name, prompt: "", temperature: 0.7 }, candidates: fusion.candidates?.[name],
          fusion, config, registry, callModel, decide, emit, signal, vars, maxAdvance: fusion.maxAdvance,
        })));
        lastSeats = roundSeats;
        record.calls += roundSeats.filter((s) => !s.degraded).length;
        stagesRun += 1;
        for (const seat of roundSeats) {
          accumulateUsage(usage, seat.usage);
          if (seat.decisionUsage) accumulateUsage(decisionUsage, seat.decisionUsage);
          seatRecords.push({
            persona: seat.persona, alias: seat.attempts?.[0]?.alias, provider: seat.provider, model: seat.model,
            template: seat.template, thinking: seat.thinking, usage: seat.usage,
            degraded: seat.degraded, error: seat.error, reason: seat.reason,
          });
          substitutions.push(...seat.substitutions);
          cascades.push(...seat.cascades);
        }
        rounds.push({ round, seats: roundSeats.filter((s) => !s.degraded).map((s) => s.persona), inputs: { input: String(vars.input ?? "").slice(0, 200) } });
      }
      vars.panel = renderPanel(lastSeats);
      vars.previous = vars.panel;
      panelSeats = lastSeats;
    }

    if (kind === "single") {
      const name = stage.single;
      record.seats = [name];
      vars.input = [resolveInput(stage.input, vars), vars.decisionPrior].filter(Boolean).join("\n\n");
      vars.decisionPrior = undefined;
      vars.alsoSynthesize = Boolean(stage.alsoSynthesize);
      const seat = await runSeat({
        personaName: name, persona: personas[name] ?? { name, prompt: "", temperature: 0.7 },
        candidates: fusion.candidates?.[name], fusion, config, registry, callModel, decide, emit, signal, vars,
        maxAdvance: fusion.maxAdvance,
        // The answer streams token-by-token; every other seat reports a status line only, because five
        // interleaved answers are unreadable.
        onDelta: isLast ? (chunk) => emit.delta(chunk) : undefined,
      });
      record.calls = seat.degraded ? 0 : 1;
      stagesRun += 1;
      accumulateUsage(usage, seat.usage);
      if (seat.decisionUsage) accumulateUsage(decisionUsage, seat.decisionUsage);
      seatRecords.push({
        persona: seat.persona, provider: seat.provider, model: seat.model, template: seat.template,
        thinking: seat.thinking, usage: seat.usage, degraded: seat.degraded, error: seat.error, reason: seat.reason,
      });
      substitutions.push(...seat.substitutions);
      cascades.push(...seat.cascades);
      vars.previous = seat.text;
      vars.judge = seat.text;
      if (isLast) text = seat.text;
    }

    if (kind === "decide") {
      record.seats = ["decision"];
      vars.input = resolveInput(stage.input, vars);
      const result = await decide({ ...stage.decide, state: vars.input }, vars, signal);
      const answer = Object.values(result.answers ?? {})[0] ?? null;
      record.calls = 1;
      stagesRun += 1;
      accumulateUsage(decisionUsage, result.usage);
      const rendered = renderDecision(answer);
      vars.previous = rendered;
      vars.judge = rendered;
      const sufficient = isSufficient(answer, stage.sufficientWhen);
      cascadeRecords.push({
        seat: "stage", kind: "decision", answer, sufficient,
        advancedTo: sufficient ? undefined : "next stage",
        // An escalated stage is told what the cheap read said, so it addresses the ambiguity rather
        // than rediscovering it.
        prior: sufficient ? undefined : priorLine(answer),
      });
      if (stage.sufficientWhen) {
        emit.delta(sufficient
          ? ` ├─ ✅ decision sufficient (${describeAnswer(answer, stage.sufficientWhen)}) — skipping stage ${index + 1}\n`
          : ` ├─  decision insufficient (${describeAnswer(answer, stage.sufficientWhen)}) — running stage ${index + 1}\n`);
        if (sufficient && index + 1 < stageList.length) skipped.add(index + 1);
        else vars.decisionPrior = priorLine(answer);
      }
      if (isLast) text = rendered;
    }

    if (kind === "score") {
      const names = stage.parallel ?? Object.keys(fusion.candidates ?? {});
      record.seats = names;
      vars.input = resolveInput(stage.input, vars);
      // Each item carries its own response text: TypeSafe evaluates every question against one
      // state, so the item travels inside the question rather than as the state.
      const items = panelSeats.length
        ? panelSeats.map((seat) => ({ persona: seat.persona, text: seat.text }))
        : names.map((n) => ({ persona: n, text: "" }));
      const result = await decide({ ...stage.score, state: vars.input, over: items }, vars, signal);
      record.calls = 1;
      stagesRun += 1;
      accumulateUsage(decisionUsage, result.usage);
      const weights = Object.entries(result.answers ?? {}).map(([name, answer]) => ({
        persona: name, score: answer?.score ?? answer?.noul ?? 0, confidence: answer?.confidence ?? 0,
      }));
      vars.weights = renderWeights(weights);
      vars.previous = vars.weights;
    }

    if (kind === "render") {
      text = resolveInput(stage.input ?? "panel", vars);
      vars.previous = text;
    }

    stages.push(record);
  }

  return {
    text,
    usage,
    decisionUsage,
    details: { fusion: fusion.id, mode: fusion.mode, stages, seats: seatRecords, rounds, substitutions, cascades: [...cascades, ...cascadeRecords] },
    stagesRun,
  };
}

function renderPeers(seats) {
  return seats
    .filter((seat) => !seat.degraded)
    .map((seat) => `## ${seat.persona} — previous opinion\n\n${seat.text?.trim()}`)
    .join("\n\n");
}