import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { openDatabase, recordJob } from "../plugins/pi/scripts/lib/db.mjs";
import {
  buildMetricsPayload,
  exportJobMetrics,
  parseKeyValueList,
  resolveOtelConfig,
  splitModelId,
  withoutOtel
} from "../plugins/pi/scripts/lib/otel-export.mjs";

function temporaryDatabase() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-otel-"));
  return { handle: openDatabase(path.join(dir, "jobs.db")), dir };
}

/** A stand-in collector that records what it received. */
async function startCollector({ statusCode = 200, hang = false } = {}) {
  const seen = [];
  const server = http.createServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      seen.push({
        url: request.url,
        contentType: request.headers["content-type"],
        authorization: request.headers.authorization,
        body: Buffer.concat(chunks).toString("utf8")
      });
      if (hang) return;
      response.writeHead(statusCode);
      response.end();
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    seen,
    url: `http://127.0.0.1:${server.address().port}/v1/metrics`,
    close: () =>
      new Promise((resolve) => {
        // A hanging handler would otherwise keep the socket (and the test process) alive.
        server.closeAllConnections();
        server.close(resolve);
      })
  };
}

function job(overrides = {}) {
  return {
    id: "delegate-1",
    kind: "delegate",
    model: "zai-coding-cn/glm-5.3-flash",
    status: "completed",
    createdAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
    usage: { input: 100, output: 20, cost: 0.5 },
    ...overrides
  };
}

const ENABLED = {
  PI_OTEL_ENABLE: "1",
  OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: "http://collector:30318/v1/metrics",
  OTEL_EXPORTER_OTLP_METRICS_HEADERS: "Authorization=Bearer t0k3n,X-Scope-OrgID=acme=corp"
};

test("resolveOtelConfig: выключен без PI_OTEL_ENABLE, без endpoint и при grpc без metrics-endpoint", () => {
  assert.equal(resolveOtelConfig({}), null);
  assert.equal(resolveOtelConfig({ PI_OTEL_ENABLE: "0" }), null);
  assert.equal(resolveOtelConfig({ PI_OTEL_ENABLE: "1" }), null, "endpoint не задан вовсе");
  // Текущее окружение владельца: grpc + gRPC-endpoint — exporter обязан молчать.
  assert.equal(
    resolveOtelConfig({ PI_OTEL_ENABLE: "1", OTEL_EXPORTER_OTLP_PROTOCOL: "grpc", OTEL_EXPORTER_OTLP_ENDPOINT: "http://collector:30317" }),
    null
  );
  // Явный metrics-endpoint спасает даже при grpc-протоколе базового сигнала.
  assert.ok(
    resolveOtelConfig({
      PI_OTEL_ENABLE: "true",
      OTEL_EXPORTER_OTLP_PROTOCOL: "grpc",
      OTEL_EXPORTER_OTLP_ENDPOINT: "http://collector:30317",
      OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: "http://collector:30318/v1/metrics"
    })
  );
});

test("resolveOtelConfig: собирает URL из базового endpoint, METRICS_ENDPOINT выигрывает", () => {
  const fromBase = resolveOtelConfig({ PI_OTEL_ENABLE: "1", OTEL_EXPORTER_OTLP_ENDPOINT: "http://collector:4318/" });
  assert.equal(fromBase.endpoint, "http://collector:4318/v1/metrics", "хвостовой слэш не задваивается");
  const metrics = resolveOtelConfig({
    PI_OTEL_ENABLE: "1",
    OTEL_EXPORTER_OTLP_ENDPOINT: "http://collector:4318",
    OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: "http://elsewhere:9/v1/metrics"
  });
  assert.equal(metrics.endpoint, "http://elsewhere:9/v1/metrics");
});

test("resolveOtelConfig: разбор k=v,k=v, значения со знаком =, resource-атрибуты и service.name", () => {
  assert.deepEqual(parseKeyValueList("a=1,b=x=y"), { a: "1", b: "x=y" });
  const config = resolveOtelConfig({
    ...ENABLED,
    OTEL_SERVICE_NAME: "my-pi",
    OTEL_RESOURCE_ATTRIBUTES: "deployment.environment=prod,team=otel=v2"
  });
  assert.equal(config.headers.Authorization, "Bearer t0k3n");
  assert.equal(config.headers["X-Scope-OrgID"], "acme=corp");
  assert.equal(config.resource["service.name"], "my-pi");
  assert.equal(config.resource["pi.runner"], "companion");
  assert.equal(config.resource["deployment.environment"], "prod");
  assert.equal(config.resource.team, "otel=v2");
  // Дефолт service.name обязан совпадать с расширением.
  assert.equal(resolveOtelConfig({ ...ENABLED }).resource["service.name"], "pi-coding-agent");
});

test("buildMetricsPayload: форма OTLP/JSON — asInt строкой, asDouble числом, temporality 2, лейблы", () => {
  const payload = buildMetricsPayload({
    model: "glm-5.3-flash",
    provider: "zai-coding-cn",
    totals: { input: 1699946793, output: 4210, cacheRead: 0, cacheWrite: 7, cost: 0.25 },
    startTimeNs: 1757000000000000000n,
    nowNs: 1758572897000000000n,
    resource: { "service.name": "pi-coding-agent", "pi.runner": "companion" }
  });
  const [resourceMetrics] = payload.resourceMetrics;
  assert.deepEqual(
    resourceMetrics.resource.attributes.map((a) => [a.key, a.value.stringValue]),
    [["service.name", "pi-coding-agent"], ["pi.runner", "companion"]]
  );
  assert.equal(resourceMetrics.scopeMetrics[0].scope.name, "pi-plugin-cc");
  const [token, cost] = resourceMetrics.scopeMetrics[0].metrics;
  assert.equal(token.name, "pi.token.usage");
  assert.equal(token.unit, "tokens");
  assert.equal(token.sum.aggregationTemporality, 2);
  assert.equal(token.sum.isMonotonic, true);
  assert.equal(token.sum.dataPoints.length, 3, "нулевой cacheRead не порождает точку");
  const input = token.sum.dataPoints[0];
  assert.equal(input.asInt, "1699946793", "int64 кодируется строкой");
  assert.equal(typeof input.asInt, "string");
  assert.equal(input.startTimeUnixNano, "1757000000000000000");
  assert.equal(input.timeUnixNano, "1758572897000000000");
  assert.deepEqual(
    input.attributes.map((a) => [a.key, a.value.stringValue]),
    [["model", "glm-5.3-flash"], ["provider", "zai-coding-cn"], ["type", "input"]]
  );
  assert.equal(cost.name, "pi.cost.usage");
  assert.equal(cost.unit, "USD");
  assert.equal(typeof cost.sum.dataPoints[0].asDouble, "number");
  assert.equal(cost.sum.dataPoints[0].asDouble, 0.25);
});

test("buildMetricsPayload: нулевые тоталы и cost=0 рядов не порождают", () => {
  assert.equal(
    buildMetricsPayload({
      model: "m", provider: "p",
      totals: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
      startTimeNs: 1n, nowNs: 2n, resource: {}
    }),
    null,
    "cost=0 не порождает pi.cost.usage"
  );
  const costOnly = buildMetricsPayload({
    model: "m", provider: "p",
    totals: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0.1 },
    startTimeNs: 1n, nowNs: 2n, resource: {}
  });
  assert.deepEqual(
    costOnly.resourceMetrics[0].scopeMetrics[0].metrics.map((m) => m.name),
    ["pi.cost.usage"]
  );
});

test("splitModelId: model без префикса провайдера, провайдер отдельным лейблом", () => {
  assert.deepEqual(splitModelId("zai-coding-cn/glm-5.3-flash"), { model: "glm-5.3-flash", provider: "zai-coding-cn" });
  assert.deepEqual(splitModelId("vllm/Qwen3.8-27B"), { model: "Qwen3.8-27B", provider: "vllm" });
  assert.deepEqual(splitModelId("bare-model"), { model: "bare-model", provider: "" });
});

test("кумулятив: два прогона одной модели — второй экспорт несёт сумму, startTime общий", async () => {
  const { handle, dir } = temporaryDatabase();
  try {
    recordJob(handle, job({ id: "a", usage: { input: 100, output: 10, cost: 0.01 } }));
    const first = await exportAndCapture(handle, "a");
    recordJob(handle, job({ id: "b", usage: { input: 50, output: 5, cost: 0.02 } }));
    const second = await exportAndCapture(handle, "b");
    const pointsOf = (capture, type) =>
      JSON.parse(capture.body).resourceMetrics[0].scopeMetrics[0].metrics
        .find((m) => m.name === "pi.token.usage")
        .sum.dataPoints.find((p) => p.attributes.some((a) => a.key === "type" && a.value.stringValue === type));
    assert.equal(pointsOf(second, "input").asInt, "150", "агрегат по всему журналу, а не по одному прогону");
    assert.equal(pointsOf(second, "output").asInt, "15");
    assert.equal(
      pointsOf(first, "input").startTimeUnixNano,
      pointsOf(second, "input").startTimeUnixNano,
      "startTime единый на БД"
    );
  } finally {
    handle.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

async function exportAndCapture(handle, jobId, env = ENABLED) {
  const captures = [];
  await exportJobMetrics(
    { id: jobId, model: job().model },
    {
      env,
      db: handle,
      // Заглушка вместо сети: даже URL из ENABLED не должен резолвиться по-настоящему.
      fetchImpl: async (url, options) => {
        captures.push({ url, body: options.body, headers: options.headers });
        return { ok: true, status: 200 };
      }
    }
  );
  return captures[0];
}

test("сквозной: локальный коллектор получает путь, Content-Type, авторизацию и тело; 500 и тишина не роняют прогон", async () => {
  const { handle, dir } = temporaryDatabase();
  try {
    recordJob(handle, job({}));
    const collector = await startCollector();
    await exportJobMetrics(job({}), { env: { ...ENABLED, OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: collector.url }, db: handle });
    const seen = collector.seen[0];
    assert.equal(seen.url.endsWith("/v1/metrics"), true);
    assert.equal(seen.contentType, "application/json");
    assert.equal(seen.authorization, "Bearer t0k3n");
    const payload = JSON.parse(seen.body);
    assert.equal(payload.resourceMetrics[0].scopeMetrics[0].metrics[0].name, "pi.token.usage");
    await collector.close();

    // 500 от коллектора: экспорт молча переживается.
    const failing = await startCollector({ statusCode: 500 });
    await exportJobMetrics(job({ id: "x2" }), { env: { ...ENABLED, OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: failing.url }, db: handle });
    await failing.close();

    // Коллектор, не отвечающий вовсе: AbortSignal рвёт запрос, исключений нет.
    const hanging = await startCollector({ hang: true });
    try {
      const started = Date.now();
      await Promise.race([
        exportJobMetrics(job({ id: "x3" }), {
          env: { ...ENABLED, OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: hanging.url },
          db: handle,
          timeoutMs: 100
        }),
        // Реальный fetch к висящему серверу иначе держит тест минутами: отказ
        // таймаута должен краснеть за секунды, а не висеть.
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("exportJobMetrics не оборвался по AbortSignal за 5 с")), 5_000).unref()
        )
      ]);
      assert.ok(Date.now() - started < 5_000, "экспорт не висит вечно");
    } finally {
      await hanging.close();
    }
  } finally {
    handle.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("без PI_OTEL_ENABLE экспортёра нет: ни fetch, ни чтения БД", async () => {
  let fetched = 0;
  await exportJobMetrics(job({}), {
    env: {},
    fetchImpl: async () => {
      fetched += 1;
      return { ok: true };
    }
  });
  assert.equal(fetched, 0, "no-op не делает сетевых вызовов");
  // Журнал не открылся — экспорт тихо пропускается, как и весь CLI (recordJobSafely).
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "pi-otel-noop-"));
  const previous = process.env.PI_PLUGIN_DB;
  process.env.PI_PLUGIN_DB = path.join(scratch, "absent", "jobs.db");
  try {
    await exportJobMetrics(job({}), {
      env: { PI_OTEL_ENABLE: "1", OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: "http://127.0.0.1:1/v1/metrics" },
      fetchImpl: async () => {
        fetched += 1;
        return { ok: true };
      },
      timeoutMs: 50
    });
  } finally {
    if (previous === undefined) delete process.env.PI_PLUGIN_DB;
    else process.env.PI_PLUGIN_DB = previous;
    fs.rmSync(scratch, { recursive: true, force: true });
  }
  assert.equal(fetched, 0, "неоткрывшийся журнал выключает экспорт");
});

test("R5: окружение дочернего pi глушит унаследованный PI_OTEL_ENABLE", () => {
  assert.deepEqual(withoutOtel({ PI_OTEL_ENABLE: "1", HOME: "/h" }), { PI_OTEL_ENABLE: "0", HOME: "/h" });
  assert.deepEqual(withoutOtel({ PI_OTEL_ENABLE: "true" }).PI_OTEL_ENABLE, "0");
  // Переменной не было — окружение не перекраивается.
  const untouched = { HOME: "/h" };
  assert.equal(withoutOtel(untouched), untouched);
});
