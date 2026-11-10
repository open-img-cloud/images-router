// Cloudflare Worker — routes path-prefixed requests to per-distribution
// buckets on Infomaniak Object Storage (Ceph S3), preserving the public URL
// pattern:
//
//   https://images.openimages.cloud/<os_name>/<version>/<filename>
//   https://images.openimages.cloud/<os_name>/latest/<filename>
//
// Each `<os_name>` is a public bucket of the same name in the Infomaniak
// Public Cloud project. Anonymous reads on Infomaniak require path-style
// URLs prefixed with the Keystone tenant id:
//
//   ${S3_ORIGIN}/${S3_TENANT}:<os_name>/<key>
//
// The first path segment selects the bucket; the remainder is the object key.
//
// Cache policy (set here, at the edge — origin metadata is ignored):
//   - Versioned paths (e.g. /alpine-linux/3.23.4/foo.qcow2) are immutable:
//     `public, max-age=31536000, immutable`.
//   - The `latest/` alias and the bucket-root index are mutable:
//     `public, max-age=300`.
//
// Allowlist (env.ALLOWED_BUCKETS) prevents the Worker from being used as an
// open proxy to arbitrary buckets of the tenant. Add the bucket name there
// when onboarding a new image repo.

const TEXT = { "content-type": "text/plain; charset=utf-8" };
const NOT_FOUND = () => new Response("Not found", { status: 404, headers: TEXT });

// Request headers forwarded to the origin (download resume, revalidation).
const FORWARD_REQUEST_HEADERS = ["range", "if-none-match", "if-modified-since", "if-range"];

// Response headers copied back from the origin.
const FORWARD_RESPONSE_HEADERS = [
  "content-type",
  "content-length",
  "content-range",
  "accept-ranges",
  "etag",
  "last-modified",
];

const IMMUTABLE_TTL = 31536000;
const LATEST_TTL = 300;

export default {
  async fetch(request, env) {
    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response("Method not allowed", { status: 405, headers: { allow: "GET, HEAD", ...TEXT } });
    }

    const url = new URL(request.url);
    // Preserve the trailing-slash signal BEFORE filtering empty segments —
    // `/foo/bar/`.split('/').filter(Boolean) drops it, and we'd never serve
    // index.html for directory requests.
    const isDirRequest = url.pathname === "/" || url.pathname.endsWith("/");
    const segments = url.pathname.split("/").filter(Boolean);

    if (segments.length === 0) {
      return new Response("openimages.cloud · path: /<os_name>/<version>/<filename>\n", {
        headers: { ...TEXT, "cache-control": "public, max-age=300" },
      });
    }

    // Reject traversal attempts outright; S3 keys never contain them here.
    if (segments.some((s) => s === "." || s === "..")) {
      return NOT_FOUND();
    }

    const bucketName = segments[0];
    const keyTail = segments.slice(1).join("/");

    const allowed = (env.ALLOWED_BUCKETS || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (!allowed.includes(bucketName)) {
      return NOT_FOUND();
    }

    if (!env.S3_ORIGIN || !env.S3_TENANT) {
      return new Response("Origin not configured (S3_ORIGIN / S3_TENANT)", { status: 500, headers: TEXT });
    }

    // Bucket-root or directory-style request → serve index.html.
    let key = keyTail;
    if (isDirRequest) {
      key = key ? `${key}/index.html` : "index.html";
    }

    // Mutable: the latest/ alias and the bucket-root index (lists versions).
    const isMutable = keyTail === "" || keyTail === "latest" || keyTail.startsWith("latest/");
    const ttl = isMutable ? LATEST_TTL : IMMUTABLE_TTL;

    // url.pathname is already percent-encoded: decode each segment before
    // re-encoding so "a%20b" is not sent upstream as "a%2520b".
    let encodedKey;
    try {
      encodedKey = key.split("/").map((s) => encodeURIComponent(decodeURIComponent(s))).join("/");
    } catch {
      return NOT_FOUND();
    }
    const originUrl = `${env.S3_ORIGIN.replace(/\/+$/, "")}/${env.S3_TENANT}:${bucketName}/${encodedKey}`;

    const originHeaders = new Headers();
    for (const h of FORWARD_REQUEST_HEADERS) {
      const v = request.headers.get(h);
      if (v) originHeaders.set(h, v);
    }

    const origin = await fetch(originUrl, {
      method: request.method,
      headers: originHeaders,
      cf: {
        cacheEverything: true,
        // Only cache successful responses; errors are retried at origin.
        cacheTtlByStatus: { "200-299": ttl, "304": ttl, "400-599": 0 },
      },
    });

    // Without ListBucket rights, S3 answers 403 for a missing key on a
    // public bucket. Surface both as a plain 404.
    if (origin.status === 403 || origin.status === 404) {
      return NOT_FOUND();
    }
    if (origin.status >= 500) {
      return new Response("Upstream storage error", { status: 502, headers: TEXT });
    }

    const headers = new Headers();
    for (const h of FORWARD_RESPONSE_HEADERS) {
      const v = origin.headers.get(h);
      if (v) headers.set(h, v);
    }
    headers.set("cache-control", isMutable ? `public, max-age=${LATEST_TTL}` : `public, max-age=${IMMUTABLE_TTL}, immutable`);

    return new Response(request.method === "HEAD" ? null : origin.body, {
      status: origin.status,
      headers,
    });
  },
};
