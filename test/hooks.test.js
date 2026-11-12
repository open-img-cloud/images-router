import { test } from "node:test";
import assert from "node:assert/strict";
import { HOOK_AUDIENCE, handleCatalogHook, verifyGithubOidc } from "../src/hooks.js";

const NOW = 1_800_000_000;

function b64url(bytes) {
  return Buffer.from(bytes).toString("base64").replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
}

const keyPair = await crypto.subtle.generateKey(
  { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
  true,
  ["sign", "verify"],
);
const publicJwk = { ...(await crypto.subtle.exportKey("jwk", keyPair.publicKey)), kid: "k1" };

async function sign(claims, { kid = "k1", key = keyPair.privateKey } = {}) {
  const enc = (o) => b64url(new TextEncoder().encode(JSON.stringify(o)));
  const head = `${enc({ alg: "RS256", typ: "JWT", kid })}.${enc(claims)}`;
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(head));
  return `${head}.${b64url(new Uint8Array(sig))}`;
}

const goodClaims = {
  iss: "https://token.actions.githubusercontent.com",
  aud: HOOK_AUDIENCE,
  exp: NOW + 300,
  nbf: NOW - 10,
  repository: "open-img-cloud/debian-13",
  repository_owner: "open-img-cloud",
  job_workflow_ref: "open-img-cloud/.github/.github/workflows/build-libguestfs-image.yml@refs/heads/main",
};

function fakeFetch(calls = []) {
  return async (url, init) => {
    calls.push({ url: String(url), init });
    if (String(url).endsWith("/.well-known/jwks")) {
      return new Response(JSON.stringify({ keys: [publicJwk] }), { status: 200 });
    }
    if (String(url).includes("/actions/workflows/")) return new Response(null, { status: 204 });
    return new Response("not found", { status: 404 });
  };
}

test("a valid organisation token is accepted", async () => {
  const claims = await verifyGithubOidc(await sign(goodClaims), { fetchImpl: fakeFetch(), now: NOW });
  assert.equal(claims.repository, "open-img-cloud/debian-13");
});

test("a repo-local workflow on main is accepted (sync-latest)", async () => {
  const token = await sign({
    ...goodClaims,
    job_workflow_ref: "open-img-cloud/debian-13/.github/workflows/sync-latest.yml@refs/heads/main",
  });
  await verifyGithubOidc(token, { fetchImpl: fakeFetch(), now: NOW });
});

for (const [why, patch, message] of [
  ["another organisation", { repository_owner: "evil", repository: "evil/x" }, /organisation/],
  ["another audience", { aud: "sigstore" }, /audience/],
  ["another issuer", { iss: "https://example.com" }, /issuer/],
  ["an expired token", { exp: NOW - 3600 }, /expired/],
  ["a feature branch", { job_workflow_ref: goodClaims.job_workflow_ref.replace("main", "feat/x") }, /workflow/],
]) {
  test(`${why} is refused`, async () => {
    const token = await sign({ ...goodClaims, ...patch });
    await assert.rejects(verifyGithubOidc(token, { fetchImpl: fakeFetch(), now: NOW }), message);
  });
}

test("a token signed by an unknown key is refused", async () => {
  const other = await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  );
  const forged = await sign(goodClaims, { key: other.privateKey });
  await assert.rejects(verifyGithubOidc(forged, { fetchImpl: fakeFetch(), now: NOW }), /signature/);
  await assert.rejects(
    verifyGithubOidc(await sign(goodClaims, { kid: "nope" }), { fetchImpl: fakeFetch(), now: NOW }),
    /unknown signing key/,
  );
});

test("the hook dispatches the site deploy", async () => {
  const realNow = Date.now;
  Date.now = () => NOW * 1000;
  try {
    const calls = [];
    const req = new Request("https://images.openimages.cloud/_hooks/catalog", {
      method: "POST",
      headers: { authorization: `Bearer ${await sign(goodClaims)}` },
    });
    const res = await handleCatalogHook(req, { GH_DISPATCH_TOKEN: "t" }, {}, fakeFetch(calls));
    assert.equal(res.status, 202);
    const dispatch = calls.find((c) => c.url.includes("/dispatches"));
    assert.equal(
      dispatch.url,
      "https://api.github.com/repos/open-img-cloud/oic-website/actions/workflows/deploy.yml/dispatches",
    );
  } finally {
    Date.now = realNow;
  }
});

test("the hook refuses a missing token and GET", async () => {
  const noAuth = new Request("https://images.openimages.cloud/_hooks/catalog", { method: "POST" });
  assert.equal((await handleCatalogHook(noAuth, {}, {}, fakeFetch())).status, 401);
  const get = new Request("https://images.openimages.cloud/_hooks/catalog");
  assert.equal((await handleCatalogHook(get, {}, {}, fakeFetch())).status, 405);
});
