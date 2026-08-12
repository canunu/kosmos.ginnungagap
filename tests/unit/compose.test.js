/*
 * Invariants of the built project.
 *
 * These run against `docker compose config`, which is a client side operation,
 * so the whole suite works with Docker Desktop stopped and is fast enough for a
 * commit hook.
 *
 * The assertions are not style checks. Most of them encode a property something
 * else on the platform depends on, and the loopback binding is the sharpest
 * example: kosmos.yggdrasil's nginx sets `set_real_ip_from 0.0.0.0/0` and trusts
 * the PROXY protocol header from any source, which is safe only because nothing
 * off-host can open that connection. Publishing on 0.0.0.0 would turn that trust
 * into a client address spoofing vulnerability, silently, in a different
 * repository. This file is the only place that link is enforced.
 */

import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { toComposeEnv } from "../../scripts/lib/deployment.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const composePath = join(repoRoot, "compose.yaml");

// A stand-in rather than the configured value, so the suite tests the project's
// shape and not whatever happens to be deployed today. The guard tests below
// cover the configured value being absent.
const PROBE_IMAGE = "probe.invalid/yggdrasil:0000000";

const CERT_MOUNTS = [
  "/etc/ssl/yggdrasil/canunu.me.fullchain.pem",
  "/etc/ssl/yggdrasil/canunu.me.key",
  "/etc/ssl/kosmos/kosmos-local-ca.crt"
];
const LOG_MOUNT = "/var/log/yggdrasil";

/** Resolve the project the way the build does, with an overridable environment. */
function composeConfig(overrides = {}) {
  const base = toComposeEnv(
    JSON.parse(readFileSync(join(repoRoot, "config", "deployment.json"), "utf8"))
  );

  const env = { ...process.env, ...base, YGGDRASIL_IMAGE: PROBE_IMAGE, ...overrides };
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete env[key];
  }

  return spawnSync(
    "docker",
    ["compose", "--env-file", "/dev/null", "-f", composePath, "config", "--format", "json"],
    {
      cwd: repoRoot,
      env,
      encoding: "utf8"
    }
  );
}

let project;
let service;

before(() => {
  const result = composeConfig();

  if (result.error) {
    assert.fail(
      `could not run docker: ${result.error.message}\n` +
        "The Docker CLI is required for these tests. The daemon is not: `docker compose config` is client side."
    );
  }

  assert.equal(result.status, 0, `docker compose config failed:\n${result.stderr}`);

  project = JSON.parse(result.stdout);
  service = project.services.yggdrasil;
});

describe("project identity", () => {
  it("is named ginnungagap", () => {
    assert.equal(project.name, "ginnungagap");
  });

  it("holds exactly one service, yggdrasil", () => {
    assert.deepEqual(Object.keys(project.services), ["yggdrasil"]);
  });

  it("names its network ginnungagap rather than leaving it as _default", () => {
    assert.deepEqual(Object.keys(project.networks), ["ginnungagap"]);
    assert.equal(project.networks.ginnungagap.name, "ginnungagap");
  });
});

describe("exposure", () => {
  it("publishes exactly one port", () => {
    assert.equal(service.ports.length, 1);
  });

  it("binds the published port to loopback only", () => {
    // If this fails, read the file header before changing the test.
    assert.equal(service.ports[0].host_ip, "127.0.0.1");
    assert.equal(service.ports[0].target, 8443);
    assert.equal(String(service.ports[0].published), "8443");
  });

  it("never publishes on a wildcard address", () => {
    for (const port of service.ports) {
      assert.ok(port.host_ip, `port ${port.target} has no host_ip, which binds all interfaces`);
      assert.notEqual(port.host_ip, "0.0.0.0");
      assert.notEqual(port.host_ip, "::");
    }
  });

  it("never publishes the status listener", () => {
    for (const port of service.ports) {
      assert.notEqual(
        port.target,
        8081,
        "8081 reports the running build version and must stay internal"
      );
    }
  });

  it("never publishes port 80, which hermes answers and never forwards", () => {
    for (const port of service.ports) {
      assert.notEqual(port.target, 80);
    }
  });
});

describe("hardening", () => {
  it("runs with a read only root filesystem", () => {
    assert.equal(service.read_only, true);
  });

  it("drops all capabilities and adds none back", () => {
    assert.deepEqual(service.cap_drop, ["ALL"]);
    assert.ok(!service.cap_add || service.cap_add.length === 0);
  });

  it("forbids privilege escalation", () => {
    assert.ok(service.security_opt?.includes("no-new-privileges:true"));
  });

  it("is not privileged and does not use host networking", () => {
    assert.notEqual(service.privileged, true);
    assert.notEqual(service.network_mode, "host");
  });

  it("gives nginx a tmpfs for its pid file and temp paths", () => {
    const tmp = service.volumes.find((v) => v.type === "tmpfs" && v.target === "/tmp");
    assert.ok(tmp, "a read only root filesystem needs /tmp writable");
  });
});

describe("mounts", () => {
  it("mounts exactly the expected targets", () => {
    const targets = service.volumes.map((v) => v.target).sort();
    assert.deepEqual(targets, [...CERT_MOUNTS, LOG_MOUNT, "/tmp"].sort());
  });

  it("mounts every certificate read only", () => {
    for (const target of CERT_MOUNTS) {
      const mount = service.volumes.find((v) => v.target === target);
      assert.ok(mount, `${target} is not mounted`);
      assert.equal(mount.read_only, true, `${target} must be read only`);
    }
  });

  it("mounts the log directory writable", () => {
    const mount = service.volumes.find((v) => v.target === LOG_MOUNT);
    assert.notEqual(mount.read_only, true);
  });

  it("never mounts the session log directory itself", () => {
    // Widening this mount would hand an Internet facing process write access to
    // the session state atlas maintains. See 02_Conventions.md, derived naming.
    for (const mount of service.volumes) {
      if (mount.type !== "bind") continue;
      assert.notEqual(mount.source, "/Users/typhon/var/logs/kosmos");
      assert.notEqual(mount.source, "/Users/typhon/var/logs");
    }
  });

  it("only mounts from the two expected host roots", () => {
    const allowed = ["/Users/typhon/certs/", "/Users/typhon/var/logs/kosmos/yggdrasil"];
    for (const mount of service.volumes) {
      if (mount.type !== "bind") continue;
      assert.ok(
        allowed.some((prefix) => mount.source.startsWith(prefix)),
        `unexpected bind mount source: ${mount.source}`
      );
    }
  });
});

describe("deployment discipline", () => {
  it("pulls only when the image is absent", () => {
    // This is what lets the first bootstrap use the locally built image without
    // contacting draupnir, and is safe only because tags are immutable.
    assert.equal(service.pull_policy, "missing");
  });

  it("pins an explicit tag rather than latest", () => {
    assert.match(service.image, /:[^:/]+$/, "the image reference carries no tag");
    assert.doesNotMatch(service.image, /:latest$/);
  });

  it("restarts unless deliberately stopped", () => {
    assert.equal(service.restart, "unless-stopped");
  });

  it("stops nginx gracefully", () => {
    // SIGTERM is nginx's fast shutdown and drops connections mid-deploy.
    assert.equal(service.stop_signal, "SIGQUIT");
  });
});

describe("the unset image guard", () => {
  it("refuses to resolve when the image is empty", () => {
    const result = composeConfig({ YGGDRASIL_IMAGE: "" });
    assert.notEqual(result.status, 0, "an empty image must not produce a usable project");
  });

  it("names the setting to change", () => {
    const result = composeConfig({ YGGDRASIL_IMAGE: "" });
    assert.match(result.stderr, /config\/deployment\.json/);
  });

  it("refuses to resolve when the retention setting is missing", () => {
    const result = composeConfig({ YGGDRASIL_LOG_RETENTION_DAYS: "" });
    assert.notEqual(result.status, 0);
  });
});
