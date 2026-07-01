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
console.log(`[deploy-sha] ${sha}`);
console.log(`[deploy-build-timestamp] ${buildTimestamp}`);