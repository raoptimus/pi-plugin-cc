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
  // Живая форма: у КАЖДОГО пресета песочница — объект `{profile, env}` с
  // пер-ролевым набором: PI_HOOKS роли (у qa добавлен test-only-guard) и
  // GIT_CONFIG_*. Это env роли, не провайдера — у членов семейства он общий.
  const roleEnv = (role, qa = false) => [
    `PI_HOOKS=commit-guard,secret-guard${qa ? ",test-only-guard" : ""}`,
    "GIT_CONFIG_COUNT=1",
    `GIT_CONFIG_KEY_0=credential.${role}`
  ];
  const sb = (role, profile, qa = false) => ({ profile, env: roleEnv(role, qa) });
  const member = (model, thinking, sandbox, extra = {}) => ({
    model,
    thinking,
    sandbox,
    systemPrompt: "@dev",
    appendSystemPrompt: ["Общий хвост"],
    timeoutMs: 1_800_000,
    git: { name: "Fleet", email: "fleet@example.com" },
    skills: ["/pi-skills/vision"],
    ...extra
  });
  const family = (role, zaiProfile, qa = false) => {
    const tags = [qa ? "qa" : "dev", role.split("-")[0]];
    return {
    [`${role}-zai`]: member("zai-coding-cn/glm-5.3-flash", "low", sb(role, zaiProfile, qa), { tags, description: `${role} (zai)` }),
    [`${role}-deepseek`]: member("deepseek/deepseek-v4-flash", "low", sb(role, "agent-deepseek", qa), { tags, description: `${role} (deepseek)` }),
    [`${role}-local`]: member("vllm/Qwen3.8-27B", "off", sb(role, "agent-dind-vllm", qa), { tags, description: `${role} (local)` })
    };
  };
  const dind = { args: ["--security-opt", "seccomp=@dind.json", "--device", "/dev/net/tun"], env: ["PI_DIND=1"], mounts: ["pi-dind:/var/lib/docker"] };
  // The owner's live layout (checked against the real file): the trio
  // agent-dind / agent-dind-vllm / agent-deepseek is byte-identical over
  // `agent` apart from concurrencyGroup; agent-lite inherits the base WITHOUT
  // the dind equipment — a difference in substance, it stays its own service.
  return {
    sandboxProfiles: {
      "agent-base": { image: "pi-sandbox-agent:latest", env: ["PATH=/t/bin"], mounts: ["/srv:/srv:ro"], args: ["--cpus", "6"] },
      agent: { profile: "agent-base", image: "pi-sandbox-agent:latest", ...dind, concurrencyGroup: "zai" },
      "agent-dind": { profile: "agent", image: "pi-sandbox-agent:latest", concurrencyGroup: "zai" },
      "agent-dind-vllm": { profile: "agent", image: "pi-sandbox-agent:latest", concurrencyGroup: "vllm" },
      "agent-deepseek": { profile: "agent", image: "pi-sandbox-agent:latest", concurrencyGroup: "deepseek" },
      "agent-lite": { profile: "agent-base", image: "pi-sandbox-agent:latest", concurrencyGroup: "zai" }
    },
    concurrencyPools: { zai: 7, deepseek: 7, vllm: 1 },
    presets: {
      ...family("go-developer", "agent-dind"),
      ...family("go-qa", "agent-dind", true),
      ...family("python-developer", "agent-dind"),
      "python-qa-zai": member("zai-coding-cn/glm-5.3-flash", "low", sb("python-qa", "agent", true), { tags: ["qa", "py"], systemPrompt: "@qa" }),
      "python-qa-local": member("vllm/Qwen3.8-27B", "off", sb("python-qa", "agent-dind-vllm", true), { tags: ["qa", "py"], systemPrompt: "@qa" }),
      ...family("web-developer", "agent"),
      "web-qa-local": member("vllm/Qwen3.8-27B", "off", sb("web-qa", "agent-dind-vllm", true), { tags: ["qa", "web"], systemPrompt: "@qa" }),
      "rust-developer-local": member("vllm/Qwen3.8-27B", "off", sb("rust-developer", "agent-dind-vllm"), { tags: ["dev", "rust"], systemPrompt: "@dev-rust" }),
      "rust-qa-local": member("vllm/Qwen3.8-27B", "off", sb("rust-qa", "agent-dind-vllm", true), { tags: ["qa", "rust"], systemPrompt: "@qa-rust" }),
      reviewer: {
        model: "zai-coding-cn/glm-5.3",
        thinking: "high",
        readOnly: true,
        tags: ["review"],
        sandbox: sb("reviewer", "agent"),
        systemPrompt: "reviewer",
        description: "Ревьюер"
      },
      researcher: { model: "zai-coding-cn/glm-5.3-flash", thinking: "high", tags: ["research"], sandbox: sb("researcher", "agent"), systemPrompt: "@research" },
      "coverage-auditor": { model: "deepseek/deepseek-v4-flash", thinking: "high", tags: ["audit", "blind"], sandbox: sb("coverage-auditor", "agent-deepseek"), systemPrompt: "@coverage" },
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
  // У роли есть собственный env, поэтому песочница переносится объектной формой
  // поверх сервиса; сам сервис — "agent".
  assert.equal(go.sandbox.profile, "agent");
  assert.equal(go.systemPrompt, "@dev");
  assert.deepEqual(go.tags, ["dev", "go"]);
  // Различавшиеся thinking — на записях моделей. С решателем по всем
  // пользователям модели: flash нужна семействам на low, researcher — на high;
  // конфликт не кладётся на запись — семейство переносит low на пресет.
  const poolModels = Object.fromEntries(
    config.concurrencyPools.flatMap((pool) => pool.models.map((model) => [model.id, model]))
  );
  assert.equal(poolModels["zai-glm-5.3-flash"].thinking, undefined, "conflicting demand must not land on the record");
  assert.equal(poolModels["deepseek-deepseek-v4-flash"].thinking, undefined);
  assert.equal(poolModels["vllm-Qwen3.8-27B"].thinking, "off");
  assert.equal(go.thinking, "low", "family carries the level its members demanded");
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

test("Т-4: живая раскладка — трио схлопывается в один dind-сервис; база и lite остаются отдельными", () => {
  const raw = liveFleet();
  const { config } = migrateConfig(raw);
  assert.equal(config.sandboxProfiles, undefined);
  assert.deepEqual(
    config.sandboxServices.map((service) => service.id),
    ["agent-base", "agent", "agent-lite"]
  );
  const dindService = config.sandboxServices.find((service) => service.id === "agent");
  assert.equal(dindService.extend, "agent-base");
  assert.ok(dindService.env.includes("PI_DIND=1"));
  assert.ok(dindService.args.includes("--device"));
  assert.ok(dindService.args.includes("/dev/net/tun"));
  assert.ok(dindService.mounts.includes("pi-dind:/var/lib/docker"));
  assert.equal(dindService.image, undefined, "the base is not repeated in the heir");
  // lite наследует базу без dind-оборудования и потому не схлопывается ни с базой, ни с dind-сервисом.
  const lite = config.sandboxServices.find((service) => service.id === "agent-lite");
  assert.equal(lite.extend, "agent-base");
  assert.equal(lite.env, undefined);
  assert.equal(lite.args, undefined);
  assert.equal(lite.mounts, undefined);
  assert.ok(!JSON.stringify(config).includes("concurrencyGroup"), "provider dimension removed from the whole document");
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

// Фикс-раунд 1: правило схлопывания и переезд группы слотов в пул.

test("фикс: различие по args/mounts — отказ с перечнем имён, схлопывать нечего", () => {
  const raw = liveFleet();
  // Существенное различие: у deepseek-варианта свой объём памяти — это уже
  // другой контейнер, эквивалентность на всех старых именах не собрать.
  raw.sandboxProfiles["agent-deepseek"].args = ["--memory", "8g"];
  assert.throws(
    () => migrateConfig(raw),
    (error) => {
      assert.match(error.message, /do not collapse|не схлопываются|spans sandbox profiles/);
      assert.match(error.message, /go-developer-zai/);
      assert.match(error.message, /go-developer-deepseek/);
      assert.match(error.message, /go-developer-local/);
      return true;
    }
  );
});

test("фикс: различие по mounts — отказ, а не схлопывание", () => {
  const raw = liveFleet();
  raw.sandboxProfiles["agent-deepseek"].mounts = ["secrets:/secrets:ro"];
  assert.throws(() => migrateConfig(raw), /spans sandbox profiles/);
});

test("фикс: группа слотов каждого старого имени равна пулу его модели; расхождение — отказ", () => {
  const raw = liveFleet();
  const { config } = migrateConfig(raw);
  assert.deepEqual(verifyEquivalence(raw, config), []);

  // Владелец перепутал группу у deepseek-профиля: старое имя go-developer-deepseek
  // считало слоты по группе deepseek, а модель уезжает в пул deepseek — расхождение
  // обязано назвать и имя, и оба пула.
  const rewired = JSON.parse(JSON.stringify(raw));
  rewired.sandboxProfiles["agent-deepseek"].concurrencyGroup = "zai";
  const problems = verifyEquivalence(rewired, migrateConfig(rewired).config);
  assert.ok(
    problems.some((line) => line.includes("go-developer-deepseek") && line.includes("zai") && line.includes("deepseek")),
    `pool rewiring must be refused, got: ${problems.join(" | ")}`
  );

  // То же на стороне РЕЗУЛЬТАТА: кто-то испортил выходной пул — сверка ловит.
  const corrupted = JSON.parse(JSON.stringify(config));
  const vllm = corrupted.concurrencyPools.find((pool) => pool.pool === "vllm");
  vllm.aliases = [];
  assert.ok(verifyEquivalence(raw, corrupted).some((line) => line.includes("go-developer-local")),
    "breaking the pool alias must be caught for the *-local name");
});

// Фикс-раунд 2: собственный env роли из объектной песочницы.

// Фикс-раунд 2: thinking одиночек не затекает из модельной записи.

// Фикс-раунд 2: теги ролей не перемешиваются через модельные записи.

test("фикс-раунд 2: теги остаются у роли, записи их не налипают на чужие имена и не дублируются", () => {
  const raw = liveFleet();
  const { config } = migrateConfig(raw);
  assert.deepEqual(verifyEquivalence(raw, config), []);
  const byId = Object.fromEntries(config.presets.map((preset) => [preset.id, preset]));
  assert.deepEqual(byId["python-qa"].tags, ["qa", "py"]);
  assert.deepEqual(byId["go-developer"].tags, ["dev", "go"]);
  assert.deepEqual(byId.researcher.tags, ["research"]);
  assert.deepEqual(byId["coverage-auditor"].tags, ["audit", "blind"]);
  const flatModels = config.concurrencyPools.flatMap((pool) => pool.models);
  assert.ok(
    flatModels.every((model) => model.tags === undefined),
    "no role tag may leak onto a globally shared model record"
  );
});

test("фикс-раунд 2: разные надбавки к тегам одной модели с разных ролей — отказ с именами, не выбор молча", () => {
  const raw = liveFleet();
  // python-developer: deepseek-член несёт роль ещё и тег "coverage" — это
  // различие внутри семейства, оно просится на запись deepseek-модели, которой
  // пользуются и другие роли без этой надбавки.
  raw.presets["python-developer-deepseek"].tags = ["dev", "python", "coverage"];
  assert.throws(
    () => migrateConfig(raw),
    (error) => {
      assert.match(error.message, /Model "deepseek\/deepseek-v4-flash" is demanded different tag extras/);
      assert.match(error.message, /python-developer-deepseek/);
      assert.match(error.message, /go-developer-deepseek|coverage-auditor/);
      return true;
    }
  );
});

test("фикс-раунд 2: thinking одиночки берётся из него самого, конфликт записи решается в пользу роли", () => {
  const raw = liveFleet();
  const { config } = migrateConfig(raw);
  assert.deepEqual(verifyEquivalence(raw, config), []);
  const researcher = config.presets.find((preset) => preset.id === "researcher");
  assert.equal(researcher.thinking, "high", "researcher keeps its own level, not the family-built record's low");
  const coverage = config.presets.find((preset) => preset.id === "coverage-auditor");
  assert.equal(coverage.thinking, "high");
  // Уровень, где различие было настоящим и бесспорным (vllm off у всех), — на записи.
  const vllm = config.concurrencyPools.flatMap((pool) => pool.models).find((model) => model.id === "vllm-Qwen3.8-27B");
  assert.equal(vllm.thinking, "off");
  // Однозначная модельная запись (glm-5.3 — только reviewer) несёт свой уровень.
  const glm = config.concurrencyPools.flatMap((pool) => pool.models).find((model) => model.id === "zai-glm-5.3");
  assert.equal(glm.thinking, "high");
});

test("фикс-раунд 2: env роли переезжает на пресет новой формы, у qa — свой test-only-guard", () => {
  const raw = liveFleet();
  const { config } = migrateConfig(raw);
  assert.deepEqual(verifyEquivalence(raw, config), []);
  const go = config.presets.find((preset) => preset.id === "go-developer");
  assert.equal(go.sandboxService, undefined, "role env cannot ride the service field");
  assert.equal(go.sandbox.profile, "agent");
  assert.ok(go.sandbox.env.includes("PI_HOOKS=commit-guard,secret-guard"));
  assert.ok(go.sandbox.env.includes("GIT_CONFIG_KEY_0=credential.go-developer"));
  const qa = config.presets.find((preset) => preset.id === "go-qa");
  assert.ok(qa.sandbox.env.includes("PI_HOOKS=commit-guard,secret-guard,test-only-guard"), "qa keeps its own hook set");
  const reviewer = config.presets.find((preset) => preset.id === "reviewer");
  assert.equal(reviewer.sandbox.profile, "agent", "a single preset carries its own env too");
});

test("фикс: concurrencyGroup на пресете снимается, назван в dropped, и его нет нигде в выходном документе", () => {
  const raw = liveFleet();
  raw.presets["go-developer-zai"].concurrencyGroup = "zai";
  const { config, dropped } = migrateConfig(raw);
  assert.ok(!JSON.stringify(config).includes("concurrencyGroup"), "field must not survive anywhere in the output");
  assert.ok(
    dropped.some((line) => line.includes("go-developer-zai.concurrencyGroup")),
    `the removal must be named, got: ${dropped.join(" | ")}`
  );
  assert.deepEqual(verifyEquivalence(raw, config), []);
});
