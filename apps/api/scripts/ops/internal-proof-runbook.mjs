#!/usr/bin/env node
// Internal live-proof runbook for the pinned canary row. One subcommand per
// operator step; every step is idempotent and prints exactly what it did.
//
// Usage: node scripts/ops/internal-proof-runbook.mjs <step> [--env .env.local]
//
// Steps, in order:
//   status        read-only posture check (row, system_control, authorizations)
//   open-session  write the bounded internal_proof_session (2h, pinned targets);
//                 re-running against a STILL-ACTIVE session renews it while
//                 preserving the original first-open created_at — the absolute
//                 lifetime cap is enforced from that first open, never reset
//   arm           (mode must be paused) pull scheduled_for back via the guarded
//                 RPC, then set queue_execution_mode=scoped_canary_only
//   mint          create a fresh single-use authorization for the pinned row;
//                 prints canary_run_id + token for the fire step
//   fire          POST the scoped canary to /api/internal/queue/run
//   verify        read-only: row status, provider sid, delivery, inbound reply,
//                 auto-reply queue rows on the internal thread
//   stamp-reply   stamp campaign_id onto the newest internal auto-reply row so
//                 the reply leg is scoped-canary dispatchable. The write is the
//                 internal_proof_stamp_queue_row RPC: an atomic server-side
//                 jsonb merge (allowlisted stamp keys only) CASed on the
//                 observed queue_status — aborts if the row transitioned, and
//                 can never clobber concurrent metadata writers. Records the
//                 open proof session id + a fresh processing run id.
//   mint-reply    mint an authorization for that reply row
//   fire-reply    dispatch the reply row via a second scoped canary run
//   close         restore queue_execution_mode=paused and expire the session;
//                 only prints "expired" after the expiry write is read back
//                 and verified
import { readFileSync } from "node:fs";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";

export const PINNED = {
  row: "4d211395-bc7b-4bfe-8afb-16a329e636a4",
  campaign: "b7c9a000-7ad3-468b-9b9b-4647dbefc35f",
  recipient: "+16128072000",
  sender: "+16128060495",
  host: "https://api-steel-three-96.vercel.app",
};

// Mirrors INTERNAL_PROOF_SESSION_MAX_MINUTES in
// src/lib/domain/queue/internal-proof-session.js: the engine parser rejects any
// session whose expires_at - created_at exceeds this, so renewals must clamp to
// the same bound anchored at the FIRST open. Kept as a literal because this
// script runs under plain `node` without the @/ alias resolver.
export const SESSION_ABSOLUTE_MAX_MINUTES = 240;
const SESSION_OPEN_WINDOW_MS = 2 * 60 * 60 * 1000;

function argValue(flag, fallback) {
  const index = process.argv.indexOf(flag);
  return index > -1 ? process.argv[index + 1] : fallback;
}

function parseTimestamp(value) {
  const parsed = new Date(String(value ?? "")).getTime();
  return Number.isFinite(parsed) ? parsed : null;
}

function parseSessionValue(raw) {
  if (raw == null || raw === "") return null;
  try {
    const value = typeof raw === "string" ? JSON.parse(raw) : raw;
    return value && typeof value === "object" && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

function rpcFunctionMissing(error) {
  const msg = `${error?.message || ""} ${error?.details || ""}`.toLowerCase();
  return (
    error?.code === "42883" ||
    error?.code === "PGRST202" ||
    msg.includes("could not find the function")
  );
}

export function createInternalProofRunbook({ supabase, now = () => new Date(), log = console.log } = {}) {
  if (!supabase) throw new Error("createInternalProofRunbook requires a supabase client");

  async function getControl(key) {
    const { data, error } = await supabase.from("system_control").select("value").eq("key", key).maybeSingle();
    // Surface read errors: a transient failure must never be indistinguishable
    // from a missing key (close would otherwise skip the expiry write and
    // still report the session as expired).
    if (error) throw error;
    return data?.value ?? null;
  }

  async function setControl(key, value) {
    const { error } = await supabase
      .from("system_control")
      .upsert({ key, value, updated_at: now().toISOString() }, { onConflict: "key" });
    if (error) throw error;
  }

  async function loadRow(id) {
    const { data, error } = await supabase.from("send_queue").select("*").eq("id", id).maybeSingle();
    if (error) throw error;
    return data;
  }

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
        expires_at: new Date(now().getTime() + 30 * 60 * 1000).toISOString(),
        metadata: { internal_proof: true, target_row: row_id },
      })
      .select("id,canary_run_id,expires_at")
      .single();
    if (error) throw error;
    log("authorization minted:", data);
    log("RUN_ID:", run_id);
    log("TOKEN:", token);
    log("ROW_ID:", row_id);
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
    log("HTTP", response.status);
    log(JSON.stringify(body, null, 2));
  }

  const steps = {
    async status() {
      const row = await loadRow(PINNED.row);
      log("pinned row:", {
        queue_status: row?.queue_status,
        scheduled_for: row?.scheduled_for,
        provider_message_id: row?.provider_message_id,
        is_locked: row?.is_locked,
      });
      for (const key of ["queue_execution_mode", "internal_proof_session", "auto_reply_mode", "followup_automation_mode"]) {
        log(key, "=", await getControl(key));
      }
      const { data: lock } = await supabase.from("queue_global_execution_lock").select("*").eq("id", 1).maybeSingle();
      log("global lock:", lock);
    },

    async "open-session"() {
      const opened_at = now();
      // Absolute-lifetime preservation: re-running open-session against a
      // STILL-ACTIVE session renews it but must NOT reset the first-open
      // timestamp — otherwise repeated opens could extend the bypass forever.
      // Only an expired/absent/unparseable session starts a fresh lifetime.
      const existing = parseSessionValue(await getControl("internal_proof_session"));
      const existing_created_ts = parseTimestamp(existing?.created_at);
      const existing_expires_ts = parseTimestamp(existing?.expires_at);
      const existing_active =
        existing_created_ts !== null &&
        existing_expires_ts !== null &&
        existing_expires_ts > opened_at.getTime();

      const first_opened_ts = existing_active ? existing_created_ts : opened_at.getTime();
      const absolute_cap_ts = first_opened_ts + SESSION_ABSOLUTE_MAX_MINUTES * 60 * 1000;
      const expires_ts = Math.min(opened_at.getTime() + SESSION_OPEN_WINDOW_MS, absolute_cap_ts);
      if (expires_ts <= opened_at.getTime()) {
        throw new Error(
          `session absolute lifetime exhausted (first opened ${new Date(first_opened_ts).toISOString()}, ` +
            `hard cap ${SESSION_ABSOLUTE_MAX_MINUTES}m); run close, then open-session for a deliberate new session`
        );
      }

      const session = {
        session_id:
          existing_active && String(existing.session_id || "")
            ? String(existing.session_id)
            : `proof-${opened_at.toISOString().replace(/[-:.]/g, "").slice(0, 15)}Z`,
        campaign_id: PINNED.campaign,
        queue_row_id: PINNED.row,
        recipient: PINNED.recipient,
        sender: PINNED.sender,
        created_at: new Date(first_opened_ts).toISOString(),
        expires_at: new Date(expires_ts).toISOString(),
        allow_thread_auto_replies: true,
        opened_by: "operator_internal_proof_runbook",
      };
      if (existing_active) session.renewed_at = opened_at.toISOString();
      await setControl("internal_proof_session", JSON.stringify(session));
      log(existing_active ? "session renewed (first-open preserved):" : "session opened:", session);
    },

    async arm() {
      const mode = String((await getControl("queue_execution_mode")) || "").toLowerCase();
      if (!["paused", "pause", "stopped"].includes(mode)) {
        throw new Error(`arm requires stopped/paused mode, found '${mode}'`);
      }
      const { data, error } = await supabase.rpc("queue_guarded_mutate_scheduled_for", {
        p_row_ids: [PINNED.row],
        p_scheduled_for: now().toISOString(),
        p_operator_reason: "internal_proof_session_arm",
        p_metadata: { internal_proof: true },
      });
      if (error) throw error;
      if (data?.ok !== true) throw new Error(`guarded mutate refused: ${JSON.stringify(data)}`);
      log("scheduled_for pulled to now:", data);
      await setControl("queue_execution_mode", "scoped_canary_only");
      log("queue_execution_mode -> scoped_canary_only");
    },

    async mint() {
      await mintAuthorization(PINNED.row, `canary-proof-${now().getTime()}`);
    },

    async fire() {
      const run_id = argValue("--run-id");
      const token = argValue("--token");
      if (!run_id || !token) throw new Error("fire requires --run-id and --token from mint");
      await fireCanary(PINNED.row, run_id, token);
    },

    async verify() {
      const row = await loadRow(PINNED.row);
      log("pinned row:", {
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
      log("thread events (newest first):");
      for (const e of events || []) {
        log(" ", e.created_at, e.direction, e.provider_message_sid, e.delivery_status || "-", e.detected_intent || "-", JSON.stringify(String(e.message_body || "").slice(0, 60)));
      }
      const { data: replies } = await supabase
        .from("send_queue")
        .select("id,queue_status,campaign_id,scheduled_for,message_body,metadata,created_at")
        .eq("to_phone_number", PINNED.recipient)
        .neq("id", PINNED.row)
        .order("created_at", { ascending: false })
        .limit(3);
      log("auto-reply queue rows:");
      for (const r of replies || []) {
        log(" ", r.id, r.queue_status, "campaign:", r.campaign_id, JSON.stringify(String(r.message_body || "").slice(0, 60)));
      }
      const { data: state } = await supabase
        .from("inbox_thread_state")
        .select("thread_key,inbox_bucket,lifecycle_stage,operational_status,lead_temperature,disposition,automation_status,last_intent,updated_at")
        .eq("thread_key", PINNED.recipient)
        .maybeSingle();
      log("thread state:", state);
      const { data: ledger } = await supabase
        .from("inbound_processing_ledger")
        .select("idempotency_key,status,terminal_disposition,detected_intent,completed_at")
        .eq("thread_key", PINNED.recipient)
        .order("created_at", { ascending: false })
        .limit(3);
      log("inbound ledger:", ledger);
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
      // Atomic server-side stamp via internal_proof_stamp_queue_row: the RPC
      // CASes on the queue_status (and campaign state) observed above and
      // merges ONLY the allowlisted stamp keys with `metadata || stamp` in
      // one statement — a concurrent metadata writer (delivery reconcile,
      // inbound automation) can no longer be clobbered by a stale JS
      // snapshot, because no snapshot is ever written back.
      const observed_status = reply.queue_status;
      const session = parseSessionValue(await getControl("internal_proof_session"));
      const session_id = String(session?.session_id || argValue("--session-id", "") || "");
      if (!session_id) {
        throw new Error(
          "no active internal_proof_session found (run open-session first) and no --session-id " +
            "override given — stamp-reply refuses to stamp without a session reference"
        );
      }
      const processing_run_id = `stamp-${crypto.randomUUID()}`;
      const { data: stamped, error: stamp_error } = await supabase.rpc(
        "internal_proof_stamp_queue_row",
        {
          p_queue_row_id: reply.id,
          p_expected_status: observed_status,
          p_expected_campaign_id: reply.campaign_id || null,
          p_campaign_id: PINNED.campaign,
          p_stamp: {
            internal_canary: true,
            campaign_id_stamped_for_internal_proof: true,
            campaign_stamped_at: now().toISOString(),
          },
          p_proof_session_id: session_id,
          p_processing_run_id: processing_run_id,
        }
      );
      if (stamp_error) {
        if (rpcFunctionMissing(stamp_error)) {
          // No fallback to the old read-modify-write path exists by design:
          // that path is the metadata-clobber race this RPC was built to
          // close.
          throw new Error(
            "internal_proof_stamp_queue_row RPC is missing — apply migration " +
              "20260802092000_internal_proof_stamp_merge.sql before running stamp-reply " +
              "(there is deliberately no client-side fallback)"
          );
        }
        throw stamp_error;
      }
      if (stamped?.ok !== true) {
        throw new Error(
          `stamp refused for reply row ${reply.id}: ${stamped?.reason || "unknown"}` +
            (stamped?.current_status !== undefined
              ? ` (current status '${stamped.current_status}', campaign ${stamped.current_campaign_id ?? "null"})`
              : "") +
            " — nothing stamped, re-run stamp-reply"
        );
      }
      log(
        "stamped reply row:",
        reply.id,
        `(atomic merge; queue_status '${observed_status}' verified at write; session ${session_id}; run ${processing_run_id})`
      );
    },

    async "mint-reply"() {
      const { data: replies, error } = await supabase
        .from("send_queue")
        .select("id")
        .eq("to_phone_number", PINNED.recipient)
        .eq("campaign_id", PINNED.campaign)
        .neq("id", PINNED.row)
        .in("queue_status", ["queued", "scheduled", "pending", "ready", "approved"])
        .order("created_at", { ascending: false })
        .limit(1);
      // A transient read failure must not masquerade as "no row" — that
      // message sends the operator back to re-run stamp-reply for nothing.
      if (error) throw new Error(`mint-reply read failed: ${error.message}`);
      const reply = replies?.[0];
      if (!reply) throw new Error("no stamped reply row found");
      await mintAuthorization(reply.id, `canary-proof-reply-${now().getTime()}`);
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
      log("queue_execution_mode -> paused");
      // getControl throws on Supabase read errors, so a transient failure can
      // never be mistaken for "no session" — the step fails loudly and the
      // session (if any) keeps its own bounded expiry.
      const raw = await getControl("internal_proof_session");
      if (!raw) {
        log("internal_proof_session absent — nothing to expire");
        return;
      }
      const session = parseSessionValue(raw);
      let closed_value = "";
      if (session) {
        session.expires_at = new Date(now().getTime() - 1000).toISOString();
        session.closed_at = now().toISOString();
        closed_value = JSON.stringify(session);
      }
      await setControl("internal_proof_session", closed_value);
      // Never claim "expired" until the write is read back and verified: a
      // lost write would otherwise leave the bypass session live while the
      // operator believes it is closed.
      const verify_raw = await getControl("internal_proof_session");
      if (!closed_value) {
        if (verify_raw) {
          throw new Error("internal_proof_session clear did not persist — session value still present");
        }
        log("internal_proof_session cleared (unparseable value removed; verified)");
        return;
      }
      const verified = parseSessionValue(verify_raw);
      const verified_expires_ts = parseTimestamp(verified?.expires_at);
      if (verified_expires_ts === null || verified_expires_ts > now().getTime()) {
        throw new Error(
          "internal_proof_session expiry write did not verify on read-back — session may still be active"
        );
      }
      log("internal_proof_session expired (verified by read-back)");
    },
  };

  return steps;
}

// ── CLI entry ────────────────────────────────────────────────────────────────
const invoked_as_script =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invoked_as_script) {
  const step = process.argv[2];
  const envFile = argValue("--env", ".env.local");
  for (const line of readFileSync(path.resolve(process.cwd(), envFile), "utf8").split("\n")) {
    const m = line.match(/^([A-Z_]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^"|"$/g, "");
  }

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
  });

  const steps = createInternalProofRunbook({ supabase });
  if (!steps[step]) {
    console.error(`unknown step '${step}'. valid: ${Object.keys(steps).join(", ")}`);
    process.exit(1);
  }
  await steps[step]().catch((error) => {
    console.error("STEP FAILED:", error?.message || error);
    process.exit(1);
  });
}
