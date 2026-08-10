// ─── s1s2-attended-proof.js ──────────────────────────────────────────────────
//
// TEMPORARY proof-only orchestration for ONE attended internal S1→S2 canary.
// All credential-bearing work (SMS, DB) runs inside the deployed runtime; this
// module only orchestrates and is fully dependency-injected so it is testable
// without production credentials.
//
// Safety invariants (all structural, not delegated to the request):
//   • recipient/sender are CODE-PINNED (INTERNAL_PROOF_PINNED) — the request can
//     never name a recipient, so arbitrary targeting is impossible;
//   • the deployed SHA must equal EXPECTED_SHA;
//   • S1S2_PROOF_ENABLED must be truthy (deny-by-default);
//   • a dedicated trigger secret must match (constant-time);
//   • a single-use, 20-minute server-side nonce gates the two phases;
//   • queue_execution_mode is restored to "paused" and the session closed on
//     EVERY success/failure path, plus an independent per-minute watchdog.
//
// This module NEVER returns or logs secret values.

import crypto from "node:crypto";
import { INTERNAL_PROOF_PINNED } from "@/lib/domain/queue/internal-proof-session.js";

export const EXPECTED_SHA = "7ff03fd41be8e1ab532282165c0ee6e417afc4e5";
export const PROOF_AUTH_KEY = "s1s2_proof_authorization";
export const EXECUTION_MODE_KEY = "queue_execution_mode";
export const SESSION_KEY = "internal_proof_session";
export const PROOF_TTL_MS = 20 * 60 * 1000;

// Code-pinned lane (recipient/sender/campaign) — reused from the upstream pin.
export const PROOF = Object.freeze({
  handset: INTERNAL_PROOF_PINNED.recipient, // +16128072000
  sender: INTERNAL_PROOF_PINNED.sender,     // +16128060495
  campaign_id: INTERNAL_PROOF_PINNED.campaign_id,
});

const S1_USE_CASE = "ownership_check";
export const S2_USE_CASES = Object.freeze(new Set(["offer_interest", "proposal_interest", "interest_probe"]));
const ACTIVE_STATUSES = ["queued", "scheduled", "pending", "approved", "ready", "processing"];

function clean(v) { return String(v ?? "").trim(); }
function nowMs(deps) { return typeof deps.now === "function" ? deps.now() : Date.now(); }
function iso(ms) { return new Date(ms).toISOString(); }

/** Constant-time secret comparison; false on any missing/short input. */
export function secretEquals(a, b) {
  const x = clean(a), y = clean(b);
  if (!x || !y || x.length !== y.length) return false;
  try { return crypto.timingSafeEqual(Buffer.from(x), Buffer.from(y)); } catch { return false; }
}

function s1Body() {
  return "Hi, this is regarding the property — are you still the owner? Reply YES or NO.";
}

// ── Deny-by-default gate (shared by every action) ─────────────────────────────
// Returns { ok:true } or { ok:false, status, reason }. Never echoes secrets.
export function evaluateProofGate({ env = {}, headers = {}, deployedSha = null } = {}) {
  if (!["1", "true", "yes", "on"].includes(clean(env.S1S2_PROOF_ENABLED).toLowerCase())) {
    return { ok: false, status: 403, reason: "proof_disabled" };
  }
  const configured = clean(env.S1S2_PROOF_TRIGGER_SECRET);
  if (!configured) return { ok: false, status: 503, reason: "proof_trigger_secret_not_configured" };
  const provided = clean(headers["x-s1s2-proof-secret"] || headers["X-S1S2-Proof-Secret"]);
  if (!secretEquals(provided, configured)) return { ok: false, status: 401, reason: "invalid_trigger_secret" };
  if (clean(deployedSha) !== EXPECTED_SHA) {
    return { ok: false, status: 409, reason: "sha_mismatch" };
  }
  return { ok: true };
}

async function readSysval(deps, key) {
  const { data, error } = await deps.supabase.from("system_control").select("value").eq("key", key).maybeSingle();
  if (error) throw new Error(`system_control read failed: ${key}`);
  return data?.value ?? null;
}
async function writeSysval(deps, key, value) {
  // Operator-owned keys require OPERATOR authority; the route injects it.
  return deps.setSystemValues({ [key]: value }, deps.operatorOpts);
}

async function loadAuthorization(deps) {
  const raw = await readSysval(deps, PROOF_AUTH_KEY);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}
function authorizationActive(auth, atMs) {
  return Boolean(auth) && !auth.closed_at && auth.expires_at && Date.parse(auth.expires_at) > atMs;
}

// ── Containment restore — idempotent; used by every exit + the watchdog ───────
export async function restoreContainment(deps, cause = "restore") {
  const errors = [];
  try { await writeSysval(deps, EXECUTION_MODE_KEY, "paused"); }
  catch (e) { errors.push(`mode_restore_failed:${e.message}`); }
  try {
    const raw = await readSysval(deps, SESSION_KEY);
    if (raw) {
      const s = JSON.parse(raw);
      if (!s.closed_at) { s.closed_at = iso(nowMs(deps)); s.closed_cause = cause; await writeSysval(deps, SESSION_KEY, JSON.stringify(s)); }
    }
  } catch (e) { errors.push(`session_close_failed:${e.message}`); }
  try {
    const auth = await loadAuthorization(deps);
    if (auth && !auth.closed_at) { auth.closed_at = iso(nowMs(deps)); auth.closed_cause = cause; await writeSysval(deps, PROOF_AUTH_KEY, JSON.stringify(auth)); }
  } catch (e) { errors.push(`auth_close_failed:${e.message}`); }
  return { ok: errors.length === 0, cause, errors };
}

async function assertPreconditions(deps) {
  const mode = clean(await readSysval(deps, EXECUTION_MODE_KEY));
  if (mode !== "paused") throw new Error(`precondition: queue_execution_mode must be paused (is "${mode}")`);
  const sessionRaw = await readSysval(deps, SESSION_KEY);
  if (sessionRaw) {
    try { const s = JSON.parse(sessionRaw); if (!s.closed_at && s.expires_at && Date.parse(s.expires_at) > nowMs(deps)) throw new Error("precondition: an internal_proof_session is already active"); } catch (e) { if (/already active/.test(e.message)) throw e; }
  }
  const { count } = await deps.supabase.from("send_queue").select("id", { count: "exact", head: true })
    .eq("to_phone_number", PROOF.handset).in("queue_status", ACTIVE_STATUSES);
  if ((count ?? 0) > 0) throw new Error(`precondition: ${count} pre-existing dispatchable rows on the handset`);
}

// ── PHASE 1: arm + exactly one S1 ─────────────────────────────────────────────
export async function runArmAndS1(deps) {
  // Refuse a second concurrent proof (single-flight).
  const existing = await loadAuthorization(deps);
  if (authorizationActive(existing, nowMs(deps))) return { ok: false, status: 409, reason: "proof_already_active" };

  // Preconditions run BEFORE anything is armed. A failure here changed nothing,
  // so we return cleanly and do NOT restore — forcing "paused" would clobber an
  // operator execution state this proof did not create.
  try {
    await assertPreconditions(deps);
  } catch (pre) {
    return { ok: false, status: 412, reason: "precondition_failed", detail: pre.message };
  }

  const startedMs = nowMs(deps);
  const nonce = deps.mintNonce ? deps.mintNonce() : crypto.randomUUID();
  const session = {
    session_id: `s1s2-${nonce}`, campaign_id: PROOF.campaign_id,
    recipient: PROOF.handset, sender: PROOF.sender,
    created_at: iso(startedMs), expires_at: iso(startedMs + PROOF_TTL_MS),
    allow_thread_auto_replies: true, opened_by: "s1s2_proof_route",
    purpose: "attended_s1_s2_canary", production_sha: EXPECTED_SHA,
  };

  let armed = false;
  try {
    // Order matters: write authorization + session BEFORE arming the mode, so the
    // watchdog can always find and reverse an armed state.
    await writeSysval(deps, PROOF_AUTH_KEY, JSON.stringify({
      nonce, phase: "armed", pinned_sha: EXPECTED_SHA, pinned_handset: PROOF.handset,
      created_at: iso(startedMs), expires_at: iso(startedMs + PROOF_TTL_MS),
    }));
    await writeSysval(deps, SESSION_KEY, JSON.stringify(session));
    await writeSysval(deps, EXECUTION_MODE_KEY, "scoped_canary_only");
    armed = true;

    const s1SentAt = iso(nowMs(deps));
    const enq = await deps.insertSendQueueRow({
      to_phone_number: PROOF.handset, from_phone_number: PROOF.sender,
      message_body: s1Body(), message_text: s1Body(),
      template_use_case: S1_USE_CASE, use_case_template: S1_USE_CASE,
      queue_status: "queued", type: "outbound", touch_number: 1,
      metadata: { source: "manual_inbox", manual_operator_send: true, proof: "s1s2_attended", use_case: S1_USE_CASE, campaign_id: PROOF.campaign_id },
    });
    const s1RowId = enq?.queue_row_id || enq?.item_id || null;
    if (!enq?.ok || !s1RowId) throw new Error("S1 enqueue failed");
    const row = await deps.fetchQueueRow(s1RowId);
    const disp = await deps.dispatchQueueRow(row);
    if (disp?.ok === false) throw new Error(`S1 dispatch rejected: ${disp?.reason || "unknown"}`);
    const fresh = await deps.fetchQueueRow(s1RowId);
    const s1ProviderId = fresh?.provider_message_id || disp?.provider_message_id || null;

    // Persist S1 identity onto the authorization for the verify phase.
    await writeSysval(deps, PROOF_AUTH_KEY, JSON.stringify({
      nonce, phase: "s1_sent", pinned_sha: EXPECTED_SHA, pinned_handset: PROOF.handset,
      created_at: iso(startedMs), expires_at: iso(startedMs + PROOF_TTL_MS),
      s1_queue_row_id: s1RowId, s1_sent_at: s1SentAt,
    }));

    return { ok: true, status: 200, nonce, s1_queue_row_id: s1RowId, s1_provider_id: s1ProviderId, s1_sent_at: s1SentAt, expires_at: session.expires_at };
  } catch (err) {
    if (armed) await restoreContainment(deps, "arm_and_s1_failure");
    else await restoreContainment(deps, "arm_and_s1_precheck_failure");
    return { ok: false, status: 500, reason: "arm_and_s1_failed", detail: err.message };
  }
}

function checkNonce(auth, providedNonce, atMs, requiredPhase) {
  if (!auth) return { ok: false, status: 409, reason: "no_active_authorization" };
  if (auth.closed_at) return { ok: false, status: 409, reason: "nonce_consumed" };
  if (!secretEquals(providedNonce, auth.nonce)) return { ok: false, status: 401, reason: "nonce_mismatch" };
  if (!auth.expires_at || Date.parse(auth.expires_at) <= atMs) return { ok: false, status: 409, reason: "nonce_expired" };
  if (requiredPhase && auth.phase !== requiredPhase) return { ok: false, status: 409, reason: `unexpected_phase:${auth.phase}` };
  return { ok: true };
}

// ── PHASE 2: verify the real inbound + dispatch exactly one S2, then restore ───
export async function runVerifyAndS2(deps, { nonce } = {}) {
  const atMs = nowMs(deps);
  const auth = await loadAuthorization(deps);
  const gate = checkNonce(auth, nonce, atMs, "s1_sent");
  if (!gate.ok) return gate;

  try {
    // 1) real inbound after S1
    const { data: inb } = await deps.supabase.from("message_events")
      .select("id, provider_message_id, body, received_at, direction")
      .eq("thread_key", PROOF.handset).eq("direction", "inbound")
      .gte("received_at", auth.s1_sent_at).order("received_at", { ascending: false }).limit(1);
    const inbound = inb?.[0];
    if (!inbound) return { ok: false, status: 425, reason: "no_real_inbound_yet" }; // 425 Too Early — operator hasn't replied

    // 2) ownership classification
    const cls = await deps.classify(inbound.body || "");
    if (cls.primary_intent !== "ownership_confirmed") throw new Error(`inbound intent ${cls.primary_intent} != ownership_confirmed`);

    // 3) burst authorized-timestamp persistence
    const { data: burst } = await deps.supabase.from("seller_inbound_bursts")
      .select("id, last_authorized_received_at").eq("thread_key", PROOF.handset)
      .order("created_at", { ascending: false }).limit(1).maybeSingle();
    if (!burst?.last_authorized_received_at) throw new Error("burst did not preserve last_authorized_received_at");

    // 4) fresh-context authority binds to the S1 we sent
    const pair = await deps.findRecentOutboundContextPair(PROOF.handset, PROOF.sender, { supabase: deps.supabase, inbound_received_at: inbound.received_at });
    const ctxId = pair?.context_source_id || pair?.outbound?.id || null;
    if (String(ctxId) !== String(auth.s1_queue_row_id)) throw new Error(`context bound to ${ctxId}, not the S1 ${auth.s1_queue_row_id}`);

    // 5) exactly one auto-created S2
    const listS2 = async () => {
      const { data } = await deps.supabase.from("send_queue").select("id, use_case_template, created_at")
        .eq("to_phone_number", PROOF.handset).gte("created_at", auth.s1_sent_at);
      return (data || []).filter((r) => S2_USE_CASES.has(clean(r.use_case_template)));
    };
    const s2rows = await listS2();
    if (s2rows.length !== 1) throw new Error(`expected exactly one S2, found ${s2rows.length}`);
    const s2RowId = s2rows[0].id;

    // 6) dispatch exactly that S2
    const s2row = await deps.fetchQueueRow(s2RowId);
    const s2disp = await deps.dispatchQueueRow(s2row);
    if (s2disp?.ok === false) throw new Error(`S2 dispatch rejected: ${s2disp?.reason || "unknown"}`);
    const s2fresh = await deps.fetchQueueRow(s2RowId);
    const s2ProviderId = s2fresh?.provider_message_id || s2disp?.provider_message_id || null;

    // 7) replay-idempotency — still exactly one S2
    const after = await listS2();
    if (after.length !== 1) throw new Error(`replay created additional S2 rows (${after.length})`);

    await restoreContainment(deps, "success");
    return {
      ok: true, status: 200,
      inbound_event_id: inbound.id, inbound_provider_id: inbound.provider_message_id || null,
      classification: { intent: cls.primary_intent, confidence: cls.confidence },
      burst_id: burst.id, context_source_id: ctxId,
      s2_queue_row_id: s2RowId, s2_provider_id: s2ProviderId, s2_count: after.length,
      final_queue_execution_mode: "paused",
    };
  } catch (err) {
    await restoreContainment(deps, "verify_and_s2_failure");
    return { ok: false, status: 500, reason: "verify_and_s2_failed", detail: err.message };
  }
}

export async function runAbort(deps) {
  const res = await restoreContainment(deps, "operator_abort");
  return { ok: res.ok, status: 200, ...res };
}

// ── WATCHDOG: independent per-minute restore on expiry ────────────────────────
export async function runS1S2ProofWatchdog(deps) {
  const auth = await loadAuthorization(deps);
  if (!auth || auth.closed_at) return { ok: true, acted: false, reason: "no_open_authorization" };
  if (auth.expires_at && Date.parse(auth.expires_at) > nowMs(deps)) return { ok: true, acted: false, reason: "not_expired" };
  const res = await restoreContainment(deps, "watchdog_expiry");
  return { ok: res.ok, acted: true, reason: "restored_on_expiry", errors: res.errors };
}
