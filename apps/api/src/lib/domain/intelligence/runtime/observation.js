/**
 * IC8 OBSERVATION HOOKS -- the production wiring of the decision journal and
 * the corrections writer (architecture §5.4, §6, §10). Observation only: no
 * hook changes what production decides or does.
 *
 * Every hook is ONE fail-open line at its site:
 *   H1 observeSellerTurn          process-seller-inbound-message.js (post-execution)
 *   H2 observeSendQueueInsert     sms-engine insertSupabaseSendQueueRow (success)
 *      observeCampaignBatchInsert campaign-automation-service batch hydration
 *   H3 observeFeederDecision      run-campaign-outbound-feeder feedCampaignBatch
 *   corrections                   beginCorrectionCapture(...) -> handle.commit()
 *
 * Contract (proved in tests/critical/ic8-observation-hooks.test.mjs):
 *   - DOUBLE GATE. The env ceiling INTELLIGENCE_LOGGING_ENABLED (exact "true",
 *     read synchronously) AND system_control.intelligence_logging_enabled
 *     (absent = off, cached 30 s). With the ceiling off a hook returns after
 *     one env read: no import, no client, no network, no derivation. With the
 *     runtime switch known-off it returns after a cache read.
 *   - NEVER AWAITED on a webhook path: hooks return a plain object
 *     synchronously; journal rows go to the bounded buffer flushed on an
 *     unref'd timer (decision-journal.js). Correction capture is the one
 *     awaited call (it must read the original BEFORE the overwrite) and is
 *     bounded by budgetMs; disabled, it resolves immediately without work.
 *   - SWALLOWS AND COUNTS every error (getObservationStats()).
 *   - IDS ONLY: hooks pass in-scope objects; only ids, codes and versions
 *     reach a row (buildJournalRow + deriveStrategyIntent enforce it).
 *   - STAMPS POLICY_FINGERPRINT (policy_version) and module versions.
 *   - SCHEMA MISSING = FAIL CLOSED, SILENTLY: if the PROPOSED migration is not
 *     applied, the first write latches "schema unavailable" for 10 minutes;
 *     writes during the latch make no network call and log nothing.
 *
 * Everything outside intelligence/ (supabase client, system_control, policy
 * manifest) is imported lazily, only once the ceiling is on, so these hooks add
 * no import edges to the hot modules that call them.
 */

import { envCeiling, readRuntimeSwitch } from "../config/flags.js";
import { createDecisionJournal } from "../journal/decision-journal.js";
import { deriveStrategyIntent } from "../journal/strategy-intent.js";
import { createCorrectionsWriter, operatorIdFromHeaders } from "../corrections/corrections.js";
import { createIntelligenceStore } from "../store/intelligence-store.js";
import { settleWithin } from "../util/async.js";

export const OBSERVATION_VERSION = "ic8_observation@1";
export const OBSERVATION_FLAG = "INTELLIGENCE_LOGGING_ENABLED";
export const OBSERVATION_DEFAULTS = Object.freeze({
  runtimeTtlMs: 30_000,
  runtimeReadTimeoutMs: 250,
  storeTimeoutMs: 2_000,
  schemaLatchMs: 10 * 60_000,
  correctionBudgetMs: 750,
});

/** PostgREST / Postgres codes meaning "the intelligence schema or table is not there". */
const SCHEMA_MISSING_CODES = new Set(["PGRST106", "PGRST205", "PGRST204", "42P01", "3F000", "42501"]);
const SCHEMA_MISSING_RE = /(schema must be one of|invalid schema|schema .* does not exist|relation .* does not exist|could not find the table|permission denied for schema)/i;
const CODE_RE = /^[a-z0-9][a-z0-9_:.-]{0,79}$/i;

const clean = (value) => String(value ?? "").trim();
const obj = (value) => (value && typeof value === "object" && !Array.isArray(value) ? value : {});

const FEED_BOUND_CODES = Object.freeze({
  buffer: "FEED_BOUND_BUFFER",
  cohort_exhausted: "FEED_BOUND_COHORT_EXHAUSTED",
  total_cap_reached: "FEED_BOUND_TOTAL_CAP_REACHED",
  daily_cap_reached: "FEED_BOUND_DAILY_CAP_REACHED",
  buffer_full: "FEED_BOUND_BUFFER_FULL",
  campaign_cap_zero: "FEED_BOUND_CAMPAIGN_CAP_ZERO",
});

// ── state ──────────────────────────────────────────────────────────────────

function freshCounters() {
  return {
    hook_calls: 0,
    skipped_ceiling_off: 0,
    skipped_runtime_off: 0,
    skipped_dry_run: 0,
    skipped_unchanged: 0,
    skipped_invalid: 0,
    entries_submitted: 0,
    hook_errors: 0,
    schema_unavailable: 0,
    corrections_captured: 0,
    corrections_skipped_noop: 0,
    corrections_load_failed: 0,
    corrections_write_failed: 0,
  };
}

let deps = null; // test/route overrides: { env, readSystemFlag, client, store, logger, now, setTimer, policy, options }
let counters = freshCounters();
let runtimePromise = null;
let runtimeRef = null;
let runtimeCache = null; // { on, at }
let runtimeRead = null; // the in-flight runtime switch read, shared
let generation = 0; // bumps on reconfigure so stale async work cannot write state
let schemaLatchedUntil = 0;
const pending = new Set();

function nowMs() {
  return typeof deps?.now === "function" ? deps.now() : Date.now();
}

function env() {
  return deps?.env || process.env;
}

function opts() {
  return { ...OBSERVATION_DEFAULTS, ...(deps?.options || {}) };
}

function logger() {
  return deps?.logger || console;
}

/** The env ceiling: one synchronous env read, nothing else. */
export function observationCeilingOn() {
  try {
    return envCeiling(OBSERVATION_FLAG, env());
  } catch {
    return false;
  }
}

function schemaLatched() {
  return nowMs() < schemaLatchedUntil;
}

function isSchemaMissing(error) {
  if (!error) return false;
  return SCHEMA_MISSING_CODES.has(clean(error.code)) || SCHEMA_MISSING_RE.test(clean(error.message));
}

/** Wrap the store so a missing schema latches off and costs nothing afterwards. */
function schemaGuarded(store) {
  const guard = (method) => async (...args) => {
    if (schemaLatched()) return { ok: false, error: { code: "SCHEMA_UNAVAILABLE", message: "intelligence schema unavailable (latched)" } };
    const result = await store[method](...args);
    if (result && result.ok === false && isSchemaMissing(result.error)) {
      if (!schemaLatched()) {
        counters.schema_unavailable += 1;
        try {
          logger().info?.("intelligence.observation.schema_unavailable", { code: clean(result.error?.code) || null, latch_ms: opts().schemaLatchMs });
        } catch {
          // logging never breaks a hook
        }
      }
      schemaLatchedUntil = nowMs() + opts().schemaLatchMs;
      return { ok: false, error: { code: "SCHEMA_UNAVAILABLE", message: "intelligence schema unavailable" } };
    }
    return result;
  };
  return Object.freeze({
    ...store,
    insertDecisions: guard("insertDecisions"),
    insertCorrection: guard("insertCorrection"),
    insertControlAudit: guard("insertControlAudit"),
  });
}

async function defaultReadSystemFlag(key) {
  const { getSystemFlag } = await import("@/lib/system-control.js");
  return getSystemFlag(key);
}

async function defaultClient() {
  const { getDefaultSupabaseClient } = await import("@/lib/supabase/default-client.js");
  return getDefaultSupabaseClient();
}

async function loadPolicy() {
  if (deps?.policy) return { fingerprint: clean(deps.policy.fingerprint) || null, manifestVersion: clean(deps.policy.manifestVersion) || null };
  try {
    const mod = await import("@/lib/domain/seller-flow/policy-manifest.js");
    return { fingerprint: mod.POLICY_FINGERPRINT || null, manifestVersion: mod.POLICY_MANIFEST_VERSION || null };
  } catch {
    return { fingerprint: null, manifestVersion: null };
  }
}

/**
 * Runtime switch with a 30 s cache. Never throws; any failure = off.
 * Concurrent cold callers share one in-flight read.
 */
function runtimeOn() {
  const t = nowMs();
  if (runtimeCache && t - runtimeCache.at < opts().runtimeTtlMs) return Promise.resolve(runtimeCache.on);
  if (runtimeRead) return runtimeRead;
  const gen = generation;
  const readSystemFlag = typeof deps?.readSystemFlag === "function" ? deps.readSystemFlag : defaultReadSystemFlag;
  runtimeRead = readRuntimeSwitch(OBSERVATION_FLAG, { readSystemFlag, timeoutMs: opts().runtimeReadTimeoutMs })
    .then((result) => {
      const on = result.on === true;
      if (gen === generation) {
        runtimeCache = { on, at: nowMs() };
        runtimeRead = null;
      }
      return on;
    })
    .catch(() => {
      if (gen === generation) runtimeRead = null;
      return false;
    });
  return runtimeRead;
}

/** Synchronous view of the cached runtime switch: true | false | null (unknown/stale). */
function runtimeCached() {
  if (!runtimeCache) return null;
  return nowMs() - runtimeCache.at < opts().runtimeTtlMs ? runtimeCache.on : null;
}

function quietWarnLogger() {
  return {
    warn(event, data) {
      if (schemaLatched()) return; // a missing schema fails closed silently
      try {
        logger().warn?.(event, data);
      } catch {
        // never
      }
    },
  };
}

function ensureRuntime() {
  if (runtimePromise) return runtimePromise;
  const gen = generation;
  const built = (async () => {
    const rawStore = deps?.store || createIntelligenceStore({ client: deps?.client || (await defaultClient()), timeoutMs: opts().storeTimeoutMs });
    const store = schemaGuarded(rawStore);
    const gate = Object.freeze({ ceiling: () => observationCeilingOn(), enabled: () => runtimeOn() });
    const journal = createDecisionJournal({
      store,
      gate,
      logger: quietWarnLogger(),
      now: () => nowMs(),
      ...(deps?.setTimer ? { setTimer: deps.setTimer } : {}),
      options: deps?.journalOptions || {},
    });
    const corrections = createCorrectionsWriter({ store, now: () => nowMs(), logger: quietWarnLogger() });
    const policy = await loadPolicy();
    const rt = { store, journal, corrections, policy };
    if (gen === generation) runtimeRef = rt;
    else journal.stop(); // reconfigured meanwhile (tests): never leak into the new state
    return rt;
  })();
  runtimePromise = built;
  built.catch(() => {
    if (runtimePromise === built) runtimePromise = null;
  });
  return built;
}

function track(promise) {
  pending.add(promise);
  promise.finally(() => pending.delete(promise)).catch(() => {});
  return promise;
}

function countError(error, where) {
  counters.hook_errors += 1;
  try {
    if (!schemaLatched()) logger().warn?.("intelligence.observation.hook_error", { where, message: clean(error?.message || error).slice(0, 200) });
  } catch {
    // never
  }
}

/**
 * The shared hook body. `prepare()` runs synchronously on the caller's turn and
 * must be cheap (no I/O); `build(policy)` turns the prepared ids into journal
 * entries once both gates are known on.
 */
function observe(where, prepare, build) {
  counters.hook_calls += 1;
  try {
    if (!observationCeilingOn()) {
      counters.skipped_ceiling_off += 1;
      return { observed: false, reason: "ceiling_off" };
    }
    const cached = runtimeCached();
    if (cached === false) {
      counters.skipped_runtime_off += 1;
      return { observed: false, reason: "runtime_off" };
    }
    const prepared = prepare();
    if (!prepared || prepared.skip) {
      if (prepared?.skip === "dry_run") counters.skipped_dry_run += 1;
      else if (prepared?.skip === "unchanged") counters.skipped_unchanged += 1;
      else counters.skipped_invalid += 1;
      return { observed: false, reason: prepared?.skip || "invalid" };
    }
    const work = (async () => {
      const on = await runtimeOn();
      if (!on) {
        counters.skipped_runtime_off += 1;
        return;
      }
      const rt = await ensureRuntime();
      const entries = build(prepared, rt.policy);
      for (const entry of entries) {
        counters.entries_submitted += 1;
        rt.journal.recordDecisionFailOpen(entry);
      }
    })().catch((error) => countError(error, where));
    track(work);
    return { observed: true };
  } catch (error) {
    countError(error, where);
    return { observed: false, reason: "hook_error" };
  }
}

function versionsFor(intent, policy, extra = {}) {
  return {
    ...(intent?.versions || {}),
    observation: OBSERVATION_VERSION,
    ...(intent ? { strategy_intent: intent.intent_version, label_map: intent.label_map_version } : {}),
    ...(policy?.manifestVersion ? { policy_manifest: policy.manifestVersion } : {}),
    ...extra,
  };
}

function idContext(pairs) {
  const out = {};
  for (const [key, value] of pairs) {
    const v = clean(value);
    if (v && v.length <= 200) out[key] = v;
  }
  return out;
}

function candidateList(values) {
  return (Array.isArray(values) ? values : []).filter((v) => CODE_RE.test(clean(v))).slice(0, 50).map((v) => ({ action: clean(v), allowed: true }));
}

// ── H1: one seller_turn row per inbound turn (including no-send turns) ─────

/**
 * @param {object} input { inboundEventId, threadKey, propertyId, ownerId,
 *   writesSuppressed, orchestration: { transition, negotiation, next_best_action,
 *   response_strategy, execution, decision, classification, deal_persistence } }
 */
export function observeSellerTurn(input = {}) {
  return observe(
    "H1",
    () => {
      if (input?.writesSuppressed) return { skip: "dry_run" };
      const inboundEventId = clean(input?.inboundEventId);
      if (!inboundEventId) return { skip: "invalid" };
      const orchestration = obj(input.orchestration);
      const execution = obj(orchestration.execution);
      return {
        inboundEventId,
        orchestration,
        decidedAt: nowMs(),
        context: idContext([
          ["inbound_message_event_id", inboundEventId],
          ["thread_key", input.threadKey],
          ["property_id", input.propertyId],
          ["master_owner_id", input.ownerId],
          ["send_queue_id", execution.queue_row_id],
          ["opportunity_id", obj(orchestration.deal_persistence).opportunity_id],
        ]),
        queueRowId: clean(execution.queue_row_id) || null,
      };
    },
    (p, policy) => {
      const intent = deriveStrategyIntent({ ...p.orchestration, policy_fingerprint: policy.fingerprint });
      return [
        {
          decision_type: "seller_turn",
          idempotency_key: `inbound:${p.inboundEventId}`,
          decided_at: p.decidedAt,
          mode: "observe",
          context: p.context,
          policy_version: policy.fingerprint,
          versions: versionsFor(intent, policy),
          candidates: candidateList(intent.candidates),
          chosen_action: intent.strategy_label,
          reason_codes: [...intent.reason_codes, "MODE_OBSERVE"],
          action_ref: p.queueRowId ? { kind: "send_queue", id: p.queueRowId } : { kind: "no_outbound" },
        },
      ];
    },
  );
}

// ── H2: one message_strategy row per send_queue insert ─────────────────────

function messageStrategyEntry(row, policy, decidedAtFallback) {
  const md = obj(row.metadata);
  const sendQueueId = clean(row.id);
  const intent = deriveStrategyIntent(row);
  const created = Date.parse(clean(row.created_at));
  return {
    decision_type: "message_strategy",
    idempotency_key: `send_queue:${sendQueueId}`,
    decided_at: Number.isFinite(created) ? created : decidedAtFallback,
    mode: "observe",
    context: idContext([
      ["send_queue_id", sendQueueId],
      ["thread_key", row.thread_key || md.thread_key],
      ["property_id", row.property_id || md.property_id],
      ["campaign_id", row.campaign_id || md.campaign_id],
      ["campaign_target_id", row.campaign_target_id || md.campaign_target_id],
      ["master_owner_id", row.master_owner_id || md.master_owner_id],
      ["inbound_message_event_id", md.inbound_message_event_id || md.inbound_message_id],
    ]),
    policy_version: policy.fingerprint,
    versions: versionsFor(intent, policy),
    candidates: candidateList(intent.candidates),
    chosen_action: intent.strategy_label,
    reason_codes: [...intent.reason_codes, "MODE_OBSERVE"],
    action_ref: { kind: "send_queue", id: sendQueueId },
  };
}

/** @param row the inserted send_queue row (needs `id`); never mutated. */
export function observeSendQueueInsert(row) {
  return observe(
    "H2",
    () => {
      if (!row || typeof row !== "object" || !clean(row.id)) return { skip: "invalid" };
      return { row, decidedAt: nowMs() };
    },
    (p, policy) => [messageStrategyEntry(p.row, policy, p.decidedAt)],
  );
}

/**
 * The campaign batch insert bypasses insertSupabaseSendQueueRow. The insert
 * returns a narrow column set, so the submitted rows (use case, source,
 * metadata) are joined to the returned ids on campaign_target_id.
 */
export function observeCampaignBatchInsert(submittedRows, insertedRows) {
  return observe(
    "H2_campaign_batch",
    () => {
      const inserted = Array.isArray(insertedRows) ? insertedRows : [];
      if (!inserted.length) return { skip: "invalid" };
      return { submitted: Array.isArray(submittedRows) ? submittedRows : [], inserted, decidedAt: nowMs() };
    },
    (p, policy) => {
      const byTarget = new Map();
      for (const row of p.submitted) {
        const key = clean(row?.campaign_target_id);
        if (key && !byTarget.has(key)) byTarget.set(key, row);
      }
      const entries = [];
      for (const ins of p.inserted) {
        if (!clean(ins?.id)) continue;
        const source = byTarget.get(clean(ins.campaign_target_id)) || {};
        entries.push(messageStrategyEntry({ ...source, ...ins, metadata: { ...obj(source.metadata), ...obj(ins.metadata) } }, policy, p.decidedAt));
      }
      return entries;
    },
  );
}

// ── H3: a campaign_feed row only when the limit is > 0 or the reason changed ─

/**
 * @param {object} input { campaignId, runAt, limit, bound, reason,
 *   previousReason, inserted, versions }
 */
export function observeFeederDecision(input = {}) {
  return observe(
    "H3",
    () => {
      const campaignId = clean(input?.campaignId);
      const limit = Number(input?.limit) || 0;
      const reason = input?.reason === null || input?.reason === undefined ? null : clean(input.reason);
      const previous = input?.previousReason === null || input?.previousReason === undefined ? null : clean(input.previousReason);
      if (!campaignId) return { skip: "invalid" };
      if (!(limit > 0) && reason === previous) return { skip: "unchanged" };
      const runMs = Date.parse(clean(input.runAt));
      const decidedAt = Number.isFinite(runMs) ? runMs : nowMs();
      return { campaignId, limit, reason, bound: clean(input.bound), inserted: Number(input.inserted) || 0, decidedAt, versions: obj(input.versions) };
    },
    (p, policy) => {
      const boundCode = FEED_BOUND_CODES[p.bound] || "FEED_BOUND_UNKNOWN";
      const resultCode = p.reason && CODE_RE.test(p.reason) ? p.reason : p.reason ? "unrecognized_reason" : p.inserted > 0 ? "placed" : "none";
      return [
        {
          decision_type: "campaign_feed",
          idempotency_key: `${p.campaignId}:${new Date(p.decidedAt).toISOString()}`,
          decided_at: p.decidedAt,
          mode: "observe",
          context: idContext([["campaign_id", p.campaignId]]),
          policy_version: policy.fingerprint,
          versions: versionsFor(null, policy, p.versions),
          candidates: [{ action: "feed", allowed: p.limit > 0, blocked_by: p.limit > 0 ? [] : [boundCode] }],
          chosen_action: p.limit > 0 ? "feed" : "hold",
          reason_codes: [boundCode, "MODE_OBSERVE"],
          action_ref: { kind: "feed_result", id: resultCode },
        },
      ];
    },
  );
}

// ── corrections ───────────────────────────────────────────────────────────

const INERT_HANDLE = Object.freeze({ active: false, commit: () => ({ scheduled: 0 }) });

function sameValue(a, b) {
  try {
    return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
  } catch {
    return false;
  }
}

/**
 * Capture the ORIGINAL value(s) before a route overwrites them, then record the
 * correction once the write succeeded:
 *
 *   const correction = await beginCorrectionCapture({ headers: request.headers,
 *     source: "route:/api/...", load: async () => [{ subject, field, original, corrected }] });
 *   ...the route's own write...
 *   correction.commit();                    // or commit({ field: actualNewValue })
 *
 * Disabled (either gate) it resolves an inert handle immediately: `load` is
 * never called. Enabled, `load` is bounded by budgetMs. commit() never throws,
 * never awaits, skips no-op "corrections" (original === corrected) and fields
 * whose corrected value is undefined (the route did not write them).
 */
export async function beginCorrectionCapture({ headers = null, operatorId = null, source, reason = null, load, budgetMs } = {}) {
  try {
    if (!observationCeilingOn()) {
      counters.skipped_ceiling_off += 1;
      return INERT_HANDLE;
    }
    if (runtimeCached() === false || !(await runtimeOn())) {
      counters.skipped_runtime_off += 1;
      return INERT_HANDLE;
    }
    if (typeof load !== "function") return INERT_HANDLE;
    const loaded = await settleWithin(load, budgetMs ?? opts().correctionBudgetMs);
    if (loaded.timedOut || loaded.error) {
      counters.corrections_load_failed += 1;
      return INERT_HANDLE;
    }
    const entries = (Array.isArray(loaded.value) ? loaded.value : loaded.value ? [loaded.value] : []).filter(
      (e) => e && e.subject && clean(e.subject.type) && clean(e.subject.id) && clean(e.field),
    );
    if (!entries.length) return INERT_HANDLE;
    const operator = clean(operatorId) || operatorIdFromHeaders(headers);
    let committed = false;
    return Object.freeze({
      active: true,
      commit(correctedByField = null) {
        try {
          if (committed) return { scheduled: 0 };
          committed = true;
          let scheduled = 0;
          for (const entry of entries) {
            const corrected =
              correctedByField && Object.prototype.hasOwnProperty.call(correctedByField, entry.field) ? correctedByField[entry.field] : entry.corrected;
            // undefined = this field was not written by the route: nothing was corrected.
            if (corrected === undefined || sameValue(entry.original, corrected)) {
              counters.corrections_skipped_noop += 1;
              continue;
            }
            scheduled += 1;
            const work = ensureRuntime()
              .then((rt) =>
                rt.corrections.recordCorrection({
                  subject: { type: clean(entry.subject.type), id: clean(entry.subject.id) },
                  field: clean(entry.field),
                  original: { value: entry.original ?? null, source: obj(entry.originalSource) },
                  corrected: corrected ?? null,
                  operatorId: operator,
                  reason: clean(entry.reason ?? reason) || null,
                  source,
                  metadata: { ...obj(entry.metadata), observation: OBSERVATION_VERSION, policy_fingerprint: rt.policy.fingerprint },
                }),
              )
              .then((result) => {
                if (result?.ok) counters.corrections_captured += 1;
                else counters.corrections_write_failed += 1;
              })
              .catch((error) => countError(error, "correction_commit"));
            track(work);
          }
          return { scheduled };
        } catch (error) {
          countError(error, "correction_commit");
          return { scheduled: 0 };
        }
      },
    });
  } catch (error) {
    countError(error, "correction_begin");
    return INERT_HANDLE;
  }
}

// ── operator toggle (audited) ─────────────────────────────────────────────

/** The store the toggle route writes control_audit through (schema-guarded). */
export async function getObservationStore() {
  const rt = await ensureRuntime();
  return rt.store;
}

/** Drop the cached runtime switch so a toggle is seen on the next hook. */
export function invalidateObservationRuntimeSwitch() {
  runtimeCache = null;
  runtimeRead = null;
}

// ── introspection and tests ───────────────────────────────────────────────

export function getObservationStats() {
  let journal = null;
  try {
    journal = runtimeRef ? { ...runtimeRef.journal.stats(), timer: runtimeRef.journal.debugState() } : null;
  } catch {
    journal = null;
  }
  return {
    version: OBSERVATION_VERSION,
    ceiling: observationCeilingOn(),
    runtime_cached: runtimeCached(),
    schema_latched: schemaLatched(),
    configured: Boolean(runtimeRef),
    ...counters,
    journal,
  };
}

/** Wait for in-flight hook work and flush the journal buffer (tests, shutdown). Never rejects. */
export async function flushObservation() {
  try {
    await Promise.allSettled([...pending]);
    if (runtimeRef) await runtimeRef.journal.flush();
    await Promise.allSettled([...pending]);
  } catch {
    // never
  }
}

/** Test seam: inject env / reader / store / clock; resets all state. */
export function __configureObservationForTests(overrides = null) {
  if (runtimeRef) {
    try {
      runtimeRef.journal.stop();
    } catch {
      // never
    }
  }
  generation += 1;
  deps = overrides;
  counters = freshCounters();
  runtimeRead = null;
  runtimePromise = null;
  runtimeRef = null;
  runtimeCache = null;
  schemaLatchedUntil = 0;
  pending.clear();
}
