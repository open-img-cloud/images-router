// Cloudflare Worker — routes path-prefixed requests to per-distribution R2
// buckets, preserving the public URL pattern:
//
//   https://images.openimages.cloud/<os_name>/<version>/<filename>
//   https://images.openimages.cloud/<os_name>/latest/<filename>
//
// Each `<os_name>` corresponds to an R2 bucket of the same name, bound to
// this Worker via `[[r2_buckets]]` in wrangler.toml. The first path
// segment selects the bucket; the remainder is the object key.
//
// Cache policy:
//   - Versioned paths (e.g. /alpaquita-linux/2026.04.14/foo.qcow2) are
//     immutable: `public, max-age=31536000, immutable`.
//   - The `latest/` alias is mutable: `public, max-age=300`.
//
// Allowlist (env.ALLOWED_BUCKETS) prevents enumeration of unbound bucket
// names. Update both ALLOWED_BUCKETS and the [[r2_buckets]] block when
// onboarding a new image repo.

const NOT_FOUND = (msg = "Not found") =>
  new Response(msg, {
    status: 404,
    headers: { "content-type": "text/plain; charset=utf-8" },
  });

export default {
  async fetch(request, env) {
    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response("Method not allowed", { status: 405, headers: { allow: "GET, HEAD" } });
    }

    const url = new URL(request.url);
    // Preserve the trailing-slash signal BEFORE filtering empty segments —
    // `/foo/bar/`.split('/').filter(Boolean) === ['foo', 'bar'] drops the
    // trailing slash, so we'd never serve index.html for directory requests.
    const isDirRequest = url.pathname === "/" || url.pathname.endsWith("/");
    const segments = url.pathname.split("/").filter(Boolean);

    // Root → static landing (or 404 — keep simple for now).
    if (segments.length === 0) {
      return new Response(
        "open-images.cloud · path: /<os_name>/<version>/<filename>\n",
        { headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "public, max-age=300" } },
      );
    }

    const bucketName = segments[0];
    const keyTail = segments.slice(1).join("/");

    // Allowlist guards against enumeration / typos pointing at unbound buckets.
    const allowed = (env.ALLOWED_BUCKETS || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (!allowed.includes(bucketName)) {
      return NOT_FOUND();
    }

    // Convention: binding name = uppercase(os_name with - → _).
    const bindingName = bucketName.replace(/-/g, "_").toUpperCase();
    const bucket = env[bindingName];
    if (!bucket) {
      // Misconfiguration — the bucket is in the allowlist but no binding.
      // Surface as 500 so it shows up in Cloudflare logs / dashboards.
      return new Response(`Bucket binding ${bindingName} not configured`, {
        status: 500,
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    }

    // Bucket-root or directory-style request → serve index.html.
    // - "/<bucket>/"          (keyTail empty + isDirRequest) → "index.html"
    // - "/<bucket>/<ver>/"    (keyTail="<ver>" + isDirRequest) → "<ver>/index.html"
    let key = keyTail;
    if (isDirRequest) {
      key = key ? `${key}/index.html` : "index.html";
    }

    const obj = request.method === "HEAD" ? await bucket.head(key) : await bucket.get(key);
    if (!obj) {
      return NOT_FOUND();
    }

    const headers = new Headers();
    obj.writeHttpMetadata(headers);
    headers.set("etag", obj.httpEtag);
    // R2's writeHttpMetadata doesn't include Content-Length; surface it
    // explicitly from the R2 object's `size` so browsers/CLI clients can
    // render download progress and so HEAD responses are useful.
    if (typeof obj.size === "number") {
      headers.set("content-length", obj.size.toString());
    }

    // Cache-Control: latest/ is short-lived, everything else is immutable.
    if (
      keyTail === "latest" ||
      keyTail === "latest/" ||
      keyTail.startsWith("latest/")
    ) {
      headers.set("cache-control", "public, max-age=300");
    } else {
      headers.set("cache-control", "public, max-age=31536000, immutable");
    }

    return new Response(request.method === "HEAD" ? null : obj.body, { headers });
  },
};
