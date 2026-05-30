#!/usr/bin/env node

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
    "npm --workspace apps/api run dev",
    "npm --workspace apps/dashboard run dev",
  ],
  nonJson: [
    `cd ${ROOT}`,
    "rm -rf apps/api/.next",
    "npm --workspace apps/api run dev",
    "npm --workspace apps/dashboard run dev",
  ],
  staleNext: [
    `cd ${ROOT}`,
    "rm -rf apps/api/.next",
    "npm --workspace apps/api run dev",
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
  return true;
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

async function main() {
  console.log(`Dev runtime doctor base=${BASE_URL}`);
  mark("OPS dashboard secret loaded", Boolean(OPS_SECRET), OPS_SECRET ? "present" : "missing", recovery.auth);
  checkNextCache();
  await checkJsonEndpoint("health", "/api/cockpit/health");
  await checkJsonEndpoint("live inbox", "/api/cockpit/inbox/live?filter=all&limit=1&timeout_mode=initial_boot");

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
