import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { normalizeConfigLayer } from "../plugins/pi/scripts/lib/config.mjs";
// buildVariants lives in the big CLI module; importing it pulls the whole file,
// which is fine under node --test and keeps the variant path honest.
import { listSandboxImages, normalizeSandbox } from "../plugins/pi/scripts/lib/sandbox.mjs";

/**
 * The shipped example config.
 *
 * A fresh install otherwise starts with no fleet at all: the config lives in the
 * owner's home and never in this repository, so there is nothing to copy and
 * `presets` answers with nothing. The example is that starting point — which
 * only helps while it stays loadable and stays clean, and both rot silently:
 * the form moves on and nobody reopens the file, or it is regenerated from a
 * live config and carries a token out with it.
 */

const EXAMPLE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "plugins",
  "pi",
  "config.example.json"
);

const raw = fs.readFileSync(EXAMPLE, "utf8");
const parsed = JSON.parse(raw);

test("the example config loads in the current form", () => {
  const config = normalizeConfigLayer(parsed);

  // Normalization is what a load does to the owner form; the example has to
  // survive it, not merely be valid JSON.
  assert.ok(Object.keys(config.presets ?? {}).length >= 5, "roles are there to copy");
  assert.ok(Object.keys(config.sandboxProfiles ?? {}).length >= 2, "sandbox services are there");
  assert.ok(Object.keys(config.concurrencyPools ?? {}).length >= 1, "at least one provider pool");

  for (const [name, preset] of Object.entries(config.presets)) {
    const service = preset.sandboxService ?? preset.sandbox;
    if (service == null) {
      continue;
    }
    const id = typeof service === "string" ? service : service.id;
    assert.doesNotThrow(
      () => normalizeSandbox(id, config.sandboxProfiles),
      `preset ${name} names a sandbox service that resolves`
    );
  }

  // Every image an example role runs on must be one the repository can build,
  // or a copied config fails at the first run instead of at review time.
  for (const entry of listSandboxImages(config)) {
    assert.match(entry.image, /^[\w.-]+(:[\w.-]+)?$/, `image tag ${entry.image} is well formed`);
  }
});

test("a role of the new form gets the slots of its model's pool", async () => {
  const { buildVariants } = await import("../plugins/pi/scripts/pi-companion.mjs");

  const config = normalizeConfigLayer(parsed);
  const { variants } = buildVariants(config.presets["go-developer"], config);
  assert.ok(variants.length >= 2, "the role lists several candidate models");
  for (const variant of variants) {
    const pool = config.concurrencyPools[variant.pool];
    assert.ok(pool, `model ${variant.id} sits in pool ${variant.pool}, which exists`);
    assert.equal(variant.sandbox.poolName, variant.pool, "the sandbox is scoped by the model's pool");
    assert.equal(variant.sandbox.maxConcurrent, Number(pool.limit), "slots come from that pool's limit");
  }
});

test("the example config carries no secret and no path of one machine", () => {
  // Generated from a live config, so the two things that leak are a token and
  // an absolute home path — the first is a disclosure, the second a mount that
  // silently points into somebody else's home.
  // `/home/pi` is the container's own user and belongs here; a host home does
  // not — it points a mount into a directory that exists on one machine only.
  const hostPaths = raw
    .split("\n")
    .filter((line) => /\/Users\//.test(line) || /\/home\/(?!pi[/"])/.test(line));
  assert.deepEqual(hostPaths, [], "absolute host home paths are replaced by ~");

  for (const entry of Object.values(parsed.gitProxy ?? {})) {
    const command = String(entry.tokenCommand ?? "");
    assert.match(command, /\$[A-Z_]+/, "a forge token comes from the environment, never inline");
  }

  // A long unbroken alphanumeric run is what an API key or a token looks like.
  // The one legitimate exception is the base64 subagent capability ceiling.
  const suspicious = raw
    .split("\n")
    .filter((line) => /[A-Za-z0-9]{32,}/.test(line) && !line.includes("CAPABILITY_CEILING"));
  assert.deepEqual(suspicious, [], "no line looks like a key or a token");
});

test("the example fleet has one role per job and vLLM as the last resort", () => {
  const config = normalizeConfigLayer(parsed);
  const roles = Object.keys(config.presets).sort();
  assert.deepEqual(roles, [
    "coverage-auditor",
    "go-developer",
    "go-qa",
    "python-developer",
    "python-qa",
    "researcher",
    "reviewer",
    "ruby-developer",
    "ruby-qa",
    "rust-developer",
    "rust-qa",
    "web-developer",
    "web-qa"
  ]);

  // The order is the whole point of the list: the first candidate with a free
  // slot wins, so a vLLM model anywhere but last would spend the local GPU while
  // a paid account sat idle — and the local one is the fallback for when every
  // account is out of money.
  for (const [name, preset] of Object.entries(config.presets)) {
    assert.ok(preset.models.length >= 1, `${name} lists at least one model`);
    const last = preset.models[preset.models.length - 1];
    assert.match(last, /^vllm-/, `${name} puts vLLM last, got ${last}`);
  }

  // Rust lists a direct DeepSeek variant of its own, not only what it inherits
  // from the shared pools.
  for (const name of ["rust-developer", "rust-qa"]) {
    assert.ok(
      config.presets[name].models.includes("deepseek-deepseek-v4-flash"),
      `${name} lists the direct DeepSeek model`
    );
  }
});

test("every model id in the example resolves to one pool and one provider", () => {
  const config = normalizeConfigLayer(parsed);
  const pools = Object.keys(config.concurrencyPools);
  const providerOfPool = new Map();

  for (const poolName of pools) {
    // One provider per pool is what makes the slot limit mean anything: two
    // accounts under one limit would each be capped by the other's usage.
    for (const record of Object.values(config.concurrencyPools[poolName].models ?? {})) {
      const seen = providerOfPool.get(poolName);
      if (seen) {
        assert.equal(record.provider, seen, `pool ${poolName} holds one provider`);
      } else {
        providerOfPool.set(poolName, record.provider);
      }
    }
  }

  const providers = [...providerOfPool.values()];
  assert.equal(new Set(providers).size, providers.length, "pools name distinct providers");

  // A preset names a model by id; an id nobody owns fails at the first variant
  // of the first run instead of at review time.
  for (const [name, preset] of Object.entries(config.presets)) {
    for (const id of preset.models) {
      const owners = pools.filter((pool) => config.concurrencyPools[pool].models?.[id]);
      assert.equal(owners.length, 1, `${name}: model ${id} belongs to exactly one pool`);
    }
  }

  // vLLM is the last resort in the ordering too: its pool ranks below every
  // account-backed one. A pool that states no priority sorts last, so it cannot
  // outrank anything.
  const priorityOf = (poolName) => config.concurrencyPools[poolName].priority ?? -Infinity;
  const vllmPriority = priorityOf("vllm");
  for (const poolName of pools) {
    if (poolName !== "vllm") {
      assert.ok(
        priorityOf(poolName) >= vllmPriority,
        `pool ${poolName} does not outrank vllm`
      );
    }
  }
});
