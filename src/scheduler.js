// Daily external scheduler (Cloudflare Cron Trigger).
//
// GitHub disables `schedule:` triggers in public repositories after 60 days
// without repository activity (this silently stopped the upstream watchers
// in 2026). This cron dispatches the workflows that must keep running. When
// GitHub has disabled one (state disabled_inactivity, the dispatch answers
// 422), it is enabled again and dispatched once more. The repos keep
// their own `schedule:` triggers as a fallback; duplicate runs are harmless
// (the watcher only updates its auto/upstream-bump PR, the site deploy is
// idempotent).
//
// Config (wrangler.toml):
//   [vars] SCHEDULED_WORKFLOWS = "repo:workflow.yml,..."  daily (org: open-img-cloud)
//   [vars] WEEKLY_WORKFLOWS    = "repo:workflow.yml,..."  Mondays, cron WEEKLY_CRON
//   secret GH_DISPATCH_TOKEN   = fine-grained PAT, Actions: Read and write,
//                                restricted to the repos listed above
//                                (write also allows enabling a workflow).

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

// Weekly cron: dispatches WEEKLY_WORKFLOWS instead of SCHEDULED_WORKFLOWS.
export const WEEKLY_CRON = "0 4 * * 1";

export function workflowsFor(cron, env) {
  return cron === WEEKLY_CRON ? env.WEEKLY_WORKFLOWS : env.SCHEDULED_WORKFLOWS;
}

export async function dispatchAll(env, fetchImpl = fetch, spec = env.SCHEDULED_WORKFLOWS) {
  const workflows = parseWorkflows(spec);
  if (!env.GH_DISPATCH_TOKEN) {
    console.error("scheduler: GH_DISPATCH_TOKEN secret is not set, nothing dispatched");
    return [];
  }
  const headers = {
    authorization: `Bearer ${env.GH_DISPATCH_TOKEN}`,
    accept: "application/vnd.github+json",
    "x-github-api-version": "2022-11-28",
    "user-agent": "openimages-scheduler",
    "content-type": "application/json",
  };
  const results = await Promise.all(
    workflows.map(async ({ repo, workflow }) => {
      const base = `https://api.github.com/repos/${ORG}/${repo}/actions/workflows/${workflow}`;
      const dispatch = () => fetchImpl(`${base}/dispatches`, { method: "POST", headers, body: JSON.stringify({ ref: "main" }) });
      try {
        let res = await dispatch();
        let reenabled = false;
        // 422 "Workflow is disabled": GitHub turned it off (60 days without activity).
        if (res.status === 422 && /disabled/i.test(await res.text())) {
          const en = await fetchImpl(`${base}/enable`, { method: "PUT", headers });
          if (en.status === 204) {
            reenabled = true;
            res = await dispatch();
          }
        }
        // 204 No Content = dispatched.
        return { repo, workflow, status: res.status, ok: res.status === 204, reenabled };
      } catch (err) {
        return { repo, workflow, status: 0, ok: false, error: String(err) };
      }
    }),
  );
  for (const r of results) {
    const line = `scheduler: ${r.repo}/${r.workflow} -> ${r.status}${r.reenabled ? " (re-enabled)" : ""}${r.error ? ` (${r.error})` : ""}`;
    if (r.ok) console.log(line);
    else console.error(line);
  }
  return results;
}
