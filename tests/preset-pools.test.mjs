import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const UNIQUE = `${process.pid}-${Date.now()}`;

/** Pool config with profiles the variants resolve to. */
function poolConfig({ limit = 1, priority = null, models = null, entries = null } = {}) {
  return {
    concurrencyPools: {
      [`alpha-${UNIQUE}`]: {
        limit,
        sandbox: "agent",
        ...(priority === null ? {} : { priority }),
        default: "fast",
        models: models ?? { fast: { model: "prov/fast" }, smart: { model: "prov/smart", thinking: "high" } }
      },
      [`beta-${UNIQUE}`]: {
        limit,
        sandbox: "agent",
        ...(priority === null ? {} : { priority }),
        default: "fast",
        models: { fast: { model: "prov2/fast" } }
      }
    },
    sandboxProfiles: {
      agent: { image: "img" },
      "agent-dind": { image: "img" }
    },
    presets: {
      role: { pools: entries ?? [`alpha-${UNIQUE}:fast`, `beta-${UNIQUE}`] }
    }
  };
}

function variantByPool(variants, poolName) {
  return variants.find((variant) => variant.poolName === poolName);
}

test("variants of one pool draw from one quota, and a bare number still reads as a limit", async () => {
  const { applyConcurrencyPool, buildVariants } = await import("../plugins/pi/scripts/pi-companion.mjs");
  const { awaitSandboxSlot, describeSlotUsage } = await import("../plugins/pi/scripts/lib/sandbox.mjs");
  const { normalizeConcurrencyPool } = await import("../plugins/pi/scripts/lib/config.mjs");
  const config = poolConfig({ limit: 1 });
  const poolName = `alpha-${UNIQUE}`;
  const { variants } = buildVariants(config.presets.role, config);
  const fast = variantByPool(variants, poolName);
  const beta = variantByPool(variants, `beta-${UNIQUE}`);

  assert.equal(fast.sandbox.concurrencyGroup, poolName, "the pool is the quota scope, not the variant");
  assert.equal(fast.sandbox.maxConcurrent, 1);

  // A slot held by the `fast` variant must be visible to `smart` of the SAME
  // pool, while a different pool with the same limit is untouched.
  const claim = await awaitSandboxSlot(fast.sandbox, { timeoutMs: 1000, pollMs: 10 });
  try {
    assert.equal(describeSlotUsage(fast.sandbox).used, 1);
    await assert.rejects(
      () => awaitSandboxSlot(fast.sandbox, { timeoutMs: 0, pollMs: 10 }),
      /allows 1 container/,
      "the second variant of one pool sees the first one's slot"
    );
    const other = await awaitSandboxSlot(beta.sandbox, { timeoutMs: 1000, pollMs: 10 });
    other.release();
  } finally {
    claim.release();
  }

  // Legacy shape: a number in concurrencyPools reads as {limit}, both through
  // the normalizer and through the pool the profiles have drawn from before.
  assert.deepEqual(normalizeConcurrencyPool(7), { limit: 7 });
  const legacy = applyConcurrencyPool(
    { profileName: "go", concurrencyGroup: "ollama-pro", maxConcurrent: 9 },
    { concurrencyPools: { "ollama-pro": 7 } }
  );
  assert.equal(legacy.maxConcurrent, 7, "the pool number wins over the profile's own cap");
});

test("a preset chooses variants; the colon form addresses one and the pool carries model fields", async () => {
  const { buildVariants } = await import("../plugins/pi/scripts/pi-companion.mjs");
  const config = poolConfig();
  config.presets.mixed = { pools: [`alpha-${UNIQUE}:smart`, `beta-${UNIQUE}`], requires: ["dind"] };

  const { variants } = buildVariants(config.presets.mixed, config);
  const smart = variants[0];
  // Model and thinking come from the pool variant, not from the preset: the
  // preset picks, the pool decides what the variant is.
  assert.equal(smart.model, "prov/smart");
  assert.equal(smart.thinking, "high");
  // The capability is the preset's ROLE: requires joins the pool's provider
  // half into one profile, so a deepseek pool could serve a dind role too.
  assert.equal(smart.sandbox.profileName, "agent-dind");

  // The no-colon form takes the pool's default variant.
  const plain = buildVariants(config.presets.role, config).variants;
  assert.equal(variantByPool(plain, `alpha-${UNIQUE}`).model, "prov/fast", "default variant without a colon");
  assert.equal(variantByPool(plain, `beta-${UNIQUE}`).model, "prov2/fast", "single-variant pool needs no default");

  // Equipment named by the variant adds to the profile's own, it does not
  // replace it.
  const layered = poolConfig();
  layered.concurrencyPools[`alpha-${UNIQUE}`].models.fast.env = ["POOL=1"];
  layered.sandboxProfiles.agent.env = ["BASE=1"];
  layered.sandboxProfiles.agent.mounts = ["/srv/base:/base:ro"];
  layered.concurrencyPools[`alpha-${UNIQUE}`].models.fast.mounts = ["/srv/extra:/extra:ro"];
  const { variants: equipped } = buildVariants(layered.presets.role, layered);
  const sandbox = variantByPool(equipped, `alpha-${UNIQUE}`).sandbox;
  assert.ok(sandbox.env.includes("BASE=1") && sandbox.env.includes("POOL=1"), "env folds");
  assert.ok(sandbox.mounts.includes("/srv/base:/base:ro") && sandbox.mounts.includes("/srv/extra:/extra:ro"), "mounts fold");

  assert.throws(
    () => buildVariants({ pools: [`alpha-${UNIQUE}:nope`] }, config),
    /no variant "nope".*fast, smart/s,
    "a wrong variant name refuses and names what the pool has"
  );
  assert.throws(
    () => buildVariants({ pools: [`ghost-${UNIQUE}`] }, config),
    /concurrency pool "ghost-.*", which is not defined/
  );
});

test("pool priority orders the variants; equal priorities keep the preset's listing order", async () => {
  const { buildVariants } = await import("../plugins/pi/scripts/pi-companion.mjs");
  const config = poolConfig({ priority: 5 });
  // Listing order deliberately differs from the priority order: the pool
  // default wins until the preset says otherwise.
  config.concurrencyPools[`alpha-${UNIQUE}`].priority = 2;
  config.concurrencyPools[`beta-${UNIQUE}`].priority = 1;

  const ordered = buildVariants(config.presets.role, config).variants.map((variant) => variant.poolName);
  assert.deepEqual(ordered, [`beta-${UNIQUE}`, `alpha-${UNIQUE}`], "smaller priority goes first");

  // Equal priorities fall back to the order the preset listed the pools in,
  // which is how a preset overrides the defaults without any extra field.
  config.concurrencyPools[`alpha-${UNIQUE}`].priority = 1;
  config.concurrencyPools[`beta-${UNIQUE}`].priority = 1;
  const tied = buildVariants(config.presets.role, config).variants.map((variant) => variant.poolName);
  assert.deepEqual(tied, [`alpha-${UNIQUE}`, `beta-${UNIQUE}`]);
});

test("a busy pool is skipped after the wait threshold, and only an all-busy role queues", async () => {
  const { buildVariants } = await import("../plugins/pi/scripts/pi-companion.mjs");
  const { awaitSandboxSlot, awaitVariantSlot } = await import("../plugins/pi/scripts/lib/sandbox.mjs");
  const config = poolConfig({ limit: 1 });
  const { variants } = buildVariants(config.presets.role, config);
  const first = variants[0];
  const second = variants[1];
  const progress = [];
  const onProgress = (event) => progress.push(event.message ?? "");

  // Threshold 0: a busy pool is left immediately for a free one. Timed,
  // because "eventually picks the free one" is also what ignoring the
  // threshold looks like — the difference is whether we queued first.
  const held = await awaitSandboxSlot(first.sandbox, { timeoutMs: 1000, pollMs: 10 });
  try {
    const startedAt = Date.now();
    const picked = await awaitVariantSlot(variants, { poolWaitMs: 0, timeoutMs: 5000, onProgress });
    assert.ok(Date.now() - startedAt < 2000, "the busy pool is not queued past the zero threshold");
    assert.equal(picked.poolName, second.poolName, "the free variant is taken instead of queuing");
    picked.release();
  } finally {
    held.release();
  }

  // A threshold longer than the release waits the busy pool out.
  const slow = await awaitSandboxSlot(first.sandbox, { timeoutMs: 1000, pollMs: 10 });
  setTimeout(() => slow.release(), 150);
  const waited = await awaitVariantSlot(variants, { poolWaitMs: 5000, timeoutMs: 30000, onProgress });
  assert.equal(waited.poolName, first.poolName, "the first by priority is waited for when it frees in time");
  assert.ok(waited.waitedMs >= 100, "the wait actually happened");
  waited.release();

  // Every variant busy: queue for the FIRST BY PRIORITY and say what for —
  // a silent queue reads as a hang.
  const holdA = await awaitSandboxSlot(first.sandbox, { timeoutMs: 1000, pollMs: 10 });
  const holdB = await awaitSandboxSlot(second.sandbox, { timeoutMs: 1000, pollMs: 10 });
  try {
    await assert.rejects(
      () => awaitVariantSlot(variants, { poolWaitMs: 0, timeoutMs: 150, onProgress, pollMs: 10 }),
      /allows 1 container/,
      "giving up is still the outcome when nothing frees"
    );
    assert.ok(
      progress.some((message) => message.includes(`pool "${first.poolName}"`) && message.includes("first by priority")),
      `the queue is announced: ${JSON.stringify(progress)}`
    );
  } finally {
    holdA.release();
    holdB.release();
  }
});

test("the old <role>-<pool> names resolve to the same variant as the role plus the pool", async () => {
  const { buildVariants } = await import("../plugins/pi/scripts/pi-companion.mjs");
  const { resolveRunSettings } = await import("../plugins/pi/scripts/lib/config.mjs");
  const config = poolConfig();
  config.presets.role.systemPrompt = "reviewer";

  const direct = resolveRunSettings(config, "delegate", { preset: "role" });
  const aliased = resolveRunSettings(config, "delegate", { preset: `role-beta-${UNIQUE}` });
  assert.equal(aliased.presetName, direct.presetName, "the alias resolves onto the role preset");
  assert.equal(aliased.presetPool, `beta-${UNIQUE}`);
  assert.equal(aliased.requestedPresetName, `role-beta-${UNIQUE}`, "the request keeps the name that was asked for");
  assert.equal(direct.requestedPresetName, direct.presetName);

  const pinned = buildVariants(config.presets.role, config, { poolPin: `beta-${UNIQUE}` });
  const throughRole = buildVariants(config.presets.role, config);
  const chosen = pinned.variants.map((variant) => `${variant.poolName}:${variant.variantName}`);
  assert.deepEqual(
    chosen,
    throughRole.variants
      .map((variant) => `${variant.poolName}:${variant.variantName}`)
      .filter((name) => name.startsWith(`beta-${UNIQUE}`)),
    "alias and role-plus-pool pick the same variant"
  );

  // The alias only fires for a role that actually lists the pool; anything
  // else stays an unknown preset.
  assert.throws(() => resolveRunSettings(config, "delegate", { preset: "role-ghost" }), /Unknown preset/);
});

test("--model addresses a variant by name or by full id, or stays a literal override", async () => {
  const { buildVariants } = await import("../plugins/pi/scripts/pi-companion.mjs");
  const config = poolConfig();
  // Without colons the entries carry the pools' defaults, so a --model can
  // reach the non-default variant at all.
  config.presets.pick = { pools: [`alpha-${UNIQUE}`, `beta-${UNIQUE}`] };

  const byName = buildVariants(config.presets.pick, config, { modelWanted: "smart" });
  assert.deepEqual(byName.variants.map((variant) => `${variant.poolName}:${variant.variantName}`), [
    `alpha-${UNIQUE}:smart`
  ]);
  assert.equal(byName.modelOverride, null, "an addressed variant needs no override");

  const byId = buildVariants(config.presets.pick, config, { modelWanted: "prov/smart" });
  assert.deepEqual(byId.variants.map((variant) => variant.model), ["prov/smart"]);

  const literal = buildVariants(config.presets.pick, config, { modelWanted: "other/model" });
  assert.equal(literal.variants.length, 2, "an unknown model id pins nothing");
  assert.equal(literal.modelOverride, "other/model", "it rides whichever variant wins the slot race");
});

test("today's configuration keeps working unchanged", async () => {
  const { applyConcurrencyPool } = await import("../plugins/pi/scripts/pi-companion.mjs");
  const { normalizeSandbox } = await import("../plugins/pi/scripts/lib/sandbox.mjs");
  const { resolveRunSettings } = await import("../plugins/pi/scripts/lib/config.mjs");
  const config = {
    concurrencyPools: { zai: 7 },
    sandboxProfiles: { agent: { image: "img", concurrencyGroup: "zai" } },
    presets: {
      "python-developer-zai": { model: "zai/gpt-5", thinking: "high", sandbox: "agent" }
    },
    poolWaitMs: 30000
  };

  const settings = resolveRunSettings(config, "delegate", { preset: "python-developer-zai" });
  assert.equal(settings.model, "zai/gpt-5");
  assert.equal(settings.presetName, "python-developer-zai");
  assert.equal(settings.presetPool, null, "an exact preset name pins nothing");
  assert.equal(settings.sandboxVariants, undefined, "no variants are built for the old shape");

  const sandbox = applyConcurrencyPool(normalizeSandbox(settings.sandbox, config.sandboxProfiles), config);
  assert.equal(sandbox.concurrencyGroup, "zai");
  assert.equal(sandbox.maxConcurrent, 7);
});

test("the run path resolves a pools preset end to end", async (t) => {
  const { sandboxPreflight } = await import("../plugins/pi/scripts/lib/sandbox.mjs");
  const preflight = sandboxPreflight({ mode: "docker", image: "img" });
  if (!preflight.ok) {
    t.skip(`нужен локальный docker с образом-заглушкой: ${preflight.errors[0]}`);
    return;
  }

  const { buildRunSettings } = await import("../plugins/pi/scripts/pi-companion.mjs");
  const config = poolConfig();
  config.presets.role.systemPrompt = "reviewer";
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-plugin-pools-"));
  try {
    const settings = buildRunSettings({
      command: "delegate",
      flags: { preset: "role", "git-name": "t", "git-email": "t@t" },
      workspaceRoot,
      runRoot: workspaceRoot,
      config
    });
    assert.equal(settings.sandboxVariants.length, 2, "both pools became candidates");
    assert.equal(settings.sandbox, settings.sandboxVariants[0].sandbox, "the first candidate stands in until slot time");
    assert.equal(settings.model, null, "the model comes from the variant, picked at slot time");
    assert.equal(settings.poolWaitMs, 30000);
  } finally {
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  }
});
