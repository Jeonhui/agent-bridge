import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { AgentBridgeError } from "../errors/AgentBridgeError.js";
import {
  isSecretReference,
  parseSecretReference,
  resolveSecrets,
} from "../secrets/SecretResolver.js";
import {
  ChainSecretResolver,
  EnvSecretResolver,
  KeychainSecretResolver,
  MapSecretResolver,
} from "../secrets/resolvers.js";

describe("secret references (spec 26.3)", () => {
  it("recognizes only the secret:// scheme", () => {
    assert.equal(isSecretReference("secret://github/token"), true);
    assert.equal(isSecretReference("ghp_actual_token"), false);
    assert.equal(isSecretReference(undefined), false);
  });

  it("splits service and account", () => {
    assert.deepEqual(parseSecretReference("secret://github/token"), {
      raw: "secret://github/token",
      service: "github",
      account: "token",
    });
    assert.deepEqual(parseSecretReference("secret://api-key"), {
      raw: "secret://api-key",
      service: "api-key",
    });
  });

  it("rejects a malformed reference with AB-6004", () => {
    assert.throws(
      () => parseSecretReference("secret://"),
      (error: unknown) => error instanceof AgentBridgeError && error.code === "AB-6004",
    );
  });
});

describe("resolveSecrets", () => {
  const resolver = new MapSecretResolver({ "secret://github/token": "ghp_real" });

  it("leaves plain values untouched and avoids the resolver entirely", async () => {
    let called = false;
    const spy = { resolve: async () => { called = true; return "x"; } };

    assert.deepEqual(await resolveSecrets({ A: "1", B: "2" }, spy), { A: "1", B: "2" });
    assert.equal(called, false);
  });

  it("substitutes a reference", async () => {
    assert.deepEqual(
      await resolveSecrets({ GITHUB_TOKEN: "secret://github/token", PLAIN: "keep" }, resolver),
      { GITHUB_TOKEN: "ghp_real", PLAIN: "keep" },
    );
  });

  it("fails loudly when no resolver is configured", async () => {
    await assert.rejects(
      () => resolveSecrets({ T: "secret://github/token" }, undefined),
      (error: unknown) => error instanceof AgentBridgeError && error.code === "AB-6004",
    );
  });

  it("fails rather than passing the literal reference through", async () => {
    // Handing `secret://...` to a child process looks like a real value and surfaces later as a
    // confusing authentication failure somewhere else entirely.
    await assert.rejects(
      () => resolveSecrets({ T: "secret://missing/entry" }, resolver),
      (error: unknown) =>
        error instanceof AgentBridgeError &&
        error.code === "AB-6004" &&
        /no secret found/.test(error.message),
    );
  });

  it("returns undefined for an absent map", async () => {
    assert.equal(await resolveSecrets(undefined, resolver), undefined);
  });
});

describe("resolvers", () => {
  it("EnvSecretResolver maps a reference onto an env var name", async () => {
    const resolver = new EnvSecretResolver({ GITHUB_TOKEN: "from-env", APIKEY: "flat" });

    assert.equal(await resolver.resolve(parseSecretReference("secret://github/token")), "from-env");
    assert.equal(await resolver.resolve(parseSecretReference("secret://apikey")), "flat");
    assert.equal(await resolver.resolve(parseSecretReference("secret://absent")), undefined);
  });

  it("MapSecretResolver matches on the full reference or the service", async () => {
    const resolver = new MapSecretResolver({ "secret://a/b": "full", c: "by-service" });

    assert.equal(await resolver.resolve(parseSecretReference("secret://a/b")), "full");
    assert.equal(await resolver.resolve(parseSecretReference("secret://c")), "by-service");
  });

  it("ChainSecretResolver takes the first hit", async () => {
    const chain = new ChainSecretResolver(
      new MapSecretResolver({}),
      new MapSecretResolver({ "secret://x": "second" }),
    );

    assert.equal(await chain.resolve(parseSecretReference("secret://x")), "second");
    assert.equal(await chain.resolve(parseSecretReference("secret://y")), undefined);
  });

  it("KeychainSecretResolver returns undefined on an unsupported platform", async () => {
    const resolver = new KeychainSecretResolver("aix" as NodeJS.Platform);
    assert.equal(await resolver.resolve(parseSecretReference("secret://a/b")), undefined);
  });

  it("KeychainSecretResolver treats a lookup miss as undefined, not a failure", async () => {
    const resolver = new KeychainSecretResolver();
    const value = await resolver.resolve(
      parseSecretReference("secret://agentbridge-test-definitely-absent/entry"),
    );
    assert.equal(value, undefined);
  });
});
