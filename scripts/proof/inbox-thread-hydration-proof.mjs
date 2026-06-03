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
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    if (value && !process.env[key]) process.env[key] = value;
  }
}

for (const file of ENV_FILES) loadEnvFile(file);

const BASE_URL = clean(process.env.COCKPIT_PROOF_BASE_URL || process.env.API_URL || "http://localhost:3000").replace(/\/$/, "");
const OPS_SECRET = clean(process.env.OPS_DASHBOARD_SECRET || process.env.VITE_BACKEND_API_SECRET);
let failures = 0;
let warnings = 0;

function headers() {
  const h = { accept: "application/json", origin: "http://localhost:5173" };
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
  mark(`${label} JSON`, result.status === 200 && contentType.includes("application/json") && Boolean(result.json), routeDetail(result));
  mark(`${label} no HTML`, !raw.startsWith("<!DOCTYPE html") && !raw.toLowerCase().includes("missing required error components"), routeDetail(result));
  return result;
}

function threadKey(row = {}) {
  return clean(row.thread_key || row.threadKey || row.id);
}

function propertyId(row = {}) {
  return clean(row.property_id || row.propertyId || row.final_property_id);
}

function identityParams(row = {}) {
  const params = new URLSearchParams({ thread_key: threadKey(row), limit: "50" });
  for (const [key, value] of Object.entries({
    conversation_thread_id: row.conversation_thread_id || row.conversationThreadId,
    legacy_thread_key: row.legacy_thread_key || row.legacyThreadKey,
    normalized_phone: row.normalized_phone || row.normalizedPhone,
    canonical_e164: row.canonical_e164 || row.canonicalE164,
    phone_e164: row.canonical_e164 || row.canonicalE164,
    phone: row.phone,
    best_phone: row.best_phone || row.bestPhone,
    seller_phone: row.seller_phone || row.sellerPhone,
    property_id: row.property_id || row.propertyId,
    prospect_id: row.prospect_id || row.prospectId,
    master_owner_id: row.master_owner_id || row.ownerId,
    owner_id: row.master_owner_id || row.ownerId,
  })) {
    if (clean(value)) params.set(key, clean(value));
  }
  return params;
}

async function main() {
  console.log(`Inbox thread hydration proof base=${BASE_URL}`);
  mark("OPS dashboard secret loaded", Boolean(OPS_SECRET), "", true);

  const live = await call("live inbox", "/api/cockpit/inbox/live?filter=all&limit=10&map=0&timeout_mode=initial_boot");
  const rows = (Array.isArray(live.json?.threads) ? live.json.threads : []).filter((row) => threadKey(row)).slice(0, 5);
  mark("selected up to five thread rows", rows.length > 0, `rows=${rows.length}`);

  for (const row of rows) {
    const key = threadKey(row);
    const params = identityParams(row);

    const messages = await call(`messages ${key}`, `/api/cockpit/inbox/thread-messages?${params.toString()}`);
    const msgRows = Array.isArray(messages.json?.messages) ? messages.json.messages : [];
    const msgDiag = messages.json?.diagnostics || {};
    mark(`messages ${key} ok`, messages.json?.ok === true, routeDetail(messages));
    mark(`messages ${key} identity diagnostics`, Boolean(msgDiag.identitiesTried || msgDiag.identities_tried || msgDiag.identityUsed || msgDiag.sourceResults), JSON.stringify({ count: msgRows.length }));
    if (msgRows.length === 0) {
      mark(`messages ${key} empty result explained`, Boolean(msgDiag.identitiesTried || msgDiag.identities_tried || msgDiag.sourceResults), JSON.stringify(msgDiag).slice(0, 400));
    }

    const hydration = await call(`hydration ${key}`, `/api/cockpit/inbox/thread-hydration?${params.toString()}`);
    mark(`hydration ${key} ok`, hydration.json?.ok === true, routeDetail(hydration));
    mark(`hydration ${key} diagnostics`, Boolean(hydration.json?.diagnostics?.sourceUsed && hydration.json?.diagnostics?.identitiesTried !== undefined), routeDetail(hydration));
    mark(`hydration ${key} has row fallback`, Boolean(hydration.json?.thread), routeDetail(hydration));

    const deal = await call(`deal context ${key}`, `/api/cockpit/deal-context/thread/${encodeURIComponent(key)}`);
    mark(`deal context ${key} ok/degraded`, deal.json?.ok === true, routeDetail(deal));

    const pid = propertyId(row) || clean(hydration.json?.property?.property_id || hydration.json?.property?.id);
    if (pid) {
      const valuation = await call(`valuation ${pid}`, `/api/cockpit/properties/${encodeURIComponent(pid)}/valuation-snapshot`);
      mark(`valuation ${pid} ok/degraded`, valuation.json?.ok === true, routeDetail(valuation));
    } else {
      mark(`valuation skipped ${key}`, true, "no property_id available");
    }
  }

  if (failures > 0) {
    console.error(`FAIL inbox thread hydration proof failures=${failures} warnings=${warnings}`);
    process.exitCode = 1;
    return;
  }
  console.log(`PASS inbox thread hydration proof warnings=${warnings}`);
}

main().catch((error) => {
  console.error("FAIL inbox thread hydration proof crashed", error?.stack || error?.message || error);
  process.exitCode = 1;
});
