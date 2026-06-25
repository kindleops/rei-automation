#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { register } from "node:module";
import { pathToFileURL } from "node:url";
import { createClient } from "@supabase/supabase-js";

const ROOT = path.resolve(new URL("../../../..", import.meta.url).pathname);
const API_ROOT = path.join(ROOT, "apps/api");
const DASH_ROOT = path.join(ROOT, "apps/dashboard");
const OUT_DIR = path.join(DASH_ROOT, "proof/inbox");
fs.mkdirSync(OUT_DIR, { recursive: true });

process.chdir(API_ROOT);
register("./tests/alias-loader.mjs", pathToFileURL(`${API_ROOT}/`));

const envFiles = [
  path.join(API_ROOT, ".env.local"),
  path.join(API_ROOT, ".env.production.local"),
  path.join(DASH_ROOT, ".env.local"),
  path.join(DASH_ROOT, ".env"),
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
const OPS_SECRET =
  process.env.OPS_DASHBOARD_SECRET ||
  process.env.VITE_OPS_DASHBOARD_SECRET ||
  process.env.INTERNAL_API_SECRET;
const API_BASE = clean(process.env.VITE_BACKEND_API_URL || process.env.APP_BASE_URL || "http://127.0.0.1:3000");

const supabase =
  SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY
    ? createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
        auth: { autoRefreshToken: false, persistSession: false },
      })
    : null;

let failures = 0;

function mark(label, condition, detail = "") {
  const line = `${condition ? "PASS" : "FAIL"} ${label}${detail ? ` ${detail}` : ""}`;
  if (condition) {
    console.log(line);
    return true;
  }
  failures += 1;
  console.error(line);
  return false;
}

async function pickThread() {
  const res = await fetch(`${API_BASE}/api/cockpit/inbox/live?filter=all&limit=5`, {
    headers: { "x-ops-dashboard-secret": OPS_SECRET },
  });
  const body = await res.json();
  const thread = (body?.threads || body?.data?.threads || []).find((row) => {
    const phone = clean(
      row?.canonical_e164 || row?.seller_phone || row?.phone || row?.phone_number || row?.thread_key
    );
    return /^\+1\d{10}$/.test(phone);
  });
  return thread || null;
}

async function main() {
  const proofSessionId = `manual-send-schema-proof-${Date.now()}`;
  const messageBody = `Schema proof ${proofSessionId.slice(-8)}`;

  const { buildSendQueueInsertPayload, SEND_QUEUE_INSERT_COLUMNS } = await import(
    pathToFileURL(path.join(API_ROOT, "src/lib/supabase/sms-engine.js")).href
  );

  const beforePayloadShape = {
    queue_key: `inbox:send_now:${proofSessionId}`,
    queue_status: "queued",
    message_body: messageBody,
    to_phone_number: "+12146072916",
    from_phone_number: "+18885551212",
    thread_key: "+12146072916",
    agent_id: "legacy-agent-proof-701",
    metadata: { source: "manual_inbox", action: "send_now" },
  };

  const afterPayload = buildSendQueueInsertPayload(beforePayloadShape, new Date().toISOString());
  const insertColumnSet = new Set(SEND_QUEUE_INSERT_COLUMNS);

  mark("supabase service role loaded", Boolean(supabase));
  mark("ops dashboard secret loaded", Boolean(OPS_SECRET));
  mark("after payload excludes agent_id", !("agent_id" in afterPayload));
  mark(
    "legacy agent_id mapped to sms_agent_id",
    afterPayload.sms_agent_id === "legacy-agent-proof-701"
  );
  mark(
    "after payload only uses verified columns",
    Object.keys(afterPayload).every((key) => insertColumnSet.has(key))
  );

  const thread = await pickThread();
  mark("resolved live inbox thread", Boolean(thread), thread?.thread_key || "none");

  const toPhone = clean(thread?.canonical_e164 || thread?.seller_phone || thread?.thread_key);
  const fromPhone = clean(thread?.our_number || thread?.sender_phone);
  const threadKey = clean(thread?.thread_key || toPhone);

  const requestPayload = {
    thread_key: threadKey,
    to_phone_number: toPhone,
    from_phone_number: fromPhone || undefined,
    message_body: messageBody,
    message_text: messageBody,
    source: "manual_inbox",
    action: "send_now",
    created_from: "leadcommand_inbox",
    manual_operator_send: true,
    agent_id: "legacy-agent-proof-701",
    queue_key: `inbox:send_now:${proofSessionId}`,
    metadata: {
      source: "manual_inbox",
      action: "send_now",
      proof_session_id: proofSessionId,
    },
  };

  const sendRes = await fetch(`${API_BASE}/api/cockpit/inbox/send-now`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-ops-dashboard-secret": OPS_SECRET,
    },
    body: JSON.stringify(requestPayload),
  });
  const sendBody = await sendRes.json();

  mark(
    "live send-now API succeeded",
    sendRes.ok && sendBody?.ok === true,
    `status=${sendRes.status} reason=${sendBody?.reason || sendBody?.error || "none"}`
  );
  mark(
    "no queue_insert_failure",
    clean(sendBody?.reason).toLowerCase() !== "queue_insert_failure" &&
      clean(sendBody?.error).toLowerCase() !== "queue_insert_failure",
    `reason=${sendBody?.reason || sendBody?.error || "none"}`
  );

  const queueRowId = clean(sendBody?.queue_row_id || sendBody?.queue_audit_id);
  const messageEventId = clean(sendBody?.message_event_id);
  const providerMessageId = clean(
    sendBody?.provider_message_id || sendBody?.provider_message_sid
  );

  let queueRow = null;
  let messageEvent = null;
  if (supabase && queueRowId) {
    const queueResult = await supabase.from("send_queue").select("*").eq("id", queueRowId).maybeSingle();
    queueRow = queueResult.data || null;
    mark("send_queue row exists", Boolean(queueRow), queueRowId);
    mark(
      "send_queue row has no agent_id column value in payload fields",
      queueRow ? !Object.prototype.hasOwnProperty.call(queueRow, "agent_id") : false
    );
    mark(
      "provider dispatch recorded on queue row",
      Boolean(clean(queueRow?.provider_message_id || queueRow?.textgrid_message_id)),
      clean(queueRow?.provider_message_id || queueRow?.textgrid_message_id) || "missing"
    );
  }

  if (supabase && messageEventId) {
    const eventResult = await supabase
      .from("message_events")
      .select("id,provider_message_sid,direction,event_type,delivery_status,thread_key,queue_id")
      .eq("id", messageEventId)
      .maybeSingle();
    messageEvent = eventResult.data || null;
    mark("message_events row exists", Boolean(messageEvent), messageEventId);
  } else if (supabase && queueRowId) {
    const eventResult = await supabase
      .from("message_events")
      .select("id,provider_message_sid,direction,event_type,delivery_status,thread_key,queue_id")
      .eq("queue_id", queueRowId)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    messageEvent = eventResult.data || null;
    mark("message_events row exists via queue_id", Boolean(messageEvent), clean(messageEvent?.id));
  }

  const duplicateCount = supabase
    ? (
        await supabase
          .from("send_queue")
          .select("id", { count: "exact", head: true })
          .eq("to_phone_number", toPhone)
          .contains("metadata", { proof_session_id: proofSessionId })
      ).count ?? 0
    : 0;
  mark("no duplicate send_queue row for proof session", duplicateCount <= 1, `count=${duplicateCount}`);

  const proof = {
    status: failures === 0 ? "MANUAL_INBOX_SEND_NOW_SCHEMA_PROOF_PASS" : "MANUAL_INBOX_SEND_NOW_SCHEMA_PROOF_FAIL",
    proofSessionId,
    beforePayloadShape: {
      ...beforePayloadShape,
      note: "agent_id was incorrectly included in insert payload before fix",
    },
    afterPayload,
    liveRequestPayload: requestPayload,
    apiResponse: sendBody,
    queueRowId: queueRowId || null,
    providerMessageId: providerMessageId || clean(queueRow?.provider_message_id) || null,
    messageEventId: messageEventId || clean(messageEvent?.id) || null,
    queueRow: queueRow
      ? {
          id: queueRow.id,
          queue_status: queueRow.queue_status,
          provider_message_id: queueRow.provider_message_id,
          sms_agent_id: queueRow.sms_agent_id,
          selected_agent_id: queueRow.selected_agent_id,
        }
      : null,
    messageEvent,
    failures,
  };

  const outPath = path.join(OUT_DIR, "manual-send-now-schema-proof.json");
  fs.writeFileSync(outPath, JSON.stringify(proof, null, 2));
  console.log(`Wrote proof artifact ${outPath}`);

  if (failures > 0) {
    console.error(`FAIL manual inbox send-now schema proof failures=${failures}`);
    process.exit(1);
  }
  console.log("PASS manual inbox send-now schema proof");
}

main().catch((error) => {
  console.error("FAIL manual inbox send-now schema proof crashed", error?.stack || error?.message || error);
  process.exit(1);
});