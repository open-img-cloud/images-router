import { test } from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.js";

const env = { ALLOWED_BUCKETS: "debian-13", S3_ORIGIN: "https://s3.example", S3_TENANT: "t" };

async function withFetch(impl, fn) {
  const realFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (req, init) => {
    calls.push(typeof req === "string" ? req : req.url);
    return impl(req, init);
  };
  try {
    return { res: await fn(), calls };
  } finally {
    globalThis.fetch = realFetch;
  }
}

test("bucket-root files such as versions.json are cached as mutable", async () => {
  const { res, calls } = await withFetch(
    () => new Response("{}", { status: 200, headers: { "content-type": "application/json" } }),
    () => worker.fetch(new Request("https://images.openimages.cloud/debian-13/versions.json"), env, {}),
  );
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("cache-control"), "public, max-age=300");
  assert.equal(calls[0], "https://s3.example/t:debian-13/versions.json");
});

test("versioned objects stay immutable", async () => {
  const { res } = await withFetch(
    () => new Response("x", { status: 200 }),
    () => worker.fetch(new Request("https://images.openimages.cloud/debian-13/13-1/MANIFEST.json"), env, {}),
  );
  assert.equal(res.headers.get("cache-control"), "public, max-age=31536000, immutable");
});

test("/index.json and /osism/images.yml are relayed from the site with CORS", async () => {
  for (const [path, type] of [["/index.json", "application/json"], ["/osism/images.yml", "application/yaml"]]) {
    const { res, calls } = await withFetch(
      () => new Response("data", { status: 200, headers: { etag: '"v1"' } }),
      () => worker.fetch(new Request(`https://images.openimages.cloud${path}`), {}, { waitUntil() {} }),
    );
    assert.equal(calls[0], `https://openimages.cloud${path}`);
    assert.equal(res.status, 200);
    assert.ok(res.headers.get("content-type").startsWith(type));
    assert.equal(res.headers.get("access-control-allow-origin"), "*");
    assert.equal(await res.text(), "data");
  }
});

test("catalog relay answers 304 on a matching ETag and 404 when the site has no file", async () => {
  const { res } = await withFetch(
    () => new Response("data", { status: 200, headers: { etag: '"v1"' } }),
    () =>
      worker.fetch(new Request("https://images.openimages.cloud/index.json", { headers: { "if-none-match": '"v1"' } }), {}, {
        waitUntil() {},
      }),
  );
  assert.equal(res.status, 304);
  const { res: missing } = await withFetch(
    () => new Response("no", { status: 404 }),
    () => worker.fetch(new Request("https://images.openimages.cloud/osism/images.yml"), {}, { waitUntil() {} }),
  );
  assert.equal(missing.status, 404);
});

test("the bucket root redirects to latest/ when it has no index.html", async () => {
  const { res } = await withFetch(
    () => new Response("", { status: 403 }),
    () => worker.fetch(new Request("https://images.openimages.cloud/debian-13/"), env, {}),
  );
  assert.equal(res.status, 302);
  assert.equal(res.headers.get("location"), "/debian-13/latest/");
});

test("a missing file below the root stays a 404", async () => {
  const { res } = await withFetch(
    () => new Response("", { status: 404 }),
    () => worker.fetch(new Request("https://images.openimages.cloud/debian-13/1.0/nope.qcow2"), env, {}),
  );
  assert.equal(res.status, 404);
});
