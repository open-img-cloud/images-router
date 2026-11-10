// Daily external scheduler (Cloudflare Cron Trigger).
//
// GitHub disables `schedule:` triggers in public repositories after 60 days
// without repository activity (this silently stopped the upstream watchers
// in 2026). `workflow_dispatch` runs are not subject to that rule, so this
// cron dispatches the workflows that must run every day. The repos keep
// their own `schedule:` triggers as a fallback; duplicate runs are harmless
// (the watcher only updates its auto/upstream-bump PR, the site deploy is
// idempotent).
//
// Config (wrangler.toml):
//   [vars] SCHEDULED_WORKFLOWS = "repo:workflow.yml,..."  (org: open-img-cloud)
//   secret GH_DISPATCH_TOKEN   = fine-grained PAT, Actions: Read and write,
//                                restricted to the repos listed above.

const ORG = "open-img-cloud";

export function parseWorkflows(spec) {
  return (spec || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      const [repo, workflow] = s.split(":");
      return { repo, workflow };
    })
    .filter((w) => w.repo && w.workflow);
}

export async function dispatchAll(env, fetchImpl = fetch) {
  const workflows = parseWorkflows(env.SCHEDULED_WORKFLOWS);
  if (!env.GH_DISPATCH_TOKEN) {
    console.error("scheduler: GH_DISPATCH_TOKEN secret is not set, nothing dispatched");
    return [];
  }
  const results = await Promise.all(
    workflows.map(async ({ repo, workflow }) => {
      const url = `https://api.github.com/repos/${ORG}/${repo}/actions/workflows/${workflow}/dispatches`;
      try {
        const res = await fetchImpl(url, {
          method: "POST",
          headers: {
            authorization: `Bearer ${env.GH_DISPATCH_TOKEN}`,
            accept: "application/vnd.github+json",
            "x-github-api-version": "2022-11-28",
            "user-agent": "openimages-scheduler",
            "content-type": "application/json",
          },
          body: JSON.stringify({ ref: "main" }),
        });
        // 204 No Content = dispatched.
        return { repo, workflow, status: res.status, ok: res.status === 204 };
      } catch (err) {
        return { repo, workflow, status: 0, ok: false, error: String(err) };
      }
    }),
  );
  for (const r of results) {
    const line = `scheduler: ${r.repo}/${r.workflow} -> ${r.status}${r.error ? ` (${r.error})` : ""}`;
    if (r.ok) console.log(line);
    else console.error(line);
  }
  return results;
}
