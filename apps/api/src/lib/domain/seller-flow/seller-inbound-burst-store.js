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
  } = {}) {
    const nowIso = nowArg || now();
    const claimable = (b) => isClaimableBurst({ burst: b, now: nowIso, lease_ms });
    const byEligible = (a, b) => String(a.eligible_at).localeCompare(String(b.eligible_at));
    const rows = [...byId.values()];
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
  } = {}) {
    const nowIso = nowArg || now();
    return listAll()
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

  async function claimEligible({
    thread_key = null,
    burst_id = null,
    now: nowArg = null,
    worker_id = "worker",
    lease_ms = SELLER_INBOUND_BURST_CLAIM_LEASE_MS,
  } = {}) {
    const nowIso = nowArg || now();
    const token = crypto.randomBytes(16).toString("hex");

    // Prefer RPC if present (atomic SKIP LOCKED claim + stale-lease reclaim)
    if (typeof supabase.rpc === "function") {
      try {
        const { data, error } = await supabase.rpc("claim_seller_inbound_burst", {
          p_thread_key: thread_key || null,
          p_burst_id: burst_id || null,
          p_now: nowIso,
          p_worker_id: clean(worker_id) || "worker",
          p_claim_token: token,
          p_lease_ms: Number(lease_ms) || SELLER_INBOUND_BURST_CLAIM_LEASE_MS,
        });
        if (!error && data) {
          const row = Array.isArray(data) ? data[0] : data;
          if (row) return { ok: true, claim_token: row.claim_token || token, burst: rowToBurst(row) };
        }
      } catch {
        // fall through to CAS
      }
    }

    // CAS fallback mirrors the RPC predicate exactly (see isClaimableBurst):
    // never a completed row; open/suppressed only when eligible AND no live
    // claim lease; claimed only when the lease expired (crash recovery).
    const staleIso = new Date(parseIsoMs(nowIso) - (Number(lease_ms) || 0)).toISOString();
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
      .limit(1);
    if (burst_id) query = query.eq("burst_id", clean(burst_id));
    if (thread_key) query = query.eq("thread_key", clean(thread_key));

    const { data: rows, error } = await query;
    if (error) throw error;
    const candidate = rows?.[0];
    if (!candidate) return { ok: false, reason: "no_eligible_burst", burst: null };
    if (!isClaimableBurst({ burst: rowToBurst(candidate), now: nowIso, lease_ms })) {
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
  } = {}) {
    const nowIso = nowArg || now();
    const staleIso = new Date(parseIsoMs(nowIso) - (Number(lease_ms) || 0)).toISOString();
    const { data, error } = await supabase
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
    if (error) throw error;
    return (data || [])
      .map(rowToBurst)
      .filter((b) => isClaimableBurst({ burst: b, now: nowIso, lease_ms }));
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
};
