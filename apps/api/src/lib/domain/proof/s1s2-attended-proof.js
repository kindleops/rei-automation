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
//   • the runtime deployed SHA must equal the DEPLOYMENT-SUPPLIED
//     S1S2_PROOF_EXPECTED_SHA (never a module constant), and both phases pin
//     to that same validated deployment;
//   • S1S2_PROOF_ENABLED must be truthy (deny-by-default);
//   • a dedicated trigger secret must match (constant-time);
//   • a single-use, 20-minute server-side nonce gates the two phases;
//   • queue_execution_mode is restored to "paused" and the session closed on
//     EVERY success/failure path, plus an independent per-minute watchdog.
//
// This module NEVER returns or logs secret values.

import crypto from "node:crypto";
import { INTERNAL_PROOF_PINNED } from "@/lib/domain/queue/internal-proof-session.js";
import {
  acquireGlobalExecutionLock,
  releaseGlobalExecutionLock,
  GLOBAL_LOCK_OWNER,
} from "@/lib/domain/queue/queue-global-execution-lock.js";
import {
  createCanaryAuthorization,
  consumeCanaryAuthorization,
  loadCanaryAuthorizationByRunId,
} from "@/lib/domain/queue/queue-canary-authorization.js";
// Canonical inbound/burst/reply readers — reuse the SAME semantic sources the
// live inbound path uses (never a proof-local re-interpretation of the schema):
//   • aggregateBurstMessage → the authoritative last_authorized_received_at that
//     the live burst flush consumes (derived from constituent_messages jsonb; it
//     is NOT a seller_inbound_bursts column).
//   • SELLER_FLOW_STAGES.CONSIDER_SELLING → the canonical ownership_confirmed →
//     consider_selling reply use-case (the real immediate S2 row). We match the
//     EXACT use_case (not canonicalStageForUseCase, which also folds
//     consider_selling_follow_up onto this stage — a later row, not our S2).
// Both modules are pure (zero I/O), so the proof stays credential-free/testable.
import { aggregateBurstMessage } from "@/lib/domain/seller-flow/seller-inbound-burst-policy.js";
import { SELLER_FLOW_STAGES } from "@/lib/domain/seller-flow/canonical-seller-flow.js";

// Canonical scoped-canary primitives — reused, not reimplemented. Injectable for tests.
function scopedOps(deps) {
  return {
    acquireLock: deps.acquireLock || ((opts) => acquireGlobalExecutionLock(deps.supabase, opts)),
    releaseLock: deps.releaseLock || ((token) => releaseGlobalExecutionLock(deps.supabase, token)),
    createAuthorization: deps.createAuthorization || ((opts) => createCanaryAuthorization(deps.supabase, opts)),
    consumeAuthorization: deps.consumeAuthorization || ((id) => consumeCanaryAuthorization(deps.supabase, id)),
    loadAuthorizationByRunId: deps.loadAuthorizationByRunId || ((runId) => loadCanaryAuthorizationByRunId(deps.supabase, runId)),
    // Current holder of the global execution lock (id=1); null when free.
    readLockToken: deps.readLockToken || (async () => {
      const { data } = await deps.supabase.from("queue_global_execution_lock").select("lock_token").eq("id", 1).maybeSingle();
      return data?.lock_token || null;
    }),
  };
}
const SCOPED_CANARY_LOCK_TTL_SECONDS = 120;
const SCOPED_CANARY_AUTH_TTL_MS = 120 * 1000;

// Confirm the proof-owned lock is no longer held BY US. release RPC returns true
// when it cleared our token; false when no row matched our token (we don't hold
// it) — but the JS wrapper also returns false on a thrown DB error, so on false
// we re-read the lock holder: not-our-token ⇒ released, our-token ⇒ still held,
// unreadable ⇒ conservatively "not released" (leave the handle for retry).
async function confirmLockReleased(deps, ops, token) {
  let released = false;
  try { released = (await ops.releaseLock(token)) === true; } catch { released = false; }
  if (released) return true;
  try { return clean(await ops.readLockToken()) !== clean(token); } catch { return false; }
}

// Confirm the proof-owned authorization is closed. consume returns {ok:true}
// when it marked it consumed; else re-check: already-consumed (e.g. spent by the
// claim), expired, or gone all mean closed; still-open+unexpired means failed.
async function confirmAuthClosed(deps, ops, authId, runId) {
  try { const r = await ops.consumeAuthorization(authId); if (r?.ok === true) return true; } catch { /* re-check below */ }
  try {
    const existing = runId ? await ops.loadAuthorizationByRunId(runId) : null;
    if (!existing) return true;
    if (existing.consumed_at) return true;
    if (existing.expires_at && Date.parse(existing.expires_at) <= nowMs(deps)) return true;
    return false;
  } catch { return false; }
}

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
const ACTIVE_STATUSES = ["queued", "scheduled", "pending", "approved", "ready", "processing"];

// The canonical post-ownership-confirmation reply use-case is `consider_selling`
// (deterministic-stage-map: ownership_confirmed → consider_selling; canonical-
// seller-flow SELLER_FLOW_STAGES.CONSIDER_SELLING). This attended proof matches
// ONLY the immediate auto-created S2 (use_case_template === "consider_selling"),
// NOT a later consider_selling_follow_up — both canonicalize to the same
// CONSIDER_SELLING stage, so canonicalStageForUseCase() would wrongly accept the
// follow-up. Compare the exact cleaned use_case against the canonical constant.
export function isCanonicalS2ReplyRow(row) {
  return clean(row?.use_case_template) === SELLER_FLOW_STAGES.CONSIDER_SELLING;
}

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
  // Neutral opening: NO leading greeting and no "Hi,/Hey,/Hello," anywhere, so it cannot
  // match the provider-level blank-greeting content guard (providers/textgrid.js:20,
  // BLANK_GREETING_RE), which reads any "Hi," as a "Hi {name}," template rendered with a
  // blank name. The proof greeting is intentionally generic — no name personalization —
  // and the earlier "Hi, this is regarding the property…" body tripped that guard and was
  // fail-closed to paused_name_missing before provider submission. Keep this greeting-free.
  return "Quick question about a property you may own — are you still the owner? Reply YES or NO.";
}

// ── Deny-by-default gate (shared by every action) ─────────────────────────────
// The deployed-SHA authority is a DEPLOYMENT-SUPPLIED value (env
// S1S2_PROOF_EXPECTED_SHA), never a module constant — a commit cannot contain
// its own post-merge SHA. On success returns the validated SHA so callers can
// stamp/pin to the exact deployment. Never echoes secrets.
export function evaluateProofGate({ env = {}, headers = {}, deployedSha = null } = {}) {
  if (!["1", "true", "yes", "on"].includes(clean(env.S1S2_PROOF_ENABLED).toLowerCase())) {
    return { ok: false, status: 403, reason: "proof_disabled" };
  }
  const configured = clean(env.S1S2_PROOF_TRIGGER_SECRET);
  if (!configured) return { ok: false, status: 503, reason: "proof_trigger_secret_not_configured" };
  const provided = clean(headers["x-s1s2-proof-secret"] || headers["X-S1S2-Proof-Secret"]);
  if (!secretEquals(provided, configured)) return { ok: false, status: 401, reason: "invalid_trigger_secret" };
  const expectedSha = clean(env.S1S2_PROOF_EXPECTED_SHA);
  if (!expectedSha) return { ok: false, status: 503, reason: "expected_sha_not_configured" };
  const runtimeSha = clean(deployedSha);
  if (!runtimeSha || runtimeSha !== expectedSha) {
    return { ok: false, status: 409, reason: "sha_mismatch" };
  }
  return { ok: true, deployed_sha: runtimeSha };
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

// Treat a write as failed if it threw, returned nullish, or returned ok:false
// (setSystemValues returns { ok:false, error } on a DB write error).
function writeFailed(res) { return !res || res.ok === false; }

// Record/clear the in-flight scoped-canary lock + authorization on the proof
// authorization record so restoreContainment and the (stateless) watchdog can
// release them. Read-modify-write of the persisted JSON.
async function persistAuthLockFields(deps, fields) {
  const raw = await readSysval(deps, PROOF_AUTH_KEY);
  const auth = raw ? JSON.parse(raw) : {};
  const next = { ...auth, ...fields };
  const res = await writeSysval(deps, PROOF_AUTH_KEY, JSON.stringify(next));
  if (writeFailed(res)) throw new Error("auth_lock_field_write_rejected");
}

// Dispatch exactly one proof-owned row through the queue engine's scoped-canary
// authority path: acquire the global execution lock as owner scoped_canary with
// a fresh canary_run_id, register a scoped-canary authorization allow-listing
// ONLY this row under the pinned campaign, then dispatch with the full claim
// context. Verifies an ACTUAL send (fail-closed). Releases the lock + consumes
// the authorization on every path. Returns { ok, provider_id, reason }.
async function dispatchProofRowScoped(deps, rowId, label) {
  const ops = scopedOps(deps);
  const row = await deps.fetchQueueRow(rowId);
  if (!row) return { ok: false, reason: `${label}_row_missing` };
  // Code-pinned: the row's campaign_id column must be the pinned proof campaign
  // (the claim RPC enforces row.campaign_id === p_campaign_id).
  if (clean(row.campaign_id) !== clean(PROOF.campaign_id)) {
    return { ok: false, reason: `${label}_row_campaign_mismatch` };
  }

  const canary_run_id = deps.mintCanaryRunId ? deps.mintCanaryRunId() : crypto.randomUUID();
  const authorization_token = deps.mintAuthToken ? deps.mintAuthToken() : crypto.randomBytes(32).toString("hex");
  let lock = null;
  let authorization = null;
  try {
    lock = await ops.acquireLock({
      owner_type: GLOBAL_LOCK_OWNER.SCOPED_CANARY,
      canary_run_id,
      ttlSeconds: SCOPED_CANARY_LOCK_TTL_SECONDS,
    });
    if (!lock?.acquired) return { ok: false, reason: `${label}_scoped_canary_lock_unavailable`, detail: lock?.reason || null };

    // Persist the lock recovery handle IMMEDIATELY — before the authorization
    // insert or any other await — so a crash between acquisition and auth
    // creation still leaves restore/watchdog a token to release.
    await persistAuthLockFields(deps, {
      execution_lock_token: lock.token,
      scoped_canary_run_id: canary_run_id,
    });

    authorization = await ops.createAuthorization({
      canary_run_id,
      campaign_id: PROOF.campaign_id,
      queue_row_ids: [rowId],
      authorization_token,
      expires_at: iso(nowMs(deps) + SCOPED_CANARY_AUTH_TTL_MS),
      metadata: { proof: "s1s2_attended", leg: label },
    });
    await persistAuthLockFields(deps, { canary_authorization_id: authorization?.id || null });

    const disp = await deps.dispatchQueueRow(row, {
      scoped_canary: true,
      canary_run_id,
      authorization_token,
      campaign_id: PROOF.campaign_id,
    });

    // FAIL CLOSED: a send is confirmed ONLY when the claim ran (not skipped) AND
    // the re-read row shows a real provider send. {ok:true, skipped:true} — an
    // unclaimed row — is NOT a send.
    if (disp?.ok !== true || disp?.skipped === true) {
      return { ok: false, reason: `${label}_dispatch_unconfirmed`, detail: disp?.reason || "not_claimed" };
    }
    const fresh = await deps.fetchQueueRow(rowId);
    const providerId = fresh?.provider_message_id || null;
    if (!fresh?.sent_at || !providerId) {
      return { ok: false, reason: `${label}_dispatch_unconfirmed`, detail: "no_sent_at_or_provider_id" };
    }
    return { ok: true, provider_id: providerId, canary_run_id };
  } finally {
    // Clean up, but CLEAR a recovery handle ONLY when the resource is confirmed
    // released — a failed cleanup keeps the handle so restore/watchdog can retry.
    const cleared = {};
    if (lock?.token) {
      if (await confirmLockReleased(deps, ops, lock.token)) { cleared.execution_lock_token = null; cleared.scoped_canary_run_id = null; }
    } else { cleared.execution_lock_token = null; cleared.scoped_canary_run_id = null; }
    if (authorization?.id) {
      // Confirm closed: a successful claim already consumed the single-row
      // authorization (consume ⇒ ok:false, re-check sees consumed_at); a failed
      // dispatch leaves it open, so we consume it here. Clear only when closed.
      if (await confirmAuthClosed(deps, ops, authorization.id, canary_run_id)) cleared.canary_authorization_id = null;
    } else { cleared.canary_authorization_id = null; }
    if (Object.keys(cleared).length) { try { await persistAuthLockFields(deps, cleared); } catch { /* handle stays for retry */ } }
  }
}

// ── Containment restore — idempotent; used by every exit + the watchdog ───────
// Ownership-aware: the execution mode is reversed to "paused" ONLY when it is
// currently the proof's own scoped_canary_only — a pre-arm failure (mode still
// paused, or an unrelated operator mode) never clobbers it. Every write result
// is checked; a failed write surfaces in `errors` and makes ok:false, so the
// caller/watchdog can raise an unmistakable error signal.
export async function restoreContainment(deps, cause = "restore") {
  const errors = [];
  try {
    const currentMode = clean(await readSysval(deps, EXECUTION_MODE_KEY));
    if (currentMode === "scoped_canary_only") {
      const res = await writeSysval(deps, EXECUTION_MODE_KEY, "paused");
      if (writeFailed(res)) errors.push("mode_restore_write_rejected");
    }
  } catch (e) { errors.push(`mode_restore_failed:${e.message}`); }
  try {
    const raw = await readSysval(deps, SESSION_KEY);
    if (raw) {
      const s = JSON.parse(raw);
      if (!s.closed_at) { s.closed_at = iso(nowMs(deps)); s.closed_cause = cause; const res = await writeSysval(deps, SESSION_KEY, JSON.stringify(s)); if (writeFailed(res)) errors.push("session_close_write_rejected"); }
    }
  } catch (e) { errors.push(`session_close_failed:${e.message}`); }
  // Release the proof-owned scoped-canary execution lock + close its
  // authorization (idempotent; token-scoped release cannot touch another run's
  // lock). A cleanup that is NOT confirmed released surfaces an explicit error
  // and RETAINS its handle so a later restore/watchdog can retry — the record
  // is NOT closed while any resource may still be held, and ok stays false.
  try {
    const auth = await loadAuthorization(deps);
    if (auth) {
      const ops = scopedOps(deps);
      let lockReleased = true;
      let authClosed = true;
      if (auth.execution_lock_token) {
        lockReleased = await confirmLockReleased(deps, ops, auth.execution_lock_token);
        if (!lockReleased) errors.push("lock_release_failed");
        else { auth.execution_lock_token = null; auth.scoped_canary_run_id = null; }
      }
      if (auth.canary_authorization_id) {
        authClosed = await confirmAuthClosed(deps, ops, auth.canary_authorization_id, auth.scoped_canary_run_id);
        if (!authClosed) errors.push("authorization_close_failed");
        else { auth.canary_authorization_id = null; }
      }
      // Close the record only when nothing is left held; otherwise persist the
      // cleared handles (if any) but keep it open for retry.
      const fullyReleased = lockReleased && authClosed;
      if (fullyReleased && !auth.closed_at) { auth.closed_at = iso(nowMs(deps)); auth.closed_cause = cause; }
      const res = await writeSysval(deps, PROOF_AUTH_KEY, JSON.stringify(auth));
      if (writeFailed(res)) errors.push("auth_close_write_rejected");
    }
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
  // Fail CLOSED: an errored count, or an unavailable/null count, must block the
  // proof — never fall through to arming on an unknown row count.
  const { count, error: countError } = await deps.supabase.from("send_queue").select("id", { count: "exact", head: true })
    .eq("to_phone_number", PROOF.handset).in("queue_status", ACTIVE_STATUSES);
  if (countError) throw new Error(`precondition: dispatchable-row count query failed (${countError.message || "error"})`);
  if (count === null || count === undefined) throw new Error("precondition: dispatchable-row count unavailable");
  if (count > 0) throw new Error(`precondition: ${count} pre-existing dispatchable rows on the handset`);
}

// ── PHASE 1: arm + exactly one S1 ─────────────────────────────────────────────
export async function runArmAndS1(deps) {
  // Single-flight + preconditions run BEFORE anything is armed. A read/precondition
  // failure here changed nothing, so we return cleanly and do NOT restore —
  // forcing "paused" would clobber an operator execution state this proof did
  // not create (restoreContainment is also ownership-aware as a second guard).
  let existing;
  try {
    existing = await loadAuthorization(deps);
  } catch (e) {
    return { ok: false, status: 500, reason: "authorization_read_failed", detail: e.message };
  }
  if (authorizationActive(existing, nowMs(deps))) return { ok: false, status: 409, reason: "proof_already_active" };

  // The gate already validated runtime === S1S2_PROOF_EXPECTED_SHA and passed
  // the validated SHA through as deps.validatedSha. Fail closed if it is absent
  // (never stamp a stale constant). Everything downstream pins to THIS value.
  const validatedSha = clean(deps.validatedSha);
  if (!validatedSha) return { ok: false, status: 500, reason: "validated_sha_missing" };

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
    purpose: "attended_s1_s2_canary", production_sha: validatedSha,
  };

  const assertWrite = (res, label) => { if (writeFailed(res)) throw new Error(`arming write rejected: ${label}`); };
  try {
    // Order matters: write authorization + session BEFORE arming the mode, so the
    // watchdog can always find and reverse an armed state. Every arming write is
    // verified — a rejected write must never leave arm reporting success.
    assertWrite(await writeSysval(deps, PROOF_AUTH_KEY, JSON.stringify({
      nonce, phase: "armed", pinned_sha: validatedSha, pinned_handset: PROOF.handset,
      created_at: iso(startedMs), expires_at: iso(startedMs + PROOF_TTL_MS),
    })), "authorization");
    assertWrite(await writeSysval(deps, SESSION_KEY, JSON.stringify(session)), "session");
    assertWrite(await writeSysval(deps, EXECUTION_MODE_KEY, "scoped_canary_only"), "execution_mode");

    const s1SentAt = iso(nowMs(deps));
    const enq = await deps.insertSendQueueRow({
      to_phone_number: PROOF.handset, from_phone_number: PROOF.sender,
      message_body: s1Body(), message_text: s1Body(),
      template_use_case: S1_USE_CASE, use_case_template: S1_USE_CASE,
      queue_status: "queued", type: "outbound", touch_number: 1,
      // The campaign_id COLUMN (not just metadata) must be the pinned proof
      // campaign — the scoped-canary claim enforces row.campaign_id === p_campaign_id.
      campaign_id: PROOF.campaign_id,
      metadata: { source: "manual_inbox", manual_operator_send: true, proof: "s1s2_attended", use_case: S1_USE_CASE, campaign_id: PROOF.campaign_id },
    });
    const s1RowId = enq?.queue_row_id || enq?.item_id || null;
    if (!enq?.ok || !s1RowId) throw new Error("S1 enqueue failed");
    // Dispatch through the queue engine's REAL scoped-canary authority: acquire
    // the scoped_canary execution lock + register an authorization scoped to
    // this one row, then claim under scoped_canary_only. Fail closed on any
    // non-send (the prior bug treated {ok:true,skipped:true} as success).
    const disp = await dispatchProofRowScoped(deps, s1RowId, "s1");
    if (!disp.ok) throw new Error(`S1 ${disp.reason}${disp.detail ? ` (${disp.detail})` : ""}`);
    const s1ProviderId = disp.provider_id;

    // Persist S1 identity onto the authorization for the verify phase.
    assertWrite(await writeSysval(deps, PROOF_AUTH_KEY, JSON.stringify({
      nonce, phase: "s1_sent", pinned_sha: validatedSha, pinned_handset: PROOF.handset,
      created_at: iso(startedMs), expires_at: iso(startedMs + PROOF_TTL_MS),
      s1_queue_row_id: s1RowId, s1_sent_at: s1SentAt,
    })), "s1_identity");

    return { ok: true, status: 200, nonce, s1_queue_row_id: s1RowId, s1_provider_id: s1ProviderId, s1_sent_at: s1SentAt, expires_at: session.expires_at };
  } catch (err) {
    // Ownership-aware restore: reverses the mode only if we actually armed
    // scoped_canary_only; always closes any session/authorization we wrote.
    await restoreContainment(deps, "arm_and_s1_failure");
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

// Structured verify failure — carries a stable `verify_stage` code so a DB /
// schema / query error is a HARD proof failure surfaced with its underlying
// reason, and can NEVER be mistaken for the legitimate "inbound not present yet"
// (425 no_real_inbound_yet) path. Every throw inside runVerifyAndS2 uses this.
function verifyFail(stage, msg) {
  const e = new Error(msg ? `${stage}: ${msg}` : stage);
  e.verify_stage = stage;
  return e;
}

// ── PHASE 2: verify the real inbound + dispatch exactly one S2, then restore ───
export async function runVerifyAndS2(deps, { nonce } = {}) {
  const atMs = nowMs(deps);
  const auth = await loadAuthorization(deps);
  const gate = checkNonce(auth, nonce, atMs, "s1_sent");
  if (!gate.ok) return gate;

  // Pin phase 2 to the SAME validated deployment that armed phase 1. The route
  // re-validated runtime === S1S2_PROOF_EXPECTED_SHA and passed deps.validatedSha;
  // if the deployment changed between arm and verify, the recorded pin no longer
  // matches and we deny (never dispatch S2 from a different build).
  const validatedSha = clean(deps.validatedSha);
  if (!validatedSha || validatedSha !== clean(auth.pinned_sha)) {
    return { ok: false, status: 409, reason: "deployment_changed" };
  }

  try {
    // ── 1) Real inbound after S1 — REAL message_events columns. A query/schema
    // ERROR is a HARD verifier failure (verifyFail), NEVER collapsed into
    // no_real_inbound_yet; only a clean EMPTY result is the legitimate 425.
    const inbRes = await deps.supabase.from("message_events")
      .select("id, provider_message_sid, message_body, received_at, direction, thread_key")
      .eq("thread_key", PROOF.handset).eq("direction", "inbound")
      .gte("received_at", auth.s1_sent_at).order("received_at", { ascending: false }).limit(1);
    if (inbRes?.error) throw verifyFail("inbound_lookup_failed", inbRes.error.message || String(inbRes.error));
    const inbound = (inbRes?.data || [])[0];
    if (!inbound) return { ok: false, status: 425, reason: "no_real_inbound_yet" }; // 425 Too Early — clean, no inbound yet

    // ── 2) Ownership classification (real message_body column) ──
    const cls = await deps.classify(inbound.message_body || "");
    if (cls?.primary_intent !== "ownership_confirmed") {
      throw verifyFail("inbound_intent_not_confirmed", `${cls?.primary_intent} != ownership_confirmed`);
    }

    // ── 3) Temporal authority — the SAME semantic source the live burst flush
    // consumes: aggregateBurstMessage(constituent_messages).last_authorized_received_at
    // (a DERIVED aggregate over the constituent jsonb, NOT a bursts column). A
    // query error, a missing burst, an absent authorized receipt, or a receipt
    // OLDER than our S1 (stale / non-authoritative) each deny as a distinct stage.
    const burstRes = await deps.supabase.from("seller_inbound_bursts")
      .select("id, thread_key, status, constituent_messages, created_at")
      .eq("thread_key", PROOF.handset).order("created_at", { ascending: false }).limit(1).maybeSingle();
    if (burstRes?.error) throw verifyFail("burst_lookup_failed", burstRes.error.message || String(burstRes.error));
    const burst = burstRes?.data;
    if (!burst) throw verifyFail("burst_authority_missing", "no seller_inbound_burst for handset");
    const authorizedAt = aggregateBurstMessage(burst.constituent_messages || []).last_authorized_received_at;
    if (!authorizedAt) throw verifyFail("temporal_authority_unavailable", "burst has no authorized_received_at constituent");
    // Both the authorized receipt and the S1 send time must parse to a FINITE epoch
    // before comparing. An unparseable/garbage value must HARD-FAIL here — never
    // reach the stale check, where `NaN < x` is false and would silently pass (fail-open).
    const authorizedMs = Date.parse(authorizedAt);
    const s1SentMs = Date.parse(auth.s1_sent_at);
    if (!Number.isFinite(authorizedMs) || !Number.isFinite(s1SentMs)) {
      throw verifyFail("temporal_authority_unparseable", `authorized_received_at=${authorizedAt} s1_sent_at=${auth.s1_sent_at}`);
    }
    if (authorizedMs < s1SentMs) {
      throw verifyFail("temporal_authority_stale", `authorized_received_at ${authorizedAt} predates S1 ${auth.s1_sent_at}`);
    }

    // ── 4) Fresh-context authority binds to the exact S1 we sent. The canonical
    // find-recent-outbound-pair returns the id at context.queue_row_id (there is
    // no context_source_id / outbound.id key on the canonical return). BOTH the
    // context id and the recorded S1 id must be NON-EMPTY — a null/missing id must
    // never compare equal via String(null)===String(null) (fail-open).
    const pair = await deps.findRecentOutboundContextPair(PROOF.handset, PROOF.sender, { supabase: deps.supabase, inbound_received_at: inbound.received_at });
    const ctxId = clean(pair?.context?.queue_row_id ?? pair?.context?.match?.matched_queue_id ?? "");
    const s1RowId = clean(auth.s1_queue_row_id);
    if (!ctxId || !s1RowId) {
      throw verifyFail("context_authority_missing", `ctx=${ctxId || "∅"} s1=${s1RowId || "∅"}`);
    }
    if (ctxId !== s1RowId) {
      throw verifyFail("context_not_bound_to_s1", `context bound to ${ctxId}, not the S1 ${s1RowId}`);
    }

    // ── 5) Exactly one auto-created S2 — the EXACT immediate reply use-case
    // (use_case_template === "consider_selling", not the follow-up) with an
    // explicit campaign pin. Distinguish lookup-error / absent / multiple /
    // campaign-mismatch as separate hard fails.
    const listS2 = async () => {
      const res = await deps.supabase.from("send_queue").select("id, use_case_template, campaign_id, created_at")
        .eq("to_phone_number", PROOF.handset).gte("created_at", auth.s1_sent_at);
      if (res?.error) throw verifyFail("s2_lookup_failed", res.error.message || String(res.error));
      return (res?.data || []).filter((r) => isCanonicalS2ReplyRow(r));
    };
    const s2rows = await listS2();
    if (s2rows.length === 0) throw verifyFail("no_s2_row", "no canonical consider_selling reply row");
    if (s2rows.length > 1) throw verifyFail("multiple_s2_rows", `found ${s2rows.length}`);
    const s2 = s2rows[0];
    if (clean(s2.campaign_id) !== clean(PROOF.campaign_id)) {
      throw verifyFail("s2_campaign_mismatch", `${s2.campaign_id} != ${PROOF.campaign_id}`);
    }
    const s2RowId = s2.id;

    // ── 6) Dispatch exactly that S2 through the SAME scoped-canary authority path
    // (fresh lock + authorization scoped to this row), fail-closed on non-send.
    const s2disp = await dispatchProofRowScoped(deps, s2RowId, "s2");
    if (!s2disp.ok) throw verifyFail("s2_dispatch_failed", `${s2disp.reason}${s2disp.detail ? ` (${s2disp.detail})` : ""}`);
    const s2ProviderId = s2disp.provider_id;

    // ── 7) Replay-idempotency — still exactly one canonical S2 ──
    const after = await listS2();
    if (after.length !== 1) throw verifyFail("s2_replay_nonidempotent", `replay left ${after.length} S2 rows`);

    await restoreContainment(deps, "success");
    return {
      ok: true, status: 200,
      inbound_event_id: inbound.id, inbound_provider_id: inbound.provider_message_sid || null,
      classification: { intent: cls.primary_intent, confidence: cls.confidence },
      burst_id: burst.id, authorized_received_at: authorizedAt, context_source_id: ctxId,
      s2_queue_row_id: s2RowId, s2_provider_id: s2ProviderId, s2_count: after.length,
      final_queue_execution_mode: "paused",
    };
  } catch (err) {
    await restoreContainment(deps, "verify_and_s2_failure");
    // A DB/schema/query error arrives here as a HARD failure with its stage code —
    // it is 500 verify_and_s2_failed, distinct from the 425 no_real_inbound_yet above.
    return { ok: false, status: 500, reason: "verify_and_s2_failed", stage: err?.verify_stage || "unknown", detail: err?.message };
  }
}

export async function runAbort(deps) {
  const res = await restoreContainment(deps, "operator_abort");
  // A failed restore must NOT read as success: non-2xx + ok:false.
  return { ok: res.ok, status: res.ok ? 200 : 500, ...res };
}

// ── WATCHDOG: independent per-minute restore on expiry ────────────────────────
export async function runS1S2ProofWatchdog(deps) {
  const auth = await loadAuthorization(deps);
  if (!auth || auth.closed_at) return { ok: true, acted: false, reason: "no_open_authorization" };
  if (auth.expires_at && Date.parse(auth.expires_at) > nowMs(deps)) return { ok: true, acted: false, reason: "not_expired" };
  const res = await restoreContainment(deps, "watchdog_expiry");
  return { ok: res.ok, acted: true, reason: "restored_on_expiry", errors: res.errors };
}
