import { QUEUE_RECONCILE_LIFECYCLE_VERSION } from "@/lib/supabase/sms-engine.js";

function clean(value = "") {
  return String(value ?? "").trim();
}

export function resolveDeployGitSha() {
  return (
    clean(process.env.VERCEL_GIT_COMMIT_SHA) ||
    clean(process.env.DEPLOY_GIT_SHA) ||
    "unknown"
  );
}

export function getQueueRouteDeploymentMeta(request = null) {
  const host =
    clean(request?.headers?.get?.("host")) ||
    clean(request?.headers?.get?.("x-forwarded-host")) ||
    clean(process.env.VERCEL_URL) ||
    null;

  return {
    git_sha: resolveDeployGitSha(),
    deployment_id: clean(process.env.VERCEL_DEPLOYMENT_ID) || null,
    request_timestamp: new Date().toISOString(),
    hostname: host,
    vercel_env: clean(process.env.VERCEL_ENV) || null,
    reconcile_lifecycle_version: QUEUE_RECONCILE_LIFECYCLE_VERSION,
  };
}