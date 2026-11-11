import { test } from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.js";
import { buildStats, computeStats, firstRange, mergeRows, rollup, shouldCount } from "../src/stats.js";

const base = { method: "GET", keyTail: "3.24.1/alpine-3.24.1-bios-x86_64.qcow2", status: 200, userAgent: "curl/8.5.0" };

test("firstRange parses the first range", () => {
  assert.deepEqual(firstRange("bytes=0-"), { start: 0, end: null });
  assert.deepEqual(firstRange("bytes=100-199,300-"), { start: 100, end: 199 });
  assert.deepEqual(firstRange("bytes=-500"), { start: null, end: 500 });
  assert.equal(firstRange("items=1-2"), null);
});

test("shouldCount: full downloads and first range chunk only", () => {
  assert.equal(shouldCount(base), "full");
  assert.equal(shouldCount({ ...base, keyTail: "latest/alpine-3.24.1-bios-x86_64.qcow2" }), "full");
  assert.equal(shouldCount({ ...base, method: "HEAD" }), null);
  assert.equal(shouldCount({ ...base, status: 304 }), null);
  assert.equal(shouldCount({ ...base, status: 404 }), null);
  assert.equal(shouldCount({ ...base, status: 206, range: "bytes=0-" }), "range0");
  assert.equal(shouldCount({ ...base, status: 206, range: "bytes=0-1048575" }), "range0");
  assert.equal(shouldCount({ ...base, status: 206, range: "bytes=1048576-" }), null);
  assert.equal(shouldCount({ ...base, status: 206, range: "bytes=0-0" }), null);
  assert.equal(shouldCount({ ...base, status: 206, range: "bytes=-1000" }), null);
  assert.equal(shouldCount({ ...base, status: 206 }), null);
});

test("shouldCount: only qcow2 objects under a version", () => {
  assert.equal(shouldCount({ ...base, keyTail: "3.24.1/alpine-3.24.1-bios-x86_64.qcow2.bundle" }), null);
  assert.equal(shouldCount({ ...base, keyTail: "3.24.1/MANIFEST.json" }), null);
  assert.equal(shouldCount({ ...base, keyTail: "foo.qcow2" }), null);
});

test("shouldCount: bots and our own CI are excluded", () => {
  assert.equal(shouldCount({ ...base, userAgent: "Mozilla/5.0 (compatible; Googlebot/2.1)" }), null);
  assert.equal(shouldCount({ ...base, userAgent: "openimages-catalog-audit" }), null);
  assert.equal(shouldCount({ ...base, userAgent: "oic-ci/1" }), null);
  assert.equal(shouldCount({ ...base, userAgent: "curl/8", excludeUa: "curl" }), null);
  assert.equal(shouldCount({ ...base, userAgent: "" }), "full");
});

test("mergeRows and buildStats aggregate per image, version and file", () => {
  const rows = mergeRows(
    [["alpine-linux", "3.24.1", "a-3.24.1.qcow2", 2]],
    [
      ["alpine-linux", "3.24.1", "a-3.24.1.qcow2", 3],
      ["alpine-linux", "latest", "a-3.24.1.qcow2", 4],
      ["nixos", "26.05", "n.qcow2", 1],
    ],
  );
  const s = buildStats(rows, { window: "x" });
  assert.equal(s.total, 10);
  assert.equal(s.window, "x");
  assert.deepEqual(s.images["alpine-linux"], {
    total: 9,
    versions: { "3.24.1": 5, latest: 4 },
    files: { "a-3.24.1.qcow2": 9 },
  });
  assert.equal(s.images.nixos.total, 1);
});

function fakeSql(rowsFor) {
  const calls = [];
  return {
    calls,
    async query({ query, params }) {
      calls.push({ query, params });
      return { data: rowsFor(params), rows: 0 };
    },
  };
}

function fakeKv() {
  const store = new Map();
  return {
    store,
    async get(k, type) {
      const v = store.get(k);
      return v == null ? null : type === "json" ? JSON.parse(v) : v;
    },
    async put(k, v) {
      store.set(k, v);
    },
  };
}

test("rollup folds finished days into KV and is idempotent", async () => {
  const sql = fakeSql(() => [{ bucket: "nixos", version: "26.05", filename: "n.qcow2", downloads: "3" }]);
  const env = { ANALYTICS_SQL: sql, STATS_KV: fakeKv() };
  const now = new Date("2026-11-11T05:40:00Z");
  const first = await rollup(env, now);
  assert.equal(first.through, "2026-11-11T00:00:00.000Z");
  assert.equal(first.since, "2026-08-13T00:00:00.000Z");
  assert.deepEqual(first.rows, [["nixos", "26.05", "n.qcow2", 3]]);
  assert.match(sql.calls[0].query, /events\.analyticsEngine\.oic_downloads/);

  await rollup(env, new Date("2026-11-11T23:00:00Z")); // same day: nothing to do
  assert.equal(sql.calls.length, 1);

  const next = await rollup(env, new Date("2026-11-12T05:40:00Z"));
  assert.equal(sql.calls[1].params.from, "2026-11-11T00:00:00.000Z");
  assert.deepEqual(next.rows, [["nixos", "26.05", "n.qcow2", 6]]);
  assert.equal(next.since, first.since);
});

test("computeStats: KV totals plus live data, or a rolling window without KV", async () => {
  const sql = fakeSql(() => [{ bucket: "nixos", version: "latest", filename: "n.qcow2", downloads: 2 }]);
  const kv = fakeKv();
  kv.store.set(
    "rollup-v1",
    JSON.stringify({ since: "2026-08-13T00:00:00.000Z", through: "2026-11-11T00:00:00.000Z", rows: [["nixos", "26.05", "n.qcow2", 5]] }),
  );
  const now = new Date("2026-11-11T12:00:00Z");
  const all = await computeStats({ ANALYTICS_SQL: sql, STATS_KV: kv }, now);
  assert.equal(all.window, "all-time");
  assert.equal(all.total, 7);
  assert.equal(sql.calls[0].params.from, "2026-11-11T00:00:00.000Z");

  const rolling = await computeStats({ ANALYTICS_SQL: sql }, now);
  assert.equal(rolling.window, "rolling-90d");
  assert.equal(rolling.total, 2);
});

// End-to-end through the Worker with a mocked origin.
async function withOrigin(status, fn) {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(status === 304 ? null : "x", { status, headers: { "content-length": "1", etag: '"e"' } });
  try {
    return await fn();
  } finally {
    globalThis.fetch = realFetch;
  }
}

function envWithPoints() {
  const points = [];
  return {
    points,
    ALLOWED_BUCKETS: "alpine-linux",
    S3_ORIGIN: "https://s3.example",
    S3_TENANT: "t",
    DOWNLOADS: { writeDataPoint: (p) => points.push(p) },
  };
}

const URL_QCOW = "https://images.openimages.cloud/alpine-linux/3.24.1/alpine-3.24.1-bios-x86_64.qcow2";

test("worker records a counted download and keeps response headers", async () => {
  const env = envWithPoints();
  const res = await withOrigin(200, () =>
    worker.fetch(new Request(URL_QCOW, { headers: { "user-agent": "curl/8.5.0" } }), env, {}),
  );
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("cache-control"), "public, max-age=31536000, immutable");
  assert.equal(env.points.length, 1);
  assert.deepEqual(env.points[0].blobs.slice(0, 4), ["alpine-linux", "3.24.1", "alpine-3.24.1-bios-x86_64.qcow2", "full"]);
  assert.equal(env.points[0].blobs[5], "curl");
});

test("worker does not record HEAD, resumed ranges or missing objects", async () => {
  const env = envWithPoints();
  await withOrigin(200, () => worker.fetch(new Request(URL_QCOW, { method: "HEAD" }), env, {}));
  await withOrigin(206, () => worker.fetch(new Request(URL_QCOW, { headers: { range: "bytes=500-" } }), env, {}));
  const missing = await withOrigin(404, () => worker.fetch(new Request(URL_QCOW), env, {}));
  assert.equal(missing.status, 404);
  assert.equal(env.points.length, 0);
});

test("worker works without the Analytics Engine binding", async () => {
  const env = envWithPoints();
  delete env.DOWNLOADS;
  const res = await withOrigin(200, () => worker.fetch(new Request(URL_QCOW), env, {}));
  assert.equal(res.status, 200);
});

test("/_stats.json serves JSON with CORS, 503 when not configured", async () => {
  const off = await worker.fetch(new Request("https://images.openimages.cloud/_stats.json"), {}, {});
  assert.equal(off.status, 503);

  const sql = fakeSql(() => [{ bucket: "alpine-linux", version: "latest", filename: "a.qcow2", downloads: 4 }]);
  const res = await worker.fetch(new Request("https://images.openimages.cloud/_stats.json"), { ANALYTICS_SQL: sql }, {});
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("access-control-allow-origin"), "*");
  assert.equal(res.headers.get("cache-control"), "public, max-age=3600");
  const body = await res.json();
  assert.equal(body.images["alpine-linux"].total, 4);

  const broken = { query: async () => { throw new Error("boom"); } };
  const err = await worker.fetch(new Request("https://images.openimages.cloud/_stats.json"), { ANALYTICS_SQL: broken }, {});
  assert.equal(err.status, 503);
});
