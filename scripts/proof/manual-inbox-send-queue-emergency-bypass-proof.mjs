#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { register } from "node:module";
import { pathToFileURL } from "node:url";
import { createClient } from "@supabase/supabase-js";

const ROOT = path.resolve(new URL("../..", import.meta.url).pathname);
const API_ROOT = path.join(ROOT, "apps/api");

process.chdir(API_ROOT);
register("./tests/alias-loader.mjs", pathToFileURL(`${API_ROOT}/`));

const envFiles = [
  path.join(ROOT, "apps/api/.env.local"),
  path.join(ROOT, "apps/api/.env.production.local"),
  path.join(ROOT, "apps/dashboard/.env.local"),
  path.join(ROOT, "apps/dashboard/.env"),
  path.join(ROOT, ".env.local"),
  path.join(ROOT, ".env"),
];

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

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY;

const supabase = SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY
  ? createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
      auth: { autoRefreshToken: false, persistSession: false },
    })
  : null;

let failures = 0;
let warnings = 0;

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

function isEmergencyStopActive(value) {
  const normalized = clean(value).toLowerCase();
  if (!normalized) return false;
  return !["0", "false", "off", "none", "null", "cleared", "clear"].includes(normalized);
}

function asDisabled(value) {
  return !["true", "1", "yes", "on", "enabled"].includes(clean(value).toLowerCase());
}

async function readControls() {
  if (!supabase) return {};
  const keys = ["queue_emergency_stop_at", "queue_auto_send_enabled"];
  const { data, error } = await supabase
    .from("system_control")
    .select("key,value")
    .in("key", keys);
  if (error) throw error;
  return Object.fromEntries((data || []).map((row) => [row.key, clean(row.value)]));
}

async function main() {
  const proofSessionId = `manual-inbox-provider-emergency-bypass-${Date.now()}`;
  console.log(`Manual inbox provider emergency bypass proof session=${proofSessionId}`);
  mark("Supabase service role loaded", Boolean(supabase));

  const [
    textgrid,
    queueSafety,
    inboxSendNow,
  ] = await Promise.all([
    import(pathToFileURL(path.join(API_ROOT, "src/lib/providers/textgrid.js")).href),
    import(pathToFileURL(path.join(API_ROOT, "src/lib/domain/queue/queue-control-safety.js")).href),
    import(pathToFileURL(path.join(API_ROOT, "src/lib/domain/inbox/send-now-service.js")).href),
  ]);

  const beforeControls = await readControls();
  mark(
    "emergency stop active before proof",
    isEmergencyStopActive(beforeControls.queue_emergency_stop_at),
    `queue_emergency_stop_at=${beforeControls.queue_emergency_stop_at || "empty"}`
  );
  mark(
    "queue_auto_send_enabled false before proof",
    asDisabled(beforeControls.queue_auto_send_enabled),
    `value=${beforeControls.queue_auto_send_enabled || "empty"}`
  );

  const runtimeBrake = queueSafety.evaluateQueueSendRuntimeBrakes(
    {
      queue_processor_mode: "live",
      queue_emergency_stop_at: beforeControls.queue_emergency_stop_at || "2026-05-31T12:00:00.000Z",
    },
    { action: "sendTextgridSMS" }
  );
  mark(
    "provider runtime brake sees queue emergency stop",
    runtimeBrake.ok === false && runtimeBrake.reason === "queue_emergency_stop_active",
    `reason=${runtimeBrake.reason || "none"}`
  );

  const manualDecision = textgrid.evaluateTextgridRuntimeBrakeForSend(runtimeBrake, {
    source: "manual_inbox",
    send_source: "manual_inbox",
    manual_operator_send: true,
    metadata: {
      source: "manual_inbox",
      send_source: "manual_inbox",
      manual_operator_send: true,
    },
  });
  mark(
    "provider safety allows manual_inbox past queue_emergency_stop_active",
    manualDecision.ok === true &&
      manualDecision.bypassed_queue_emergency_stop_for_manual_send === true &&
      manualDecision.metadata?.bypassed_queue_emergency_stop_for_manual_send === true,
    `bypassed=${manualDecision.bypassed_queue_emergency_stop_for_manual_send === true}`
  );

  const queueDecision = textgrid.evaluateTextgridRuntimeBrakeForSend(runtimeBrake, {
    source: "send_queue",
    send_source: "queue_runner",
    manual_operator_send: false,
    metadata: { source: "send_queue" },
  });
  mark(
    "provider safety still blocks queue runner context",
    queueDecision.ok === false && queueDecision.reason === "queue_emergency_stop_active",
    `reason=${queueDecision.reason || "none"}`
  );

  const campaignDecision = textgrid.evaluateTextgridRuntimeBrakeForSend(runtimeBrake, {
    source: "campaign",
    send_source: "campaign",
    metadata: { source: "campaign" },
  });
  mark(
    "provider safety still blocks campaign context",
    campaignDecision.ok === false && campaignDecision.reason === "queue_emergency_stop_active",
    `reason=${campaignDecision.reason || "none"}`
  );

  const autoReplyDecision = textgrid.evaluateTextgridRuntimeBrakeForSend(runtimeBrake, {
    source: "auto_reply",
    send_source: "automation",
    metadata: { source: "auto_reply" },
  });
  mark(
    "provider safety still blocks automation context",
    autoReplyDecision.ok === false && autoReplyDecision.reason === "queue_emergency_stop_active",
    `reason=${autoReplyDecision.reason || "none"}`
  );

  const complianceResult = await inboxSendNow.executeManualInboxSendNow(
    {
      thread_key: "+12146072916",
      to_phone_number: "+12146072916",
      from_phone_number: "+18885551212",
      message_body: "Manual proof message",
      queue_key: `inbox:send_now:${proofSessionId}`,
      source: "manual_inbox",
      send_source: "manual_inbox",
      manual_operator_send: true,
    },
    {
      getSystemValue: async (key) => {
        if (key === "queue_emergency_stop_at") return beforeControls.queue_emergency_stop_at;
        if (key === "campaign_mode") return "paused";
        return null;
      },
      hardComplianceCheckImpl: async () => ({ blocked: true, reason: "opt_out" }),
      insertImpl: async () => {
        throw new Error("proof should not insert send_queue rows after compliance block");
      },
      supabase: {
        from() {
          throw new Error("proof should not claim send_queue rows after compliance block");
        },
      },
    }
  );
  mark(
    "compliance block still blocks manual send",
    complianceResult.ok === false &&
      complianceResult.reason === "compliance_blocked" &&
      complianceResult.detail_reason === "opt_out" &&
      complianceResult.queue_inserted === false,
    `reason=${complianceResult.reason || "none"} detail=${complianceResult.detail_reason || "none"}`
  );

  const providerSource = fs.readFileSync(path.join(API_ROOT, "src/lib/providers/textgrid.js"), "utf8");
  const proofSource = fs.readFileSync(new URL(import.meta.url), "utf8");
  mark("provider proof does not call TextGrid transport", !/sendTextgridSMS\s*\(/.test(proofSource));
  mark("provider proof does not run queue", !/runSendQueue\s*\(/.test(proofSource) && !/processSendQueueItem\s*\(/.test(proofSource));
  mark("provider contains manual emergency bypass guard", providerSource.includes("bypassed_queue_emergency_stop_for_manual_send"));

  const afterControls = await readControls();
  mark(
    "emergency stop remains active after proof",
    isEmergencyStopActive(afterControls.queue_emergency_stop_at),
    `queue_emergency_stop_at=${afterControls.queue_emergency_stop_at || "empty"}`
  );
  mark(
    "queue_auto_send_enabled remains false after proof",
    asDisabled(afterControls.queue_auto_send_enabled),
    `value=${afterControls.queue_auto_send_enabled || "empty"}`
  );

  if (failures > 0) {
    console.error(`FAIL manual inbox provider emergency bypass proof failures=${failures} warnings=${warnings}`);
    process.exit(1);
  }
  console.log(`PASS manual inbox provider emergency bypass proof warnings=${warnings}`);
}

main().catch((error) => {
  console.error("FAIL manual inbox provider emergency bypass proof crashed", error?.stack || error?.message || error);
  process.exit(1);
});
