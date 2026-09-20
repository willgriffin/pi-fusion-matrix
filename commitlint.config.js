/**
 * Conventional Commits, enforced. `AGENTS.md` has required this since the first commit and nothing checked it,
 * which is why the branch that added the review route carries scopes (`proxy`, `seats`, `telemetry`) that no
 * written rule ever named.
 *
 * A scope is either a module of this package or the concern the change belongs to. The list is closed on
 * purpose: an invented scope makes a commit log's own vocabulary useless for finding things, and a commit log
 * is the only index a repository keeps for free.
 *
 *   npm run lint:commits                       # every commit this branch adds over the default branch
 *   npm run lint:commits -- --message "…"      # one message, as a pull request title is checked
 */
export default {
  extends: ["@commitlint/config-conventional"],
  rules: {
    "scope-enum": [2, "always", [
      // modules
      "config", "resolve", "pipeline", "decide", "doctor", "run", "labels", "index",
      // operator tools and repository furniture
      "scripts", "tools", "docs", "tests", "ci", "deps",
      // concerns, as the log already uses them
      "proxy", "review", "route", "cascade", "seats", "streaming", "telemetry", "security",
    ]],
    "subject-case": [2, "always", "lower-case"],
    "header-max-length": [2, "always", 100],
    // A body is prose and carries evidence — quoted output, paths, commands. Wrapping it to fit a terminal would
    // break the quotes, so only the header is bounded. The same goes for a "footer": a body paragraph that opens
    // with a word and a colon (`Tests: …`, `Evidence: …`) is read as a trailer by the parser, and it is prose
    // like any other. Trailers this repository actually uses (`Refs #9`) are short by convention, not by rule.
    "body-max-line-length": [0],
    "footer-max-line-length": [0],
  },
};