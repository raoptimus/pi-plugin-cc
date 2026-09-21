import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { normalizeConfigLayer } from "../plugins/pi/scripts/lib/config.mjs";

const UNIQUE = `${process.pid}-${Date.now()}`;

/** A config in the owner's form: three arrays, models by global id. */
function ownerFormConfig({ limit = 1, priority = null, aliases = null } = {}) {
  return {
    concurrencyPools: [
      {
        pool: `alpha-${UNIQUE}`,
        limit,
        ...(priority === null ? {} : { priority }),
        ...(aliases ? { aliases } : {}),
        models: [
          { id: `fast-${UNIQUE}`, provider: "prov", name: "fast-model" },
          { id: `smart-${UNIQUE}`, provider: "prov", name: "smart-model", thinking: "high" }
        ]
      },
      {
        pool: `beta-${UNIQUE}`,
        limit,
        ...(priority === null ? {} : { priority }),
        models: [{ id: `other-${UNIQUE}`, provider: "prov2", name: "other-model" }]
      }
    ],
    sandboxServices: [
      { id: "base", image: "busybox:latest", env: ["PATH=/toolchain"], mounts: ["/srv/base:/base:ro"], args: ["--cpus", "6"] },
      {
        id: "agent",
        extend: "base",
        image: "busybox:latest",
        env: ["EXTRA=1"],
        mounts: ["/srv/extra:/extra:ro"],
        args: ["--security-opt", "no-new-privileges"]
      }
    ],
    presets: [
      {
        id: "role",
        models: [`fast-${UNIQUE}`, `other-${UNIQUE}`],
        sandboxService: "agent"
      }
    ]
  };
}

function variantByPool(variants, poolName) {
  return variants.find((variant) => variant.pool === poolName);
}

function variantById(variants, id) {
  return variants.find((variant) => variant.id === id);
}

// Дословный пример владельца (спека B-52, раздел «ЦЕЛЕВАЯ ФОРМА»); содержимое
// монтирований/env сокращено до маркеров, как в спеке, — важна структура.
function ownerExampleLiteral() {
  return {
    sandboxServices: [
      {
        id: "sandbox-base",
        image: "pi-sandbox-agent:latest",
        dockerfile: "agent",
        mounts: ["<14 монтирований базы: тулчейн, кэши volume, хуки, скилл vision>"],
        env: ["<PATH, GOPROXY, GOPRIVATE, GOFLAGS, лимиты потоков BLAS — 12 строк>"],
        extensions: ["/pi-agent/host-extensions/hooks/index.ts", "<lsp-адаптер>"],
        args: ["--cpus", "6"],
        skills: ["/pi-skills/vision"]
      },
      {
        id: "sandbox-agent",
        extend: "sandbox-base",
        image: "pi-sandbox-agent:latest",
        args: [
          "--security-opt",
          "seccomp=@sandbox/dind-seccomp.json",
          "--security-opt",
          "systempaths=unconfined",
          "--device",
          "/dev/net/tun",
          "--add-host",
          "host.docker.internal:host-gateway"
        ],
        env: [
          "PI_DIND=1",
          "DOCKERD_ROOTLESS_ROOTLESSKIT_FLAGS=--pidns",
          "TESTCONTAINERS_RYUK_DISABLED=true",
          "TESTCONTAINERS_HOST_OVERRIDE=127.0.0.1",
          "PI_REGISTRY_MIRROR=http://host.docker.internal:5000"
        ],
        mounts: ["pi-dind-agent-images:/home/pi/.local/share/docker:isolate"]
      }
    ],
    concurrencyPools: [
      {
        pool: "zai",
        limit: 5,
        priority: 10,
        models: [
          { id: "zai-glm-5.3", provider: "zai-coding-cn", name: "glm-5.3" },
          { id: "zai-glm-5.3-flash", provider: "zai-coding-cn", name: "glm-5.3-flash" }
        ]
      },
      {
        pool: "vllm",
        limit: 1,
        priority: 10,
        models: [
          {
            id: "vllm-Qwen3.8-27B",
            provider: "vllm",
            name: "Qwen3.8-27B",
            samplingParams: { temperature: 1, max_tokens: 120000 }
          },
          {
            id: "vllm-dev-Qwen3.8-27B",
            provider: "vllm",
            name: "Qwen3.8-27B",
            samplingParams: { temperature: 0.8, max_tokens: 120000 }
          }
        ]
      },
      {
        pool: "deepseek",
        limit: 5,
        priority: 10,
        models: [
          { id: "deepseek-deepseek-v4-pro", provider: "deepseek", name: "deepseek-v4-flash-pro" },
          { id: "deepseek-deepseek-v4-flash", provider: "deepseek", name: "deepseek-v4-flash" }
        ]
      }
    ],
    presets: [
      {
        id: "go-developer",
        models: ["zai-glm-5.3-flash", "deepseek-deepseek-v4-flash", "vllm-dev-Qwen3.8-27B"],
        sandboxService: "sandbox-agent"
      }
    ]
  };
}

test("the owner's example reads verbatim: three arrays become a preset with models and a service", async () => {
  const { buildVariants } = await import("../plugins/pi/scripts/pi-companion.mjs");

  const config = normalizeConfigLayer(ownerExampleLiteral());
  assert.deepEqual(Object.keys(config.concurrencyPools), ["zai", "vllm", "deepseek"], "pool order is kept");
  const service = config.sandboxProfiles["sandbox-agent"];
  assert.equal(service.profile, "sandbox-base", "extend became the profile link");
  assert.ok(service.env.includes("PI_DIND=1") && service.mounts[0].includes("dind"), "the child's own fields stay");

  const { variants } = buildVariants(config.presets["go-developer"], config);
  assert.deepEqual(
    variants.map((variant) => variant.id),
    ["zai-glm-5.3-flash", "deepseek-deepseek-v4-flash", "vllm-dev-Qwen3.8-27B"],
    "the preset's listing order is the choice order when priorities tie"
  );
  const zai = variants[0];
  assert.equal(zai.model, "zai-coding-cn/glm-5.3-flash");
  assert.equal(zai.pool, "zai");
  assert.equal(zai.sandbox.concurrencyGroup, "zai", "slots come from the pool of the model");
  assert.equal(zai.sandbox.maxConcurrent, 5);
  assert.equal(zai.sandbox.profileName, "sandbox-agent", "one sandbox for the role, named by the preset");

  // Two ids may share one name and differ only in samplingParams.
  const prod = config.concurrencyPools.vllm.models["vllm-Qwen3.8-27B"];
  const dev = config.concurrencyPools.vllm.models["vllm-dev-Qwen3.8-27B"];
  assert.equal(prod.name, dev.name);
  assert.notDeepEqual(prod.samplingParams, dev.samplingParams);
});

test("duplicates and removed-form fields are refused by name", async () => {

  const duplicate = ownerExampleLiteral();
  duplicate.concurrencyPools.push({ pool: "zai", limit: 2, models: [] });
  assert.throws(() => normalizeConfigLayer(duplicate), /Duplicate pool "zai".*concurrencyPools/);

  const dupeService = ownerExampleLiteral();
  dupeService.sandboxServices.push({ id: "sandbox-base", image: "x" });
  assert.throws(() => normalizeConfigLayer(dupeService), /Duplicate id "sandbox-base"/);

  const dupeModel = ownerFormConfig();
  dupeModel.concurrencyPools[1].models.push({ id: `fast-${UNIQUE}`, provider: "prov2", name: "x" });
  // The cross-pool duplicate is caught when the registry is built: within one
  // layer the ids are unique per pool, uniqueness is global.
  const { modelRegistry } = await import("../plugins/pi/scripts/pi-companion.mjs");
  assert.throws(
    () => modelRegistry(normalizeConfigLayer(dupeModel)),
    new RegExp(`Model id "fast-${UNIQUE}" is defined in both pool.*globally unique`)
  );

  const dupeInPool = ownerFormConfig();
  dupeInPool.concurrencyPools[0].models.push({ id: `fast-${UNIQUE}`, provider: "prov", name: "fast-model" });
  assert.throws(() => normalizeConfigLayer(dupeInPool), new RegExp(`Duplicate model id "fast-${UNIQUE}"`));

  const incomplete = ownerFormConfig();
  delete incomplete.concurrencyPools[0].models[0].provider;
  assert.throws(() => normalizeConfigLayer(incomplete), /needs "provider" and "name"/);

  assert.throws(
    () => normalizeConfigLayer({ presets: [{ id: "old", pools: ["zai:fast"] }] }),
    /removed "pools" field.*"models"/,
    "the cancelled pools form does not come back through a second door"
  );
  assert.throws(
    () => normalizeConfigLayer({ presets: [{ id: "old", requires: ["dind"] }] }),
    /removed "requires" field/
  );
  assert.throws(
    () => normalizeConfigLayer({ concurrencyPools: [{ pool: "zai", limit: 1, default: "fast", models: [] }] }),
    /removed "default" field/
  );
  assert.throws(
    () => normalizeConfigLayer({ concurrencyPools: [{ pool: "zai", limit: 1, sandbox: "agent", models: [] }] }),
    /removed "sandbox" field/
  );
  assert.throws(
    () => normalizeConfigLayer({ concurrencyPools: [{ pool: "zai", limit: 1, models: { fast: {} } }] }),
    /Named variant maps are gone/
  );
});

test("extend folds the base's lists in; a cycle is refused with the chain", async () => {
  const { normalizeSandbox } = await import("../plugins/pi/scripts/lib/sandbox.mjs");

  const config = normalizeConfigLayer(ownerFormConfig());
  const agent = normalizeSandbox("agent", config.sandboxProfiles);
  // The base's toolchain plus the child's own extras; args are positional and
  // must survive in order, both halves of them.
  assert.ok(agent.env.includes("PATH=/toolchain") && agent.env.includes("EXTRA=1"));
  assert.ok(agent.mounts.includes("/srv/base:/base:ro") && agent.mounts.includes("/srv/extra:/extra:ro"));
  const args = agent.args.join(" ");
  assert.ok(args.includes("--cpus 6") && args.includes("--security-opt no-new-privileges"));

  const cycle = normalizeConfigLayer(ownerFormConfig());
  cycle.sandboxProfiles.a = { profile: "b" };
  cycle.sandboxProfiles.b = { profile: "a" };
  assert.throws(() => normalizeSandbox("a", cycle.sandboxProfiles), /extends itself: a → b/);
});

test("old forms keep working: maps, numeric pools, concurrencyGroup profiles", async () => {
  const { normalizeConcurrencyPool, BUILT_IN_CONFIG, mergeConfigLayer } = await import(
    "../plugins/pi/scripts/lib/config.mjs"
  );
  const { applyConcurrencyPool } = await import("../plugins/pi/scripts/pi-companion.mjs");
  const { normalizeSandbox } = await import("../plugins/pi/scripts/lib/sandbox.mjs");

  assert.deepEqual(normalizeConcurrencyPool(7), { limit: 7 });

  const today = {
    concurrencyPools: { zai: 7 },
    sandboxProfiles: { agent: { image: "busybox:latest", concurrencyGroup: "zai" } },
    presets: { "python-developer-zai": { model: "zai/gpt-5", thinking: "high", sandbox: "agent" } }
  };
  // Normalization is a no-op on today's shape, apart from reading each numeric
  // pool as its {limit} record.
  assert.deepEqual(normalizeConfigLayer(today), {
    concurrencyPools: { zai: { limit: 7 } },
    sandboxProfiles: { agent: { image: "busybox:latest", concurrencyGroup: "zai" } },
    presets: { "python-developer-zai": { model: "zai/gpt-5", thinking: "high", sandbox: "agent" } }
  });

  const merged = mergeConfigLayer(BUILT_IN_CONFIG, normalizeConfigLayer(today));
  const sandbox = applyConcurrencyPool(normalizeSandbox("agent", merged.sandboxProfiles), merged);
  assert.equal(sandbox.concurrencyGroup, "zai");
  assert.equal(sandbox.maxConcurrent, 7);
});

test("a project layer with one pool does not wipe the user's pools, and cannot point models at a provider", async () => {
  const { sanitizeProjectLayer, BUILT_IN_CONFIG, mergeConfigLayer } = await import(
    "../plugins/pi/scripts/lib/config.mjs"
  );

  const user = normalizeConfigLayer(ownerFormConfig());
  const projectWarnings = [];
  const project = sanitizeProjectLayer(
    normalizeConfigLayer({
      concurrencyPools: [{ pool: `beta-${UNIQUE}`, limit: 9, models: [{ id: "x", provider: "evil", name: "m" }] }],
      sandboxServices: [{ id: "sneaky", image: "img", mounts: ["/:/host:rw"], args: ["--privileged"] }]
    }),
    projectWarnings
  );
  const merged = mergeConfigLayer(mergeConfigLayer(BUILT_IN_CONFIG, user), project);

  assert.equal(merged.concurrencyPools[`alpha-${UNIQUE}`].limit, 1, "the user's pool survives");
  assert.equal(merged.concurrencyPools[`beta-${UNIQUE}`].limit, 9, "the project's capacity change lands");
  assert.equal(
    merged.concurrencyPools[`beta-${UNIQUE}`].models,
    undefined,
    "the project cannot decide which provider a pool's models hit"
  );
  assert.ok(projectWarnings.some((line) => line.includes("cannot point a pool's models")), JSON.stringify(projectWarnings));

  // The trust boundary covers the new block exactly like the old one: a service
  // is a profile once normalized, so its mounts and args are stripped.
  assert.ok(projectWarnings.some((line) => line.includes("sneaky.sandbox.mounts ignored")), JSON.stringify(projectWarnings));
  assert.equal(merged.sandboxProfiles.sneaky.mounts, undefined);
  assert.equal(merged.sandboxProfiles.sneaky.args, undefined);
});

test("an unknown model id or service is refused with what is known, and provider/name gets a hint", async () => {
  const { buildVariants } = await import("../plugins/pi/scripts/pi-companion.mjs");
  const config = normalizeConfigLayer(ownerFormConfig());

  assert.throws(
    () => buildVariants({ models: [`ghost-${UNIQUE}`], sandbox: "agent" }, config),
    new RegExp(`references model "ghost-${UNIQUE}".*Known models: fast-${UNIQUE}, smart-${UNIQUE}, other-${UNIQUE}`)
  );
  assert.throws(
    () => buildVariants({ models: ["prov/fast-model"], sandbox: "agent" }, config),
    /"prov\/fast-model" is provider\/name — address this model by its id/,
    "the old addressing habit is named, not just refused"
  );
  assert.throws(
    () => buildVariants({ models: [`fast-${UNIQUE}`], sandbox: "no-such-service" }, config),
    /Unknown sandbox "no-such-service".*base, agent/
  );
});

test("models of one pool share one quota, and a bare number still reads as a limit", async () => {
  const { buildVariants } = await import("../plugins/pi/scripts/pi-companion.mjs");
  const { awaitSandboxSlot, describeSlotUsage } = await import("../plugins/pi/scripts/lib/sandbox.mjs");
  const config = normalizeConfigLayer(ownerFormConfig({ limit: 1 }));
  config.presets.role.models = [`fast-${UNIQUE}`, `smart-${UNIQUE}`, `other-${UNIQUE}`];
  const { variants } = buildVariants(config.presets.role, config);
  const fast = variantById(variants, `fast-${UNIQUE}`);
  const smart = variantById(variants, `smart-${UNIQUE}`);
  const other = variantById(variants, `other-${UNIQUE}`);

  assert.equal(fast.sandbox.concurrencyGroup, fast.pool, "the pool is the quota scope, not the model");
  assert.equal(fast.sandbox.maxConcurrent, 1);
  assert.equal(smart.sandbox.concurrencyGroup, fast.sandbox.concurrencyGroup, "same pool, same scope");

  // A slot held by `fast` must be visible to `smart` of the SAME pool, while a
  // different pool with the same limit is untouched.
  const claim = await awaitSandboxSlot(fast.sandbox, { timeoutMs: 1000, pollMs: 10 });
  try {
    assert.equal(describeSlotUsage(fast.sandbox).used, 1);
    await assert.rejects(
      () => awaitSandboxSlot(smart.sandbox, { timeoutMs: 0, pollMs: 10 }),
      /allows 1 container/,
      "the second model of one pool sees the first one's slot"
    );
    const slot = await awaitSandboxSlot(other.sandbox, { timeoutMs: 1000, pollMs: 10 });
    slot.release();
  } finally {
    claim.release();
  }
});

test("pool priority orders the candidates; equal priorities keep the preset's listing order", async () => {
  const { buildVariants } = await import("../plugins/pi/scripts/pi-companion.mjs");
  const config = normalizeConfigLayer(ownerFormConfig());
  config.concurrencyPools[`alpha-${UNIQUE}`].priority = 5;
  config.concurrencyPools[`beta-${UNIQUE}`].priority = 1;

  const ordered = buildVariants(config.presets.role, config).variants.map((variant) => variant.pool);
  assert.deepEqual(ordered, [`beta-${UNIQUE}`, `alpha-${UNIQUE}`], "smaller priority goes first");

  // Equal priorities fall back to the order the preset listed the models in —
  // the owner's example ties all pools at 10 and orders through the list.
  config.concurrencyPools[`alpha-${UNIQUE}`].priority = 10;
  config.concurrencyPools[`beta-${UNIQUE}`].priority = 10;
  const tied = buildVariants(config.presets.role, config).variants.map((variant) => variant.id);
  assert.deepEqual(tied, [`fast-${UNIQUE}`, `other-${UNIQUE}`]);
});

test("a busy pool is skipped after the wait threshold, and only an all-busy preset queues", async () => {
  const { buildVariants } = await import("../plugins/pi/scripts/pi-companion.mjs");
  const { awaitSandboxSlot, awaitVariantSlot } = await import("../plugins/pi/scripts/lib/sandbox.mjs");
  const config = normalizeConfigLayer(ownerFormConfig({ limit: 1 }));
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
    assert.equal(picked.pool, second.pool, "the free pool is taken instead of queuing");
    picked.release();
  } finally {
    held.release();
  }

  // A threshold longer than the release waits the busy pool out.
  const slow = await awaitSandboxSlot(first.sandbox, { timeoutMs: 1000, pollMs: 10 });
  setTimeout(() => slow.release(), 150);
  const waited = await awaitVariantSlot(variants, { poolWaitMs: 5000, timeoutMs: 30000, onProgress });
  assert.equal(waited.pool, first.pool, "the first by priority is waited for when it frees in time");
  assert.ok(waited.waitedMs >= 100, "the wait actually happened");
  waited.release();

  // Every pool busy: queue for the FIRST BY ORDER and say what for — a silent
  // queue reads as a hang.
  const holdA = await awaitSandboxSlot(first.sandbox, { timeoutMs: 1000, pollMs: 10 });
  const holdB = await awaitSandboxSlot(second.sandbox, { timeoutMs: 1000, pollMs: 10 });
  try {
    await assert.rejects(
      () => awaitVariantSlot(variants, { poolWaitMs: 0, timeoutMs: 150, onProgress, pollMs: 10 }),
      /allows 1 container/,
      "giving up is still the outcome when nothing frees"
    );
    assert.ok(
      progress.some(
        (message) => message.includes(`pool "${first.pool}"`) && message.includes("first by priority")
      ),
      `the queue is announced: ${JSON.stringify(progress)}`
    );
  } finally {
    holdA.release();
    holdB.release();
  }
});

test("the chosen model's thinking and tags win over the preset's", async () => {
  const { buildVariants } = await import("../plugins/pi/scripts/pi-companion.mjs");
  const { resolveRunSettings } = await import("../plugins/pi/scripts/lib/config.mjs");
  const config = normalizeConfigLayer(ownerFormConfig());
  config.presets.role.models = [`fast-${UNIQUE}`, `smart-${UNIQUE}`, `other-${UNIQUE}`];
  config.concurrencyPools[`alpha-${UNIQUE}`].models[`fast-${UNIQUE}`].thinking = "off";
  config.concurrencyPools[`alpha-${UNIQUE}`].models[`fast-${UNIQUE}`].tags = ["local"];
  config.concurrencyPools[`alpha-${UNIQUE}`].models[`smart-${UNIQUE}`].thinking = "low";
  config.presets.role.thinking = "high";
  config.presets.role.tags = ["role-tag"];

  const variants = buildVariants(config.presets.role, config).variants;
  assert.equal(variantById(variants, `fast-${UNIQUE}`).thinking, "off");
  assert.equal(variantById(variants, `smart-${UNIQUE}`).thinking, "low");

  // Through the settings layer: the preset's thinking is what resolves before a
  // model is picked; the slot-time pick replaces it with the model's own, but a
  // flag outranks both — hence the source is carried, not re-derived.
  const settings = resolveRunSettings(config, "delegate", { preset: "role" });
  assert.equal(settings.thinking, "high", "the preset's value stands until a model is chosen");
  assert.deepEqual(settings.tags, ["role-tag"], "the preset's tags resolve per layer");
  assert.equal(settings.thinkingFromFlag, false, "no flag, so the model may override");
  const flagged = resolveRunSettings(config, "delegate", {
    preset: "role",
    thinking: "medium"
  });
  assert.equal(flagged.thinkingFromFlag, true, "a flag outranks the model record");
});

test("the old <role>-<pool> names resolve through pool, alias, or model id", async () => {
  const { resolveRunSettings } = await import("../plugins/pi/scripts/lib/config.mjs");
  const { buildVariants } = await import("../plugins/pi/scripts/pi-companion.mjs");
  const config = normalizeConfigLayer(ownerFormConfig({ aliases: ["local"] }));
  config.presets.role.systemPrompt = "reviewer";

  const byPool = resolveRunSettings(config, "delegate", { preset: `role-beta-${UNIQUE}` });
  assert.equal(byPool.presetName, "role", "the alias resolves onto the role preset");
  assert.equal(byPool.presetPool, `beta-${UNIQUE}`);
  assert.equal(byPool.requestedPresetName, `role-beta-${UNIQUE}`, "the request keeps the name that was asked for");

  // Presets are called *-local, the pool is called beta: the alias bridges.
  const byAlias = resolveRunSettings(config, "delegate", { preset: "role-local" });
  assert.equal(byAlias.presetPool, `alpha-${UNIQUE}`, "the alias names the vllm-style pool, not a pool called local");

  // A tail naming a model id pins that model's pool.
  const byModel = resolveRunSettings(config, "delegate", { preset: `role-other-${UNIQUE}` });
  assert.equal(byModel.presetPool, `beta-${UNIQUE}`);

  const pinned = buildVariants(config.presets.role, config, { poolPin: `beta-${UNIQUE}` });
  assert.deepEqual(pinned.variants.map((variant) => variant.pool), [`beta-${UNIQUE}`]);
  assert.throws(
    () => resolveRunSettings(config, "delegate", { preset: "role-ghost" }),
    /Unknown preset/,
    "an unmatched tail is a refusal, not a silent fall-back to the first model"
  );
});

test("--model addresses a model by id or provider/name, or stays a literal override", async () => {
  const { buildVariants } = await import("../plugins/pi/scripts/pi-companion.mjs");
  const config = normalizeConfigLayer(ownerFormConfig());
  config.presets.role.models = [`fast-${UNIQUE}`, `smart-${UNIQUE}`, `other-${UNIQUE}`];

  const byId = buildVariants(config.presets.role, config, { modelWanted: `smart-${UNIQUE}` });
  assert.deepEqual(byId.variants.map((variant) => variant.id), [`smart-${UNIQUE}`]);
  assert.equal(byId.modelOverride, null, "an addressed model needs no override");

  const byFullName = buildVariants(config.presets.role, config, { modelWanted: "prov2/other-model" });
  assert.deepEqual(byFullName.variants.map((variant) => variant.id), [`other-${UNIQUE}`]);

  const literal = buildVariants(config.presets.role, config, { modelWanted: "other/model" });
  assert.equal(literal.variants.length, 3, "an unknown model pins nothing");
  assert.equal(literal.modelOverride, "other/model", "it rides whichever candidate wins the slot race");
});

test("pia presets prints models with pools and the sandbox service", async () => {
  const { presetPlansFor } = await import("../plugins/pi/scripts/pi-companion.mjs");
  const { presetLines } = await import("../plugins/pi/scripts/lib/render.mjs");
  const config = normalizeConfigLayer(ownerFormConfig());
  const plans = presetPlansFor(config);
  assert.deepEqual(
    plans.role.models.map((model) => `${model.id} (${model.pool}, ${model.provider})`),
    [`fast-${UNIQUE} (alpha-${UNIQUE}, prov)`, `other-${UNIQUE} (beta-${UNIQUE}, prov2)`]
  );
  assert.equal(plans.role.sandbox, "agent");

  // A preset that cannot resolve degrades to no plan instead of muting others.
  const broken = normalizeConfigLayer(ownerFormConfig());
  broken.presets.broken = { id: "broken", models: ["no-such-id"], sandboxService: "agent" };
  const tolerant = presetPlansFor(broken);
  assert.equal(tolerant.broken, undefined);
  assert.ok(tolerant.role, "the healthy preset is still listed");

  const lines = presetLines({ role: { sandbox: "agent" } }, {}, {}, plans);
  assert.match(lines[0], new RegExp(`models \`fast-${UNIQUE}\` \\(alpha-${UNIQUE}, prov\\)`));
  assert.match(lines[0], /sandbox `agent`/);
});

test("the run path resolves a models preset end to end", async (t) => {
  const { sandboxPreflight } = await import("../plugins/pi/scripts/lib/sandbox.mjs");
  const preflight = sandboxPreflight({ mode: "docker", image: "busybox:latest" });
  if (!preflight.ok) {
    t.skip(`нужен локальный docker с образом-заглушкой: ${preflight.errors[0]}`);
    return;
  }

  const { buildRunSettings } = await import("../plugins/pi/scripts/pi-companion.mjs");
  const config = normalizeConfigLayer(ownerFormConfig());
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
    // buildRunSettings reshapes the stand-in (identity env, isolateCaches), so
    // compare the shape, not the object identity.
    assert.equal(settings.sandbox.concurrencyGroup, settings.sandboxVariants[0].sandbox.concurrencyGroup,
      "the first candidate stands in until slot time");
    assert.equal(settings.sandbox.profileName, "agent");
    assert.equal(settings.model, null, "the model comes from the candidate, picked at slot time");
    assert.equal(settings.poolWaitMs, 30000);
  } finally {
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  }
});

// The slot-time pick used to rebuild `settings.sandbox` from `picked.sandbox`
// — the raw role sandbox — dropping everything buildRunSettings had developed:
// cache isolation, git proxy hosts, the run's own mounts and the git identity
// env. A pooled run then went out without any of it, silently.
test("the slot-time pick keeps the developed sandbox and moves only model-choice fields", async () => {
  const { applyPickedVariant } = await import("../plugins/pi/scripts/pi-companion.mjs");
  const settings = {
    sandbox: {
      mode: "docker",
      image: "busybox:latest",
      provider: "stand-in",
      profileName: "agent",
      isolateCaches: true,
      gitProxyHosts: { "github.com": "127.0.0.1:0" },
      mounts: ["/need:/need:ro"],
      env: ["GIT_AUTHOR_NAME=t", "GIT_AUTHOR_EMAIL=t@t"],
      concurrencyGroup: `alpha-${UNIQUE}`,
      maxConcurrent: 1
    },
    thinking: "high",
    tags: ["role-tag"]
  };
  applyPickedVariant(settings, {
    provider: "prov",
    model: "prov/smart-model",
    thinking: "low",
    tags: ["model-tag"],
    samplingParams: { max_tokens: 4096 },
    sandbox: { concurrencyGroup: `beta-${UNIQUE}`, maxConcurrent: 2, heldSlot: { waitedMs: 5, release: () => {} } }
  });

  assert.equal(settings.sandbox.isolateCaches, true, "cache isolation survives the pick");
  assert.deepEqual(settings.sandbox.gitProxyHosts, { "github.com": "127.0.0.1:0" }, "git proxy hosts survive");
  assert.deepEqual(settings.sandbox.mounts, ["/need:/need:ro"], "declared mounts survive");
  assert.ok(
    settings.sandbox.env.includes("GIT_AUTHOR_NAME=t") && settings.sandbox.env.includes("GIT_AUTHOR_EMAIL=t@t"),
    "git identity env survives"
  );
  assert.equal(settings.sandbox.provider, "prov", "the winner's provider keys the credential proxy");
  assert.deepEqual(settings.sandbox.samplingParams, { max_tokens: 4096 });
  assert.equal(settings.sandbox.concurrencyGroup, `beta-${UNIQUE}`, "the pool fields follow the winner");
  assert.equal(settings.sandbox.maxConcurrent, 2);
  assert.equal(settings.sandbox.heldSlot.waitedMs, 5, "the claimed slot travels in the sandbox");
  assert.equal(settings.model, "prov/smart-model");
  assert.equal(settings.provider, "prov");
  assert.equal(settings.thinking, "low", "the model record's thinking overrides the preset's");
  assert.deepEqual(settings.tags, ["role-tag", "model-tag"]);
});
