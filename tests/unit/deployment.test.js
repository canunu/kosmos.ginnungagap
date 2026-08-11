/*
 * The configuration to environment mapping, tested in isolation.
 *
 * This is the only hand written transform in the repository, so it is the only
 * place a substitution bug can live. Everything else is Compose's own behaviour.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  referencedVariables,
  screamingSnake,
  stripComments,
  toComposeEnv
} from "../../scripts/lib/deployment.mjs";

describe("screamingSnake", () => {
  it("splits camelCase", () => {
    assert.equal(screamingSnake("logRetentionDays"), "LOG_RETENTION_DAYS");
  });

  it("leaves a single lowercase word alone but for case", () => {
    assert.equal(screamingSnake("image"), "IMAGE");
    assert.equal(screamingSnake("yggdrasil"), "YGGDRASIL");
  });

  it("handles digits without splitting them off", () => {
    assert.equal(screamingSnake("port8443"), "PORT8443");
  });
});

describe("toComposeEnv", () => {
  it("joins the service and the key", () => {
    const env = toComposeEnv({ yggdrasil: { image: "example/x:1", logRetentionDays: 30 } });

    assert.deepEqual(env, {
      YGGDRASIL_IMAGE: "example/x:1",
      YGGDRASIL_LOG_RETENTION_DAYS: "30"
    });
  });

  it("stringifies numbers, because interpolation is textual", () => {
    const env = toComposeEnv({ svc: { count: 7 } });
    assert.strictEqual(env.SVC_COUNT, "7");
  });

  it("renders an empty value as an empty string so the ${VAR:?} guard fires", () => {
    const env = toComposeEnv({ yggdrasil: { image: "" } });
    assert.strictEqual(env.YGGDRASIL_IMAGE, "");
  });

  it("supports more than one service", () => {
    const env = toComposeEnv({ one: { image: "a" }, two: { image: "b" } });
    assert.deepEqual(Object.keys(env).sort(), ["ONE_IMAGE", "TWO_IMAGE"]);
  });

  it("rejects nested settings, which cannot be interpolated", () => {
    assert.throws(() => toComposeEnv({ svc: { nested: { a: 1 } } }), /scalar/);
  });

  it("rejects a service that is not an object", () => {
    assert.throws(() => toComposeEnv({ svc: "nope" }), /object of settings/);
  });

  it("rejects a collision between two settings", () => {
    assert.throws(() => toComposeEnv({ a: { bC: 1, "b-c": 2 } }), /collides/);
  });
});

describe("referencedVariables", () => {
  it("finds a bare reference", () => {
    assert.deepEqual([...referencedVariables("image: ${FOO}")], ["FOO"]);
  });

  it("finds a reference carrying an error message", () => {
    const found = referencedVariables("image: ${FOO:?set foo somewhere, e.g. a:b}");
    assert.deepEqual([...found], ["FOO"]);
  });

  it("finds a reference carrying a default", () => {
    assert.deepEqual([...referencedVariables("x: ${FOO:-bar}")], ["FOO"]);
  });

  it("deduplicates", () => {
    assert.deepEqual([...referencedVariables("${FOO} ${FOO}")], ["FOO"]);
  });

  it("finds nothing in a file with no interpolation", () => {
    assert.equal(referencedVariables("image: alpine:3\n").size, 0);
  });

  it("ignores a variable mentioned only in a comment", () => {
    // compose.yaml explains why it does not use ${HOME}. Compose interpolates
    // the parsed model, so a comment can never need a value.
    const source =
      "# Absolute paths rather than ${HOME}, because the account is fixed.\nimage: ${FOO}\n";
    assert.deepEqual([...referencedVariables(source)], ["FOO"]);
  });

  it("ignores a trailing comment", () => {
    assert.deepEqual([...referencedVariables("image: ${FOO} # not ${BAR}")], ["FOO"]);
  });
});

describe("stripComments", () => {
  it("removes a whole line comment", () => {
    assert.equal(stripComments("# gone\nkept: 1"), "\nkept: 1");
  });

  it("removes a trailing comment", () => {
    assert.equal(stripComments("kept: 1 # gone"), "kept: 1 ");
  });

  it("keeps a hash inside a double quoted scalar", () => {
    assert.equal(stripComments('name: "a#b"'), 'name: "a#b"');
  });

  it("keeps a hash inside a single quoted scalar", () => {
    assert.equal(stripComments("name: 'a#b'"), "name: 'a#b'");
  });

  it("keeps a hash that is not preceded by whitespace", () => {
    // YAML only starts a comment at a # that begins a line or follows a space.
    assert.equal(stripComments("tag: sha#abc"), "tag: sha#abc");
  });
});
