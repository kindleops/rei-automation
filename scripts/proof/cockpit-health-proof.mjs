#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { callProofJson, formatProofHttp401Diagnostic } from "./proof-http-client.mjs";

const ROOT = path.resolve(new URL("../..", import.meta.url).pathname);
const PRIMARY_THREAD_SOURCE = "v_inbox_threads_live_v2";
const PRIMARY_COUNT_SOURCE = "v_inbox_thread_counts_live_v2";

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
  const lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/);
  for (const rawLine of lines) {
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

const BASE_URL = String(
  process.env.COCKPIT_PROOF_BASE_URL ||
  process.env.API_URL ||
  process.env.LOCAL_API_URL ||
  "http://localhost:3000"
).replace(/\/$/, "");

const OPS_SECRET =
  process.env.OPS_DASHBOARD_SECRET ||
  process.env.VITE_OPS_DASHBOARD_SECRET ||
  process.env.VITE_BACKEND_API_SECRET ||
  "";

const CRON_SECRET = process.env.CRON_SECRET || "";
const QUEUE_ENGINE_SECRET = process.env.QUEUE_ENGINE_SHARED_SECRET || "";

const results = [];
let failures = 0;
let warnings = 0;

function asBool(value) {
  return value === true || String(value).toLowerCase() === "true";
}

function headers(extra = {}) {
  const h = {
    "content-type": "application/json",
    accept: "application/json",
    origin: "http://localhost:5173",
    ...extra,
  };
  if (OPS_SECRET) h["x-ops-dashboard-secret"] = OPS_SECRET;
  return h;
}

function feederHeaders() {
  const h = headers();
  if (CRON_SECRET) h.authorization = `Bearer ${CRON_SECRET}`;
  if (QUEUE_ENGINE_SECRET) h["x-queue-engine-secret"] = QUEUE_ENGINE_SECRET;
  return h;
}

function encodePathSegment(value) {
  return encodeURIComponent(String(value ?? ""));
}

function getThreadKey(row = {}) {
  return String(row.thread_key || row.threadKey || row.id || "").trim();
}

function getPropertyId(row = {}) {
  return String(row.property_id || row.propertyId || row.final_property_id || "").trim();
}

function degradedFromJson(json = {}) {
  return Boolean(
    json.degraded ||
    json.fallback ||
    json.partial ||
    json.countsDegraded ||
    json.diagnostics?.countsDegraded ||
    json.diagnostics?.degraded
  );
}

function sourceFromLive(json = {}) {
  return json.source || json.diagnostics?.source || json.diagnostics?.live_source || null;
}

function countsSourceFromLive(json = {}) {
  return json.countsSource || json.diagnostics?.countsSource || null;
}

async function callJson(label, pathOrUrl, options = {}) {
  const result = await callProofJson({
    root: ROOT,
    baseUrl: BASE_URL,
    pathOrUrl,
    label,
    method: options.method || "GET",
    headers: options.headers || headers(),
    body: options.body,
    timeoutSeconds: options.timeout_seconds || 60,
  });
  result.degraded = degradedFromJson(result.json || {});
  results.push(result);
  return result;
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
  const parts = [`status=${result.status || "ERR"}`, `${result.ms}ms`];
  if (result.degraded) parts.push("degraded=true");
  const authDiagnostic = formatProofHttp401Diagnostic(result);
  if (authDiagnostic) parts.push(authDiagnostic);
  if (result.error) parts.push(`error=${result.error}`);
  return `[${parts.join(" ")}]`;
}

function requireSecrets() {
  mark("OPS dashboard secret loaded", Boolean(OPS_SECRET));
  mark(
    "feeder auth secret loaded",
    Boolean(CRON_SECRET || QUEUE_ENGINE_SECRET),
    "(CRON_SECRET or QUEUE_ENGINE_SHARED_SECRET)",
    true,
  );
}

async function main() {
  console.log(`Cockpit health proof base=${BASE_URL}`);
  console.log("Cockpit health proof mode=production-safe-read-only; feeder check uses dry_run=true.");
  requireSecrets();
  mark("health proof mutating seller sends disabled", true, "no live queue run or seller send endpoints are called");

  const live = await callJson(
    "live inbox",
    "/api/cockpit/inbox/live?filter=all&limit=5&timeout_mode=initial_boot",
  );
  const liveJson = live.json || {};
  const liveRows = Array.isArray(liveJson.threads)
    ? liveJson.threads
    : Array.isArray(liveJson.messages)
      ? liveJson.messages
      : [];
  const liveSource = sourceFromLive(liveJson);
  const countsSource = countsSourceFromLive(liveJson);

  mark(
    "live inbox route",
    live.status === 200 && liveJson.ok === true,
    `${routeDetail(live)} source=${liveSource || "unknown"} countsSource=${countsSource || "unknown"}`,
  );
  mark(
    "live inbox primary source",
    liveSource === PRIMARY_THREAD_SOURCE && asBool(liveJson.fallback_used) === false,
    `source=${liveSource || "unknown"}`,
  );
  mark(
    "live inbox primary counts source",
    countsSource === PRIMARY_COUNT_SOURCE,
    `countsSource=${countsSource || "unknown"}`,
  );
  mark("live inbox returned rows", liveRows.length > 0, `rows=${liveRows.length}`);

  const selectedRows = liveRows.slice(0, 5);
  const selected = selectedRows.map((row) => ({
    threadKey: getThreadKey(row),
    propertyId: getPropertyId(row),
    canonicalE164: row.canonical_e164 || row.canonicalE164 || "",
    phone: row.phone || "",
    bestPhone: row.best_phone || row.bestPhone || "",
    sellerPhone: row.seller_phone || row.sellerPhone || "",
  })).filter((row) => row.threadKey);

  console.log(`Selected threads=${selected.map((row) => row.threadKey).join(", ") || "(none)"}`);

  for (const row of selected) {
    const params = new URLSearchParams({
      thread_key: row.threadKey,
      limit: "200",
    });
    if (row.canonicalE164) params.set("canonical_e164", row.canonicalE164);
    if (row.phone) params.set("phone", row.phone);
    if (row.bestPhone) params.set("best_phone", row.bestPhone);
    if (row.sellerPhone) params.set("seller_phone", row.sellerPhone);

    const messages = await callJson(
      `thread messages ${row.threadKey}`,
      `/api/cockpit/inbox/thread-messages?${params.toString()}`,
    );
    mark(
      `thread messages ${row.threadKey}`,
      messages.status === 200 && messages.json?.ok === true,
      routeDetail(messages),
    );

    const context = await callJson(
      `deal context ${row.threadKey}`,
      `/api/cockpit/deal-context/thread/${encodePathSegment(row.threadKey)}`,
    );
    mark(
      `deal context ${row.threadKey}`,
      context.status === 200,
      `${routeDetail(context)} ok=${context.json?.ok}`,
    );

    if (row.propertyId) {
      const valuation = await callJson(
        `valuation ${row.propertyId}`,
        `/api/cockpit/properties/${encodePathSegment(row.propertyId)}/valuation-snapshot`,
      );
      mark(
        `valuation ${row.propertyId}`,
        valuation.status === 200,
        `${routeDetail(valuation)} ok=${valuation.json?.ok}`,
      );
    } else {
      mark(`valuation skipped ${row.threadKey}`, true, "property_id missing");
    }
  }

  const metrics = await callJson("ops metrics", "/api/cockpit/ops/metrics?window=today");
  mark(
    "ops metrics",
    metrics.status === 200 && metrics.json?.ok === true,
    routeDetail(metrics),
  );

  const queueControl = await callJson("queue control", "/api/cockpit/queue/control");
  mark(
    "queue control",
    queueControl.status === 200 && queueControl.json?.ok === true,
    routeDetail(queueControl),
  );

  const feeder = await callJson(
    "feeder dry-run",
    "/api/internal/outbound/feed-candidates?dry_run=true&limit=1&scan_limit=25",
    { headers: feederHeaders() },
  );
  const feederDryRun = feeder.json?.dry_run === true || feeder.json?.dryRun === true;
  mark(
    "feeder dry-run endpoint",
    feeder.status > 0 && feeder.status < 500 && (feederDryRun || feeder.json?.ok === false),
    `${routeDetail(feeder)} ok=${feeder.json?.ok} dry_run=${feeder.json?.dry_run}`,
    feeder.status === 401 || feeder.status === 403 || feeder.status === 423,
  );

  console.log("");
  console.log("Route summary:");
  for (const result of results) {
    const json = result.json || {};
    const source = sourceFromLive(json);
    const countSource = countsSourceFromLive(json);
    const extra = [
      source ? `source=${source}` : null,
      countSource ? `countsSource=${countSource}` : null,
      result.degraded ? "degraded=true" : null,
    ].filter(Boolean).join(" ");
    console.log(`- ${result.label}: status=${result.status || "ERR"} ms=${result.ms}${extra ? ` ${extra}` : ""}`);
  }

  console.log("");
  console.log("Realtime proof: local reducer-level coverage is in apps/dashboard/scripts/proof/inbox-store-proof.ts and uses an internal test phone. Live DB insertion is intentionally skipped here.");

  if (failures > 0) {
    console.error(`FAIL cockpit health proof failures=${failures} warnings=${warnings}`);
    process.exit(1);
  }
  console.log(`PASS cockpit health proof warnings=${warnings}`);
}

main().catch((error) => {
  console.error("FAIL cockpit health proof crashed", error?.stack || error?.message || error);
  process.exit(1);
});
