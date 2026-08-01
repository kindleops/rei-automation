#!/usr/bin/env node
// Internal live-proof runbook for the pinned canary row. One subcommand per
// operator step; every step is idempotent and prints exactly what it did.
//
// Usage: node scripts/ops/internal-proof-runbook.mjs <step> [--env .env.local]
//
// Steps, in order:
//   status        read-only posture check (row, system_control, authorizations)
//   open-session  write the bounded internal_proof_session (2h, pinned targets)
//   arm           (mode must be paused) pull scheduled_for back via the guarded
//                 RPC, then set queue_execution_mode=scoped_canary_only
//   mint          create a fresh single-use authorization for the pinned row;
//                 prints canary_run_id + token for the fire step
//   fire          POST the scoped canary to /api/internal/queue/run
//   verify        read-only: row status, provider sid, delivery, inbound reply,
//                 auto-reply queue rows on the internal thread
//   stamp-reply   stamp campaign_id onto the newest internal auto-reply row so
//                 the reply leg is scoped-canary dispatchable (audited patch)
//   mint-reply    mint an authorization for that reply row
//   fire-reply    dispatch the reply row via a second scoped canary run
//   close         restore queue_execution_mode=paused and expire the session
import { readFileSync } from "node:fs";
import crypto from "node:crypto";
import path from "node:path";
import { createClient } from "@supabase/supabase-js";

const PINNED = {
  row: "4d211395-bc7b-4bfe-8afb-16a329e636a4",
  campaign: "b7c9a000-7ad3-468b-9b9b-4647dbefc35f",
  recipient: "+16128072000",
  sender: "+16128060495",
  host: "https://api-steel-three-96.vercel.app",
};

function argValue(flag, fallback) {
  const index = process.argv.indexOf(flag);
  return index > -1 ? process.argv[index + 1] : fallback;
}

const step = process.argv[2];
const envFile = argValue("--env", ".env.local");
for (const line of readFileSync(path.resolve(process.cwd(), envFile), "utf8").split("\n")) {
  const m = line.match(/^([A-Z_]+)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^"|"$/g, "");
}

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

async function getControl(key) {
  const { data } = await supabase.from("system_control").select("value").eq("key", key).maybeSingle();
  return data?.value ?? null;
}

async function setControl(key, value) {
  const { error } = await supabase
    .from("system_control")
    .upsert({ key, value, updated_at: new Date().toISOString() }, { onConflict: "key" });
  if (error) throw error;
}

async function loadRow(id) {
  const { data, error } = await supabase.from("send_queue").select("*").eq("id", id).maybeSingle();
  if (error) throw error;
  return data;
}

const steps = {
  async status() {
    const row = await loadRow(PINNED.row);
    console.log("pinned row:", {
      queue_status: row?.queue_status,
      scheduled_for: row?.scheduled_for,
      provider_message_id: row?.provider_message_id,
      is_locked: row?.is_locked,
    });
    for (const key of ["queue_execution_mode", "internal_proof_session", "auto_reply_mode", "followup_automation_mode"]) {
      console.log(key, "=", await getControl(key));
    }
    const { data: lock } = await supabase.from("queue_global_execution_lock").select("*").eq("id", 1).maybeSingle();
    console.log("global lock:", lock);
  },

  async "open-session"() {
    const now = new Date();
    const session = {
      session_id: `proof-${now.toISOString().replace(/[-:.]/g, "").slice(0, 15)}Z`,
      campaign_id: PINNED.campaign,
      queue_row_id: PINNED.row,
      recipient: PINNED.recipient,
      sender: PINNED.sender,
      created_at: now.toISOString(),
      expires_at: new Date(now.getTime() + 2 * 60 * 60 * 1000).toISOString(),
      allow_thread_auto_replies: true,
      opened_by: "operator_internal_proof_runbook",
    };
    await setControl("internal_proof_session", JSON.stringify(session));
    console.log("session opened:", session);
  },

  async arm() {
    const mode = String((await getControl("queue_execution_mode")) || "").toLowerCase();
    if (!["paused", "pause", "stopped"].includes(mode)) {
      throw new Error(`arm requires stopped/paused mode, found '${mode}'`);
    }
    const { data, error } = await supabase.rpc("queue_guarded_mutate_scheduled_for", {
      p_row_ids: [PINNED.row],
      p_scheduled_for: new Date().toISOString(),
      p_operator_reason: "internal_proof_session_arm",
      p_metadata: { internal_proof: true },
    });
    if (error) throw error;
    if (data?.ok !== true) throw new Error(`guarded mutate refused: ${JSON.stringify(data)}`);
    console.log("scheduled_for pulled to now:", data);
    await setControl("queue_execution_mode", "scoped_canary_only");
    console.log("queue_execution_mode -> scoped_canary_only");
  },

  async mint() {
    await mintAuthorization(PINNED.row, `canary-proof-${Date.now()}`);
  },

  async fire() {
    const run_id = argValue("--run-id");
    const token = argValue("--token");
    if (!run_id || !token) throw new Error("fire requires --run-id and --token from mint");
    await fireCanary(PINNED.row, run_id, token);
  },

  async verify() {
    const row = await loadRow(PINNED.row);
    console.log("pinned row:", {
      queue_status: row?.queue_status,
      provider_message_id: row?.provider_message_id,
      sent_at: row?.sent_at,
      contact_window_bypass: row?.metadata?.contact_window_bypass || null,
    });
    const { data: events } = await supabase
      .from("message_events")
      .select("id,direction,provider_message_sid,message_body,delivery_status,detected_intent,auto_reply_status,created_at")
      .eq("thread_key", PINNED.recipient)
      .order("created_at", { ascending: false })
      .limit(8);
    console.log("thread events (newest first):");
    for (const e of events || []) {
      console.log(" ", e.created_at, e.direction, e.provider_message_sid, e.delivery_status || "-", e.detected_intent || "-", JSON.stringify(String(e.message_body || "").slice(0, 60)));
    }
    const { data: replies } = await supabase
      .from("send_queue")
      .select("id,queue_status,campaign_id,scheduled_for,message_body,metadata,created_at")
      .eq("to_phone_number", PINNED.recipient)
      .neq("id", PINNED.row)
      .order("created_at", { ascending: false })
      .limit(3);
    console.log("auto-reply queue rows:");
    for (const r of replies || []) {
      console.log(" ", r.id, r.queue_status, "campaign:", r.campaign_id, JSON.stringify(String(r.message_body || "").slice(0, 60)));
    }
    const { data: state } = await supabase
      .from("inbox_thread_state")
      .select("thread_key,inbox_bucket,lifecycle_stage,operational_status,lead_temperature,disposition,automation_status,last_intent,updated_at")
      .eq("thread_key", PINNED.recipient)
      .maybeSingle();
    console.log("thread state:", state);
    const { data: ledger } = await supabase
      .from("inbound_processing_ledger")
      .select("idempotency_key,status,terminal_disposition,detected_intent,completed_at")
      .eq("thread_key", PINNED.recipient)
      .order("created_at", { ascending: false })
      .limit(3);
    console.log("inbound ledger:", ledger);
  },

  async "stamp-reply"() {
    const { data: replies, error } = await supabase
      .from("send_queue")
      .select("id,queue_status,campaign_id,metadata,created_at")
      .eq("to_phone_number", PINNED.recipient)
      .neq("id", PINNED.row)
      .in("queue_status", ["queued", "scheduled", "pending", "ready", "approved"])
      .order("created_at", { ascending: false })
      .limit(1);
    if (error) throw error;
    const reply = replies?.[0];
    if (!reply) throw new Error("no pending internal auto-reply row found");
    if (reply.campaign_id && reply.campaign_id !== PINNED.campaign) {
      throw new Error(`reply row carries foreign campaign ${reply.campaign_id}`);
    }
    const { error: update_error } = await supabase
      .from("send_queue")
      .update({
        campaign_id: PINNED.campaign,
        metadata: {
          ...(reply.metadata || {}),
          internal_canary: true,
          campaign_id_stamped_for_internal_proof: true,
          campaign_stamped_at: new Date().toISOString(),
        },
      })
      .eq("id", reply.id);
    if (update_error) throw update_error;
    console.log("stamped reply row:", reply.id);
  },

  async "mint-reply"() {
    const { data: replies } = await supabase
      .from("send_queue")
      .select("id")
      .eq("to_phone_number", PINNED.recipient)
      .eq("campaign_id", PINNED.campaign)
      .neq("id", PINNED.row)
      .in("queue_status", ["queued", "scheduled", "pending", "ready", "approved"])
      .order("created_at", { ascending: false })
      .limit(1);
    const reply = replies?.[0];
    if (!reply) throw new Error("no stamped reply row found");
    await mintAuthorization(reply.id, `canary-proof-reply-${Date.now()}`);
  },

  async "fire-reply"() {
    const run_id = argValue("--run-id");
    const token = argValue("--token");
    const row_id = argValue("--row-id");
    if (!run_id || !token || !row_id) throw new Error("fire-reply requires --run-id --token --row-id");
    await fireCanary(row_id, run_id, token);
  },

  async close() {
    await setControl("queue_execution_mode", "paused");
    const raw = await getControl("internal_proof_session");
    if (raw) {
      try {
        const session = JSON.parse(raw);
        session.expires_at = new Date(Date.now() - 1000).toISOString();
        session.closed_at = new Date().toISOString();
        await setControl("internal_proof_session", JSON.stringify(session));
      } catch {
        await setControl("internal_proof_session", "");
      }
    }
    console.log("queue_execution_mode -> paused; internal_proof_session expired");
  },
};

async function mintAuthorization(row_id, run_id) {
  const token = crypto.randomBytes(32).toString("hex");
  const token_hash = crypto.createHash("sha256").update(token, "utf8").digest("hex");
  const { data, error } = await supabase
    .from("queue_canary_authorizations")
    .insert({
      canary_run_id: run_id,
      campaign_id: PINNED.campaign,
      queue_row_ids: [row_id],
      authorization_token_hash: token_hash,
      expires_at: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
      metadata: { internal_proof: true, target_row: row_id },
    })
    .select("id,canary_run_id,expires_at")
    .single();
  if (error) throw error;
  console.log("authorization minted:", data);
  console.log("RUN_ID:", run_id);
  console.log("TOKEN:", token);
  console.log("ROW_ID:", row_id);
}

async function fireCanary(row_id, run_id, token) {
  const secret =
    process.env.SCOPED_CANARY_EXECUTION_SECRET || process.env.QUEUE_ENGINE_SHARED_SECRET;
  if (!secret) throw new Error("no scoped canary secret in env");
  const response = await fetch(`${PINNED.host}/api/internal/queue/run`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-scoped-canary-secret": secret,
      "x-canary-authorization-token": token,
    },
    body: JSON.stringify({
      scoped_canary: true,
      campaign_id: PINNED.campaign,
      canary_run_id: run_id,
      queue_row_ids: [row_id],
      max_rows: 1,
    }),
  });
  const body = await response.json().catch(() => ({}));
  console.log("HTTP", response.status);
  console.log(JSON.stringify(body, null, 2));
}

if (!steps[step]) {
  console.error(`unknown step '${step}'. valid: ${Object.keys(steps).join(", ")}`);
  process.exit(1);
}
await steps[step]().catch((error) => {
  console.error("STEP FAILED:", error?.message || error);
  process.exit(1);
});
