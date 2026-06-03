#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { callProofJson, formatProofHttp401Diagnostic } from "./proof-http-client.mjs";

const ROOT = path.resolve(new URL("../..", import.meta.url).pathname);
const ENV_FILES = [
  path.join(ROOT, "apps/api/.env.local"),
  path.join(ROOT, "apps/dashboard/.env.local"),
  path.join(ROOT, ".env.local"),
  path.join(ROOT, ".env"),
];

function clean(value) {
  return String(value ?? "").trim();
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
    let value = normalized.slice(equalsIndex + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (value && !process.env[key]) process.env[key] = value;
  }
}

for (const file of ENV_FILES) loadEnvFile(file);

const BASE_URL = clean(process.env.COCKPIT_PROOF_BASE_URL || process.env.API_URL || "http://localhost:3000").replace(/\/$/, "");
const OPS_SECRET = clean(process.env.OPS_DASHBOARD_SECRET || process.env.VITE_BACKEND_API_SECRET);
let failures = 0;
let warnings = 0;

function headers() {
  const h = {
    accept: "application/json",
    origin: "http://localhost:5173",
  };
  if (OPS_SECRET) h["x-ops-dashboard-secret"] = OPS_SECRET;
  return h;
}

function mark(label, condition, detail = "", warnOnly = false) {
  const prefix = condition ? "PASS" : warnOnly ? "WARN" : "FAIL";
  const line = `${prefix} ${label}${detail ? ` ${detail}` : ""}`;
  if (condition) {
    console.log(line);
    return true;
  }
  if (warnOnly) {
    warnings += 1;
    console.warn(line);
    return false;
  }
  failures += 1;
  console.error(line);
  return false;
}

function routeDetail(result) {
  const auth = formatProofHttp401Diagnostic(result);
  return [
    `status=${result.status || "ERR"}`,
    `${result.ms}ms`,
    `ct=${clean(result.headers?.["content-type"]) || "missing"}`,
    result.error ? `error=${result.error}` : "",
    auth,
  ].filter(Boolean).join(" ");
}

async function call(label, pathOrUrl) {
  const result = await callProofJson({
    root: ROOT,
    baseUrl: BASE_URL,
    pathOrUrl,
    label,
    headers: headers(),
    timeoutSeconds: 60,
  });
  const contentType = clean(result.headers?.["content-type"]).toLowerCase();
  const raw = clean(result.raw);
  const isJson = contentType.includes("application/json") && result.json && typeof result.json === "object";
  mark(`${label} returned JSON`, isJson, routeDetail(result));
  mark(`${label} avoided raw HTML`, !raw.startsWith("<!DOCTYPE html") && !raw.toLowerCase().includes("missing required error components"), routeDetail(result));
  mark(`${label} status is JSON-success/degraded`, result.status === 200 && result.json?.ok !== false, routeDetail(result));
  mark(`${label} includes diagnostics`, Boolean(result.json?.diagnostics || result.json?.queryMs != null), routeDetail(result), true);
  return result;
}

function threadKey(row = {}) {
  return clean(row.thread_key || row.threadKey || row.id);
}

function propertyId(row = {}) {
  return clean(row.property_id || row.propertyId || row.final_property_id);
}

async function main() {
  console.log(`Inbox API JSON contract proof base=${BASE_URL}`);
  mark("OPS dashboard secret loaded", Boolean(OPS_SECRET), "", true);

  const live = await call("inbox live", "/api/cockpit/inbox/live?filter=all&limit=5&map=0&timeout_mode=initial_boot");
  const rows = Array.isArray(live.json?.threads) ? live.json.threads : [];
  const selected = rows.find((row) => threadKey(row)) || rows[0] || null;

  if (!selected) {
    mark("live row selected", false, "no rows available", true);
  } else {
    mark("live row selected", true, `thread_key=${threadKey(selected)}`);
    const params = new URLSearchParams({ thread_key: threadKey(selected), limit: "200" });
    for (const [key, value] of Object.entries({
      canonical_e164: selected.canonical_e164 || selected.canonicalE164,
      phone_e164: selected.canonical_e164 || selected.canonicalE164,
      phone: selected.phone,
      best_phone: selected.best_phone || selected.bestPhone,
      seller_phone: selected.seller_phone || selected.sellerPhone,
      property_id: selected.property_id || selected.propertyId,
      prospect_id: selected.prospect_id || selected.prospectId,
      master_owner_id: selected.master_owner_id || selected.ownerId,
    })) {
      if (clean(value)) params.set(key, clean(value));
    }
    await call("thread messages", `/api/cockpit/inbox/thread-messages?${params.toString()}`);
    await call("deal context thread", `/api/cockpit/deal-context/thread/${encodeURIComponent(threadKey(selected))}`);
    if (propertyId(selected)) {
      await call("valuation snapshot", `/api/cockpit/properties/${encodeURIComponent(propertyId(selected))}/valuation-snapshot`);
    } else {
      mark("valuation snapshot skipped", true, "selected row has no property_id");
    }
  }

  await call("ops metrics", "/api/cockpit/ops/metrics?window=today");

  if (failures > 0) {
    console.error(`FAIL inbox API JSON contract proof failures=${failures} warnings=${warnings}`);
    process.exitCode = 1;
    return;
  }
  console.log(`PASS inbox API JSON contract proof warnings=${warnings}`);
}

main().catch((error) => {
  console.error("FAIL inbox API JSON contract proof crashed", error?.stack || error?.message || error);
  process.exitCode = 1;
});
