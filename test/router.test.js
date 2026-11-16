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

test("latest/ is served from the version named by latest.json", async () => {
  const { res, calls } = await withFetch(
    (req) => {
      const url = typeof req === "string" ? req : req.url;
      if (url.endsWith("/latest.json")) return Response.json({ version: "13-2" });
      return new Response("qcow2", { status: 200, headers: { "content-length": "5" } });
    },
    () => worker.fetch(new Request("https://images.openimages.cloud/debian-13/latest/debian-13-2.qcow2"), env, {}),
  );
  assert.deepEqual(calls, ["https://s3.example/t:debian-13/latest.json", "https://s3.example/t:debian-13/13-2/debian-13-2.qcow2"]);
  assert.equal(res.status, 200);
  assert.equal(await res.text(), "qcow2");
  // The alias keeps its short client cache lifetime.
  assert.equal(res.headers.get("cache-control"), "public, max-age=300");
});

test("latest/ directory listing is the index.html of the current version", async () => {
  const { calls } = await withFetch(
    (req) => {
      const url = typeof req === "string" ? req : req.url;
      if (url.endsWith("/latest.json")) return Response.json({ version: "13-2" });
      return new Response("<html>", { status: 200 });
    },
    () => worker.fetch(new Request("https://images.openimages.cloud/debian-13/latest/"), env, {}),
  );
  assert.equal(calls[1], "https://s3.example/t:debian-13/13-2/index.html");
});

test("without a valid pointer, latest/ falls back to the physical directory", async () => {
  for (const pointer of [
    () => new Response("", { status: 404 }),
    () => new Response("not json", { status: 200 }),
    () => Response.json({ version: "../etc" }),
    () => Response.json({ version: "a/b" }),
    () => Response.json({}),
  ]) {
    const { res, calls } = await withFetch(
      (req) => {
        const url = typeof req === "string" ? req : req.url;
        return url.endsWith("/latest.json") ? pointer() : new Response("x", { status: 200 });
      },
      () => worker.fetch(new Request("https://images.openimages.cloud/debian-13/latest/MANIFEST.json"), env, {}),
    );
    assert.equal(res.status, 200);
    assert.equal(calls[1], "https://s3.example/t:debian-13/latest/MANIFEST.json");
  }
});

test("versioned paths never read the pointer", async () => {
  const { calls } = await withFetch(
    () => new Response("x", { status: 200 }),
    () => worker.fetch(new Request("https://images.openimages.cloud/debian-13/13-1/MANIFEST.json"), env, {}),
  );
  assert.deepEqual(calls, ["https://s3.example/t:debian-13/13-1/MANIFEST.json"]);
});
