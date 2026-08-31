import { readFileSync } from "node:fs";
import { join } from "node:path";

function clean(value = "") {
  return String(value ?? "").trim();
}

export function resolveDeployGitSha() {
  const fromEnv =
    clean(process.env.VERCEL_GIT_COMMIT_SHA) || clean(process.env.DEPLOY_GIT_SHA);
  if (fromEnv && fromEnv !== "unknown") return fromEnv;

  try {
    const fromFile = readFileSync(join(process.cwd(), ".deploy-sha"), "utf8").trim();
    if (fromFile && fromFile !== "unknown") return fromFile;
  } catch {
    // fall through
  }

  return "unknown";
}

export function resolveDeployBuildTimestamp() {
  const fromEnv =
    clean(process.env.VERCEL_BUILD_TIMESTAMP) || clean(process.env.BUILD_TIMESTAMP);
  if (fromEnv) return fromEnv;

  try {
    const fromFile = readFileSync(join(process.cwd(), ".deploy-build-timestamp"), "utf8").trim();
    if (fromFile) return fromFile;
  } catch {
    // fall through
  }

  return null;
}
/* ===========================================================================
 * Provider-neutral deployment provenance.
 *
 * /api/version previously read VERCEL_* directly, so on any non-Vercel host it
 * reported env:"development" and deployment_id:null -- i.e. a production
 * container would describe itself as a dev box.
 *
 * Resolution order for every field: the generic DEPLOYMENT_* name first, then
 * the DEPLOY_* name already used by resolveDeployGitSha, then the legacy
 * VERCEL_* value while Vercel still exists. Cloudflare (or any host) supplies
 * the same generic names.
 *
 * SAFETY: absence of metadata resolves to "unknown", never to "production" and
 * never to a falsely confident "development". Only an explicit signal can claim
 * an environment.
 * ======================================================================== */

export function resolveDeploymentEnv() {
  const explicit =
    clean(process.env.DEPLOYMENT_ENV) ||
    clean(process.env.DEPLOY_ENV) ||
    clean(process.env.VERCEL_ENV);
  if (explicit) return explicit.toLowerCase();

  const node_env = clean(process.env.NODE_ENV).toLowerCase();
  if (node_env === "production") return "production";
  if (node_env === "development" || node_env === "test") return node_env;

  // No signal at all: say so rather than guessing.
  return "unknown";
}

export function resolveDeploymentId() {
  return (
    clean(process.env.DEPLOYMENT_ID) ||
    clean(process.env.DEPLOY_ID) ||
    clean(process.env.VERCEL_DEPLOYMENT_ID) ||
    null
  );
}

export function resolveDeploymentProvider() {
  const explicit =
    clean(process.env.DEPLOYMENT_PROVIDER) || clean(process.env.DEPLOY_PROVIDER);
  if (explicit) return explicit.toLowerCase();

  if (clean(process.env.VERCEL_ENV) || clean(process.env.VERCEL)) return "vercel";

  return "unknown";
}

export function resolveDeploymentProject() {
  return (
    clean(process.env.DEPLOYMENT_PROJECT) ||
    clean(process.env.DEPLOY_PROJECT) ||
    clean(process.env.VERCEL_PROJECT_NAME) ||
    "rei-automation-api"
  );
}

export function resolveDeploymentHostname() {
  return (
    clean(process.env.DEPLOYMENT_HOSTNAME) ||
    clean(process.env.DEPLOY_HOSTNAME) ||
    clean(process.env.VERCEL_URL) ||
    null
  );
}
