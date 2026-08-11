#!/usr/bin/env node
/*
 * Validates the shell in this repository.
 *
 * That is only the git hooks. They are worth checking anyway, because a broken
 * hook fails at the worst possible moment, in the middle of someone's commit,
 * and because they are the one place here that handles a path handed over by
 * git, which is where an unquoted expansion would bite.
 *
 * husky's own generated shims under .husky/_ are not ours and are skipped.
 *
 * `sh -n` is always available and catches syntax errors. shellcheck catches the
 * things that actually matter, above all unquoted expansions.
 *
 * A missing shellcheck is a failure rather than a skip. It is a declared tool in
 * this repository's README, so its absence is a broken development environment
 * and not an optional extra, and a check that merely prints when it cannot run is
 * a check that quietly stops running.
 *
 * Everything is checked as POSIX sh rather than bash, because git runs hooks
 * with whatever shell it has, and assuming bash would be checking a shell that
 * never runs these.
 */

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const hooksDir = join(repoRoot, ".husky");

function hookScripts() {
  if (!existsSync(hooksDir)) return [];

  return readdirSync(hooksDir)
    .filter((name) => !name.startsWith("_") && !name.startsWith("."))
    .map((name) => join(hooksDir, name))
    .filter((path) => statSync(path).isFile());
}

function have(tool) {
  return spawnSync(tool, ["--version"], { stdio: "ignore" }).status === 0;
}

const targets = hookScripts();

if (targets.length === 0) {
  console.log("lint-shell: nothing to check");
  process.exit(0);
}

if (!have("shellcheck")) {
  console.error("lint-shell: shellcheck not found. Install it with `brew install shellcheck`.");
  console.error("lint-shell: it is a declared tool for this repository, so this is a failure");
  console.error("lint-shell: rather than a skip. Skipping would mean the hooks stop being checked");
  console.error("lint-shell: without anyone noticing.");
  process.exit(1);
}

let failed = false;

for (const path of targets) {
  const name = relative(repoRoot, path);

  const syntax = spawnSync("sh", ["-n", path], { encoding: "utf8" });
  if (syntax.status !== 0) {
    process.stderr.write(`lint-shell: ${name}: syntax error\n${syntax.stderr}`);
    failed = true;
    continue;
  }

  // -s sh forces the POSIX dialect regardless of any shebang, since these files
  // have none: husky sources them.
  const check = spawnSync("shellcheck", ["-s", "sh", path], { encoding: "utf8" });
  if (check.status !== 0) {
    process.stderr.write(`lint-shell: ${name}\n${check.stdout}${check.stderr}`);
    failed = true;
  }
}

if (failed) process.exit(1);

console.log(`lint-shell: ${targets.length} file(s) OK`);
