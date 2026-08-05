// ─── seller-inbound-burst-store.js ───────────────────────────────────────────
// Durable burst coordination store.
//
// Production path uses Supabase table public.seller_inbound_bursts with
// compare-and-set version updates + claim RPC semantics emulated in JS when
// RPC is unavailable (tests inject memory store).
//
// Memory store is for unit/critical tests only — never production authority.

import crypto from "node:crypto";
import {
  BURST_STATUSES,
  buildBurstDecisionIdempotencyKey,
  createOpenBurstState,
  projectAppendToOpenBurst,
  resolveBurstGroupKey,
  isBurstEligible,
  isClaimableBurst,
  parseIsoMs,
  SELLER_INBOUND_BURST_DEBOUNCE_MS,
  SELLER_INBOUND_BURST_MAX_DURATION_MS,
  SELLER_INBOUND_BURST_CLAIM_LEASE_MS,
} from "@/lib/domain/seller-flow/seller-inbound-burst-policy.js";

const TABLE = "seller_inbound_bursts";

// Single bounded-retry authority for append races (open-generation unique
// insert race, version-CAS lose). Shared by the memory and Supabase stores;
// exhaustion is an explicit deterministic failure (burst_append_retry_exhausted)
// that fails the webhook closed — provider/idempotency redelivery retries,
// never a per-message fallback. Exported so tests derive retry-cap
// expectations from this authority instead of duplicating the literal.
export const BURST_APPEND_MAX_ROUNDS = 5;

function clean(value) {
  return String(value ?? "").trim();
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

// ── Work scope: activation authority for burst selection ─────────────────────
//
// Burst work selection is DENY BY DEFAULT. A caller that passes no scope gets
// nothing. The 2026-08-03 incident was a permissive default — one hard-coded
// `enabled: true` at a single call site silently disarmed every gate below it —
// and a store that read "no scope" as "all production work" would rebuild that
// same failure one layer down, where the next caller who forgets is invisible.
//
// The scope is the `.scope` descriptor produced by
// burst-flush-activation-policy.toBurstFlushScopeDescriptor(), with the
// coordinator's `authorized`/`global` assertions attached. This module invents
// no bound, widens nothing, and NEVER degrades a malformed scope to global:
// every missing or unparseable field denies.
//
//   {
//     authorized: boolean,          // must be exactly true
//     global: boolean,              // enabled-mode assertion
//     kind: "global"|"thread"|"none",
//     thread_keys: string[],        // exact-equality allowlist
//     min_first_received_at, max_first_received_at,  // message-time window
//     min_created_at, max_created_at,                // row-insert window
//     session_expires_at,           // max_created_at fallback
//     reason: string|null           // denial reason, echoed for observability
//   }
//
// TWO durable windows, not one. `first_received_at` derives from provider
// ingress data; `created_at` is now() at INSERT and is not attacker-influenced.
// Bounding both is the anti-backdating leg: a replayed or backdated
// first_received_at cannot drag an old row into the session window on its own.
// There is deliberately NO grace on either floor — a grace window is exactly
// the temporal ambiguity that lets an old artifact qualify, and these bounds
// are what stands between a proof session and a 36-hour-old burst on the same
// thread. "Open the session, then text" is a runbook precondition.
//
// The admission RULE lives in burst-flush-activation-policy.isBurstWithinFlushScope
// and this module does not import it: the policy imports the coordinator, the
// coordinator imports this store, so importing back would close a module cycle
// through the production path. Instead the resolved bounds below are applied
// identically in SQL and in JS, and their equivalence to the policy's predicate
// is pinned by test (burst-eligible-scope.test.mjs) — which CAN import both
// without a production cycle. The invariant the test enforces is one-directional
// and deliberately so: anything this store admits, the policy admits too.
export function resolveBurstScopeFilter(scope) {
  if (scope == null) return { deny: true, reason: "burst_scope_absent" };
  if (typeof scope !== "object" || Array.isArray(scope)) {
    return { deny: true, reason: "burst_scope_invalid" };
  }
  // Explicit denial carries the policy's own reason so the flush log says WHY
  // (session expired vs never opened vs revoked), not just "zero rows".
  if (scope.authorized === false) {
    return { deny: true, reason: clean(scope.reason) || "burst_scope_denied" };
  }
  // Authorization must be asserted, never inferred: `{}` and `{global: true}`
  // alone are denials, so a half-built scope object cannot open the door.
  if (scope.authorized !== true) return { deny: true, reason: "burst_scope_not_authorized" };

  if (scope.global === true || scope.kind === "global") {
    return { deny: false, global: true, thread_keys: [] };
  }
  // Any scope kind other than the thread-bounded one — including "none" and an
  // absent kind — is not an activation.
  if (scope.kind !== "thread") return { deny: true, reason: "burst_scope_not_activated" };

  const thread_keys = [
    ...new Set((Array.isArray(scope.thread_keys) ? scope.thread_keys : []).map(clean).filter(Boolean)),
  ];
  if (!thread_keys.length) return { deny: true, reason: "burst_scope_thread_keys_required" };

  const min_first = parseIsoMs(scope.min_first_received_at, null);
  const max_first = parseIsoMs(scope.max_first_received_at, null);
  const min_created = parseIsoMs(scope.min_created_at, null);
  // Absent upper insert bound falls back to session expiry — never unbounded.
  const max_created = parseIsoMs(scope.max_created_at ?? scope.session_expires_at, null);
  if (
    !Number.isFinite(min_first) ||
    !Number.isFinite(max_first) ||
    !Number.isFinite(min_created) ||
    !Number.isFinite(max_created) ||
    max_first < min_first
  ) {
    return { deny: true, reason: "burst_scope_bounds_invalid" };
  }

  return {
    deny: false,
    global: false,
    thread_keys,
    min_first: new Date(min_first).toISOString(),
    max_first: new Date(max_first).toISOString(),
    min_created: new Date(min_created).toISOString(),
    max_created: new Date(max_created).toISOString(),
  };
}

/**
 * In-process re-assert of the same predicate the query applies. Both stores
 * run it on every candidate BEFORE any claim, so a mis-parsed PostgREST filter
 * degrades to "claims nothing" instead of "claims anything".
 */
export function matchesBurstScope(burst, resolved) {
  if (!burst || !resolved || resolved.deny) return false;
  if (resolved.global) return true;
  if (!resolved.thread_keys.includes(clean(burst.thread_key))) return false;

  // A row that cannot prove when it opened, or when it was inserted, cannot
  // prove it belongs to the session. Unprovable membership is denied membership.
  const first_ms = parseIsoMs(burst.first_received_at, null);
  if (!Number.isFinite(first_ms)) return false;
  if (first_ms < parseIsoMs(resolved.min_first)) return false;
  if (first_ms > parseIsoMs(resolved.max_first)) return false;

  if (burst.created_at == null || clean(burst.created_at) === "") return false;
  const created_ms = parseIsoMs(burst.created_at, null);
  if (!Number.isFinite(created_ms)) return false;
  if (created_ms < parseIsoMs(resolved.min_created)) return false;
  if (created_ms > parseIsoMs(resolved.max_created)) return false;

  return true;
}

// ── Memory store (tests) ─────────────────────────────────────────────────────

export function createMemorySellerInboundBurstStore({ now = () => new Date().toISOString() } = {}) {
  /** @type {Map<string, object>} */
  const byId = new Map();
  /** thread_key → open burst id */
  const openByThread = new Map();
  /** per-thread async mutex so concurrent appends serialize (CAS equivalent). */
  const threadLocks = new Map();
  let seq = 0;

  function listAll() {
    return [...byId.values()].map(clone);
  }

  function getOpen(thread_key) {
    const id = openByThread.get(clean(thread_key));
    if (!id) return null;
    const row = byId.get(id);
    if (!row || row.status !== BURST_STATUSES.OPEN) return null;
    return clone(row);
  }

  function getById(id) {
    const row = byId.get(clean(id));
    return row ? clone(row) : null;
  }

  async function withThreadLock(thread_key, fn) {
    const key = clean(thread_key);
    const prev = threadLocks.get(key) || Promise.resolve();
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    threadLocks.set(
      key,
      prev.then(() => gate)
    );
    await prev;
    try {
      return await fn();
    } finally {
      release();
      if (threadLocks.get(key) === gate) threadLocks.delete(key);
    }
  }

  async function appendMessage({
    thread_key,
    message,
    debounce_ms = SELLER_INBOUND_BURST_DEBOUNCE_MS,
    max_duration_ms = SELLER_INBOUND_BURST_MAX_DURATION_MS,
    now: nowArg = null,
  } = {}) {
    const group = resolveBurstGroupKey({ thread_key });
    return withThreadLock(group, async () => {
      const nowIso = nowArg || now();
      // Loop (never recurse through the thread lock) for CAS retries.
      for (let round = 0; round < BURST_APPEND_MAX_ROUNDS; round += 1) {
        const open = getOpen(group);

        if (!open) {
          // Next generation = max existing + 1
          const gens = listAll()
            .filter((b) => b.thread_key === group)
            .map((b) => Number(b.generation) || 0);
          const generation = (gens.length ? Math.max(...gens) : 0) + 1;
          const created = createOpenBurstState({
            thread_key: group,
            generation,
            message,
            now: nowIso,
            debounce_ms,
            max_duration_ms,
          });
          const id = `burst-mem-${++seq}`;
          const row = {
            id,
            ...created,
            decision_idempotency_key: buildBurstDecisionIdempotencyKey({
              thread_key: group,
              generation,
              burst_id: created.burst_id,
            }),
            created_at: nowIso,
            updated_at: nowIso,
          };
          byId.set(id, row);
          if (row.status === BURST_STATUSES.OPEN) {
            openByThread.set(group, id);
          } else {
            openByThread.delete(group);
          }
          return { ok: true, created: true, appended: true, duplicate: false, burst: clone(row) };
        }

        const projected = projectAppendToOpenBurst({
          burst: open,
          message,
          now: nowIso,
          debounce_ms,
          max_duration_ms,
        });

        if (projected.rollover) {
          // Mirror the production (Supabase) rollover contract exactly: the
          // old generation stays the thread's ONLY open row (partial unique
          // index allows one OPEN per thread), force-marked eligible, and the
          // message is handed back to the caller. The coordinator flushes
          // (claims + completes) the old generation, then retries the append —
          // generation N+1 opens only after the old row left OPEN.
          const stale = byId.get(open.id);
          if (stale && stale.status === BURST_STATUSES.OPEN) {
            byId.set(open.id, {
              ...stale,
              eligible_at: nowIso,
              version: Number(stale.version || 1) + 1,
              updated_at: nowIso,
            });
          }
          return {
            ok: false,
            reason: "open_burst_past_hard_close_flush_required",
            rollover: true,
            burst: clone(byId.get(open.id)),
            pending_message: message,
          };
        }

        if (projected.duplicate || !projected.appended) {
          return {
            ok: true,
            created: false,
            appended: false,
            duplicate: true,
            burst: clone(byId.get(open.id)),
          };
        }

        // CAS on version — loop from latest on conflict.
        const current = byId.get(open.id);
        if (!current || current.version !== open.version) {
          continue;
        }

        const next = {
          ...current,
          ...projected.burst,
          id: current.id,
          updated_at: nowIso,
        };
        byId.set(current.id, next);
        if (next.status !== BURST_STATUSES.OPEN) {
          openByThread.delete(group);
        }
        return {
          ok: true,
          created: false,
          appended: true,
          duplicate: false,
          burst: clone(next),
        };
      }
      throw new Error("burst_append_retry_exhausted");
    });
  }

  async function claimEligible({
    thread_key = null,
    burst_id = null,
    now: nowArg = null,
    worker_id = "worker",
    lease_ms = SELLER_INBOUND_BURST_CLAIM_LEASE_MS,
    scope = null,
  } = {}) {
    const scoped = resolveBurstScopeFilter(scope);
    if (scoped.deny) return { ok: false, reason: scoped.reason, burst: null };
    const nowIso = nowArg || now();
    const claimable = (b) => isClaimableBurst({ burst: b, now: nowIso, lease_ms });
    const byEligible = (a, b) => String(a.eligible_at).localeCompare(String(b.eligible_at));
    // Scope is applied to the candidate SET, before any branch picks a winner —
    // so it constrains the burst_id, thread_key and global branches identically
    // and an out-of-scope row is never a candidate for any of them.
    const rows = [...byId.values()].filter((b) => matchesBurstScope(b, scoped));
    let candidate = null;
    if (burst_id) {
      const match = rows.find((b) => b.burst_id === clean(burst_id));
      candidate = match && claimable(match) ? match : null;
      if (match && !candidate) {
        return { ok: false, reason: claimBlockReason(match, nowIso, lease_ms), burst: clone(match) };
      }
    } else if (thread_key) {
      const threadRows = rows.filter((b) => b.thread_key === clean(thread_key));
      candidate = threadRows.filter(claimable).sort(byEligible)[0] || null;
      if (!candidate && threadRows.length) {
        const blocked = threadRows.filter((b) => !b.completed_at).sort(byEligible)[0];
        if (blocked) {
          return { ok: false, reason: claimBlockReason(blocked, nowIso, lease_ms), burst: clone(blocked) };
        }
      }
    } else {
      candidate = rows.filter(claimable).sort(byEligible)[0] || null;
    }

    if (!candidate) return { ok: false, reason: "no_eligible_burst", burst: null };

    const token = crypto.randomBytes(16).toString("hex");
    const current = byId.get(candidate.id);
    if (!current || current.version !== candidate.version) {
      return { ok: false, reason: "cas_conflict", burst: null };
    }

    // Exclusive claim (or stale-lease reclaim): safety-latched bursts stay
    // SUPPRESSED but still take claim_token so only one worker finalizes the
    // no-reply decision. Reclaim keeps generation, constituents and
    // decision_idempotency_key intact — only lease bookkeeping changes.
    const next = {
      ...current,
      status: current.safety_latched ? BURST_STATUSES.SUPPRESSED : BURST_STATUSES.CLAIMED,
      claim_token: token,
      claimed_at: nowIso,
      claimed_by: clean(worker_id) || "worker",
      attempt_count: Number(current.attempt_count || 0) + 1,
      version: Number(current.version || 1) + 1,
      updated_at: nowIso,
    };
    byId.set(current.id, next);
    openByThread.delete(current.thread_key);
    return { ok: true, claim_token: token, burst: clone(next) };
  }

  function claimBlockReason(row, nowIso, lease_ms) {
    if (row.completed_at || row.status === BURST_STATUSES.COMPLETED) return "already_completed";
    if (row.status === BURST_STATUSES.FAILED || row.status === BURST_STATUSES.CANCELLED) {
      return "not_claimable";
    }
    const claimedMs = parseIsoMs(row.claimed_at, null);
    const leaseActive =
      Number.isFinite(claimedMs) && parseIsoMs(nowIso) < claimedMs + Number(lease_ms || 0);
    if (leaseActive) return "claim_lease_active";
    if (
      row.status === BURST_STATUSES.OPEN &&
      !isBurstEligible({ eligible_at: row.eligible_at, now: nowIso })
    ) {
      return "not_yet_eligible";
    }
    return "no_eligible_burst";
  }

  async function completeClaimed({
    burst_id,
    claim_token,
    result_summary = null,
    now: nowArg = null,
    status = BURST_STATUSES.COMPLETED,
  } = {}) {
    const nowIso = nowArg || now();
    const current = [...byId.values()].find((b) => b.burst_id === clean(burst_id));
    if (!current) return { ok: false, reason: "not_found" };
    if (current.claim_token !== clean(claim_token)) {
      return { ok: false, reason: "claim_token_mismatch", burst: clone(current) };
    }
    // Idempotent complete: completed_at is the terminal marker for both
    // COMPLETED and finalized-SUPPRESSED bursts.
    if (current.completed_at || current.status === BURST_STATUSES.COMPLETED) {
      return { ok: true, already_completed: true, burst: clone(current) };
    }
    if (
      current.status !== BURST_STATUSES.CLAIMED &&
      current.status !== BURST_STATUSES.SUPPRESSED
    ) {
      return { ok: false, reason: "invalid_status", burst: clone(current) };
    }
    const next = {
      ...current,
      status: current.safety_latched ? BURST_STATUSES.SUPPRESSED : status,
      completed_at: nowIso,
      result_summary: result_summary || current.result_summary || null,
      version: Number(current.version || 1) + 1,
      updated_at: nowIso,
    };
    byId.set(current.id, next);
    return { ok: true, burst: clone(next) };
  }

  async function latchSafety({
    thread_key,
    reason,
    kind = null,
    now: nowArg = null,
  } = {}) {
    const open = getOpen(thread_key);
    if (!open) return { ok: false, reason: "no_open_burst" };
    const current = byId.get(open.id);
    const nowIso = nowArg || now();
    const next = {
      ...current,
      safety_latched: true,
      safety_reason: reason || current.safety_reason,
      safety_kind: kind || current.safety_kind,
      eligible_at: nowIso,
      status: BURST_STATUSES.SUPPRESSED,
      version: Number(current.version || 1) + 1,
      updated_at: nowIso,
    };
    byId.set(current.id, next);
    openByThread.delete(current.thread_key);
    return { ok: true, burst: clone(next) };
  }

  async function listEligible({
    now: nowArg = null,
    limit = 20,
    lease_ms = SELLER_INBOUND_BURST_CLAIM_LEASE_MS,
    scope = null,
  } = {}) {
    const scoped = resolveBurstScopeFilter(scope);
    if (scoped.deny) return [];
    const nowIso = nowArg || now();
    // Scope filters BEFORE the sort+slice: an out-of-scope row must not occupy
    // a page slot. `eligible_at ASC` means the oldest row wins the page, so a
    // post-slice filter would let one stale burst starve every live one.
    return listAll()
      .filter((b) => matchesBurstScope(b, scoped))
      .filter((b) => isClaimableBurst({ burst: b, now: nowIso, lease_ms }))
      .sort((a, b) => String(a.eligible_at).localeCompare(String(b.eligible_at)))
      .slice(0, limit);
  }

  return {
    kind: "memory",
    appendMessage,
    claimEligible,
    completeClaimed,
    latchSafety,
    listEligible,
    getOpen,
    getById,
    _debug: { byId, openByThread, listAll },
  };
}

// ── Supabase store ───────────────────────────────────────────────────────────

function rowToBurst(row) {
  if (!row) return null;
  return {
    id: row.id,
    thread_key: row.thread_key,
    generation: row.generation,
    burst_id: row.burst_id,
    status: row.status,
    first_event_id: row.first_event_id,
    latest_event_id: row.latest_event_id,
    constituents: row.constituent_messages || [],
    first_received_at: row.first_received_at,
    last_received_at: row.last_received_at,
    eligible_at: row.eligible_at,
    hard_close_at: row.hard_close_at,
    safety_latched: Boolean(row.safety_latched),
    safety_reason: row.safety_reason,
    safety_kind: row.safety_kind,
    version: row.version,
    policy_version: row.policy_version,
    decision_idempotency_key: row.decision_idempotency_key,
    claim_token: row.claim_token,
    claimed_at: row.claimed_at,
    claimed_by: row.claimed_by,
    attempt_count: Number(row.attempt_count || 0),
    completed_at: row.completed_at,
    result_summary: row.result_summary,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function burstToRow(burst) {
  return {
    thread_key: burst.thread_key,
    generation: burst.generation,
    burst_id: burst.burst_id,
    status: burst.status,
    first_event_id: burst.first_event_id,
    latest_event_id: burst.latest_event_id,
    constituent_event_ids: (burst.constituents || []).map((c) => c.event_id).filter(Boolean),
    constituent_messages: burst.constituents || [],
    first_received_at: burst.first_received_at,
    last_received_at: burst.last_received_at,
    eligible_at: burst.eligible_at,
    hard_close_at: burst.hard_close_at,
    safety_latched: Boolean(burst.safety_latched),
    safety_reason: burst.safety_reason || null,
    safety_kind: burst.safety_kind || null,
    version: burst.version,
    policy_version: burst.policy_version,
    decision_idempotency_key: burst.decision_idempotency_key,
    claim_token: burst.claim_token,
    claimed_at: burst.claimed_at || null,
    claimed_by: burst.claimed_by || null,
    attempt_count: Number(burst.attempt_count || 0),
    completed_at: burst.completed_at || null,
    result_summary: burst.result_summary || null,
    updated_at: burst.updated_at || new Date().toISOString(),
  };
}

/**
 * Supabase-backed store. Concurrent append uses version CAS.
 * Prefer RPC claim_seller_inbound_burst when available; fall back to
 * select+update CAS.
 */
export function createSupabaseSellerInboundBurstStore({
  supabase,
  now = () => new Date().toISOString(),
} = {}) {
  if (!supabase) throw new Error("supabase_required");

  async function fetchOpen(thread_key) {
    const { data, error } = await supabase
      .from(TABLE)
      .select("*")
      .eq("thread_key", clean(thread_key))
      .eq("status", BURST_STATUSES.OPEN)
      .order("generation", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) throw error;
    return rowToBurst(data);
  }

  async function appendMessage({
    thread_key,
    message,
    debounce_ms = SELLER_INBOUND_BURST_DEBOUNCE_MS,
    max_duration_ms = SELLER_INBOUND_BURST_MAX_DURATION_MS,
    now: nowArg = null,
  } = {}) {
    const group = resolveBurstGroupKey({ thread_key });
    const nowIso = nowArg || now();
    // Bounded iterative retry (no recursion) for the two append races:
    // unique open-generation insert race and version-CAS lose. Exhaustion is
    // an explicit deterministic failure — webhook fails closed, provider
    // redelivers, never a per-message fallback.
    for (let round = 0; round < BURST_APPEND_MAX_ROUNDS; round += 1) {
      const result = await appendMessageOnce({
        group,
        message,
        debounce_ms,
        max_duration_ms,
        nowIso,
      });
      if (result.retry) continue;
      return result.value;
    }
    throw new Error("burst_append_retry_exhausted");
  }

  async function appendMessageOnce({ group, message, debounce_ms, max_duration_ms, nowIso }) {
    const open = await fetchOpen(group);

    if (!open) {
      const { data: lastRows } = await supabase
        .from(TABLE)
        .select("generation")
        .eq("thread_key", group)
        .order("generation", { ascending: false })
        .limit(1);
      const generation = (Number(lastRows?.[0]?.generation) || 0) + 1;
      const created = createOpenBurstState({
        thread_key: group,
        generation,
        message,
        now: nowIso,
        debounce_ms,
        max_duration_ms,
      });
      const decision_idempotency_key = buildBurstDecisionIdempotencyKey({
        thread_key: group,
        generation,
        burst_id: created.burst_id,
      });
      const insertRow = {
        ...burstToRow({
          ...created,
          decision_idempotency_key,
          updated_at: nowIso,
        }),
        created_at: nowIso,
      };
      const { data, error } = await supabase.from(TABLE).insert(insertRow).select("*").single();
      if (error) {
        // Unique open-burst race → re-read the winner and retry the append.
        if (String(error.message || "").includes("one_open") || error.code === "23505") {
          return { retry: true };
        }
        throw error;
      }
      return {
        value: { ok: true, created: true, appended: true, duplicate: false, burst: rowToBurst(data) },
      };
    }

    const projected = projectAppendToOpenBurst({
      burst: open,
      message,
      now: nowIso,
      debounce_ms,
      max_duration_ms,
    });

    if (projected.rollover) {
      // Leave old open for eligibility; open cannot accept — force-complete path
      // will pick it up. Create next generation.
      const { data: lastRows } = await supabase
        .from(TABLE)
        .select("generation")
        .eq("thread_key", group)
        .order("generation", { ascending: false })
        .limit(1);
      const generation = (Number(lastRows?.[0]?.generation) || open.generation) + 1;
      // Mark old open as past hard close by setting eligible_at=now if needed is left to claim.
      const created = createOpenBurstState({
        thread_key: group,
        generation,
        message,
        now: nowIso,
        debounce_ms,
        max_duration_ms,
      });
      // Old open still exists — unique partial index only allows one OPEN.
      // Close old by claiming/completing is required first. Force eligible now.
      await supabase
        .from(TABLE)
        .update({
          eligible_at: nowIso,
          updated_at: nowIso,
          version: Number(open.version || 1) + 1,
        })
        .eq("id", open.id)
        .eq("version", open.version)
        .eq("status", BURST_STATUSES.OPEN);

      // Claim-complete old generation without decision (handoff marker) then insert
      // is complex mid-append. Simpler: refuse rollover insert until old claimed;
      // caller flushEligible first. Here we still try claim of old.
      return {
        value: {
          ok: false,
          reason: "open_burst_past_hard_close_flush_required",
          rollover: true,
          burst: open,
          pending_message: message,
        },
      };
    }

    if (projected.duplicate || !projected.appended) {
      return {
        value: { ok: true, created: false, appended: false, duplicate: true, burst: open },
      };
    }

    const next = projected.burst;
    const patch = {
      latest_event_id: next.latest_event_id,
      constituent_event_ids: (next.constituents || []).map((c) => c.event_id).filter(Boolean),
      constituent_messages: next.constituents,
      last_received_at: next.last_received_at,
      eligible_at: next.eligible_at,
      safety_latched: next.safety_latched,
      safety_reason: next.safety_reason,
      safety_kind: next.safety_kind,
      status: next.status,
      version: next.version,
      updated_at: nowIso,
    };

    const { data, error } = await supabase
      .from(TABLE)
      .update(patch)
      .eq("id", open.id)
      .eq("version", open.version)
      .eq("status", BURST_STATUSES.OPEN)
      .select("*")
      .maybeSingle();

    if (error) throw error;
    if (!data) {
      // CAS lost — re-read the latest row and retry.
      return { retry: true };
    }
    return {
      value: { ok: true, created: false, appended: true, duplicate: false, burst: rowToBurst(data) },
    };
  }

  /**
   * The ONE eligible-selection query, shared by both doors into production
   * work (listEligible and claimEligible). They are kept on a single builder
   * deliberately: a scoped list path next to an unscoped claim path is exactly
   * how an authority gate gets bypassed without anybody editing the gate.
   *
   * Filter order reproduces the pre-existing chain exactly, so a global scope
   * issues the identical PostgREST request it issued before scoping existed.
   */
  function buildEligibleQuery({
    nowIso,
    staleIso,
    scoped,
    thread_key = null,
    burst_id = null,
    limit = 1,
  }) {
    let query = supabase
      .from(TABLE)
      .select("*")
      .is("completed_at", null)
      .or(
        [
          `and(status.in.(${BURST_STATUSES.OPEN},${BURST_STATUSES.SUPPRESSED}),eligible_at.lte.${nowIso},or(claimed_at.is.null,claimed_at.lte.${staleIso}))`,
          `and(status.eq.${BURST_STATUSES.CLAIMED},claimed_at.lte.${staleIso})`,
        ].join(",")
      )
      .order("eligible_at", { ascending: true })
      .limit(limit);
    if (burst_id) query = query.eq("burst_id", clean(burst_id));
    if (thread_key) query = query.eq("thread_key", clean(thread_key));
    // Scope lives in the WHERE clause, never in a post-filter: `eligible_at
    // ASC … LIMIT n` gives the page to the OLDEST rows, so an out-of-scope
    // burst that reaches the result set has already starved the live work it
    // outranks — filtering it afterwards returns an empty page, not the right
    // one.
    if (!scoped.global) {
      query = query
        .in("thread_key", scoped.thread_keys)
        // Message-time window: which conversation moment this burst belongs to.
        .gte("first_received_at", scoped.min_first)
        .lte("first_received_at", scoped.max_first)
        // Row-insert window: the anti-backdating leg. created_at is now() at
        // INSERT, so a replayed or backdated first_received_at cannot carry an
        // old row into the session on its own.
        .gte("created_at", scoped.min_created)
        .lte("created_at", scoped.max_created);
    }
    return query;
  }

  async function claimEligible({
    thread_key = null,
    burst_id = null,
    now: nowArg = null,
    worker_id = "worker",
    lease_ms = SELLER_INBOUND_BURST_CLAIM_LEASE_MS,
    scope = null,
  } = {}) {
    // Authorization first — an unauthorized caller issues no query, no RPC and
    // no update. There is no code path here that claims and then authorizes.
    const scoped = resolveBurstScopeFilter(scope);
    if (scoped.deny) return { ok: false, reason: scoped.reason, burst: null };
    const nowIso = nowArg || now();
    const token = crypto.randomBytes(16).toString("hex");
    // CAS/pre-select predicate mirrors the RPC exactly (see isClaimableBurst):
    // never a completed row; open/suppressed only when eligible AND no live
    // claim lease; claimed only when the lease expired (crash recovery).
    const staleIso = new Date(parseIsoMs(nowIso) - (Number(lease_ms) || 0)).toISOString();

    // A scoped claim resolves its target BEFORE claiming. claim_seller_inbound_burst
    // selects `ORDER BY b.eligible_at ASC … FOR UPDATE SKIP LOCKED LIMIT 1`
    // over every row matching p_thread_key when p_burst_id is null (migration
    // 20260726120000_seller_inbound_bursts.sql:102-124) — so handing it a bare
    // thread key claims the OLDEST burst on that thread, which is precisely how
    // a 36-hour-old artifact outranks the live burst beside it. Pinning
    // p_burst_id to a row the scope already authorized takes that choice away
    // from the database without giving up SKIP LOCKED atomicity, stale-lease
    // reclaim, attempt_count or the version bump.
    let pinned = null;
    if (!scoped.global) {
      const { data: candidates, error: candidate_error } = await buildEligibleQuery({
        nowIso,
        staleIso,
        scoped,
        thread_key,
        burst_id,
        limit: 1,
      });
      if (candidate_error) throw candidate_error;
      const candidate_row = candidates?.[0];
      if (!candidate_row) return { ok: false, reason: "no_eligible_burst", burst: null };
      const candidate_burst = rowToBurst(candidate_row);
      if (
        !isClaimableBurst({ burst: candidate_burst, now: nowIso, lease_ms }) ||
        !matchesBurstScope(candidate_burst, scoped)
      ) {
        return { ok: false, reason: "no_eligible_burst", burst: null };
      }
      pinned = candidate_burst;
    }

    // Prefer RPC if present (atomic SKIP LOCKED claim + stale-lease reclaim)
    if (typeof supabase.rpc === "function") {
      try {
        const { data, error } = await supabase.rpc("claim_seller_inbound_burst", {
          p_thread_key: (pinned ? pinned.thread_key : thread_key) || null,
          p_burst_id: (pinned ? pinned.burst_id : burst_id) || null,
          p_now: nowIso,
          p_worker_id: clean(worker_id) || "worker",
          p_claim_token: token,
          p_lease_ms: Number(lease_ms) || SELLER_INBOUND_BURST_CLAIM_LEASE_MS,
        });
        if (!error && data) {
          const row = Array.isArray(data) ? data[0] : data;
          if (row) {
            const claimed = rowToBurst(row);
            // Unreachable while p_burst_id pins the authorized row. Kept because
            // the only outcome worse than a failed claim is handing an
            // out-of-scope burst to the reply path: refusing it leaves a lease
            // that expires on its own, so nothing is stranded permanently.
            if (!matchesBurstScope(claimed, scoped)) {
              return { ok: false, reason: "burst_scope_violation_after_claim", burst: null };
            }
            return { ok: true, claim_token: row.claim_token || token, burst: claimed };
          }
        }
      } catch {
        // fall through to CAS
      }
    }

    // CAS fallback — same builder, so it carries the same scope.
    const { data: rows, error } = await buildEligibleQuery({
      nowIso,
      staleIso,
      scoped,
      thread_key: pinned ? pinned.thread_key : thread_key,
      burst_id: pinned ? pinned.burst_id : burst_id,
      limit: 1,
    });
    if (error) throw error;
    const candidate = rows?.[0];
    if (!candidate) return { ok: false, reason: "no_eligible_burst", burst: null };
    if (!isClaimableBurst({ burst: rowToBurst(candidate), now: nowIso, lease_ms })) {
      return { ok: false, reason: "no_eligible_burst", burst: null };
    }
    // Last gate before the only mutation in this function.
    if (!matchesBurstScope(rowToBurst(candidate), scoped)) {
      return { ok: false, reason: "no_eligible_burst", burst: null };
    }

    const nextStatus = candidate.safety_latched
      ? BURST_STATUSES.SUPPRESSED
      : BURST_STATUSES.CLAIMED;

    const { data: claimed, error: claimErr } = await supabase
      .from(TABLE)
      .update({
        status: nextStatus,
        claim_token: token,
        claimed_at: nowIso,
        claimed_by: clean(worker_id) || "worker",
        attempt_count: Number(candidate.attempt_count || 0) + 1,
        version: Number(candidate.version || 1) + 1,
        updated_at: nowIso,
      })
      .eq("id", candidate.id)
      .eq("version", candidate.version)
      .in("status", [BURST_STATUSES.OPEN, BURST_STATUSES.SUPPRESSED, BURST_STATUSES.CLAIMED])
      .is("completed_at", null)
      .select("*")
      .maybeSingle();

    if (claimErr) throw claimErr;
    if (!claimed) return { ok: false, reason: "already_claimed", burst: null };
    return { ok: true, claim_token: token, burst: rowToBurst(claimed) };
  }

  async function completeClaimed({
    burst_id,
    claim_token,
    result_summary = null,
    now: nowArg = null,
    status = BURST_STATUSES.COMPLETED,
  } = {}) {
    const nowIso = nowArg || now();
    const { data: current, error } = await supabase
      .from(TABLE)
      .select("*")
      .eq("burst_id", clean(burst_id))
      .maybeSingle();
    if (error) throw error;
    if (!current) return { ok: false, reason: "not_found" };
    if (current.claim_token !== clean(claim_token)) {
      return { ok: false, reason: "claim_token_mismatch", burst: rowToBurst(current) };
    }
    // completed_at is the terminal marker for COMPLETED and finalized-
    // SUPPRESSED bursts alike — both are idempotent re-completes.
    if (current.completed_at || current.status === BURST_STATUSES.COMPLETED) {
      return { ok: true, already_completed: true, burst: rowToBurst(current) };
    }
    const finalStatus = current.safety_latched ? BURST_STATUSES.SUPPRESSED : status;
    // Atomic terminal CAS: completed_at IS NULL in the update predicate makes
    // exactly one of two concurrent same-token completions win — the loser
    // observes complete_cas_failed and the first terminal result_summary
    // stays authoritative (never overwritten).
    const { data, error: upErr } = await supabase
      .from(TABLE)
      .update({
        status: finalStatus,
        completed_at: nowIso,
        result_summary: result_summary || current.result_summary,
        version: Number(current.version || 1) + 1,
        updated_at: nowIso,
      })
      .eq("id", current.id)
      .eq("claim_token", clean(claim_token))
      .is("completed_at", null)
      .select("*")
      .maybeSingle();
    if (upErr) throw upErr;
    if (!data) return { ok: false, reason: "complete_cas_failed" };
    return { ok: true, burst: rowToBurst(data) };
  }

  async function latchSafety({
    thread_key,
    reason,
    kind = null,
    now: nowArg = null,
  } = {}) {
    const open = await fetchOpen(thread_key);
    if (!open) return { ok: false, reason: "no_open_burst" };
    const nowIso = nowArg || now();
    const { data, error } = await supabase
      .from(TABLE)
      .update({
        safety_latched: true,
        safety_reason: reason,
        safety_kind: kind,
        eligible_at: nowIso,
        status: BURST_STATUSES.SUPPRESSED,
        version: Number(open.version || 1) + 1,
        updated_at: nowIso,
      })
      .eq("id", open.id)
      .eq("version", open.version)
      .select("*")
      .maybeSingle();
    if (error) throw error;
    if (!data) return { ok: false, reason: "cas_conflict" };
    return { ok: true, burst: rowToBurst(data) };
  }

  async function listEligible({
    now: nowArg = null,
    limit = 20,
    lease_ms = SELLER_INBOUND_BURST_CLAIM_LEASE_MS,
    scope = null,
  } = {}) {
    const scoped = resolveBurstScopeFilter(scope);
    // Denied callers never reach Supabase at all — no page is fetched, so no
    // out-of-scope burst is ever even observed, let alone handed to a claim.
    if (scoped.deny) return [];
    const nowIso = nowArg || now();
    const staleIso = new Date(parseIsoMs(nowIso) - (Number(lease_ms) || 0)).toISOString();
    const { data, error } = await buildEligibleQuery({ nowIso, staleIso, scoped, limit });
    if (error) throw error;
    return (data || [])
      .map(rowToBurst)
      .filter((b) => isClaimableBurst({ burst: b, now: nowIso, lease_ms }))
      // Defence in depth: re-assert the scope the query already applied, so a
      // mis-parsed PostgREST filter degrades to "returns nothing" rather than
      // "returns everything".
      .filter((b) => matchesBurstScope(b, scoped));
  }

  return {
    kind: "supabase",
    appendMessage,
    claimEligible,
    completeClaimed,
    latchSafety,
    listEligible,
    getOpen: fetchOpen,
  };
}

export default {
  createMemorySellerInboundBurstStore,
  createSupabaseSellerInboundBurstStore,
  resolveBurstScopeFilter,
  matchesBurstScope,
};
