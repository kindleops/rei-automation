#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { callProofJson } from "./proof-http-client.mjs";

const ROOT = path.resolve(new URL("../..", import.meta.url).pathname);
const DASHBOARD_INBOX_ADAPTER = path.join(ROOT, "apps/dashboard/src/modules/inbox/inbox.adapter.ts");
const DASHBOARD_INBOX_PAGE = path.join(ROOT, "apps/dashboard/src/modules/inbox/InboxPage.tsx");
const API_THREAD_MESSAGES = path.join(ROOT, "apps/api/src/lib/domain/inbox/live-inbox-service.js");

let failures = 0;
let warnings = 0;

function clean(value) {
  return String(value ?? "").trim();
}

function read(filePath) {
  return fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf8") : "";
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

function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return;
  for (const rawLine of fs.readFileSync(filePath, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const equalsIndex = line.indexOf("=");
    if (equalsIndex <= 0) continue;
    const key = line.slice(0, equalsIndex).replace(/^export\s+/, "").trim();
    let value = line.slice(equalsIndex + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    if (value && !process.env[key]) process.env[key] = value;
  }
}

for (const file of [
  path.join(ROOT, "apps/api/.env.local"),
  path.join(ROOT, "apps/dashboard/.env.local"),
  path.join(ROOT, ".env.local"),
]) loadEnvFile(file);

async function optionalLiveSmoke() {
  const baseUrl = clean(process.env.COCKPIT_PROOF_BASE_URL || process.env.API_URL);
  if (!baseUrl) {
    mark("optional live smoke skipped", true, "COCKPIT_PROOF_BASE_URL not set");
    return;
  }
  const headers = { accept: "application/json", origin: "http://localhost:5173" };
  if (process.env.OPS_DASHBOARD_SECRET) headers["x-ops-dashboard-secret"] = process.env.OPS_DASHBOARD_SECRET;
  const result = await callProofJson({
    root: ROOT,
    baseUrl,
    pathOrUrl: "/api/cockpit/inbox/live?filter=all&limit=3&map=0&timeout_mode=auto_refresh",
    headers,
    timeoutSeconds: 30,
  });
  mark("optional live smoke JSON", result.status === 200 && result.json?.ok === true, `status=${result.status} error=${result.error || ""}`, true);
}

async function main() {
  console.log("Inbox live message merge proof mode=no-send; no TextGrid/provider/send_queue mutation is executed.");

  const adapter = read(DASHBOARD_INBOX_ADAPTER);
  const page = read(DASHBOARD_INBOX_PAGE);
  const service = read(API_THREAD_MESSAGES);
  const proofSource = fs.readFileSync(new URL(import.meta.url), "utf8");

  mark("global realtime subscribes to message_events", adapter.includes("table: 'message_events'") && adapter.includes("REALTIME_PATCH_THREAD"));
  mark("global realtime patches latest message body", adapter.includes("latestMessageBody") && adapter.includes("latest_message_body"));
  mark("global realtime moves buckets and count deltas", adapter.includes("buildRealtimeCountDeltas") && adapter.includes("targetBucketKey"));
  mark("global polling fallback is focused and lightweight", adapter.includes("const POLL_INTERVAL_MS = 15_000") && adapter.includes("document.hidden"));
  mark("selected thread realtime appends visible messages", page.includes("mergeRealtimeMessage") && page.includes("setSelectedMessages((current)"));
  mark("selected thread has 12s polling fallback", page.includes("selectedMessagePollInterval") && page.includes("12_000") && page.includes("getThreadMessagesForThread(selected"));
  mark("selected thread dedupes merged messages", page.includes("dedupeMessages([...current, ...messages])") && page.includes("messageCacheRef.current[selectedKey]"));
  mark("row fallback renders recovered latest activity", page.includes("buildRecoveredLatestActivityMessage") && page.includes("row_fallback"));
  mark("thread messages resolve multiple identities", service.includes("send_queue.thread_key") && service.includes("phone_numbers.canonical_e164") && service.includes("identitiesTried"));
  mark("proof does not call TextGrid send", !/sendTextgridSMS\s*\(|sendInboxMessageNow\s*\(|queueInboxReply\s*\(/.test(proofSource));

  mark(
    "synthetic insert skipped unless explicitly enabled",
    process.env.INBOX_LIVE_MERGE_INSERT_PROOF !== "true",
    "Set INBOX_LIVE_MERGE_INSERT_PROOF=true only after confirming the internal/proof phone allowlist.",
    true,
  );

  await optionalLiveSmoke();

  if (failures > 0) {
    console.error(`FAIL inbox live message merge proof failures=${failures} warnings=${warnings}`);
    process.exitCode = 1;
    return;
  }
  console.log(`PASS inbox live message merge proof warnings=${warnings}`);
}

main().catch((error) => {
  console.error("FAIL inbox live message merge proof crashed", error?.stack || error?.message || error);
  process.exitCode = 1;
});
