import fs from "node:fs";
import path from "node:path";
import { createClient } from "@supabase/supabase-js";
import { callProofJson, formatProofHttp401Diagnostic } from "./proof-http-client.mjs";

export const ROOT = path.resolve(new URL("../..", import.meta.url).pathname);

const envFiles = [
  path.join(ROOT, "apps/api/.env.local"),
  path.join(ROOT, "apps/api/.env.production.local"),
  path.join(ROOT, "apps/dashboard/.env.local"),
  path.join(ROOT, "apps/dashboard/.env"),
  path.join(ROOT, ".env.local"),
  path.join(ROOT, ".env"),
];

function parseEnvValue(value) {
  const trimmed = String(value ?? "").trim();
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

export const BASE_URL = String(
  process.env.COCKPIT_PROOF_BASE_URL ||
  process.env.API_URL ||
  process.env.LOCAL_API_URL ||
  "http://localhost:3000"
).replace(/\/$/, "");

export const OPS_SECRET =
  process.env.OPS_DASHBOARD_SECRET ||
  process.env.VITE_OPS_DASHBOARD_SECRET ||
  process.env.VITE_BACKEND_API_SECRET ||
  "";

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY;

export const supabase = SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY
  ? createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
      auth: { autoRefreshToken: false, persistSession: false },
    })
  : null;

export function createMarker() {
  return {
    failures: 0,
    warnings: 0,
    mark(label, condition, detail = "", warnOnly = false) {
      const prefix = condition ? "PASS" : warnOnly ? "WARN" : "FAIL";
      const line = `${prefix} ${label}${detail ? ` ${detail}` : ""}`;
      if (condition) {
        console.log(line);
        return true;
      }
      if (warnOnly) {
        this.warnings += 1;
        console.warn(line);
        return false;
      }
      this.failures += 1;
      console.error(line);
      return false;
    },
    finish(label) {
      if (this.failures > 0) {
        console.error(`FAIL ${label} failures=${this.failures} warnings=${this.warnings}`);
        process.exit(1);
      }
      console.log(`PASS ${label} warnings=${this.warnings}`);
    },
  };
}

export function headers() {
  const h = {
    "content-type": "application/json",
    accept: "application/json",
    origin: "http://localhost:5173",
  };
  if (OPS_SECRET) h["x-ops-dashboard-secret"] = OPS_SECRET;
  return h;
}

export async function callJson(pathOrUrl, options = {}) {
  return callProofJson({
    root: ROOT,
    baseUrl: BASE_URL,
    pathOrUrl,
    method: options.method || "GET",
    headers: options.headers || headers(),
    body: options.body,
    timeoutSeconds: options.timeout_seconds || 30,
  });
}

export function routeSummary(result = {}) {
  const authDiagnostic = formatProofHttp401Diagnostic(result);
  return `status=${result.status} ms=${result.ms}${authDiagnostic ? ` ${authDiagnostic}` : ""}`;
}

export function readRel(relPath) {
  return fs.readFileSync(path.join(ROOT, relPath), "utf8");
}

export async function countSendQueueRowsForCampaign(campaignId) {
  if (!supabase || !campaignId) return null;
  const { count, error } = await supabase
    .from("send_queue")
    .select("id", { count: "exact", head: true })
    .eq("campaign_id", campaignId);
  if (error) throw error;
  return Number(count || 0);
}

export function isHttpUnavailable(result = {}) {
  return Boolean(result.error) && Number(result.status || 0) === 0;
}
