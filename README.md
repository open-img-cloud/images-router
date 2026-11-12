<p align="center">
  <a href="https://openimages.cloud">
    <img src="https://openimages.cloud/img/og.png" alt="openimages.cloud: signed, boot-tested cloud images for OpenStack and Proxmox" width="720">
  </a>
</p>

<h1 align="center">images-router</h1>

<p align="center">
  <a href="https://github.com/open-img-cloud/images-router/actions/workflows/test.yml"><img alt="Test" src="https://github.com/open-img-cloud/images-router/actions/workflows/test.yml/badge.svg"></a>
  <a href="https://github.com/open-img-cloud/images-router/actions/workflows/deploy.yml"><img alt="Deploy Worker" src="https://github.com/open-img-cloud/images-router/actions/workflows/deploy.yml/badge.svg"></a>
  <a href="LICENSE"><img alt="License GPL-2.0" src="https://img.shields.io/badge/license-GPL--2.0-555"></a>
</p>

<p align="center">
  <a href="https://openimages.cloud"><b>Website</b></a> ·
  <a href="https://images.openimages.cloud/index.json">Registry index</a> ·
  <a href="https://images.openimages.cloud/_stats.json">Download stats</a> ·
  <a href="https://github.com/open-img-cloud/docs/blob/main/docs/architecture.md">Architecture</a> ·
  <a href="https://github.com/open-img-cloud/images-router/issues">Report an issue</a>
</p>

Cloudflare Worker that routes `https://images.openimages.cloud/<os>/...` to
per-distribution public buckets on **Infomaniak Object Storage** (Ceph S3,
Public Cloud project `Images_Storage`). Keeps the public URL pattern stable
while each distribution gets its own bucket (see
[`open-img-cloud/.github` CONVENTIONS.md][conv]).

## What it does

```
GET https://images.openimages.cloud/alpine-linux/3.23.4/foo.qcow2
                                    └────┬─────┘ └─┬──┘ └───┬───┘
                                       bucket   version  object key
                                          │
                                          ▼
GET https://s3.gva2.infomaniak.cloud/<tenant>:alpine-linux/3.23.4/foo.qcow2
```

- First path segment selects the bucket (must be in `ALLOWED_BUCKETS`).
- The rest of the path is the object key.
- Trailing-slash or empty key serves `<key>/index.html`.
- `latest/…` and the bucket-root index are served with
  `Cache-Control: public, max-age=300`. Versioned paths get
  `public, max-age=31536000, immutable`.
- Origin 403/404 are returned as 404: without ListBucket rights, S3 answers
  403 for a missing key on a public bucket.
- `Range`, `If-None-Match`, `If-Modified-Since` and `If-Range` are forwarded,
  so interrupted downloads can resume.
- Responses are cached at the Cloudflare edge. Objects above the plan's cache
  size limit are streamed from the origin on each request.

## Configuration (`wrangler.toml` `[vars]`)

| Variable | Value |
|---|---|
| `ALLOWED_BUCKETS` | Comma-separated bucket names |
| `S3_ORIGIN` | `https://s3.gva2.infomaniak.cloud` |
| `S3_TENANT` | Keystone project id of `Images_Storage` (public, appears in every object URL) |

## Onboarding a new image repo

1. **Create the bucket** in the Infomaniak Public Cloud project
   `Images_Storage`, with the **exact same name** as the repo (`<os>`),
   region `dc4-a`, public access enabled.
2. **Add `<os>`** to `ALLOWED_BUCKETS` in `wrangler.toml`.
3. **Commit + push** to `main`. The `deploy.yml` workflow runs
   `wrangler deploy`.

## Daily scheduler (Cron Trigger)

GitHub disables `schedule:` triggers in public repositories after 60 days
without repository activity, which silently stopped the upstream watchers
in 2026. This Worker also has a Cron Trigger (`[triggers] crons` in
`wrangler.toml`, daily 05:40 UTC) that dispatches, via `workflow_dispatch`
(never disabled for inactivity), every workflow listed in
`SCHEDULED_WORKFLOWS` (`repo:workflow.yml,...`, org `open-img-cloud`):
the `watch.yml` upstream watcher of every image repository and the
`oic-website` daily deploy.

A second, weekly cron (Mondays 04:00 UTC, `WEEKLY_WORKFLOWS`) dispatches the
`.github` catalog audit, which re-validates every published image.

The repos keep their own `schedule:` triggers as a fallback; duplicate runs
are harmless. Code: `src/scheduler.js`. Results are logged per workflow
(`scheduler: <repo>/<workflow> -> 204` on success) in Workers observability.

Required secret, set once:

```sh
npx wrangler secret put GH_DISPATCH_TOKEN
```

A fine-grained personal access token, resource owner `open-img-cloud`,
restricted to the repos in `SCHEDULED_WORKFLOWS`, permission
**Actions: Read and write** only.

## Catalog rebuild hook (`POST /_hooks/catalog`)

`index.json` and `osism/images.yml` come from the oic-website build. A release
moves `latest/` and the digests at once, so the reusable build workflows call
this hook at the end of a release, and the Worker dispatches
`oic-website:deploy.yml` with `GH_DISPATCH_TOKEN`. Clients that check
signatures against `index.json` (oic-sync) then see the new digests within
minutes instead of at the next daily build.

Authentication is a GitHub Actions OIDC token, no shared secret: audience
`https://images.openimages.cloud/_hooks/catalog`, organisation
`open-img-cloud`, workflow running from `main` (`job_workflow_ref`). The
signature is checked against GitHub's JWKS.

```sh
tok=$(curl -fsS -H "Authorization: bearer $ACTIONS_ID_TOKEN_REQUEST_TOKEN" \
  "$ACTIONS_ID_TOKEN_REQUEST_URL&audience=https://images.openimages.cloud/_hooks/catalog" | jq -r .value)
curl -fsS -X POST -H "Authorization: Bearer $tok" https://images.openimages.cloud/_hooks/catalog
```

## Download statistics

Every qcow2 download is counted in the Worker (edge cache hits never reach
the S3 origin, so bucket logs would miss most of them). Code: `src/stats.js`.

**What counts.** A `GET` of `<bucket>/<version|latest>/<file>.qcow2` answered
`200`, or `206` for a `Range` starting at byte 0 (first chunk of a segmented or
resumable download). Resumed transfers (`bytes=N-`, N > 0), parallel chunks,
the `bytes=0-0` probe, `HEAD`, `304`, errors, obvious crawlers and our own CI
(User-Agent containing a `STATS_EXCLUDE_UA` substring) are not counted. A
count means "download started": an aborted transfer still counts once.

**Storage.** One data point per download in the Workers Analytics Engine
dataset `oic_downloads` (binding `DOWNLOADS`, created automatically on the
first write): `blob1` bucket, `blob2` version segment (`latest` for the
alias), `blob3` filename, `blob4` `full` or `range0`, `blob5` country,
`blob6` client family (`curl`, `wget`...), `double1` status, `double2` bytes.
Analytics Engine keeps 3 months of data.

**Public endpoint.** `GET https://images.openimages.cloud/_stats.json`,
cached at the edge for one hour, CORS open:

```json
{
  "generated_at": "2026-11-11T12:00:00.000Z",
  "since": "2026-08-13T00:00:00.000Z",
  "window": "all-time",
  "total": 1234,
  "images": {
    "alpine-linux": {
      "total": 321,
      "versions": { "3.24.1": 120, "latest": 201 },
      "files": { "alpine-3.24.1-bios-x86_64.qcow2": 250, "alpine-3.24.1-uefi-x86_64.qcow2": 71 }
    }
  }
}
```

`versions` follows the URL (`latest` kept apart); `files` is keyed by
filename, which embeds the version, so it merges `/latest/` and
`/<version>/` downloads of the same artifact. The endpoint queries the
dataset through the Analytics SQL binding (`ANALYTICS_SQL`, no API token).

**All-time totals (optional).** Without KV, `window` is `rolling-90d`. With
the `STATS_KV` namespace bound, the daily cron folds every finished UTC day
into KV (idempotent, catches up missed days) and the endpoint adds today's
live counts: `window` becomes `all-time`, starting 90 days before the first
rollup. Setup, once:

```sh
npx wrangler kv namespace create oic-download-stats
# then uncomment the [[kv_namespaces]] block in wrangler.toml with the id
```

Ad hoc queries: Cloudflare dashboard, or the SQL API with a token holding
*Account Analytics: Read*, e.g.
`SELECT blob1, COUNT(*) FROM events.analyticsEngine.oic_downloads WHERE timestamp >= NOW() - INTERVAL '7' DAY GROUP BY blob1`.

## Local development

```sh
npm install
npm test
npx wrangler dev
# then: curl http://localhost:8787/alpaquita-linux/2026.04.14/foo.qcow2
```


## Deploy

`main` branch pushes that touch `src/`, `wrangler.toml`, `package.json`,
or the workflow itself trigger an automatic deploy. To deploy manually:

```sh
npx wrangler login   # one-time
npx wrangler deploy
```

## Required secrets (repo scope)

For the `deploy.yml` workflow to run:

| Secret | Where to get it | Permissions |
|---|---|---|
| `CLOUDFLARE_API_TOKEN` | Cloudflare → My Profile → API Tokens → *Create Token* → custom | `Account → Workers Scripts → Edit` + `Account → Account Settings → Read` (for the account ID lookup) + `Zone → Workers Routes → Edit` on the openimages.cloud zone. |
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare Dashboard → right-side panel → "Account ID" | n/a (just the value) |

These are **repo-level secrets** (Settings → Secrets and variables →
Actions), not org-level: scoped tightly because they have Workers
deploy power.

## Verification

After deploy, smoke test the route:

```sh
curl -I https://images.openimages.cloud/alpaquita-linux/2026.11.11/alpaquita-2026.11.11-glibc-x86_64.qcow2
# expected: 200 + Cache-Control: public, max-age=31536000, immutable

curl -I https://images.openimages.cloud/nonexistent-os/foo
# expected: 404 (not in allowlist)

curl -I https://images.openimages.cloud/alpaquita-linux/latest/MANIFEST.json
# expected: 200 + Cache-Control: public, max-age=300
```

[conv]: https://github.com/open-img-cloud/.github/blob/main/CONVENTIONS.md

## License

[GPL-2.0](LICENSE), like the rest of the open-img-cloud tooling.
