/*
 * What the daemon actually did, as opposed to what Compose said.
 *
 * The unit suite asserts the resolved project. This one asserts that Docker
 * applied it, which is a different claim: a setting can be accepted by Compose,
 * emitted in `config`, and still not take effect the way it reads.
 *
 * `docker compose create` rather than `up`, so nothing has to start. The
 * container is built and inspected and never run, which means no working image
 * is required and the suite finishes in seconds. A stand-in image is used for
 * the same reason: the subject here is this project's runtime contract, not
 * yggdrasil, whose own image is covered by the docker suite in kosmos.yggdrasil.
 *
 * A separate project name is used throughout so that running this can never
 * disturb a real ginnungagap on the same machine.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { toComposeEnv } from "../../scripts/lib/deployment.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const composePath = join(repoRoot, "compose.template.yaml");

const PROJECT = "ginnungagap-test";
const CONTAINER = `${PROJECT}-yggdrasil-1`;

/*
 * The deployment this suite resolves the template against, and the names of what has
 * to exist for it. Both come from the fixture rather than from config/deployment.json,
 * so the suite tests the project rather than what Kosmos is configured with.
 *
 * The mounts declare `create_host_path: false`, so a source that does not exist stops
 * `docker compose create` with the path named. That is the point of the setting and it
 * means this suite has to provide the sources: three files and one directory, under a
 * directory it creates and removes. A file for a file mount and a directory for a
 * directory mount, because mounting one onto the other is a different failure.
 *
 * A mount added to the template and not to `seed` fails `create` naming the path,
 * which is a louder guard than an assertion would be.
 */
const { seed: SEED, ...FIXTURE } = JSON.parse(
  readFileSync(join(repoRoot, "tests", "fixtures", "deployment.json"), "utf8")
);

const CERT_TARGETS = [
  "/etc/ssl/yggdrasil/canunu.me.fullchain.pem",
  "/etc/ssl/yggdrasil/canunu.me.key",
  "/etc/ssl/kosmos/kosmos-local-ca.crt"
];
const LOG_TARGET = "/var/log/yggdrasil";

/*
 * What the daemon should record for the limits the fixture asks for.
 *
 * Compose canonicalises both, so these are not the values written in the fixture:
 * `cpus` becomes NanoCpus and `1g` becomes a byte count. That translation is part of
 * what is being asserted, which is why they are computed here rather than read.
 */
const EXPECTED_NANO_CPUS = 2_000_000_000;
const EXPECTED_MEMORY_BYTES = 1_073_741_824;

/*
 * The directory the seeded mount sources live under, created before the container and
 * removed after it. `mkdtemp` rather than a fixed path so two runs cannot collide and
 * so nothing outside it is ever written to.
 */
let hostRoot;

/** Create every source the template mounts, as the kind of thing it mounts. */
function seedMountSources(root) {
  for (const relative of SEED.directories) {
    mkdirSync(join(root, relative), { recursive: true });
  }
  for (const relative of SEED.files) {
    const path = join(root, relative);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, "");
  }
}

function compose(args, extraEnv = {}) {
  const configured = toComposeEnv(FIXTURE);

  return spawnSync(
    "docker",
    ["compose", "--env-file", "/dev/null", "-f", composePath, "-p", PROJECT, ...args],
    {
      cwd: repoRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        ...configured,
        // The fixture holds the roots as names. Absolute here, joined onto the
        // directory this suite owns, because Compose resolves a relative host path
        // against the project directory.
        YGGDRASIL_HOST_CERT_ROOT: join(hostRoot, FIXTURE.yggdrasil.hostCertRoot),
        YGGDRASIL_HOST_LOG_ROOT: join(hostRoot, FIXTURE.yggdrasil.hostLogRoot),
        ...extraEnv
      }
    }
  );
}

/**
 * Whether the daemon can be reached, and why not when it cannot.
 *
 * "Not running" and "not reachable" are different problems and a failed `docker
 * info` covers both: a socket the current user cannot open reports permission
 * denied, not a stopped daemon. Reporting the daemon as down in that case sends
 * you to look at Docker Desktop instead of at the socket.
 */
function daemonStatus() {
  const result = spawnSync("docker", ["info"], { encoding: "utf8" });

  if (result.error)
    return { reachable: false, reason: `could not run docker: ${result.error.message}` };
  if (result.status === 0) return { reachable: true };

  const stderr = (result.stderr ?? "").trim().split("\n").pop() ?? "";
  return { reachable: false, reason: stderr || "docker info failed" };
}

/**
 * Every mount, from wherever Docker happens to have recorded it.
 *
 * Docker reports mounts in more than one place, and which place depends on how
 * they were requested rather than on what they are. Compose emits bind mounts as
 * `HostConfig.Binds` strings and non-bind mounts as `HostConfig.Mounts` specs,
 * while the top level `Mounts` array is the effective view and names its fields
 * differently again: `Destination` rather than `Target`, and `RW` rather than
 * `ReadOnly`.
 *
 * Normalising all three is not defensive clutter. A test that understands only
 * one placement passes or fails according to the Docker version rather than
 * according to the project, which is the opposite of what it is for.
 */
function mountsOf(inspected) {
  const hostConfig = inspected.HostConfig ?? {};
  const mounts = [];

  for (const bind of hostConfig.Binds ?? []) {
    const [source, destination, mode = ""] = bind.split(":");
    mounts.push({
      type: "bind",
      source,
      destination,
      readOnly: mode.split(",").includes("ro")
    });
  }

  for (const spec of hostConfig.Mounts ?? []) {
    mounts.push({
      type: spec.Type,
      source: spec.Source ?? "",
      destination: spec.Target,
      readOnly: spec.ReadOnly === true
    });
  }

  for (const [target] of Object.entries(hostConfig.Tmpfs ?? {})) {
    mounts.push({ type: "tmpfs", source: "", destination: target, readOnly: false });
  }

  for (const effective of inspected.Mounts ?? []) {
    if (mounts.some((mount) => mount.destination === effective.Destination)) continue;
    mounts.push({
      type: effective.Type,
      source: effective.Source ?? "",
      destination: effective.Destination,
      readOnly: effective.RW === false
    });
  }

  return mounts;
}

const status = daemonStatus();
const skip = status.reachable ? false : `cannot reach the Docker daemon: ${status.reason}`;

let inspected;
let hostConfig;
let mounts;

before(() => {
  if (!status.reachable) return;

  hostRoot = mkdtempSync(join(tmpdir(), "ginnungagap-runtime-"));
  seedMountSources(hostRoot);

  const created = compose(["create", "--quiet-pull"]);
  assert.equal(created.status, 0, `docker compose create failed:\n${created.stderr}`);

  const result = spawnSync("docker", ["inspect", CONTAINER], { encoding: "utf8" });
  assert.equal(result.status, 0, `docker inspect failed:\n${result.stderr}`);

  inspected = JSON.parse(result.stdout)[0];
  hostConfig = inspected.HostConfig;
  mounts = mountsOf(inspected);
});

after(() => {
  if (!status.reachable) return;
  compose(["down", "--remove-orphans"]);
  if (hostRoot) rmSync(hostRoot, { recursive: true, force: true });
});

describe("what the daemon applied", { skip }, () => {
  it("made the root filesystem read only", () => {
    assert.equal(hostConfig.ReadonlyRootfs, true);
  });

  it("dropped all capabilities", () => {
    assert.deepEqual(hostConfig.CapDrop, ["ALL"]);
    assert.ok(!hostConfig.CapAdd || hostConfig.CapAdd.length === 0);
  });

  it("forbade privilege escalation", () => {
    const opts = hostConfig.SecurityOpt ?? [];
    assert.ok(
      opts.some((opt) => opt.includes("no-new-privileges")),
      `SecurityOpt was ${JSON.stringify(opts)}`
    );
  });

  it("bound the published port to loopback and nothing else", () => {
    const bindings = hostConfig.PortBindings["8443/tcp"];
    assert.equal(bindings.length, 1);
    assert.equal(bindings[0].HostIp, "127.0.0.1");
    assert.equal(bindings[0].HostPort, "8443");
  });

  it("published no other port", () => {
    assert.deepEqual(Object.keys(hostConfig.PortBindings), ["8443/tcp"]);
  });

  it("gave the container a tmpfs on /tmp", () => {
    const tmp = mounts.find((mount) => mount.destination === "/tmp");
    assert.ok(tmp, `no mount on /tmp; mounts were ${JSON.stringify(mounts)}`);
    assert.equal(tmp.type, "tmpfs");
  });

  it("mounted every certificate read only", () => {
    for (const target of CERT_TARGETS) {
      const mount = mounts.find((candidate) => candidate.destination === target);
      assert.ok(mount, `${target} is not mounted; mounts were ${JSON.stringify(mounts)}`);
      assert.equal(mount.readOnly, true, `${target} was mounted writable`);
    }
  });

  it("mounted the log directory writable", () => {
    const log = mounts.find((mount) => mount.destination === LOG_TARGET);
    assert.ok(log, `${LOG_TARGET} is not mounted; mounts were ${JSON.stringify(mounts)}`);
    assert.equal(log.readOnly, false);
  });

  it("mounted nothing unexpected", () => {
    const destinations = mounts.map((mount) => mount.destination).sort();
    assert.deepEqual(destinations, [...CERT_TARGETS, LOG_TARGET, "/tmp"].sort());
  });

  it("is not privileged", () => {
    assert.equal(hostConfig.Privileged, false);
  });

  /*
   * These two are the reason this suite is worth having, in miniature.
   *
   * `deploy:` was Swarm-only under Compose v1 and is silently ignored there,
   * which makes a resource limit the textbook case of a setting that Compose
   * accepts, emits in `config`, and does not apply. Asserting it against the
   * daemon is the only way to know which of those two worlds the installed
   * Compose is in.
   */
  it("applied the memory limit", () => {
    assert.equal(hostConfig.Memory, EXPECTED_MEMORY_BYTES);
  });

  it("applied the CPU limit", () => {
    assert.equal(hostConfig.NanoCpus, EXPECTED_NANO_CPUS);
  });
});
