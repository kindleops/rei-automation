#!/usr/bin/env node

import crypto from "node:crypto";
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const API_ROOT = path.join(ROOT, "apps/api");
const DASHBOARD_ROOT = path.join(ROOT, "apps/dashboard");

const envFiles = [
  path.join(API_ROOT, ".env.local"),
  path.join(API_ROOT, ".env.production.local"),
  path.join(DASHBOARD_ROOT, ".env.local"),
  path.join(DASHBOARD_ROOT, ".env"),
  path.join(ROOT, ".env.local"),
  path.join(ROOT, ".env"),
];

const recovery = {
  deadApi: [
    `cd ${ROOT}`,
    "npm run dev:all",
  ],
  nonJson: [
    `cd ${ROOT}`,
    "rm -rf apps/api/.next",
    "npm run dev:all",
  ],
  staleNext: [
    `cd ${ROOT}`,
    "rm -rf apps/api/.next",
    "npm run dev:all",
  ],
  auth: [
    `cd ${ROOT}`,
    "cp apps/api/.env.example apps/api/.env.local",
    "cp apps/dashboard/.env.example apps/dashboard/.env.local",
    "vercel env pull apps/api/.env.local --yes",
  ],
};

let failures = 0;

function clean(value) {
  return String(value ?? "").trim();
}

function parseEnvValue(value) {
  const trimmed = clean(value);
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return;
  for (const rawLine of fs.readFileSync(filePath, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const normalized = line.startsWith("export ") ? line.slice(7).trim() : line;
    const equalsIndex = normalized.indexOf("=");
    if (equalsIndex <= 0) continue;
    const key = normalized.slice(0, equalsIndex).trim();
    const value = parseEnvValue(normalized.slice(equalsIndex + 1));
    if (!process.env[key]) process.env[key] = value;
  }
}

for (const file of envFiles) loadEnvFile(file);

const BASE_URL = clean(
  process.env.DEV_DOCTOR_API_URL ||
  process.env.COCKPIT_PROOF_BASE_URL ||
  process.env.API_URL ||
  process.env.LOCAL_API_URL ||
  "http://localhost:3000",
).replace(/\/$/, "");
const HTTP_TIMEOUT_MS = Number(process.env.DEV_DOCTOR_HTTP_TIMEOUT_MS || 30000);

const OPS_SECRET =
  process.env.OPS_DASHBOARD_SECRET ||
  process.env.VITE_OPS_DASHBOARD_SECRET ||
  process.env.VITE_BACKEND_API_SECRET ||
  "";

function printRecovery(commands) {
  if (!commands?.length) return;
  console.log("  Recovery commands:");
  for (const command of commands) console.log(`    ${command}`);
}

function mark(label, condition, detail = "", commands = []) {
  const prefix = condition ? "PASS" : "FAIL";
  const line = `${prefix} ${label}${detail ? ` ${detail}` : ""}`;
  if (condition) {
    console.log(line);
    return true;
  }
  failures += 1;
  console.error(line);
  printRecovery(commands);
  return false;
}

function headers() {
  const h = {
    accept: "application/json",
    "content-type": "application/json",
    origin: "http://localhost:5173",
  };
  if (OPS_SECRET) h["x-ops-dashboard-secret"] = OPS_SECRET;
  return h;
}

function isHtml(text, contentType = "") {
  const trimmed = clean(text).slice(0, 200).toLowerCase();
  return contentType.toLowerCase().includes("text/html") ||
    trimmed.startsWith("<!doctype") ||
    trimmed.startsWith("<html") ||
    trimmed.includes("<body");
}

async function checkJsonEndpoint(label, routePath) {
  const url = `${BASE_URL}${routePath}`;
  let response;
  let text = "";
  try {
    response = await fetch(url, {
      headers: headers(),
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });
    text = await response.text();
  } catch (error) {
    return mark(
      `${label} API reachable`,
      false,
      `url=${url} error=${error?.message || error}`,
      recovery.deadApi,
    );
  }

  const contentType = response.headers.get("content-type") || "";
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    const commands = isHtml(text, contentType) ? recovery.nonJson : recovery.staleNext;
    return mark(
      `${label} returns JSON`,
      false,
      `status=${response.status} content-type=${contentType || "unknown"} body=${clean(text).slice(0, 160)}`,
      commands,
    );
  }

  if (response.status === 401 || response.status === 403) {
    return mark(
      `${label} authenticated`,
      false,
      `status=${response.status} error=${json?.error || json?.reason || "auth_failed"}`,
      recovery.auth,
    );
  }

  if (response.status >= 500) {
    return mark(
      `${label} has no runtime 500`,
      false,
      `status=${response.status} error=${json?.error || json?.reason || json?.message || "server_error"}`,
      recovery.nonJson,
    );
  }

  mark(`${label} API reachable`, true, `status=${response.status}`);
  mark(`${label} returns JSON`, true, `content-type=${contentType || "unknown"}`);
  return json;
}

function fileMtimeMs(filePath) {
  try {
    return fs.statSync(filePath).mtimeMs;
  } catch {
    return 0;
  }
}

function latestMtime(paths) {
  let latest = 0;
  for (const entry of paths) {
    if (!fs.existsSync(entry)) continue;
    const stat = fs.statSync(entry);
    latest = Math.max(latest, stat.mtimeMs);
    if (!stat.isDirectory()) continue;
    for (const child of fs.readdirSync(entry)) {
      if (child === "node_modules" || child === ".next" || child === "dist") continue;
      latest = Math.max(latest, latestMtime([path.join(entry, child)]));
    }
  }
  return latest;
}

function checkNextCache() {
  const nextDir = path.join(API_ROOT, ".next");
  if (!fs.existsSync(nextDir)) {
    mark("stale .next cache absent", true, "apps/api/.next not present");
    return;
  }

  const sourceMtime = latestMtime([
    path.join(API_ROOT, "src/app/api"),
    path.join(API_ROOT, "src/lib"),
    path.join(API_ROOT, "next.config.js"),
    path.join(API_ROOT, "package.json"),
    path.join(API_ROOT, "package-lock.json"),
  ]);
  const cacheMtime = latestMtime([
    path.join(nextDir, "server"),
    path.join(nextDir, "routes-manifest.json"),
    path.join(nextDir, "BUILD_ID"),
    nextDir,
  ]);
  const staleByMs = sourceMtime - cacheMtime;
  mark(
    "stale .next cache",
    staleByMs <= 5000,
    staleByMs > 5000
      ? `source is ${Math.round(staleByMs / 1000)}s newer than apps/api/.next`
      : "cache is fresh enough",
    recovery.staleNext,
  );
}

const EXPECTED_WORKTREE = clean(
  process.env.CANONICAL_WORKTREE || "/Users/ryankindle/rei-automation-canonical",
);
const EXPECTED_API_PORT = Number(process.env.CANONICAL_API_PORT || 3000);
const EXPECTED_DASHBOARD_PORT = Number(process.env.CANONICAL_DASHBOARD_PORT || 5173);

function worktreeFingerprint(dirPath) {
  return crypto.createHash("sha256").update(path.resolve(dirPath)).digest("hex").slice(0, 12);
}

function readGitValue(command) {
  try {
    return clean(execSync(command, { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }));
  } catch {
    return "";
  }
}

function listListeners(port) {
  try {
    const output = execSync(`lsof -nP -iTCP:${port} -sTCP:LISTEN`, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return output
      .split(/\r?\n/)
      .slice(1)
      .map((line) => line.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

function checkCanonicalWorktree() {
  const resolvedRoot = path.resolve(ROOT);
  const expected = path.resolve(EXPECTED_WORKTREE);
  const sameTree = resolvedRoot === expected;
  mark(
    "canonical worktree path",
    sameTree,
    sameTree ? `cwd=${resolvedRoot}` : `expected=${expected} actual=${resolvedRoot}`,
    [`cd ${expected}`],
  );
  const branch = readGitValue("git rev-parse --abbrev-ref HEAD");
  mark(
    "canonical integration branch",
    branch === "integration/canonical-20260622",
    branch ? `branch=${branch}` : "branch=unknown",
    [`cd ${expected}`, "git checkout integration/canonical-20260622"],
  );
}

function checkRequiredEnv() {
  const required = ["OPS_DASHBOARD_SECRET"];
  for (const key of required) {
    mark(`required env ${key}`, Boolean(clean(process.env[key])), clean(process.env[key]) ? "present" : "missing", recovery.auth);
  }
}

function checkPortInventory() {
  for (const port of [EXPECTED_API_PORT, EXPECTED_DASHBOARD_PORT]) {
    const listeners = listListeners(port);
    mark(
      `port ${port} has listener`,
      listeners.length > 0,
      listeners.length ? listeners.join(" | ") : "no listener",
      [`cd ${ROOT}`, "npm run dev:all"],
    );
  }

  for (const strayPort of [3001, 3002, 5175, 5176]) {
    const listeners = listListeners(strayPort);
    if (listeners.length > 0) {
      mark(
        `stray port ${strayPort} idle`,
        false,
        listeners.join(" | "),
        [`# inspect manually: lsof -nP -iTCP:${strayPort} -sTCP:LISTEN`],
      );
    } else {
      mark(`stray port ${strayPort} idle`, true, "no listener");
    }
  }
}

async function checkRuntimeIdentityPairing() {
  const url = `${BASE_URL}/api/cockpit/dev/runtime-identity`;
  let response;
  let json = null;
  try {
    response = await fetch(url, {
      headers: headers(),
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });
    const text = await response.text();
    json = text ? JSON.parse(text) : null;
  } catch (error) {
    mark("runtime identity endpoint", false, error?.message || String(error), recovery.deadApi);
    return;
  }

  mark("runtime identity endpoint", response.ok && json?.commit_sha, `status=${response.status} sha=${json?.commit_sha || "missing"}`);
  const localSha = readGitValue("git rev-parse HEAD");
  mark(
    "API SHA matches local checkout",
    Boolean(localSha) && localSha === json?.commit_sha,
    `local=${localSha || "unknown"} api=${json?.commit_sha || "unknown"}`,
    recovery.deadApi,
  );
  const expectedWorktreeId = worktreeFingerprint(EXPECTED_WORKTREE);
  mark(
    "API worktree fingerprint",
    json?.worktree_id === expectedWorktreeId,
    `expected=${expectedWorktreeId} api=${json?.worktree_id || "unknown"}`,
    [`cd ${EXPECTED_WORKTREE}`],
  );
}

async function main() {
  console.log(`Dev runtime doctor base=${BASE_URL}`);
  checkCanonicalWorktree();
  checkRequiredEnv();
  checkPortInventory();
  mark("OPS dashboard secret loaded", Boolean(OPS_SECRET), OPS_SECRET ? "present" : "missing", recovery.auth);
  checkNextCache();
  await checkRuntimeIdentityPairing();
  await checkJsonEndpoint("health", "/api/cockpit/health");
  const liveJson = await checkJsonEndpoint("live inbox", "/api/cockpit/inbox/live?filter=all&limit=5&map=0&timeout_mode=initial_boot");
  const liveRows = Array.isArray(liveJson?.threads) ? liveJson.threads : [];
  const sample = liveRows.find((row) => clean(row.thread_key || row.threadKey || row.id)) || null;
  if (sample) {
    const threadKey = clean(sample.thread_key || sample.threadKey || sample.id);
    const params = new URLSearchParams({ thread_key: threadKey, limit: "50" });
    for (const [key, value] of Object.entries({
      canonical_e164: sample.canonical_e164 || sample.canonicalE164,
      phone_e164: sample.canonical_e164 || sample.canonicalE164,
      phone: sample.phone,
      best_phone: sample.best_phone || sample.bestPhone,
      seller_phone: sample.seller_phone || sample.sellerPhone,
      property_id: sample.property_id || sample.propertyId,
      prospect_id: sample.prospect_id || sample.prospectId,
      master_owner_id: sample.master_owner_id || sample.ownerId,
    })) {
      if (clean(value)) params.set(key, clean(value));
    }
    await checkJsonEndpoint("thread messages", `/api/cockpit/inbox/thread-messages?${params.toString()}`);
    await checkJsonEndpoint("thread hydration", `/api/cockpit/inbox/thread-hydration?${params.toString()}`);
    await checkJsonEndpoint("deal context thread", `/api/cockpit/deal-context/thread/${encodeURIComponent(threadKey)}`);
    const propertyId = clean(sample.property_id || sample.propertyId || sample.final_property_id);
    if (propertyId) {
      await checkJsonEndpoint("valuation snapshot", `/api/cockpit/properties/${encodeURIComponent(propertyId)}/valuation-snapshot`);
    }
  } else {
    mark("sample inbox row for detail routes", true, "skipped because live inbox returned no rows");
  }
  await checkJsonEndpoint("ops metrics", "/api/cockpit/ops/metrics?window=today");

  if (failures > 0) {
    console.error(`FAIL dev runtime doctor failures=${failures}`);
    process.exit(1);
  }
  console.log("PASS dev runtime doctor");
}

main().catch((error) => {
  console.error("FAIL dev runtime doctor crashed", error?.stack || error?.message || error);
  printRecovery(recovery.nonJson);
  process.exit(1);
});
