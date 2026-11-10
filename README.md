# images-router

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

## Local development

```sh
npm install
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
| `CLOUDFLARE_API_TOKEN` | Cloudflare → My Profile → API Tokens → *Create Token* → custom | `Account → Workers Scripts → Edit` + `Account → Account Settings → Read` (for the account ID lookup) + `Zone → Workers Routes → Edit` on the openimages.cloud zone. Optionally `Account → Workers R2 Storage → Read` if you want the Worker to enumerate buckets in dev. |
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare Dashboard → right-side panel → "Account ID" | n/a (just the value) |

These are **repo-level secrets** (Settings → Secrets and variables →
Actions), not org-level — scoped tightly because they have Workers
deploy power.

## Verification

After deploy, smoke test the route:

```sh
curl -I https://images.openimages.cloud/alpaquita-linux/2026.04.14/alpaquita-2026.04.14-glibc-x86_64.qcow2
# expected: 200 + Cache-Control: public, max-age=31536000, immutable

curl -I https://images.openimages.cloud/nonexistent-os/foo
# expected: 404 (not in allowlist)

curl -I https://images.openimages.cloud/alpaquita-linux/latest/MANIFEST.json
# expected: 200 + Cache-Control: public, max-age=300
```

[conv]: https://github.com/open-img-cloud/.github/blob/main/CONVENTIONS.md
