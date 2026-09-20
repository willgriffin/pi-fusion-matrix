#!/usr/bin/env node
/**
 * Lint the commits a branch adds, or a single message.
 *
 * Two callers, one rule set. Locally and in CI it checks a *range* — what this branch adds over the default
 * branch — because a repository's older commits are history and rewriting them to satisfy a rule introduced
 * later would be a lie about what happened. For a pull request it checks one *message*, the title, because a
 * squash merge turns that title into the commit.
 *
 *   node scripts/lint-commits.mjs                          # the range from the merge base with origin/main
 *   node scripts/lint-commits.mjs --from <sha> --to <sha>  # an explicit range
 *   node scripts/lint-commits.mjs --message "fix(seats): …"
 *
 * Needs no network: commitlint resolves from the local install.
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const bin = path.join(root, "node_modules", ".bin", "commitlint");
const args = process.argv.slice(2);
const value = (name) => {
  const index = args.indexOf(`--${name}`);
  return index === -1 ? undefined : args[index + 1];
};

if (!existsSync(bin)) {
  console.error(`lint:commits — commitlint is not installed. Run: npm install`);
  process.exit(2);
}

const run = (input) => {
  const result = spawnSync(bin, [], { cwd: root, input, encoding: "utf8" });
  process.stdout.write(result.stdout ?? "");
  process.stderr.write(result.stderr ?? "");
  return result.status ?? 1;
};

const message = value("message");
if (message !== undefined) {
  if (!message.trim()) {
    console.error("lint:commits — --message was given nothing to check");
    process.exit(2);
  }
  const status = run(message);
  console.log(status === 0 ? `lint:commits — message ok` : `lint:commits — message rejected`);
  process.exit(status);
}

const git = (gitArgs) => {
  const result = spawnSync("git", gitArgs, { cwd: root, encoding: "utf8" });
  return result.status === 0 ? result.stdout.trim() : undefined;
};

const to = value("to") ?? git(["rev-parse", "HEAD"]);
if (!to) {
  console.error("lint:commits — HEAD does not resolve; not a git checkout?");
  process.exit(2);
}
// `--from` wins; otherwise the merge base with the default branch. A branch that has already merged (or a
// detached checkout) has no merge base to find, and saying so beats linting the whole history.
const base =
  value("from") ?? ["origin/main", "origin/master", "main", "master"].map((ref) => git(["merge-base", "HEAD", ref])).find(Boolean);
if (!base) {
  console.log("lint:commits — no merge base with a default branch; nothing to check");
  process.exit(0);
}

const list = git(["log", "--format=%H %s", `${base}..${to}`]);
if (!list) {
  console.log(`lint:commits — no commits between ${base.slice(0, 8)} and ${to.slice(0, 8)}`);
  process.exit(0);
}
const commits = list.split("\n").filter(Boolean);
console.log(`lint:commits — ${commits.length} commit(s) over ${base.slice(0, 8)}`);

const result = spawnSync(bin, ["--from", base, "--to", to, "--verbose"], { cwd: root, encoding: "utf8" });
process.stdout.write(result.stdout ?? "");
process.stderr.write(result.stderr ?? "");
process.exit(result.status ?? 1);
