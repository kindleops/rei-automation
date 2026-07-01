import {
  resolveDeployBuildTimestamp,
  resolveDeployGitSha,
} from "@/lib/domain/deploy/resolve-deploy-sha.js";
import { QUEUE_RECONCILE_LIFECYCLE_VERSION } from "@/lib/supabase/sms-engine.js";

function clean(value = "") {
  return String(value ?? "").trim();
}

export { resolveDeployGitSha };

export function getQueueRouteDeploymentMeta(request = null) {
  const host =
    clean(request?.headers?.get?.("host")) ||
    clean(request?.headers?.get?.("x-forwarded-host")) ||
    clean(process.env.VERCEL_URL) ||
    null;

  return {
    git_sha: resolveDeployGitSha(),
    deployment_id: clean(process.env.VERCEL_DEPLOYMENT_ID) || null,
    build_timestamp: resolveDeployBuildTimestamp(),
    request_timestamp: new Date().toISOString(),
    hostname: host,
    vercel_env: clean(process.env.VERCEL_ENV) || null,
    reconcile_lifecycle_version: QUEUE_RECONCILE_LIFECYCLE_VERSION,
  };
}