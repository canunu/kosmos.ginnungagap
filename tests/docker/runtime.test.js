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
 *
 * **Only yggdrasil is created.** Compose still loads and interpolates the whole
 * project, so the registry's variables have to be supplied below, but creating
 * draupnir would require `draupnir-volume` to exist — an external volume, created
 * by hand on the host, carrying a credential. A test suite has no business
 * demanding that, and one that created a stand-in volume of the same name could
 * shadow the real store.
 *
 * The gap that leaves is worth stating: the registry's daemon-applied settings,
 * its capabilities, its published port and its limits, are asserted in the unit
 * suite as resolved configuration and are not checked here against what Docker
 * did with them. Its image and its behaviour against a real store are covered by
 * the suites in kosmos.draupnir.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const composePath = join(repoRoot, "compose.yaml");

const PROJECT = "ginnungagap-test";
const CONTAINER = `${PROJECT}-yggdrasil-1`;
const STAND_IN_IMAGE = "alpine:3";

const CERT_TARGETS = [
  "/etc/ssl/yggdrasil/canunu.me.fullchain.pem",
  "/etc/ssl/yggdrasil/canunu.me.key",
  "/etc/ssl/kosmos/kosmos-local-ca.crt"
];
const LOG_TARGET = "/var/log/yggdrasil";

/*
 * The limits this suite asks for, and what the daemon should record for them.
 *
 * Compose canonicalises both, so the expected values are not the values written
 * in the compose file: `cpus` becomes NanoCpus and `1g` becomes a byte count.
 * That translation is part of what is being asserted.
 *
 * These are the suite's own fixture rather than the values in
 * config/deployment.json, for the same reason the retention value below is.
 * The claim under test is that a limit is applied at all, not that production is
 * currently sized a particular way, and a test that read the deployment would
 * fail every time someone re-tuned it.
 */
const CPU_LIMIT = "2";
const MEMORY_LIMIT = "1g";
const EXPECTED_NANO_CPUS = 2_000_000_000;
const EXPECTED_MEMORY_BYTES = 1_073_741_824;

function compose(args, extraEnv = {}) {
  return spawnSync(
    "docker",
    ["compose", "--env-file", "/dev/null", "-f", composePath, "-p", PROJECT, ...args],
    {
      cwd: repoRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        YGGDRASIL_IMAGE: STAND_IN_IMAGE,
        YGGDRASIL_LOG_RETENTION_DAYS: "30",
        YGGDRASIL_CPU_LIMIT: CPU_LIMIT,
        YGGDRASIL_MEMORY_LIMIT: MEMORY_LIMIT,
        // Supplied because Compose interpolates every service before it creates
        // any, not because draupnir is created here. See the file header.
        DRAUPNIR_IMAGE: STAND_IN_IMAGE,
        DRAUPNIR_CPU_LIMIT: CPU_LIMIT,
        DRAUPNIR_MEMORY_LIMIT: MEMORY_LIMIT,
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

  const created = compose(["create", "--quiet-pull", "yggdrasil"]);
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
