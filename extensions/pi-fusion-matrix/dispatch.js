/**
 * dispatch.js — what a `/matrix` argument string asks for, as a pure unit.
 *
 * The bare spelling (or one naming a tab) asks for the interface; a named id dispatches its run; and
 * anything else is a free-text prompt for the default rung — carrying `notice`, which names the token
 * that matched no fusion, so a retired or mistyped id is never swallowed into a billed run silently.
 * The command path falls back (free-text prompts are deliberate); the `matrix` tool path has an
 * explicit `fusion` parameter and refuses an unknown one outright.
 */
export function dispatchPlan(text, { fusions, tabs, defaultFusion }) {
  const trimmed = String(text ?? "").trim();
  const ids = Object.keys(fusions ?? {});
  if (!trimmed || tabs.includes(trimmed)) return { kind: "interface", tab: trimmed || undefined };
  const [first, ...rest] = trimmed.split(/\s+/);
  const named = Boolean(fusions?.[first]);
  const fusion = named ? first : (defaultFusion ?? ids[0]);
  const prompt = named ? rest.join(" ") : trimmed;
  if (!prompt) return { kind: "usage" };
  return {
    kind: "run",
    fusion,
    prompt,
    ...(named ? {} : { notice: `no fusion "${first}"; known: ${ids.join(", ")} — ${fusion} runs with the line as the prompt` }),
  };
}
