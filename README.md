# images-router

Cloudflare Worker that routes `https://images.openimages.cloud/<os>/...` to
per-distribution R2 buckets. Keeps the public URL pattern stable while
each distribution gets its own bucket (see
[`open-img-cloud/.github` CONVENTIONS.md][conv]).

## What it does

```
GET https://images.openimages.cloud/alpaquita-linux/2026.04.14/foo.qcow2
                                    └─────┬─────┘ └────┬────┘ └───┬───┘
                                       bucket       version    object key
                                          │
                                          ▼
                                   R2 bucket "alpaquita-linux"
                                   key: "2026.04.14/foo.qcow2"
```

- First path segment selects an R2 bucket (must be in the allowlist
  *and* have a matching `[[r2_buckets]]` binding in `wrangler.toml`).
- The rest of the path is the object key.
- Trailing-slash or empty key serves `<key>/index.html`.
- `latest/<key>` is served with `Cache-Control: public, max-age=300`.
  Versioned paths get `public, max-age=31536000, immutable`.

## Onboarding a new image repo

When a new `open-img-cloud/<os>` image repo is added:

1. **Create the R2 bucket** on Cloudflare with the **exact same name**
   (`<os>`).
2. **Edit `wrangler.toml`**:
   - Add `<os>` to the `ALLOWED_BUCKETS` comma-separated list under
     `[vars]`.
   - Uncomment (or add) the matching `[[r2_buckets]]` block. Binding
     name = uppercase(`<os>`) with `-` replaced by `_`. Example:
     `alpaquita-linux` → `ALPAQUITA_LINUX`.
3. **Commit + push** to `main`. The `deploy.yml` workflow runs
   `wrangler deploy` and the new bucket starts serving immediately.

## Local development

```sh
npm install
npx wrangler dev
# then: curl http://localhost:8787/alpaquita-linux/2026.04.14/foo.qcow2
```

`wrangler dev` connects to remote R2 by default (proxies through
Cloudflare). To dev fully offline, see the wrangler docs on
`--remote=false` + `r2_buckets` simulators.

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
