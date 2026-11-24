import { test } from "node:test";
import assert from "node:assert/strict";
import { dispatchAll } from "../src/scheduler.js";

const env = { GH_DISPATCH_TOKEN: "t" };

function fakeFetch(script) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push(`${init.method} ${url.replace("https://api.github.com/repos/open-img-cloud/", "")}`);
    const next = script.shift();
    return new Response(next.body ?? null, { status: next.status });
  };
  return { impl, calls };
}

test("dispatches an active workflow once", async () => {
  const { impl, calls } = fakeFetch([{ status: 204 }]);
  const [r] = await dispatchAll(env, impl, "debian-13:watch.yml");
  assert.equal(r.ok, true);
  assert.equal(r.reenabled, false);
  assert.deepEqual(calls, ["POST debian-13/actions/workflows/watch.yml/dispatches"]);
});

test("enables a workflow GitHub disabled, then dispatches it again", async () => {
  const { impl, calls } = fakeFetch([
    { status: 422, body: JSON.stringify({ message: "Workflow is disabled" }) },
    { status: 204 },
    { status: 204 },
  ]);
  const [r] = await dispatchAll(env, impl, "docs:links.yml");
  assert.equal(r.ok, true);
  assert.equal(r.reenabled, true);
  assert.deepEqual(calls, [
    "POST docs/actions/workflows/links.yml/dispatches",
    "PUT docs/actions/workflows/links.yml/enable",
    "POST docs/actions/workflows/links.yml/dispatches",
  ]);
});

test("does not enable on another 422", async () => {
  const { impl, calls } = fakeFetch([{ status: 422, body: JSON.stringify({ message: "No ref found for: main" }) }]);
  const [r] = await dispatchAll(env, impl, "x:y.yml");
  assert.equal(r.ok, false);
  assert.equal(calls.length, 1);
});

test("reports a failed enable without retrying", async () => {
  const { impl, calls } = fakeFetch([
    { status: 422, body: "Workflow is disabled" },
    { status: 403, body: "Resource not accessible" },
  ]);
  const [r] = await dispatchAll(env, impl, "x:y.yml");
  assert.equal(r.ok, false);
  assert.equal(r.status, 422);
  assert.equal(calls.length, 2);
});
