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

import { resolvePrompt, HARNESS_THINKING } from "./config.js";
import { resolveCandidates, seatRequest, label, isObject } from "./resolve.js";

/** pi-ai rejects temperature on some models; learned per provider/model and reported once. */
const noTemperature = new Set();

/**
 * A harness (or a provider) may refuse a thinking level a model does not support. Learned per
 * provider/model *and* level, so a supported level is still requested, and reported once.
 */
const noThinking = new Set();

const MODELS_REJECT_TEMPERATURE = /temperature/i;
const THINKING_UNSUPPORTED =
  /thinking effort .*not supported|unsupported (thinking|reasoning)|thinking .*not supported|reasoning .*not supported/i;
const QUOTA = /\b429\b|usage limit|quota|balance/i;
const CREDENTIAL = /\b40[13]\b|unauthorized|invalid api key/i;
const MISSING_MODEL = /not found|unknown model|\b404\b/i;

/**
 * Whether an error refused the thinking level it was given: "Thinking effort low is not supported by
 * alibaba-token-plan/deepseek-v4.1-flash. Supported efforts: high, max" — measured 2026-09-19 on omp,
 * which enforces a model's supported levels where pi passes them through. It can surface where the stream
 * is created or where it is first pulled, so callers ask this of whatever error they got.
 */
export function isThinkingRefusal(message) {
  return THINKING_UNSUPPORTED.test(String(message ?? ""));
}

/**
 * Remember that this (provider, model, level) is refused, so a *seat* does not retry one it already knows
 * is refused, while a level that is supported is still requested next time.
 *
 * Seats are the only writers. The proxy branch (run.js) retries once unconditionally — it never fails a
 * whole turn to save one call — so a refusal it has already recovered from must not suppress that retry,
 * which is what sharing this memory did: one proxied refusal made `/matrix` on the same rung degrade
 * instead of answering without reasoning.
 */
export function rememberThinkingRefusal(provider, model, level) {
  if (level) noThinking.add(`${provider}/${model}@${level}`);
}

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

/**
 * `output: "json"` personas. The keys come from the persona's own prompt (the packaged judge names
 * them), so the instruction only has to demand the object and nothing else.
 */
const JSON_INSTRUCTION =
  "Output only a valid JSON object matching the keys described above — no prose, no markdown fence, and nothing before or after it.";

/** The two-stage recovery the spec names: a leading fence, else the first `{` to the last `}`. */
export function parseJsonOutput(text) {
  const trimmed = String(text ?? "").trim();
  const candidates = [];
  const fenced = /^```(?:json)?\s*([\s\S]*?)```$/.exec(trimmed);
  if (fenced) candidates.push(fenced[1]);
  const first = trimmed.indexOf("{");
  const last = trimmed.lastIndexOf("}");
  if (first !== -1 && last > first) candidates.push(trimmed.slice(first, last + 1));
  for (const candidate of candidates) {
    try {
      const value = JSON.parse(candidate);
      if (value && typeof value === "object" && !Array.isArray(value)) return { ok: true, value };
    } catch {
      /* try the next recovery */
    }
  }
  return { ok: false };
}

/**
 * A JSON seat's answer as it reaches the next stage. Total parse failure keeps the raw text under
 * `unique_insights` — the reference implementation's fallback object — so the stage still receives
 * something rather than an empty seat.
 */
function normaliseJsonSeat(text) {
  const { ok, value } = parseJsonOutput(text);
  if (ok) return JSON.stringify(value, null, 2);
  return JSON.stringify({ unique_insights: [String(text ?? "")] }, null, 2);
}

/**
 * The severities a review finding may carry, worst first. Closed where it is recorded: a model that invents a
 * severity is kept as `unknown` rather than dropped, because a finding nobody can sort is still a finding.
 */
export const SEVERITIES = ["blocking", "major", "minor", "editorial"];

/** Findings by severity, in the closed order, plus `unknown` for one nobody could sort. */
function countSeverities(findings = []) {
  const counts = Object.fromEntries(SEVERITIES.map((severity) => [severity, 0]));
  for (const finding of findings) counts[finding.severity ?? "unknown"] = (counts[finding.severity ?? "unknown"] ?? 0) + 1;
  return counts;
}

const VERDICTS = ["clean", "findings"];

/**
 * One finding, as recorded. `line` keeps an explicit `null`: the persona prompt allows a null line for a finding
 * about the change as a whole, and dropping the key would lose the field the contract says is always present.
 */
const normaliseFinding = (finding) => ({
  severity: finding.severity,
  path: finding.path,
  line: finding.line === null ? null : finding.line,
  criterion: finding.criterion,
  claim: finding.claim,
});

/**
 * Why a disposition is not one, or `undefined` when it is. The schema is the persona prompt's, enforced here
 * because a *parseable* answer is not necessarily a disposition: `{"verdict":"clean"}` would otherwise record as
 * an empty, unmarked review — a clean-looking result produced by an answer that answered nothing.
 */
function dispositionFlaw(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "the disposition is not an object";
  if (!VERDICTS.includes(value.verdict)) return `verdict is not one of ${VERDICTS.join("|")}`;
  if (!Array.isArray(value.findings)) return "findings is not an array";
  for (const [index, finding] of value.findings.entries()) {
    if (!finding || typeof finding !== "object" || Array.isArray(finding)) return `findings[${index}] is not an object`;
    if (!SEVERITIES.includes(finding.severity)) return `findings[${index}].severity is not one of ${SEVERITIES.join("|")}`;
    if (typeof finding.path !== "string" || !finding.path) return `findings[${index}].path is missing`;
    if (!(finding.line === null || Number.isInteger(finding.line))) return `findings[${index}].line is neither an integer nor null`;
    if (typeof finding.criterion !== "string" || !finding.criterion) return `findings[${index}].criterion is missing`;
    if (typeof finding.claim !== "string" || !finding.claim) return `findings[${index}].claim is missing`;
  }
  // An inconsistent verdict is a flaw, not a preference: `clean` with findings, or `findings` with none, cannot be
  // both recorded and trusted.
  if (value.verdict === "clean" && value.findings.length > 0) return "verdict is clean but findings is not empty";
  if (value.verdict === "findings" && value.findings.length === 0) return "verdict is findings but findings is empty";
  return undefined;
}

/**
 * A JSON seat's answer as both *text for the next stage* and *the disposition it declared*. The record is the
 * point: a review whose findings exist only as prose cannot be counted, and a verdict the model never stated is
 * not invented here — `findings` is always present, `verdict` only when it said one, and an answer that does not
 * satisfy the contract it was asked for is recorded as malformed rather than wrapped into something that reads
 * like a clean review.
 *
 * Exported because this *is* a unit: the schema is the whole contract of a review rung's last seat, and it is
 * testable without running a pipeline.
 */
export function dispositionOf(persona, text) {
  if (persona?.output !== "json") return { text };
  const { ok, value } = parseJsonOutput(text);
  if (!ok) return { text: normaliseJsonSeat(text), malformed: "the answer was not a JSON object" };
  // Only an answer that *claims* to be a disposition is judged by the disposition's schema. Another JSON
  // persona's answer — a classifier's label, a summariser's object — is a valid answer to a different promise,
  // and failing it here would be this seat's schema applied to somebody else's contract. The claim is read from
  // the answer, not from a list of personas, so a new JSON seat is judged by the schema it actually answers to.
  const claimsDisposition = isObject(value) && ("verdict" in value || "findings" in value);
  if (!claimsDisposition) return { text: JSON.stringify(value, null, 2) };
  const flaw = dispositionFlaw(value);
  if (flaw) return { text: normaliseJsonSeat(text), malformed: flaw };
  return {
    text: JSON.stringify(value, null, 2),
    disposition: {
      verdict: value.verdict,
      summary: typeof value.summary === "string" ? value.summary : undefined,
      findings: value.findings.map(normaliseFinding),
    },
  };
}

function temperatureFor(persona, model, override) {
  const base = override ?? persona.temperature;
  return String(model).toLowerCase().includes("kimi") ? 1.0 : base;
}

/** Shared with `route` in run.js: one predicate, so a gate cannot drift between the two callers. */
export function isSufficient(answer, sufficientWhen) {
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

const emptyUsage = () => ({
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  reasoning: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
});
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
/**
 * The seat's own clock, wrapped around the body rather than threaded through five returns, and the only
 * place a seat's duration is set: a seat that retried a level or a temperature took the sum of its calls,
 * while a *failed* call's own time rides its attempt record. The harness records neither — omp times its own
 * turns, pi none at all — so this is the only figure either harness has for a call we make ourselves.
 */
export async function runSeat(args) {
  const startedAt = Date.now();
  const seat = await runSeatInner(args);
  return { ...seat, durationMs: Date.now() - startedAt };
}

/**
 * How long one seat call may take before it is treated as a failed attempt.
 *
 * A seat that hangs is worse than a seat that fails: a failure advances the cascade and is reported, while a
 * hang is a silent run — no answer, no error, nothing to report — for as long as the harness waits, which is
 * forever. Observed seat calls on a full-diff packet run 12–80 s, so this leaves room for a slow provider and
 * still turns a stall into a substitution. A fusion may tighten or loosen it with `seatTimeoutMs`.
 *
 * The bound is built from `AbortSignal.timeout` and `AbortSignal.any`, so the runtime floor this package
 * declares in `engines` is Node 20.3 rather than whatever the extension API alone would need.
 */
const SEAT_TIMEOUT_MS = 300000;

async function runSeatInner({
  personaName,
  persona,
  candidates,
  fusion,
  config,
  registry,
  callModel,
  decide,
  emit,
  signal,
  vars,
  maxAdvance = 3,
  onDelta,
  fusionSource,
}) {
  const seatTimeoutMs = Number.isInteger(fusion?.seatTimeoutMs) && fusion.seatTimeoutMs > 0 ? fusion.seatTimeoutMs : SEAT_TIMEOUT_MS;
  // A fusion may override one persona's prompt. Inline text, or a path beside the layer that declared
  // the fusion — the packaged `review` synthesis override depends on this. `resolvePrompt` decides by
  // "contains a newline": right for a persona, whose prompt is normally a file, but wrong for a
  // one-line override like `review`'s, which would be read as a filename and silently dropped. So the
  // override tries the file first and keeps its own text when there is no file.
  const override = fusion.prompts?.[personaName];
  if (override !== undefined) {
    const fromFile = resolvePrompt(override, fusionSource);
    const text = fromFile ?? (typeof override === "string" && override.trim() ? override : null);
    if (text !== null) persona = { ...persona, prompt: text };
  }
  const substitutions = [];
  const cascades = [];
  const attempts = [];
  let advances = 0;
  let prior = null;
  let calls = 0;

  /**
   * The route this seat tries next after a failure: a sibling provider of the same alias, the first
   * route of the next candidate, or a dash when nothing is left. It is the substitution's `to`, so the
   * transcript names what answered instead of the literal "next".
   */
  const nextRouteLabel = (candidateIndex, resolvedList, resolvedIndex) => {
    if (resolvedList[resolvedIndex + 1]) return label(resolvedList[resolvedIndex + 1]);
    for (let i = candidateIndex + 1; i < (candidates ?? []).length; i += 1) {
      const next = candidates[i];
      if (isObject(next) && next.decide !== undefined) return "the decision";
      try {
        const list = resolveCandidates(config, next);
        if (list.length > 0) return label(list[0]);
      } catch {
        /* an invalid candidate cannot name the route it never had */
      }
    }
    return "—";
  };

  for (const [candidateIndex, candidate] of (candidates ?? []).entries()) {
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
        seat: personaName,
        kind: "decision",
        answer,
        sufficient,
        advancedTo: sufficient ? undefined : "next candidate",
        prior: sufficient ? undefined : priorLine(answer),
      });
      if (sufficient) {
        emit.delta(` ├─ ⚖️ ${personaName} via decision (${describeAnswer(answer, candidate.sufficientWhen)})\n`);
        return {
          persona: personaName,
          text: renderDecision(answer),
          usage: emptyUsage(),
          decisionUsage: result.usage,
          substitutions,
          cascades,
          attempts,
          degraded: false,
          calls: 1,
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

    for (const [resolvedIndex, resolved] of resolvedList.entries()) {
      const seat = await seatRequest(registry, resolved);
      if (!seat.ok) {
        const to = nextRouteLabel(candidateIndex, resolvedList, resolvedIndex);
        attempts.push({
          alias: resolved.alias,
          seat: label(resolved),
          provider: resolved.provider,
          model: resolved.model,
          reason: seat.reason,
          detail: seat.detail,
        });
        emit.substitution({ seat: personaName, from: label(resolved), to, reason: seat.reason, detail: seat.detail });
        substitutions.push({ seat: personaName, from: label(resolved), to, reason: seat.reason });
        continue;
      }

      // `"harness"` is the execute face's literal (Step 8) and means nothing to a seat, which we call at
      // a level we choose: a seat reading it would ask its provider for a level called "harness". So it is
      // stripped here and the seat keeps its own persona level, exactly as if the fusion had not declared
      // one for it.
      const declaredThinking = fusion.thinking?.[personaName];
      const thinking = (declaredThinking === HARNESS_THINKING ? undefined : declaredThinking) ?? resolved.thinking ?? persona.thinking;
      const key = `${resolved.provider}/${resolved.model}`;
      const messages = [];
      if (prior) messages.push({ role: "user", content: prior });
      messages.push({ role: "user", content: `${buildPrompt(persona, vars)}` });

      // Announced before the call, so the reader sees which seat is running rather than a line that
      // arrives after its own streamed answer.
      emit.delta(` ├─ ⏳ ${personaName}: ${resolved.provider}/${resolved.model}${thinking ? ` @${thinking}` : ""}\n`);
      // A JSON persona is asked for the object in its system prompt, and its answer is recovered to
      // JSON before any later stage sees it — so `{{judge}}` is data, not a fenced blob.
      const seatPersona =
        persona.output === "json" ? { ...persona, prompt: `${persona.prompt ?? ""}\n\n${JSON_INSTRUCTION}`.trim() } : persona;
      let temperature = temperatureFor(persona, resolved.model, undefined);
      let emitted = "";
      // A thrown transport error is an attempt like any other: classified, retried once when transient,
      // then a substitution. Only text already streamed to the caller is sacred — if any went out, the
      // run ends with it rather than concatenating a second model's answer onto a partial one.
      const call = async (withTemperature, withThinking = true) => {
        calls += 1;
        const callStartedAt = Date.now();
        // Per call, not per seat: each attempt gets the bound, and the attempts are counted, so a seat that
        // spent three deadlines has spent three attempts' worth of time in the record rather than one.
        const deadline = AbortSignal.timeout(seatTimeoutMs);
        const bounded = signal ? AbortSignal.any([signal, deadline]) : deadline;
        // A call started after the run was already stopped must not be *made*: a transport that only listens
        // for the abort event never sees one that has already been dispatched, so the request would be sent
        // after cancellation and its answer waited for indefinitely.
        if (signal?.aborted) {
          return {
            text: "",
            usage: emptyUsage(),
            stopReason: "error",
            toolCalls: [],
            durationMs: 0,
            timedOut: false,
            errorMessage: "the run was already aborted before this call",
          };
        }
        try {
          const message = await callModel({
            model: seat.model,
            apiKey: seat.apiKey,
            headers: seat.headers,
            messages,
            temperature: withTemperature ? temperature : undefined,
            reasoning: withThinking ? thinking : undefined,
            signal: bounded,
            persona: seatPersona,
            onDelta: onDelta
              ? (chunk) => {
                  emitted += chunk;
                  onDelta(chunk);
                }
              : undefined,
          });
          return { ...message, durationMs: Date.now() - callStartedAt };
        } catch (error) {
          // The deadline and the caller's abort are different facts: one is the provider failing to answer
          // in time (a substitution), the other is the user stopping the run (which must propagate as such).
          const timedOut = deadline.aborted && !signal?.aborted;
          return {
            text: "",
            usage: emptyUsage(),
            stopReason: "error",
            toolCalls: [],
            durationMs: Date.now() - callStartedAt,
            errorMessage: timedOut ? `no answer within ${seatTimeoutMs} ms` : (error?.message ?? String(error)),
            timedOut,
          };
        }
      };

      // Every failed call is recorded as its own attempt, with its own time: a seat that spent four seconds on
      // a temperature retry and then failed has spent twice what the last call took, and the record used to
      // keep only the final figure.
      const noteFailure = (failed) => {
        const text = failed.errorMessage ?? "unknown error";
        // A cancelled run is neither the provider's failure nor a timeout: the taxonomy has to say which, or a
        // deliberate stop is filed as a transient provider error and read as one later.
        const reason = failed.timedOut
          ? "timeout"
          : signal?.aborted
            ? "aborted"
            : QUOTA.test(text)
              ? "quota"
              : CREDENTIAL.test(text)
                ? "credential"
                : MISSING_MODEL.test(text)
                  ? "missing model"
                  : "transient";
        attempts.push({
          alias: resolved.alias,
          seat: label(resolved),
          provider: resolved.provider,
          model: resolved.model,
          reason,
          detail: text,
          durationMs: failed.durationMs,
        });
        return { text, reason };
      };

      let message = await call(!noTemperature.has(key));
      let lastFailure = message.stopReason === "error" ? noteFailure(message) : null;
      if (message.stopReason === "error" && MODELS_REJECT_TEMPERATURE.test(message.errorMessage ?? "") && !noTemperature.has(key)) {
        noTemperature.add(key);
        emit.delta(` ├─ ⚠️ ${key} rejects a temperature override; retrying without it.\n`);
        message = await call(false);
        if (message.stopReason === "error") lastFailure = noteFailure(message);
      }
      // A harness may enforce a model's supported thinking efforts instead of passing the level through.
      // The seat is retried once at no reasoning level rather than at a guess — a level the config did
      // not ask for would be a silent substitution — and the level that failed is remembered per model, so
      // a level that *is* supported is still requested next time and one that is refused is not retried
      // forever.
      const thinkingKey = `${key}@${thinking}`;
      if (message.stopReason === "error" && thinking && !noThinking.has(thinkingKey) && isThinkingRefusal(message.errorMessage)) {
        rememberThinkingRefusal(resolved.provider, resolved.model, thinking);
        emit.delta(` ├─ ️ ${key} does not support thinking "${thinking}"; retrying that seat without a reasoning level.\n`);
        message = await call(!noTemperature.has(key), false);
        if (message.stopReason === "error") lastFailure = noteFailure(message);
      }

      if (message.stopReason === "error") {
        const { text, reason } = lastFailure ?? noteFailure(message);
        if (emitted) {
          emit.delta(` ├─ ⚠️ ${personaName}: streamed ${emitted.length} chars then failed (${reason}); ending with what was emitted\n`);
          return {
            persona: personaName,
            text: emitted,
            provider: resolved.provider,
            model: resolved.model,
            alias: resolved.alias,
            template: seat.template,
            thinking,
            usage: message.usage ?? emptyUsage(),
            substitutions,
            cascades,
            attempts,
            degraded: true,
            error: text,
            reason,
            calls,
          };
        }
        // A retry is for a failure that might not repeat. `aborted` and `timeout` are not transient, so a
        // cancelled run and a stalled provider both advance rather than paying the wait again.
        const isTransient = reason === "transient";
        if (isTransient) {
          await new Promise((resolve) => setTimeout(resolve, 2000));
          const retried = await call(!noTemperature.has(key));
          if (retried.stopReason !== "error") {
            const retriedDisposition = dispositionOf(persona, retried.text);
            return {
              persona: personaName,
              text: retriedDisposition.text,
              disposition: retriedDisposition.disposition,
              malformed: retriedDisposition.malformed,
              provider: resolved.provider,
              model: resolved.model,
              alias: resolved.alias,
              template: seat.template,
              thinking,
              usage: retried.usage,
              substitutions,
              cascades,
              attempts,
              degraded: false,
              calls,
            };
          }
        }
        const to = nextRouteLabel(candidateIndex, resolvedList, resolvedIndex);
        emit.substitution({ seat: personaName, from: label(resolved), to, reason, detail: text.slice(0, 140) });
        substitutions.push({ seat: personaName, from: label(resolved), to, reason });
        continue;
      }

      const seatDisposition = dispositionOf(persona, message.text);
      return {
        persona: personaName,
        text: seatDisposition.text,
        disposition: seatDisposition.disposition,
        malformed: seatDisposition.malformed,
        provider: resolved.provider,
        model: resolved.model,
        alias: resolved.alias,
        template: seat.template,
        thinking,
        usage: message.usage,
        substitutions,
        cascades,
        attempts,
        degraded: false,
        calls,
      };
    }

    advances += 1;
    if (advances >= maxAdvance) break;
  }

  const detail = attempts.map((a) => `${a.seat} (${a.reason})`).join(", ") || "no candidates";
  emit.delta(` ├─ ⚠️ ${personaName} unavailable: ${detail}\n`);
  return {
    persona: personaName,
    text: "",
    provider: undefined,
    model: undefined,
    usage: emptyUsage(),
    substitutions,
    cascades,
    attempts,
    degraded: true,
    error: `all candidates failed: ${detail}`,
    reason: attempts[0]?.reason,
    calls,
  };
}

function buildPrompt(persona, vars) {
  const parts = [];
  if (vars.prefix) parts.push(vars.prefix);
  parts.push(vars.input ?? vars.prompt ?? "");
  if (vars.alsoSynthesize) {
    parts.push(
      "After your analysis above, write the final answer to the original request in this same message, resolving what you found. Do not restate the analysis verbatim.",
    );
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
export async function runPipeline({ config, sources, fusion, prompt, registry, callModel, decide, emit, signal, cwd = process.cwd() }) {
  const personas = loadPersonas(config, sources);
  const mode = config.modes[fusion.mode];
  const vars = { prompt, cwd };
  const usage = emptyUsage();
  const decisionUsage = emptyUsage();
  const stages = [];
  const seatRecords = [];
  const runStartedAt = Date.now();
  let lastDisposition = null;
  const malformedAnswers = [];
  /**
   * One writer, in order, and nothing is overwritten. Every answer that failed its contract is a fact about the
   * run, so each one stays in the record; when a later answer lands — valid or malformed — the ones before it are
   * named as superseded by it. The answer that stands is the one `dispositionBy` names; when no valid answer
   * landed, it is the last malformed entry, the only one left without `supersededBy`.
   *
   * A malformed answer that arrives after a valid one takes the standing position outright: that ordering must
   * never read as clean. A malformed answer after another malformed one does not make the first disappear — the
   * record is a chain, not a slot.
   */
  const noteDisposition = (seat) => {
    if (!seat.disposition && !seat.malformed) return;
    for (const earlier of malformedAnswers) if (earlier.supersededBy === undefined) earlier.supersededBy = seat.persona;
    if (seat.disposition) {
      lastDisposition = { persona: seat.persona, ...seat.disposition };
    } else {
      lastDisposition = null;
      malformedAnswers.push({ persona: seat.persona, reason: seat.malformed });
    }
  };
  const rounds = [];
  const substitutions = [];
  const cascades = [];
  const cascadeRecords = [];
  let text = "";
  let stagesRun = 0;
  let panelSeats = [];

  const stageList = mode?.stages ?? [];
  const skipped = new Set();

  // The expansion is the execution plan: one line per seat naming the alias@provider chain it will walk,
  // so the routes are visible before the first call rather than only when one of them fails.
  for (const [persona, list] of Object.entries(fusion.candidates ?? {})) {
    const plan = [];
    for (const candidate of list ?? []) {
      if (isObject(candidate) && candidate.decide !== undefined) {
        plan.push("a decision");
        continue;
      }
      try {
        plan.push(...resolveCandidates(config, candidate).map(label));
      } catch {
        plan.push("unknown route"); // the seat reports the config error when it runs
      }
    }
    if (plan.length > 0) emit.delta(` ├─ plan ${persona}: ${plan.join(" → ")}\n`);
  }

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
        // Later rounds run the survivors only, and each seat sees every *other* survivor's previous
        // opinion — never its own.
        const active = round === 1 ? names : lastSeats.filter((s) => !s.degraded).map((s) => s.persona);
        const seatVars = (seatName) => {
          const peers = round === 1 ? undefined : renderPeers(lastSeats.filter((s) => s.persona !== seatName && !s.degraded));
          const input =
            round === 1 ? resolveInput(stage.input, vars) : resolveInput(stage.roundInput ?? stage.input, { ...vars, peers: peers ?? "" });
          return { ...vars, peers, input };
        };
        const roundSeats = await Promise.all(
          active.map((name) =>
            runSeat({
              personaName: name,
              persona: personas[name] ?? { name, prompt: "", temperature: 0.7 },
              candidates: fusion.candidates?.[name],
              fusion,
              config,
              registry,
              callModel,
              decide,
              emit,
              signal,
              vars: seatVars(name),
              maxAdvance: fusion.maxAdvance,
              fusionSource: sources?.fusions?.[fusion.id],
            }),
          ),
        );
        lastSeats = roundSeats;
        record.calls += roundSeats.reduce((total, seat) => total + (seat.calls ?? 0), 0);
        stagesRun += 1;
        for (const seat of roundSeats) {
          noteDisposition(seat);
          accumulateUsage(usage, seat.usage);
          if (seat.decisionUsage) accumulateUsage(decisionUsage, seat.decisionUsage);
          seatRecords.push({
            persona: seat.persona,
            alias: seat.alias ?? seat.attempts?.[0]?.alias,
            provider: seat.provider,
            model: seat.model,
            template: seat.template,
            thinking: seat.thinking,
            usage: seat.usage,
            durationMs: seat.durationMs,
            attempts: seat.attempts,
            degraded: seat.degraded,
            error: seat.error,
            reason: seat.reason,
          });
          substitutions.push(...seat.substitutions);
          cascades.push(...seat.cascades);
        }
        rounds.push({
          round,
          seats: roundSeats.filter((s) => !s.degraded).map((s) => s.persona),
          dropped: roundSeats.filter((s) => s.degraded).map((s) => `${s.persona} (${s.reason ?? "unknown"})`),
          inputs: Object.fromEntries(roundSeats.map((s) => [s.persona, String(seatVars(s.persona).input ?? "").slice(0, 400)])),
        });
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
        personaName: name,
        persona: personas[name] ?? { name, prompt: "", temperature: 0.7 },
        candidates: fusion.candidates?.[name],
        fusion,
        config,
        registry,
        callModel,
        decide,
        emit,
        signal,
        vars,
        maxAdvance: fusion.maxAdvance,
        fusionSource: sources?.fusions?.[fusion.id],
        // The answer streams token-by-token; every other seat reports a status line only, because five
        // interleaved answers are unreadable.
        onDelta: isLast ? (chunk) => emit.delta(chunk) : undefined,
      });
      record.calls = seat.calls ?? 0;
      stagesRun += 1;
      noteDisposition(seat);
      accumulateUsage(usage, seat.usage);
      if (seat.decisionUsage) accumulateUsage(decisionUsage, seat.decisionUsage);
      seatRecords.push({
        persona: seat.persona,
        alias: seat.alias ?? seat.attempts?.[0]?.alias,
        provider: seat.provider,
        model: seat.model,
        template: seat.template,
        thinking: seat.thinking,
        usage: seat.usage,
        durationMs: seat.durationMs,
        attempts: seat.attempts,
        degraded: seat.degraded,
        error: seat.error,
        reason: seat.reason,
      });
      substitutions.push(...seat.substitutions);
      cascades.push(...seat.cascades);
      vars.previous = seat.text;
      // `{{judge}}` is the analysis stage's own output — the single stage an answer stage synthesizes
      // from — so the final synthesis must not overwrite it. A shape with no separate judge (lean, pair,
      // a merged single) keeps its answer as the judge, which is what `{{judge}}` meant there.
      if (!isLast || !vars.judge) vars.judge = seat.text;
      if (isLast) text = seat.text;
    }

    if (kind === "decide") {
      record.seats = ["decision"];
      vars.input = resolveInput(stage.input, vars);
      let result;
      try {
        result = await decide({ ...stage.decide, state: vars.input }, vars, signal);
      } catch (error) {
        const detail = error?.message ?? String(error);
        substitutions.push({ seat: "stage", from: kind, to: "next stage", reason: "decision" });
        emit.substitution({ seat: "stage", from: kind, to: "next stage", reason: "decision", detail });
        emit.delta(` ├─ ⚠️ decision unavailable (${detail.slice(0, 120)}); continuing without it\n`);
        stages.push({ ...record, error: detail });
        continue;
      }
      const answer = Object.values(result.answers ?? {})[0] ?? null;
      record.calls = 1;
      stagesRun += 1;
      accumulateUsage(decisionUsage, result.usage);
      const rendered = renderDecision(answer);
      vars.previous = rendered;
      vars.judge = rendered;
      const sufficient = isSufficient(answer, stage.sufficientWhen);
      cascadeRecords.push({
        seat: "stage",
        kind: "decision",
        answer,
        sufficient,
        advancedTo: sufficient ? undefined : "next stage",
        // An escalated stage is told what the cheap read said, so it addresses the ambiguity rather
        // than rediscovering it.
        prior: sufficient ? undefined : priorLine(answer),
      });
      if (stage.sufficientWhen) {
        emit.delta(
          sufficient
            ? ` ├─ ✅ decision sufficient (${describeAnswer(answer, stage.sufficientWhen)}) — skipping stage ${index + 1}\n`
            : ` ├─  decision insufficient (${describeAnswer(answer, stage.sufficientWhen)}) — running stage ${index + 1}\n`,
        );
        if (sufficient && index + 1 < stageList.length) {
          skipped.add(index + 1);
          // The loader rejects a gate on the final stage, so this only fires for a config that reached
          // the interpreter another way: the decision becomes the answer instead of progress lines.
          if (index + 1 === stageList.length - 1) {
            text = rendered;
            emit.delta(` ├─ ⚠️ decision skipped the answer stage; using the decision as the answer\n`);
          }
        } else {
          vars.decisionPrior = priorLine(answer);
        }
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
      let result;
      try {
        result = await decide({ ...stage.score, state: vars.input, over: items }, vars, signal);
      } catch (error) {
        const detail = error?.message ?? String(error);
        substitutions.push({ seat: "stage", from: "score", to: "next stage", reason: "decision" });
        emit.delta(` ├─ ⚠️ score unavailable (${detail.slice(0, 120)}); continuing without weights\n`);
        stages.push({ ...record, error: detail });
        continue;
      }
      record.calls = 1;
      stagesRun += 1;
      accumulateUsage(decisionUsage, result.usage);
      const weights = Object.entries(result.answers ?? {}).map(([name, answer]) => ({
        persona: name,
        score: answer?.score ?? answer?.noul ?? 0,
        confidence: answer?.confidence ?? 0,
      }));
      vars.weights = renderWeights(weights);
      vars.previous = vars.weights;
    }

    if (kind === "render") {
      text = resolveInput(stage.input ?? "panel", vars);
      vars.previous = text;
    }

    // A stage that declares `name` publishes its own output under that name. Assigned here, after the
    // stage ran, because `vars.previous` holds this stage's output by now — assigning it before the
    // stage would hand later readers the *preceding* stage's text.
    if (stage.name) vars[stage.name] = vars.previous;

    stages.push(record);
  }

  const seatErrors = seatRecords
    .filter((seat) => seat.degraded)
    .map((seat) => ({ persona: seat.persona, error: seat.error, reason: seat.reason }));

  return {
    text,
    // `render`, a final `decide`, and a skipped answer stage produce text without a model call, so
    // nothing carried it into the stream; the caller must send the answer itself rather than leaving
    // status lines as the whole message.
    streamedAnswer: stageList[stageList.length - 1]?.single !== undefined && !skipped.has(stageList.length - 1),
    // The vars snapshot is what `verify` needs: the panel as the panel saw it, the judge's own
    // output, and the answer — not the answer standing in for all three.
    vars: { prompt: vars.prompt, panel: vars.panel ?? "", judge: vars.judge ?? "", synthesis: text, cwd },
    usage,
    decisionUsage,
    // `seatErrors` is always present, empty array included: a run that degraded quietly is a wrong answer.
    details: {
      fusion: fusion.id,
      mode: fusion.mode,
      stages,
      seats: seatRecords,
      seatErrors,
      rounds,
      substitutions,
      cascades: [...cascades, ...cascadeRecords],
      durationMs: Date.now() - runStartedAt,
      // `malformedAnswers` is a chain, one entry per answer that failed its own contract, each naming the seat
      // that superseded it: an answer that failed is a fact about the run, and a fact that a later answer
      // overwrites is a fact the record lost.
      ...(lastDisposition
        ? {
            dispositionBy: lastDisposition.persona,
            verdict: lastDisposition.verdict,
            severityCounts: countSeverities(lastDisposition.findings),
            findings: lastDisposition.findings,
          }
        : {}),
      ...(malformedAnswers.length > 0 ? { malformedAnswers } : {}),
    },
    stagesRun,
  };
}

function renderPeers(seats) {
  return seats
    .filter((seat) => !seat.degraded)
    .map((seat) => `## ${seat.persona} — previous opinion\n\n${seat.text?.trim()}`)
    .join("\n\n");
}
