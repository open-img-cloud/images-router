// Download statistics.
//
// Write side: every counted qcow2 download writes one data point to the
// Workers Analytics Engine dataset bound as env.DOWNLOADS. Counting happens
// here, in the Worker, because edge cache hits never reach the S3 origin.
//
// Read side: GET /_stats.json aggregates the dataset through the Analytics
// SQL binding (env.ANALYTICS_SQL, no API token needed), cached at the edge
// for an hour. Analytics Engine keeps 3 months of data: when the optional
// KV namespace env.STATS_KV is bound, the cron rolls every finished UTC day
// up into KV so totals keep growing past that horizon ("all-time").
//
// What counts as one download (shouldCount):
//   - GET (not HEAD) of a key ending in ".qcow2" under <bucket>/<version>/;
//   - answered 200, or 206 for a Range starting at byte 0 (first chunk);
//     resumed (bytes=N- with N > 0) and parallel chunk requests are ignored,
//     as are 304 revalidations and the "bytes=0-0" size probe;
//   - not from an obvious crawler, nor from our own CI (STATS_EXCLUDE_UA).
// A count means "download started": an aborted transfer is still counted.

export const STATS_PATH = "/_stats.json";
export const STATS_TTL = 3600;
const RETENTION_DAYS = 90;
const DAY_MS = 86400 * 1000;
const ROLLUP_KEY = "rollup-v1";
const DEFAULT_DATASET = "oic_downloads";
const DEFAULT_EXCLUDE_UA = "openimages-,oic-ci";
const BOT_UA = /bot\b|crawl|spider|slurp|facebookexternalhit|headless/i;

/** "bytes=A-B[,...]" -> { start, end } of the first range, or null. */
export function firstRange(header) {
  const m = /^\s*bytes\s*=\s*(\d*)\s*-\s*(\d*)/i.exec(header || "");
  if (!m) return null;
  return {
    start: m[1] === "" ? null : Number(m[1]),
    end: m[2] === "" ? null : Number(m[2]),
  };
}

/** Returns "full" | "range0" when the request is a countable download, else null. */
export function shouldCount({ method, keyTail, status, range, userAgent, excludeUa }) {
  if (method !== "GET") return null;
  const parts = (keyTail || "").split("/");
  if (parts.length < 2 || !parts[0] || !parts.at(-1).endsWith(".qcow2")) return null;
  if (status !== 200 && status !== 206) return null;

  const ua = userAgent || "";
  if (BOT_UA.test(ua)) return null;
  const excluded = (excludeUa ?? DEFAULT_EXCLUDE_UA)
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  if (excluded.some((s) => ua.toLowerCase().includes(s))) return null;

  if (!range) return status === 200 ? "full" : null;
  const r = firstRange(range);
  // Unparsable Range: S3 ignores it and answers 200 with the full body.
  if (!r) return status === 200 ? "full" : null;
  if (r.start !== 0) return null; // resume, parallel chunk or suffix range
  if (r.end === 0) return null; // 1-byte size probe
  return "range0";
}

/** Short client family for the data point (curl, wget, python-requests...). */
export function clientFamily(userAgent) {
  const m = /^([A-Za-z][\w.-]*)/.exec(userAgent || "");
  return m ? m[1].toLowerCase().slice(0, 32) : "unknown";
}

/** Records one download. Never throws: statistics must not break downloads. */
export function recordDownload(env, { bucket, keyTail, kind, request, status, bytes }) {
  if (!env.DOWNLOADS || !kind) return;
  try {
    const parts = keyTail.split("/");
    env.DOWNLOADS.writeDataPoint({
      indexes: [bucket],
      blobs: [
        bucket,
        parts[0], // version path segment, "latest" for the alias
        parts.at(-1), // filename
        kind,
        request.cf?.country || "",
        clientFamily(request.headers.get("user-agent")),
      ],
      doubles: [status, Number(bytes) || 0],
    });
  } catch (err) {
    console.error(`stats: writeDataPoint failed: ${err}`);
  }
}

function datasetName(env) {
  const name = env.STATS_DATASET || DEFAULT_DATASET;
  if (!/^[A-Za-z0-9_]+$/.test(name)) throw new Error(`invalid STATS_DATASET ${name}`);
  return name;
}

/** Downloads per (bucket, version, filename) in [from, to). */
export async function queryRows(env, from, to) {
  const query = `
    SELECT blob1 AS bucket, blob2 AS version, blob3 AS filename, COUNT(*) AS downloads
    FROM events.analyticsEngine.${datasetName(env)}
    WHERE timestamp >= $from AND timestamp < $to
    GROUP BY blob1, blob2, blob3`;
  const result = await env.ANALYTICS_SQL.query({
    query,
    params: { from: from.toISOString(), to: to.toISOString() },
  });
  return (result?.data ?? [])
    .map((r) => [String(r.bucket), String(r.version), String(r.filename), Math.round(Number(r.downloads) || 0)])
    .filter((r) => r[0] && r[3] > 0);
}

/** Adds row counts keyed by (bucket, version, filename). */
export function mergeRows(...lists) {
  const acc = new Map();
  for (const rows of lists) {
    for (const [b, v, f, n] of rows || []) {
      const k = JSON.stringify([b, v, f]);
      acc.set(k, (acc.get(k) || 0) + n);
    }
  }
  return [...acc].map(([k, n]) => [...JSON.parse(k), n]);
}

/**
 * Public JSON shape:
 *   images.<bucket>.total     all downloads of the image
 *   images.<bucket>.versions  by URL version segment ("latest" kept apart)
 *   images.<bucket>.files     by filename; filenames embed the version, so
 *                             this merges /latest/ and /<version>/ downloads
 */
export function buildStats(rows, meta) {
  const images = {};
  let total = 0;
  for (const [b, v, f, n] of rows) {
    const img = (images[b] ??= { total: 0, versions: {}, files: {} });
    img.total += n;
    img.versions[v] = (img.versions[v] || 0) + n;
    img.files[f] = (img.files[f] || 0) + n;
    total += n;
  }
  return { ...meta, total, images };
}

function startOfUtcDay(d) {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

/** Rolls finished UTC days into KV. Idempotent; catches up missed days. */
export async function rollup(env, now = new Date()) {
  if (!env.STATS_KV || !env.ANALYTICS_SQL) return null;
  const state = await env.STATS_KV.get(ROLLUP_KEY, "json");
  const end = startOfUtcDay(now);
  const start = state?.through ? new Date(state.through) : new Date(end.getTime() - RETENTION_DAYS * DAY_MS);
  if (start >= end) return state;
  const rows = await queryRows(env, start, end);
  const next = {
    since: state?.since ?? start.toISOString(),
    through: end.toISOString(),
    rows: mergeRows(state?.rows, rows),
  };
  await env.STATS_KV.put(ROLLUP_KEY, JSON.stringify(next));
  console.log(`stats: rolled up ${start.toISOString()} -> ${end.toISOString()} (${rows.length} rows)`);
  return next;
}

export async function computeStats(env, now = new Date()) {
  const state = env.STATS_KV ? await env.STATS_KV.get(ROLLUP_KEY, "json") : null;
  const from = state?.through ? new Date(state.through) : new Date(now.getTime() - RETENTION_DAYS * DAY_MS);
  const live = from < now ? await queryRows(env, from, now) : [];
  return buildStats(mergeRows(state?.rows, live), {
    generated_at: now.toISOString(),
    since: state?.since ?? from.toISOString(),
    window: state ? "all-time" : `rolling-${RETENTION_DAYS}d`,
  });
}

const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "access-control-allow-origin": "*",
};

/** GET /_stats.json, cached at the edge for STATS_TTL seconds. */
export async function handleStats(request, env, ctx) {
  const cache = globalThis.caches?.default;
  const cacheKey = new Request(new URL(STATS_PATH, request.url).toString(), { method: "GET" });
  const cached = cache ? await cache.match(cacheKey) : null;
  let response = cached;
  if (!response) {
    if (!env.ANALYTICS_SQL) {
      response = new Response(JSON.stringify({ error: "statistics not configured" }), {
        status: 503,
        headers: { ...JSON_HEADERS, "cache-control": "public, max-age=60" },
      });
    } else {
      try {
        const body = JSON.stringify(await computeStats(env));
        response = new Response(body, {
          headers: { ...JSON_HEADERS, "cache-control": `public, max-age=${STATS_TTL}` },
        });
        if (cache) ctx?.waitUntil(cache.put(cacheKey, response.clone()));
      } catch (err) {
        console.error(`stats: query failed: ${err}`);
        response = new Response(JSON.stringify({ error: "statistics unavailable" }), {
          status: 503,
          headers: { ...JSON_HEADERS, "cache-control": "public, max-age=60" },
        });
      }
    }
  }
  return request.method === "HEAD" ? new Response(null, response) : response;
}
