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
const composePath = join(repoRoot, "compose.template.yaml");
const recordPath = join(repoRoot, "config", "deployment.json");

/*
 * Stand-in values throughout, so the suite tests the project's shape rather than
 * whatever Kosmos is configured with today. The image was already a stand-in for
 * that reason and the host roots now join it, which is what makes the containment
 * assertions below hold for any deployment instead of for one set of paths.
 *
 * What the committed record actually says is asserted separately, at the bottom,
 * because nothing else would: every containment assertion is satisfied trivially by
 * a root of `/`.
 */
const { seed: _seed, ...FIXTURE } = JSON.parse(
  readFileSync(join(repoRoot, "tests", "fixtures", "deployment.json"), "utf8")
);

const PROBE_IMAGE = "probe.invalid/yggdrasil:0000000";

/*
 * The fixture holds the roots as names; each suite supplies the base. This one is
 * never on the filesystem, so the base is fictional and only has to be absolute:
 * Compose resolves a relative host path against the project directory, which would
 * put every mount inside the checkout and make the containment assertions below
 * compare a relative name against an absolute path. The runtime suite joins the same
 * names onto a directory it creates instead.
 */
const PROBE_BASE = "/probe";
const CERT_ROOT = join(PROBE_BASE, FIXTURE.yggdrasil.hostCertRoot);
const LOG_ROOT = join(PROBE_BASE, FIXTURE.yggdrasil.hostLogRoot);

const CERT_MOUNTS = [
  "/etc/ssl/yggdrasil/canunu.me.fullchain.pem",
  "/etc/ssl/yggdrasil/canunu.me.key",
  "/etc/ssl/kosmos/kosmos-local-ca.crt"
];
const LOG_MOUNT = "/var/log/yggdrasil";

/** Resolve the project the way the build does, with an overridable environment. */
function composeConfig(overrides = {}) {
  const base = toComposeEnv(FIXTURE);

  const env = {
    ...process.env,
    ...base,
    YGGDRASIL_IMAGE: PROBE_IMAGE,
    YGGDRASIL_HOST_CERT_ROOT: CERT_ROOT,
    YGGDRASIL_HOST_LOG_ROOT: LOG_ROOT,
    ...overrides
  };
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

  it("holds the edge, and not the registry", () => {
    // The registry has a project of its own, in kosmos.draupnir. It sits below
    // this one rather than beside the edge: the cluster pulls from it too, and it
    // must be running before anything here starts, which cannot be expressed in a
    // single project because Compose resolves every image before creating any
    // container.
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

  it("never publishes on a wildcard address, in any service", () => {
    // Across every service rather than the edge alone, so a service added later
    // inherits the rule instead of escaping it. The edge's own reason is in the
    // file header: hermes is the only way in, and it is the only thing that sees
    // a real client address.
    for (const [name, declared] of Object.entries(project.services)) {
      for (const port of declared.ports ?? []) {
        assert.ok(port.host_ip, `${name} publishes ${port.target} with no host_ip`);
        assert.notEqual(port.host_ip, "0.0.0.0", `${name} publishes ${port.target} on a wildcard`);
        assert.notEqual(port.host_ip, "::", `${name} publishes ${port.target} on a wildcard`);
      }
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

describe("secrets", () => {
  it("carries no credential anywhere in the resolved project", () => {
    // Nothing here needs a credential today, and that is the point: this artifact
    // is built on a development machine, has its inputs committed by way of
    // config/deployment.json, and is copied to Kosmos. Anything secret that
    // reached it would be secret in three places at once.
    const rendered = JSON.stringify(project);
    assert.doesNotMatch(rendered, /password=/i);
    assert.doesNotMatch(rendered, /username=/i);
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

  it("refuses to create a missing certificate source", () => {
    // Without this Docker invents a directory in place of a missing source and the
    // container starts anyway, which nginx reports as a certificate it cannot read.
    // This is what stops a reverted mount block restoring that quietly.
    for (const target of CERT_MOUNTS) {
      const mount = service.volumes.find((v) => v.target === target);
      assert.equal(
        mount.bind?.create_host_path,
        false,
        `${target} must not have its host path created for it`
      );
    }
  });

  it("mounts the log directory writable", () => {
    const mount = service.volumes.find((v) => v.target === LOG_MOUNT);
    assert.notEqual(mount.read_only, true);
  });

  it("never mounts an ancestor of the log root", () => {
    // Every component keeps its files under one shared root, including the session
    // state atlas maintains, and the log root is this component's directory inside
    // it. Widening the mount to a parent would hand an Internet facing process write
    // access to all of it. See Locations in kosmos.bootstrap/docs/03_Logging.md.
    //
    // Implied by the whitelist below, and kept because it names the hazard: a
    // failure here says the mount was widened rather than that a prefix did not
    // match.
    for (const mount of service.volumes) {
      if (mount.type !== "bind") continue;
      assert.ok(
        !LOG_ROOT.startsWith(`${mount.source}/`),
        `${mount.source} is an ancestor of the log root ${LOG_ROOT}`
      );
    }
  });

  it("refuses to create a missing log directory", () => {
    // atlas creates it at login. A directory Docker invents instead has a mode
    // nobody chose, and the container starts anyway.
    const mount = service.volumes.find((v) => v.target === LOG_MOUNT);
    assert.equal(mount.bind?.create_host_path, false);
  });

  it("only mounts from the two configured host roots", () => {
    const allowed = [`${CERT_ROOT}/`, LOG_ROOT];
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

  it("leaves the initial start to atlas, in every service", () => {
    // atlas is the sole start authority for this project: it checks the resources a
    // service depends on before the `up`, and readiness after it. `always` and
    // `unless-stopped` both have the daemon start the container when the daemon
    // starts, which on this host is every login, so a container could reach the
    // network having been through neither check. Asserted across every service
    // rather than yggdrasil alone, so a service added later inherits the rule
    // instead of escaping it. See "What atlas is responsible for starting" in
    // kosmos.bootstrap/docs/bare_metal/07_KosmosStartup.md.
    for (const [name, declared] of Object.entries(project.services)) {
      const policy = declared.restart;
      assert.ok(policy, `${name} declares no restart policy`);
      assert.ok(
        policy.startsWith("on-failure"),
        `${name} declares restart: ${policy}. Only on-failure leaves the first start to atlas`
      );
    }
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

describe("the committed deployment record", () => {
  /*
   * The suite above resolves the template against stand-in values, which is what
   * makes its assertions hold for any deployment. The consequence is that nothing
   * there looks at what Kosmos is actually configured with: a host root of `/` would
   * satisfy every containment assertion trivially, because everything is inside it.
   *
   * So the record is checked on its own terms, here, and only for the properties that
   * are wrong at any value rather than for the values themselves. Re-pathing a
   * deployment must not fail these.
   */
  const record = JSON.parse(readFileSync(recordPath, "utf8")).yggdrasil;

  for (const key of ["hostCertRoot", "hostLogRoot"]) {
    it(`states ${key} as an absolute path`, () => {
      // The built artifact is read by Docker on Kosmos with no shell and no working
      // directory to be relative to, and the template deliberately does not use
      // ${HOME}, so a relative value here would resolve against whatever ran the
      // build rather than against the account that runs the container.
      assert.ok(record[key].startsWith("/"), `${key} is ${record[key]}`);
      assert.ok(!record[key].endsWith("/"), `${key} has a trailing slash: ${record[key]}`);
    });
  }

  it("gives the log mount a directory of its own, not a shared root", () => {
    // The mount is writable and reaches an Internet facing process. Its parent holds
    // every other component's files, including the session state atlas maintains.
    const parent = record.hostLogRoot.split("/").slice(0, -1).join("/");
    assert.ok(parent.length > 1, `hostLogRoot has no parent to be inside: ${parent}`);
    assert.notEqual(record.hostLogRoot, parent);
  });

  it("keeps the certificate material outside the writable mount", () => {
    // Certificates are mounted read only and the log directory is not. Nesting one
    // inside the other would put material the edge verifies against inside the only
    // directory it can write to.
    assert.ok(!record.hostCertRoot.startsWith(`${record.hostLogRoot}/`));
    assert.ok(!record.hostLogRoot.startsWith(`${record.hostCertRoot}/`));
  });
});
