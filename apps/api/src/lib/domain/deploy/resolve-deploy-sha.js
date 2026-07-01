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