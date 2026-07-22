/**
 * In-memory send_queue / message_events / campaigns / inbox_thread_state
 * store for tests/critical/deterministic-launch-lifecycle-core.test.mjs.
 *
 * CONTRACT: this file emulates STORAGE and PostgREST query/response shape
 * only (filtering, chaining, the send_queue unique-dedupe-key constraint,
 * row-lock compare-and-swap). It must never decide an eligibility, bucket,
 * stage, suppression, or dispatch outcome — every such decision in the tests
 * that use this helper comes from a real production function. Two DISCLOSED
 * simplifications sit outside that storage-only contract, both bypasses
 * (not competing decision logic) of checks that are exhaustively covered by
 * other real-code tests elsewhere in tests/critical/:
 *   - makeLifecycleQueueRunDeps()'s `verifyDispatchAuthorization` always
 *     returns ok:true, skipping the real execution-mode/emergency-stop RPC
 *     decision covered by queue-atomic-claim-containment.test.mjs.
 *   - `getSystemFlag`/`getSystemValue` return fixed "everything enabled"
 *     values rather than reading real system_control rows.
 *
 * Mirrors the real Postgres constraint this lifecycle relies on so the real
 * production functions (insertSupabaseSendQueueRow, runSendQueue,
 * processSendQueueItem, ...) can run unmodified against it:
 *   - uq_send_queue_active_dedupe_key (supabase/migrations/20260428_harden_send_queue.sql):
 *     dedupe_key unique WHERE sent_at IS NULL AND queue_status IN
 *     ('queued','ready','runnable','scheduled','pending','paused','paused_after_hours').
 */
import { normalizeSendQueueRow, shouldRunSendQueueRow } from "@/lib/supabase/sms-engine.js";

const ACTIVE_DEDUPE_STATUSES = new Set([
  "queued",
  "ready",
  "runnable",
  "scheduled",
  "pending",
  "paused",
  "paused_after_hours",
]);

function cleanStr(value) {
  return String(value ?? "").trim();
}

export function makeLifecycleStore() {
  const sendQueueRows = new Map();
  const messageEvents = [];
  const campaigns = new Map();
  const threadState = new Map();
  let nextQueueId = 1;
  let nextEventId = 1;

  function appendMessageEvent(payload) {
    const evt = { id: `evt_${nextEventId++}`, ...payload };
    messageEvents.push(evt);
    return evt;
  }

  // Mirrors the real Postgres upsert this lifecycle relies on for replay
  // safety (e.g. writeOutboundSuccessMessageEvent in sms-engine.js:
  // `.from(MESSAGE_EVENTS_TABLE).upsert(payload, { onConflict: "message_event_key",
  // ignoreDuplicates: false })`). A conflicting message_event_key updates the
  // existing row in place (preserving its id) instead of appending a
  // duplicate. Payloads with no message_event_key, or upserts not declaring
  // onConflict: "message_event_key", fall back to plain append — no
  // production caller proves a different conflict rule for those.
  function upsertMessageEvent(payload, options = {}) {
    const conflictColumn = cleanStr(options?.onConflict);
    const eventKey = cleanStr(payload?.message_event_key);
    if (conflictColumn === "message_event_key" && eventKey) {
      const existing = messageEvents.find((e) => cleanStr(e.message_event_key) === eventKey);
      if (existing) {
        const { id: _incomingId, ...rest } = payload;
        Object.assign(existing, rest);
        return { ...existing };
      }
    }
    return appendMessageEvent(payload);
  }

  function activeDedupeConflict(dedupe_key) {
    const key = cleanStr(dedupe_key);
    if (!key) return null;
    for (const row of sendQueueRows.values()) {
      if (
        cleanStr(row.dedupe_key) === key &&
        !row.sent_at &&
        ACTIVE_DEDUPE_STATUSES.has(String(row.queue_status || "").toLowerCase())
      ) {
        return row;
      }
    }
    return null;
  }

  return {
    sendQueueRows,
    messageEvents,
    campaigns,
    threadState,

    setThreadState(thread_key, patch) {
      const existing = threadState.get(thread_key) || { thread_key };
      threadState.set(thread_key, { ...existing, ...patch, thread_key });
      return threadState.get(thread_key);
    },

    insertSendQueueRow(payload) {
      const conflict = activeDedupeConflict(payload.dedupe_key);
      if (conflict) {
        return {
          data: null,
          error: { code: "23505", message: "duplicate key value violates unique constraint \"uq_send_queue_active_dedupe_key\"" },
        };
      }
      const id = cleanStr(payload.id) || `sq_${nextQueueId++}`;
      const stored = { ...payload, id };
      sendQueueRows.set(id, stored);
      return { data: { ...stored }, error: null };
    },

    recordMessageEvent: appendMessageEvent,
    upsertMessageEvent,

    setCampaign(id, status) {
      campaigns.set(id, { id, status });
    },

    runnableRowsLoader() {
      return async (limit = 50, deps = {}) => {
        const now = deps.now || new Date().toISOString();
        const allRows = [...sendQueueRows.values()].map((r) => normalizeSendQueueRow(r));
        const skipped = [];
        const runnable = [];
        for (const row of allRows) {
          const decision = shouldRunSendQueueRow(row, now);
          if (!decision.ok) {
            skipped.push({ id: row.id, reason: decision.reason, row });
            continue;
          }
          runnable.push(row);
          if (runnable.length >= limit) break;
        }
        return {
          rows: runnable,
          raw_rows: allRows,
          skipped,
          now,
          preclaim_scanned_count: allRows.length,
          eligible_claim_count: runnable.length,
          preclaim_outside_window_excluded_count: 0,
          preclaim_retry_pending_excluded_count: skipped.filter((s) => s.reason === "next_retry_pending").length,
          preclaim_paused_name_missing_count: 0,
          preclaim_paused_invalid_count: 0,
          preclaim_paused_max_retries_count: 0,
          skipped_invalid_phone_count: 0,
          skipped_missing_body_count: 0,
        };
      };
    },
  };
}

/** Best-effort evaluator for a single PostgREST .or() sub-clause: col.op.value (supports eq/ilike, and metadata->>key columns). */
function evalOrSubclause(row, subclause) {
  const parts = String(subclause || "").trim().split(".");
  if (parts.length < 3) return false;
  const [col, op, ...rest] = parts;
  const value = rest.join(".");
  const rawVal = col.includes("->>")
    ? (row?.metadata && typeof row.metadata === "object" ? row.metadata[col.split("->>")[1]] : undefined)
    : row?.[col];
  const strVal = cleanStr(rawVal).toLowerCase();
  if (op === "eq") return strVal === cleanStr(value).toLowerCase();
  if (op === "ilike") {
    const pattern = cleanStr(value).toLowerCase().replace(/%/g, "");
    return pattern ? strVal.includes(pattern) : true;
  }
  return false;
}

function makeSelectChain(rowsGetter) {
  let filtered = rowsGetter();
  const api = {
    eq(col, val) {
      filtered = filtered.filter((r) => cleanStr(r?.[col]) === cleanStr(val));
      return api;
    },
    in(col, vals) {
      const set = new Set((vals || []).map(cleanStr));
      filtered = filtered.filter((r) => set.has(cleanStr(r?.[col])));
      return api;
    },
    gte(col, val) {
      const cutoff = new Date(val).getTime();
      filtered = filtered.filter((r) => new Date(r?.[col] || 0).getTime() >= cutoff);
      return api;
    },
    lt(col, val) {
      const cutoff = new Date(val).getTime();
      filtered = filtered.filter((r) => new Date(r?.[col] || 0).getTime() < cutoff);
      return api;
    },
    ilike(col, val) {
      const pattern = cleanStr(val).toLowerCase().replace(/%/g, "");
      filtered = filtered.filter((r) => cleanStr(r?.[col]).toLowerCase().includes(pattern));
      return api;
    },
    not() {
      return api;
    },
    or(clause) {
      const subclauses = String(clause || "").split(",");
      filtered = filtered.filter((r) => subclauses.some((sc) => evalOrSubclause(r, sc)));
      return api;
    },
    order() {
      return api;
    },
    limit(n) {
      filtered = filtered.slice(0, n);
      return api;
    },
    maybeSingle: async () => ({ data: filtered[0] ? { ...filtered[0] } : null, error: null }),
    single: async () => ({ data: filtered[0] ? { ...filtered[0] } : null, error: null }),
    then(resolve, reject) {
      return Promise.resolve({ data: filtered.map((r) => ({ ...r })), error: null }).then(resolve, reject);
    },
  };
  return api;
}

function makeUpdateChain(rowsGetter, patch) {
  let matchers = [];
  const apply = () => {
    const matched = rowsGetter().filter((r) => matchers.every((m) => m(r)));
    matched.forEach((r) => Object.assign(r, patch));
    return matched.map((r) => ({ ...r }));
  };
  const chain = {
    eq(col, val) {
      matchers.push((r) => cleanStr(r?.[col]) === cleanStr(val));
      return chain;
    },
    lt(col, val) {
      const cutoff = new Date(val).getTime();
      matchers.push((r) => new Date(r?.[col] || 0).getTime() < cutoff);
      return chain;
    },
    select() {
      return {
        maybeSingle: async () => {
          const m = apply();
          return { data: m[0] || null, error: null };
        },
        single: async () => {
          const m = apply();
          return { data: m[0] || null, error: null };
        },
        then(resolve, reject) {
          return Promise.resolve({ data: apply(), error: null }).then(resolve, reject);
        },
      };
    },
    then(resolve, reject) {
      return Promise.resolve({ data: apply(), error: null }).then(resolve, reject);
    },
  };
  return chain;
}

/** Fake supabase client backing the lifecycle store's send_queue / message_events / campaigns tables. */
export function makeLifecycleFakeSupabase(store) {
  return {
    rpc(name) {
      if (name === "queue_acquire_global_execution_lock") return Promise.resolve({ data: true, error: null });
      if (name === "queue_release_global_execution_lock") return Promise.resolve({ data: true, error: null });
      return Promise.resolve({ data: null, error: { code: "42883", message: "function does not exist" } });
    },
    from(table) {
      if (table === "send_queue") {
        return {
          insert: (payload) => ({
            select: () => ({
              maybeSingle: async () => store.insertSendQueueRow(payload),
              single: async () => store.insertSendQueueRow(payload),
            }),
          }),
          select: () => makeSelectChain(() => [...store.sendQueueRows.values()]),
          update: (patch) => makeUpdateChain(() => [...store.sendQueueRows.values()], patch),
        };
      }
      if (table === "message_events") {
        return {
          insert: (payload) => ({
            select: () => ({
              single: async () => ({ data: store.recordMessageEvent(payload), error: null }),
            }),
          }),
          upsert: (payload, options = {}) => ({
            select: () => ({
              maybeSingle: async () => ({ data: store.upsertMessageEvent(payload, options), error: null }),
            }),
          }),
          select: () => makeSelectChain(() => store.messageEvents),
        };
      }
      if (table === "campaigns") {
        return {
          select: () => makeSelectChain(() => [...store.campaigns.values()]),
        };
      }
      if (table === "inbox_thread_state") {
        return {
          select: () => makeSelectChain(() => [...store.threadState.values()]),
          upsert: (payload) => ({
            select: () => ({
              maybeSingle: async () => {
                const merged = store.setThreadState(payload.thread_key, payload);
                return { data: merged, error: null };
              },
            }),
          }),
        };
      }
      // Generic empty fallback for tables this harness does not model
      // (phone_suppressions, contact_outreach_state, ...) — "not found" reads
      // as "not suppressed" throughout this codebase's guard functions.
      return {
        select: () => makeSelectChain(() => []),
        insert: () => ({
          select: () => ({
            maybeSingle: async () => ({ data: { id: `mock-${table}` }, error: null }),
            single: async () => ({ data: { id: `mock-${table}` }, error: null }),
          }),
        }),
        upsert: (payload) => ({
          select: () => Promise.resolve({ data: Array.isArray(payload) ? payload : [payload], error: null }),
          then(resolve, reject) {
            return Promise.resolve({ data: Array.isArray(payload) ? payload : [payload], error: null }).then(resolve, reject);
          },
        }),
        update: () => makeUpdateChain(() => [], {}),
      };
    },
  };
}

/** Builds the deps object needed to run insertSupabaseSendQueueRow / enqueueSendQueueItem for real. */
export function makeLifecycleWriteDeps(store, now) {
  const supabase = makeLifecycleFakeSupabase(store);
  return { supabase, supabaseClient: supabase, now };
}

/** Builds the deps object needed to run runSendQueue / processSendQueueItem for real with a fake provider. */
export function makeLifecycleQueueRunDeps(store, { now, sendTextgridSMS }) {
  const supabase = makeLifecycleFakeSupabase(store);
  return {
    now,
    supabase,
    supabaseClient: supabase,
    // Fixed "everything enabled" fixture values, not a re-derived decision —
    // see the file-level CONTRACT note on disclosed simplifications.
    getSystemFlag: async () => true,
    getSystemValue: async (key) => {
      const values = {
        queue_processor_mode: "live",
        queue_execution_mode: "normal",
        queue_emergency_stop_at: "",
      };
      return Object.prototype.hasOwnProperty.call(values, key) ? values[key] : null;
    },
    reconcileCanonicalQueueLifecycle: async () => ({ ok: true, reconciled: 0 }),
    loadRunnableSendQueueRows: store.runnableRowsLoader(),
    // Bypasses the real execution-mode/emergency-stop RPC decision — see the
    // file-level CONTRACT note; queue-atomic-claim-containment.test.mjs
    // covers that decision with real code.
    verifyDispatchAuthorization: async () => ({ ok: true, reason: "dispatch_authorized" }),
    // Storage-layer compare-and-swap (mirrors the real queue_atomic_claim_send_row
    // RPC's is_locked/lock_token check), not a business decision.
    claimSendQueueRow: async (normalizedRow, patch) => {
      const stored = store.sendQueueRows.get(normalizedRow.id);
      if (!stored) return { claimed: false, reason: "queue_row_not_found" };
      if (stored.is_locked) return { claimed: false, reason: "queue_row_not_claimable" };
      Object.assign(stored, patch);
      return { claimed: true, row: { ...stored }, lock_token: patch.lock_token };
    },
    // Storage-layer optimistic-lock update (mirrors `UPDATE ... WHERE id=... AND
    // lock_token=...`), not a business decision.
    updateSendQueueRowWithLock: async (row_id, lock_token, payload) => {
      const stored = store.sendQueueRows.get(row_id);
      if (!stored) return null;
      if (lock_token && stored.lock_token && stored.lock_token !== lock_token) return null;
      Object.assign(stored, payload);
      return normalizeSendQueueRow(stored);
    },
    writeOutboundSuccessMessageEvent: async (payload) => store.recordMessageEvent(payload),
    writeOutboundFailureMessageEvent: async (payload) => store.recordMessageEvent(payload),
    sendTextgridSMS,
  };
}
