#!/usr/bin/env node
/*
 * Builds the deployable compose file from compose.yaml and config/deployment.json.
 *
 * The transform is `docker compose config` rather than a templating library, and
 * that is the whole point of the design. Compose already interpolates `${VAR}`,
 * validates the schema, and emits canonical YAML, so there is no substitution
 * code here to get wrong and no second definition of what a valid project is.
 * compose.yaml stays a valid compose file that can be run directly during
 * development.
 *
 * Two consequences worth knowing:
 *
 *   The output has no comments. Compose reparses and reserialises the project,
 *   so the reasoning in compose.yaml does not survive into dist/. That is
 *   accepted: the artifact is not where the reasoning is read.
 *
 *   An unset variable fails here rather than on Kosmos. compose.yaml uses the
 *   `${VAR:?}` form, so a missing image is a build failure on a development
 *   machine instead of a container that will not start after a reboot.

 */

import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { referencedVariables, toComposeEnv } from "./lib/deployment.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const composePath = join(repoRoot, "compose.yaml");
const configPath = join(repoRoot, "config", "deployment.json");
const outDir = join(repoRoot, "dist");
const outPath = join(outDir, "compose.yaml");

function fail(message) {
  console.error(`build-compose: ${message}`);
  process.exit(1);
}

const config = JSON.parse(readFileSync(configPath, "utf8"));
const composeSource = readFileSync(composePath, "utf8");

let env;
try {
  env = toComposeEnv(config);
} catch (error) {
  fail(`${configPath}: ${error.message}`);
}

// Check the template and the configuration against each other before handing
// anything to Compose. Compose reports an unset variable, but it cannot report a
// setting that is configured and referenced nowhere, which is the quieter of the
// two mistakes and the one that leaves dead configuration behind.
const referenced = referencedVariables(composeSource);
const configured = new Set(Object.keys(env));

const unconfigured = [...referenced].filter((name) => !configured.has(name)).sort();
if (unconfigured.length > 0) {
  fail(
    `compose.yaml references variables that config/deployment.json does not set: ${unconfigured.join(", ")}`
  );
}

const unused = [...configured].filter((name) => !referenced.has(name)).sort();
if (unused.length > 0) {
  fail(`config/deployment.json sets values that compose.yaml never uses: ${unused.join(", ")}`);
}

// --env-file /dev/null so a stray .env in the working directory cannot silently
// contribute a value. Everything the build uses comes from the tracked config.
const result = spawnSync(
  "docker",
  ["compose", "--env-file", "/dev/null", "-f", composePath, "config"],
  { cwd: repoRoot, env: { ...process.env, ...env }, encoding: "utf8" }
);

if (result.error) {
  fail(`could not run docker: ${result.error.message}`);
}

if (result.status !== 0) {
  process.stderr.write(result.stderr ?? "");
  fail("docker compose config rejected the project");
}

mkdirSync(outDir, { recursive: true });
writeFileSync(outPath, result.stdout);

console.log(`build-compose: wrote ${outPath}`);
