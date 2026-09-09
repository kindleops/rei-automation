#!/usr/bin/env node
import { execSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const API_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function resolveSha() {
  if (process.env.VERCEL_GIT_COMMIT_SHA) return process.env.VERCEL_GIT_COMMIT_SHA;
  if (process.env.DEPLOY_GIT_SHA) return process.env.DEPLOY_GIT_SHA;
  try {
    const fromGit = execSync("git rev-parse HEAD", { cwd: API_ROOT, encoding: "utf8" }).trim();
    if (fromGit) return fromGit;
  } catch {
    // fall through
  }
  return "unknown";
}

const sha = resolveSha();
const buildTimestamp = new Date().toISOString();
writeFileSync(resolve(API_ROOT, ".deploy-sha"), `${sha}\n`);
writeFileSync(resolve(API_ROOT, ".deploy-build-timestamp"), `${buildTimestamp}\n`);

// Emit the SAME values as a source module so they compile INTO the bundle.
// The .deploy-sha file above never reaches the Cloudflare container (the
// Dockerfile copies .next/standalone only), and the runtime env SHA describes
// what the Worker was TOLD to run, not what the container is executing. A
// static import is the only carrier that cannot lie about its own code -- see
// the header of build-stamp.generated.js for the incident this prevents.
writeFileSync(
  resolve(API_ROOT, "src/lib/domain/deploy/build-stamp.generated.js"),
  [
    "// GENERATED FILE -- overwritten by scripts/write-deploy-sha.mjs during `npm run build`.",
    '// Committed placeholder reads "unknown"; do NOT gitignore it (a missing module',
    "// breaks every import of the queue runner and /api/version at load time).",
    `export const BUILD_SHA = ${JSON.stringify(sha)};`,
    `export const BUILD_TIMESTAMP = ${JSON.stringify(buildTimestamp)};`,
    "",
  ].join("\n")
);

console.log(`[deploy-sha] ${sha}`);
console.log(`[deploy-build-timestamp] ${buildTimestamp}`);