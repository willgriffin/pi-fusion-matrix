/**
 * The outcomes a `/matrix-label` may carry.
 *
 * One list, in one place, because two readers depend on it: the command refuses anything outside it, and
 * `scripts/session-report.mjs` refuses to *read* anything outside it — the store is editable by hand, and a
 * report that accepted `shipped` would count an outcome nobody defined. A free-text outcome cannot be
 * counted, which is the whole reason the vocabulary is closed.
 */
export const LABEL_OUTCOMES = ["landed", "review", "findings", "ci-red", "blocked", "abandoned"];

export const isOutcome = (value) => typeof value === "string" && LABEL_OUTCOMES.includes(value);
