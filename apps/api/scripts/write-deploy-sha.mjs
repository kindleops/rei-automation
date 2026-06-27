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
    return execSync("git rev-parse HEAD", { cwd: API_ROOT, encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
}

const sha = resolveSha();
writeFileSync(resolve(API_ROOT, ".deploy-sha"), `${sha}\n`);
console.log(`[deploy-sha] ${sha}`);