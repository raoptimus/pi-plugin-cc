import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { lineDiff, migrateConfig, verifyEquivalence } from "../plugins/pi/scripts/migrate-config.mjs";

const SCRIPT = path.resolve(path.dirname(decodeURIComponent(new URL(import.meta.url).pathname)), "../plugins/pi/scripts/migrate-config.mjs");

/** The fleet in its historical shape: 20 presets on 11 roles, five profiles, numeric pools. */
function liveFleet() {
  const member = (model, thinking, sandbox, extra = {}) => ({
    model,
    thinking,
    sandbox,
    systemPrompt: "@dev",
    appendSystemPrompt: ["Общий хвост"],
    timeoutMs: 1_800_000,
    git: { name: "Fleet", email: "fleet@example.com" },
    skills: ["/pi-skills/vision"],
    tags: ["fleet"],
    ...extra
  });
  const family = (role, zaiSandbox) => ({
    [`${role}-zai`]: member("zai-coding-cn/glm-5.3-flash", "low", zaiSandbox, { description: `${role} (zai)` }),
    [`${role}-deepseek`]: member("deepseek/deepseek-v4-flash", "off", "agent-deepseek", { description: `${role} (deepseek)` }),
    [`${role}-local`]: member("vllm/Qwen3.8-27B", "off", "agent-dind-vllm", { description: `${role} (local)` })
  });
  const dind = { args: ["--security-opt", "seccomp=@dind.json", "--device", "/dev/net/tun"], env: ["PI_DIND=1"] };
  return {
    sandboxProfiles: {
      "agent-base": { image: "pi-agent:latest", env: ["PATH=/t/bin"], mounts: ["/srv:/srv:ro"], args: ["--cpus", "6"] },
      agent: { profile: "agent-base", ...dind, concurrencyGroup: "zai" },
      "agent-dind": { profile: "agent-base", ...dind, concurrencyGroup: "zai" },
      "agent-lite": { profile: "agent-base", concurrencyGroup: "zai" },
      "agent-dind-vllm": { profile: "agent-base", ...dind, concurrencyGroup: "vllm" },
      "agent-deepseek": { profile: "agent-base", ...dind, concurrencyGroup: "deepseek" }
    },
    concurrencyPools: { zai: 7, deepseek: 7, vllm: 1 },
    presets: {
      ...family("go-developer", "agent"),
      ...family("go-qa", "agent"),
      ...family("python-developer", "agent"),
      "python-qa-zai": member("zai-coding-cn/glm-5.3-flash", "low", "agent", { systemPrompt: "@qa" }),
      "python-qa-local": member("vllm/Qwen3.8-27B", "off", "agent-dind-vllm", { systemPrompt: "@qa" }),
      ...family("web-developer", "agent"),
      "web-qa-local": member("vllm/Qwen3.8-27B", "off", "agent-dind-vllm", { systemPrompt: "@qa" }),
      "rust-developer-local": member("vllm/Qwen3.8-27B", "off", "agent-dind-vllm", { systemPrompt: "@dev-rust" }),
      "rust-qa-local": member("vllm/Qwen3.8-27B", "off", "agent-dind-vllm", { systemPrompt: "@qa-rust" }),
      reviewer: {
        model: "zai-coding-cn/glm-5.3",
        thinking: "high",
        readOnly: true,
        sandbox: "agent",
        systemPrompt: "reviewer",
        description: "Ревьюер"
      },
      researcher: { model: "zai-coding-cn/glm-5.3-flash", thinking: "low", sandbox: "agent", systemPrompt: "@research" },
      "coverage-auditor": { model: "deepseek/deepseek-v4-flash", thinking: "off", sandbox: "agent-deepseek", systemPrompt: "@coverage" },
    },
    gitProxy: { "github.com": {} }
  };
}
// The rudiment the spec names: model2 on a family member, read by nothing.
function liveFleetWithModel2() {
  const fleet = liveFleet();
  fleet.presets["python-developer-deepseek"].model2 = "deepseek/deepseek-v4-flash-pro";
  return fleet;
}

test("Т-2: семейство схлопывается в один пресет роли; thinking и tags переезжают на записи моделей", () => {
  const raw = liveFleet();
  const { config } = migrateConfig(raw);
  assert.equal(config.presets.length, 11);
  const go = config.presets.find((preset) => preset.id === "go-developer");
  assert.ok(go, "role preset go-developer exists");
  assert.deepEqual(go.models, ["zai-glm-5.3-flash", "deepseek-deepseek-v4-flash", "vllm-Qwen3.8-27B"]);
  // Общая часть один раз: ни model, ни per-провайдерных полей в пресете нет.
  assert.equal(go.model, undefined);
  assert.equal(go.sandboxService, "agent");
  assert.equal(go.systemPrompt, "@dev");
  assert.deepEqual(go.tags, ["fleet"]);
  // Различавшиеся thinking — на записях моделей.
  const poolModels = Object.fromEntries(
    config.concurrencyPools.flatMap((pool) => pool.models.map((model) => [model.id, model]))
  );
  assert.equal(poolModels["zai-glm-5.3-flash"].thinking, "low");
  assert.equal(poolModels["deepseek-deepseek-v4-flash"].thinking, "off");
  assert.equal(poolModels["vllm-Qwen3.8-27B"].thinking, "off");
  // Одиночки переносятся как есть.
  const reviewer = config.presets.find((preset) => preset.id === "reviewer");
  assert.deepEqual(reviewer.models, ["zai-glm-5.3"]);
  assert.equal(reviewer.thinking, "high");
  assert.equal(reviewer.readOnly, true);
  assert.equal(reviewer.systemPrompt, "reviewer");
});

test("Т-3: равные приоритеты — vLLM последней; меньший приоритет пула ставит его первым", () => {
  const raw = liveFleet();
  const even = migrateConfig(raw).config.presets.find((preset) => preset.id === "go-developer");
  assert.deepEqual(even.models, ["zai-glm-5.3-flash", "deepseek-deepseek-v4-flash", "vllm-Qwen3.8-27B"]);

  const uneven = liveFleet();
  uneven.concurrencyPools = { zai: 7, deepseek: { limit: 7, priority: 1 }, vllm: 1 };
  const odd = migrateConfig(uneven).config.presets.find((preset) => preset.id === "go-developer");
  assert.deepEqual(odd.models, ["deepseek-deepseek-v4-flash", "zai-glm-5.3-flash", "vllm-Qwen3.8-27B"]);
});

test("Т-4: пять профилей сворачиваются в минимальный набор сервисов с extend, без concurrencyGroup", () => {
  const raw = liveFleet();
  const { config } = migrateConfig(raw);
  assert.equal(config.sandboxProfiles, undefined);
  assert.deepEqual(
    config.sandboxServices.map((service) => service.id),
    ["agent-base", "agent"]
  );
  assert.equal(config.sandboxServices[1].extend, "agent-base");
  assert.ok(config.sandboxServices[1].env.includes("PI_DIND=1"));
  assert.ok(!JSON.stringify(config).includes("concurrencyGroup"), "provider dimension removed");
  // База не повторяет себя в наследнике.
  assert.equal(config.sandboxServices[1].image, undefined);
});

test("Т-5: реестр моделей с глобальными id; пул несёт limit, priority и aliases", () => {
  const raw = liveFleet();
  const { config } = migrateConfig(raw);
  const pools = Object.fromEntries(config.concurrencyPools.map((pool) => [pool.pool, pool]));
  assert.equal(pools.zai.limit, 7);
  assert.equal(pools.deepseek.limit, 7);
  assert.equal(pools.vllm.limit, 1);
  assert.deepEqual(pools.vllm.aliases, ["local"]);
  for (const pool of config.concurrencyPools) {
    assert.equal(pool.priority, 10);
    for (const model of pool.models) {
      assert.match(model.id, new RegExp(`^${pool.pool}-`));
      assert.ok(model.provider && model.name);
    }
  }
});

test("Т-6: сверка проходит по всем 20 старым именам", () => {
  const raw = liveFleet();
  const { config } = migrateConfig(raw);
  assert.equal(Object.keys(raw.presets).length, 20);
  assert.deepEqual(verifyEquivalence(raw, config), []);
});

test("Т-6: подмена thinking на записи модели — отказ с перечнем", () => {
  const raw = liveFleet();
  const { config } = migrateConfig(raw);
  const corrupted = JSON.parse(JSON.stringify(config));
  corrupted.concurrencyPools.find((pool) => pool.pool === "zai").models.find((model) => model.id === "zai-glm-5.3-flash").thinking = "high";
  const problems = verifyEquivalence(raw, corrupted);
  assert.ok(problems.length > 0, "corrupted thinking must be refused");
  assert.ok(
    problems.some((line) => line.includes("go-developer-zai") && line.includes("thinking")),
    `mismatch must name the old preset and the field, got: ${problems.join(" | ")}`
  );
});

test("Т-6: расхождение песочницы — отказ, а не предупреждение", () => {
  const raw = liveFleet();
  const { config } = migrateConfig(raw);
  const corrupted = JSON.parse(JSON.stringify(config));
  corrupted.sandboxServices.find((service) => service.id === "agent").env = ["PI_DIND=0"];
  const problems = verifyEquivalence(raw, corrupted);
  assert.ok(problems.some((line) => line.includes("sandbox")));
});

test("Т-7: model2 снят и назван", () => {
  const raw = liveFleetWithModel2();
  const { config, dropped } = migrateConfig(raw);
  assert.ok(!JSON.stringify(config).includes("model2"), "model2 removed from the proposed config");
  assert.ok(!JSON.stringify(config).includes("deepseek-v4-flash-pro"), "rudiment does not seed a model record");
  assert.equal(dropped.length, 1);
  assert.match(dropped[0], /python-developer-deepseek\.model2/);
});

test("Т-8: скрипт не пишет в исходник; пишет только в указанный другой путь", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "migrate-"));
  const src = path.join(dir, "config.json");
  const dst = path.join(dir, "new.json");
  fs.writeFileSync(src, JSON.stringify(liveFleet()));
  const before = fs.readFileSync(src, "utf8");

  // Без --out ничего не пишется.
  let out = execFileSync(process.execPath, [SCRIPT, src], { encoding: "utf8" });
  assert.equal(fs.readdirSync(dir).sort().join(","), "config.json", "no files written without --out");
  assert.ok(out.includes("---"), "diff is printed to stdout");

  // Запись — только в указанный другой путь.
  out = execFileSync(process.execPath, [SCRIPT, src, "--out", dst], { encoding: "utf8" });
  assert.equal(fs.readFileSync(src, "utf8"), before, "input untouched");
  const written = JSON.parse(fs.readFileSync(dst, "utf8"));
  assert.ok(Array.isArray(written.presets) && written.presets.length === 11);
  assert.ok(out.includes("Removed rudiments") === false, "no rudiments in the clean fleet");

  // --out на исходник — отказ.
  assert.throws(
    () => execFileSync(process.execPath, [SCRIPT, src, "--out", src], { encoding: "utf8" }),
    (error) => error.status === 2
  );
  assert.equal(fs.readFileSync(src, "utf8"), before);

  // Эквивалентность предложенной формы доказана на этой же копии.
  const problems = verifyEquivalence(JSON.parse(before), written);
  assert.deepEqual(problems, []);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("дифф печатается построчно и показывает схлопывание", () => {
  const raw = liveFleet();
  const old = JSON.stringify(raw, null, 2);
  const fresh = JSON.stringify(migrateConfig(raw).config, null, 2);
  const diff = lineDiff(old, fresh, "old", "new");
  assert.ok(diff.startsWith("--- old"));
  assert.ok(diff.split("\n").some((line) => line.startsWith("- ") && line.includes("go-developer-zai")));
  assert.ok(diff.split("\n").some((line) => line.startsWith("+ ") && line.includes('"id": "go-developer"')));
});
