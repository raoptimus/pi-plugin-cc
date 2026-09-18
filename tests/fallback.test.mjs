import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

/**
 * Подмена мёртвого пресета первым живым из цепочки.
 *
 * Чистые правила проверяются таблицами; в конце файла — сквозной прогон через
 * настоящий CLI с двойником вместо pi: подмена обязана проверяться по факту
 * (какие `--provider`/`--model` реально ушли в запуск), а не по тексту
 * предупреждения.
 */

import {
  classifyFailure,
  deriveFallbackChain,
  parsePresetName,
  presetDead,
  presetPool,
  resolvePresetFallback
} from "../plugins/pi/scripts/lib/fallback.mjs";
import { openDatabase, queryPresetHealth } from "../plugins/pi/scripts/lib/db.mjs";
import { BUILT_IN_CONFIG } from "../plugins/pi/scripts/lib/config.mjs";

const CONFIG = {
  ...BUILT_IN_CONFIG,
  sandboxProfiles: {
    gpu: { mode: "docker", concurrencyGroup: "zai-pool" },
    plain: { mode: "docker" }
  },
  presets: {
    "go-developer-deepseek": { model: "deepseek-chat", fallbackPreset: "go-developer-zai" },
    "go-developer-zai": { model: "glm-5" },
    "go-developer-local": { model: "qwen3" },
    "go-qa-zai": { model: "glm-5" },
    "web-developer-zai": { model: "glm-5" },
    broken: { sandbox: "no-such-profile" }
  }
};

const run = (preset, status, text, createdIndex = 0) => ({
  preset,
  status,
  error_text: status === "failed" ? text : null,
  result_text: status === "completed" ? text : null,
  created_at: new Date(Date.now() - createdIndex * 60_000).toISOString()
});

test("классификация отказа: занятый пул — не отказ провайдера", () => {
  const cases = [
    ['Waiting for a free slot: pool "zai" is at its limit of 3.', "pool"],
    ["Sandbox pool \"zai\" allows 2 container(s) at once and all of them are busy after 900s.", "pool"],
    ["Error 402: Insufficient Balance", "quota"],
    ["429 rate limit exceeded", "quota"],
    ['{"code":"1310","message":"使用上限"}', "quota"],
    ["Weekly usage limit reached, resets 2026-07-20 04:00", "quota"],
    ["fetch failed: ECONNREFUSED 1.2.3.4:443", "network"],
    ["502: The model endpoint could not be reached", "network"],
    ["socket hang up", "network"],
    ["model \"glm-57\" is unknown", "unknown"],
    ["", "unknown"],
    [null, "unknown"]
  ];
  for (const [text, expected] of cases) {
    assert.equal(classifyFailure(text), expected, JSON.stringify(text));
  }
});

test("500 не считается сетевым отказом: он приходит и на содержательные ошибки", () => {
  assert.equal(classifyFailure("500 internal error while parsing the request"), "unknown");
});

test("пул пресета: группа профиля, иначе имя профиля", () => {
  assert.equal(presetPool({ sandbox: "gpu" }, CONFIG), "zai-pool");
  assert.equal(presetPool({ sandbox: "plain" }, CONFIG), "plain");
  assert.equal(presetPool({ sandbox: { profile: "gpu", maxConcurrent: 1 } }, CONFIG), "zai-pool");
  assert.equal(presetPool({}, CONFIG), null, "без песочницы пула нет");
  assert.equal(presetPool({ sandbox: "no-such-profile" }, CONFIG), null, "битый профиль — не повод падать на старте");
});

test("имя пресета разбирается на стек, роль и провайдера", () => {
  assert.deepEqual(parsePresetName("go-qa-deepseek"), { stack: "go", role: "qa", provider: "deepseek" });
  assert.deepEqual(parsePresetName("python-developer-zai"), { stack: "python", role: "developer", provider: "zai" });
  assert.deepEqual(parsePresetName("web-ui-developer-local"), { stack: "web", role: "ui-developer", provider: "local" });
  assert.equal(parsePresetName("solo"), null);
  assert.equal(parsePresetName(""), null);
});

test("цепочка: объявленный fallbackPreset первый, дальше — тот же стек и роль", () => {
  assert.deepEqual(
    deriveFallbackChain("go-developer-deepseek", CONFIG),
    ["go-developer-zai", "go-developer-local"],
    "go-qa-zai и web-developer-zai — другие роли и стеки, в цепочку не попадают"
  );
  assert.deepEqual(deriveFallbackChain("go-qa-zai", CONFIG), [], "без объявления и без соседей цепочка пуста");
  assert.deepEqual(
    deriveFallbackChain("solo", { presets: { solo: { fallbackPreset: "go-developer-zai" }, "go-developer-zai": {} } }),
    ["go-developer-zai"],
    "неразбираемое имя — только объявленный кандидат"
  );
  assert.deepEqual(
    deriveFallbackChain("go-developer-deepseek", {
      presets: { "go-developer-deepseek": { fallbackPreset: "missing" } }
    }),
    [],
    "объявленный, но несуществующий пресет кандидатом не становится"
  );
});

test("мертв: последний прогон упал по квоте или сети", () => {
  const dead = presetDead("go-developer-deepseek", [
    run("go-developer-deepseek", "failed", "Error 402: Insufficient Balance")
  ]);
  assert.deepEqual(dead, { kind: "quota", text: "Error 402: Insufficient Balance" });
  assert.equal(presetDead("p", [run("p", "failed", "ETIMEDOUT")]).kind, "network");
});

test("жив: успех позже отказа, занятый пул, неопознанная причина или пустой журнал", () => {
  const cases = [
    [
      [run("p", "completed", "готово"), run("p", "failed", "Error 402: Insufficient Balance", 1)],
      "успех позже отказа — пресет вернулся"
    ],
    [[run("p", "failed", "Waiting for a free slot: pool \"zai\" is at its limit of 3.")], "занятый пул — не отказ провайдера"],
    [[run("p", "failed", "model \"glm-57\" is unknown")], "неопознанная причина подмену не вызывает"],
    [[run("other", "failed", "Error 402: Insufficient Balance")], "чужой отказ ничего не говорит об этом пресете"],
    [[], "нет прогонов — нет состояния"]
  ];
  for (const [runs, why] of cases) {
    assert.equal(presetDead("p", runs), null, why);
  }
});

test("подмена: первый живой кандидат, а при всеобщей смерти — никакой", () => {
  const balance = "Error 402: Insufficient Balance";
  const runs = (failed) => failed.map((preset) => run(preset, "failed", balance));
  assert.deepEqual(
    resolvePresetFallback({
      config: CONFIG,
      presetName: "go-developer-deepseek",
      runs: runs(["go-developer-deepseek", "go-developer-zai"])
    }),
    { preset: "go-developer-local", dead: { kind: "quota", text: balance } },
    "мёртвый объявленный кандидат пропускается — берётся первый живой"
  );
  assert.deepEqual(
    resolvePresetFallback({ config: CONFIG, presetName: "go-developer-deepseek", runs: runs(["go-developer-deepseek"]) }),
    { preset: "go-developer-zai", dead: { kind: "quota", text: balance } },
    "объявленный запасной жив — идёт первым"
  );
  assert.equal(
    resolvePresetFallback({
      config: CONFIG,
      presetName: "go-developer-deepseek",
      runs: runs(["go-developer-deepseek", "go-developer-zai", "go-developer-local"])
    }),
    null,
    "вся цепочка мёртва — подмены нет"
  );
  assert.equal(
    resolvePresetFallback({ config: CONFIG, presetName: "go-developer-deepseek", runs: [] }),
    null,
    "живой пресет не трогаем"
  );
  assert.equal(
    resolvePresetFallback({ config: CONFIG, presetName: "no-such-preset", runs: runs(["no-such-preset"]) }),
    null,
    "неизвестный пресет не наше решение"
  );
});

// --- сквозной прогон: подмена видна в реальном запуске ----------------------

const CLI = fileURLToPath(new URL("../plugins/pi/scripts/pi-companion.mjs", import.meta.url));

function makeHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fallback-home-"));
  fs.mkdirSync(path.join(home, ".claude", "pi"), { recursive: true });
  fs.writeFileSync(
    path.join(home, ".claude", "pi", "config.json"),
    JSON.stringify({
      presets: {
        "go-developer-deepseek": { model: "deepseek-chat", provider: "deepseek", engine: "json", fallbackPreset: "go-developer-zai" },
        "go-developer-zai": { model: "glm-5", provider: "zai", engine: "json" }
      }
    })
  );
  return home;
}

const FAKE_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fallback-bin-"));
const FAKE_BINARY = path.join(FAKE_ROOT, "fake-pi.mjs");
fs.writeFileSync(
  FAKE_BINARY,
  `#!/usr/bin/env node
import fs from "node:fs";
process.stdin.setEncoding("utf8");
let prompt = "";
process.stdin.on("data", (chunk) => { prompt += chunk; });
process.stdin.on("end", () => {
  const say = (event) => process.stdout.write(JSON.stringify(event) + "\\n");
  fs.appendFileSync(process.env.PI_FAKE_LOG, JSON.stringify({ args: process.argv.slice(2), prompt }) + "\\n");
  say({ type: "session", id: "sess-fb" });
  say({ type: "turn_start" });
  say({ type: "message_end", message: { role: "assistant", stopReason: "stop", usage: { input: 1, output: 1 }, content: [{ type: "text", text: "done" }] } });
});
`,
  { encoding: "utf8", mode: 0o755 }
);

function seedFailure(dbFile, preset, text) {
  const handle = openDatabase(dbFile);
  assert.ok(handle, "журнал открылся");
  try {
    handle.db
      .prepare("INSERT INTO jobs (id, preset, status, error_text, created_at) VALUES ($id, $preset, 'failed', $error, $created)")
      .run({ id: `seed-${preset}`, preset, error: text, created: new Date().toISOString() });
  } finally {
    handle.close();
  }
}

function runDelegate({ home, workspace, dbFile, preset }) {
  const log = path.join(workspace, "pi-calls.jsonl");
  fs.writeFileSync(log, "", "utf8");
  const result = spawnSync(
    process.execPath,
    [CLI, "delegate", "--preset", preset, "сделай задачу", "--engine", "json"],
    {
      cwd: workspace,
      encoding: "utf8",
      timeout: 120_000,
      env: {
        ...process.env,
        HOME: home,
        XDG_DATA_HOME: path.join(workspace, "data"),
        PI_PLUGIN_BINARY: FAKE_BINARY,
        PI_PLUGIN_DB: dbFile,
        PI_FAKE_LOG: log
      }
    }
  );
  return { result, calls: () => fs.readFileSync(log, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)) };
}

test("delegate уходит на запасной пресет: провайдер и модель — кандидата, не мёртвого", () => {
  const home = makeHome();
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fallback-ws-"));
  const dbFile = path.join(workspace, "jobs.db");
  seedFailure(dbFile, "go-developer-deepseek", "Error 402: Insufficient Balance");

  const { result, calls } = runDelegate({ home, workspace, dbFile, preset: "go-developer-deepseek" });
  assert.equal(result.status, 0, `CLI завершился успешно:\n${result.stderr}`);
  const args = calls().at(-1).args;
  assert.ok(args.includes("--provider"), "провайдер передан");
  const provider = args[args.indexOf("--provider") + 1];
  const model = args[args.indexOf("--model") + 1];
  assert.equal(provider, "zai", `стартовал запасной провайдер, а не deepseek (args: ${args.join(" ")})`);
  assert.equal(model, "glm-5", "стартовала модель запасного пресета");

  // Факт подмены остаётся в журнале: новый прогон записан за кандидатом.
  const handle = openDatabase(dbFile);
  const rows = queryPresetHealth(handle);
  handle.close();
  assert.equal(rows[0].preset, "go-developer-zai");
  assert.equal(rows[0].status, "completed");
  assert.match(result.stdout, /go-developer-zai/, "подмена названа в отчёте");
});

test("живой пресет не подменяется: задача стартует у того, кого назвали", () => {
  const home = makeHome();
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fallback-ws-"));
  const dbFile = path.join(workspace, "jobs.db");

  const { result, calls } = runDelegate({ home, workspace, dbFile, preset: "go-developer-deepseek" });
  assert.equal(result.status, 0, `CLI завершился успешно:\n${result.stderr}`);
  const args = calls().at(-1).args;
  assert.equal(args[args.indexOf("--provider") + 1], "deepseek", "без отказа в журнале подмены нет");
});

test.after(() => {
  fs.rmSync(FAKE_ROOT, { recursive: true, force: true });
});
