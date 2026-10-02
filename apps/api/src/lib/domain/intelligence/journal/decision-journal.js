/**
 * IC8 DECISION JOURNAL WRITER (architecture §5.1).
 *
 * recordDecisionFailOpen(entry) is what the H1/H2/H3 hooks call (one line,
 * after RC 7.1 locks). Its contract:
 *   - GATED: env ceiling INTELLIGENCE_LOGGING_ENABLED (checked synchronously)
 *     AND system_control.intelligence_logging_enabled (checked at flush, ~30 s
 *     cache). Missing or unreadable = OFF. Without configuration = OFF.
 *   - NEVER THROWS, NEVER BLOCKS: the caller gets a plain object back
 *     synchronously; rows go into a bounded in-process buffer (cap 500,
 *     overflow drops and counts) flushed asynchronously on an unref'd timer.
 *     Store errors and timeouts are counted, warned at most once a minute, and
 *     after repeated failures a breaker drops rows for a cool-down instead of
 *     piling work onto a struggling database.
 *   - IDEMPOTENT: decision_id = uuid v5 of `${decision_type}:${idempotency_key}`;
 *     the store upserts with ignore-duplicates. The stored idempotency_key is
 *     type-namespaced, so UNIQUE(idempotency_key) cannot collide across types.
 *   - IDS ONLY: context keys are allowlisted ids, reason codes must be
 *     registered, actions/codes are identifier-shaped. No message bodies, no
 *     free-text rationale.
 */

import { IC8_DECISION_NAMESPACE, isUuid, uuidV5 } from "../util/hash.js";
import { settleWithin, unrefTimeout } from "../util/async.js";
import { toIso, toMs } from "../util/time.js";
import { partitionReasonCodes } from "./reason-codes.js";

/** Decision types v1 (architecture §5.2). Reserved types are rejected until they are activated. */
export const DECISION_TYPES = Object.freeze({
  seller_turn: Object.freeze({ reserved: false }),
  message_strategy: Object.freeze({ reserved: false }),
  follow_up_timing: Object.freeze({ reserved: false }),
  fact_acceptance: Object.freeze({ reserved: false }),
  campaign_feed: Object.freeze({ reserved: false }),
  campaign_selection: Object.freeze({ reserved: false }),
  campaign_scale: Object.freeze({ reserved: false }),
  campaign_pause: Object.freeze({ reserved: false }),
  comp_selection: Object.freeze({ reserved: false }),
  valuation: Object.freeze({ reserved: false }),
  human_handoff: Object.freeze({ reserved: false }),
  buyer_match: Object.freeze({ reserved: true }),
  market_selection: Object.freeze({ reserved: true }),
});

export const JOURNAL_MODES = Object.freeze(["observe", "shadow", "assist", "act"]);

/** Ids a journal row may carry in `context`. */
export const CONTEXT_KEYS = Object.freeze([
  "thread_key",
  "message_event_id",
  "inbound_message_event_id",
  "property_id",
  "opportunity_id",
  "campaign_id",
  "campaign_target_id",
  "send_queue_id",
  "seller_automation_decision_id",
  "master_owner_id",
  "ade_snapshot_id",
  "burst_id",
  "closing_case_id",
]);

export const JOURNAL_DEFAULTS = Object.freeze({
  bufferCap: 500,
  flushIntervalMs: 250,
  batchSize: 100,
  writeTimeoutMs: 2000,
  breakerThreshold: 3,
  breakerCooldownMs: 60_000,
  warnIntervalMs: 60_000,
});

const IDENT_RE = /^[a-z0-9][a-z0-9_:.-]{0,79}$/i;
const KEY_RE = /^[a-z][a-z0-9_]{0,39}$/;

export function decisionIdFor(decisionType, idempotencyKey) {
  return uuidV5(`${decisionType}:${idempotencyKey}`, IC8_DECISION_NAMESPACE);
}

function shortString(value, max) {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string" && typeof value !== "number") return null;
  const text = String(value).trim();
  return text && text.length <= max ? text : null;
}

function sanitizeObject(value, valueCheck, problems, label) {
  const out = {};
  if (!value || typeof value !== "object" || Array.isArray(value)) return out;
  for (const [key, inner] of Object.entries(value)) {
    if (!KEY_RE.test(key)) {
      problems.push(`${label}.${key}:bad_key`);
      continue;
    }
    const checked = valueCheck(inner, key);
    if (checked === undefined) problems.push(`${label}.${key}:dropped`);
    else out[key] = checked;
  }
  return out;
}

/**
 * Normalise an entry into an intelligence.decision_journal row. Pure.
 * Returns { row, problems, fatal } -- fatal entries are never written.
 */
export function buildJournalRow(rawEntry = {}, { now = () => Date.now() } = {}) {
  const entry = rawEntry && typeof rawEntry === "object" ? rawEntry : {};
  const problems = [];
  const type = String(entry.decision_type ?? "");
  if (!DECISION_TYPES[type]) return { row: null, problems, fatal: "unknown_decision_type" };
  if (DECISION_TYPES[type].reserved) return { row: null, problems, fatal: "reserved_decision_type" };
  const rawKey = shortString(entry.idempotency_key, 300);
  if (!rawKey) return { row: null, problems, fatal: "missing_idempotency_key" };
  const decidedMs = entry.decided_at === undefined ? now() : toMs(entry.decided_at);
  if (decidedMs === null) return { row: null, problems, fatal: "invalid_decided_at" };
  const mode = entry.mode ?? "observe";
  if (!JOURNAL_MODES.includes(mode)) return { row: null, problems, fatal: "invalid_mode" };

  const context = {};
  for (const [key, value] of Object.entries(entry.context && typeof entry.context === "object" ? entry.context : {})) {
    const v = shortString(value, 200);
    if (!CONTEXT_KEYS.includes(key) || v === null) problems.push(`context.${key}:dropped`);
    else context[key] = v;
  }

  const { known, unknown } = partitionReasonCodes(Array.isArray(entry.reason_codes) ? entry.reason_codes : []);
  const reasonCodes = [...known];
  if (unknown.length) {
    problems.push(`reason_codes:unregistered:${unknown.length}`);
    reasonCodes.push("JOURNAL_REASON_CODE_UNREGISTERED");
  }

  const candidates = [];
  for (const candidate of Array.isArray(entry.candidates) ? entry.candidates.slice(0, 50) : []) {
    const action = shortString(candidate?.action, 80);
    if (!action || !IDENT_RE.test(action)) {
      problems.push("candidates:bad_action");
      continue;
    }
    const blocked = partitionReasonCodes(Array.isArray(candidate.blocked_by) ? candidate.blocked_by : []).known;
    const score = typeof candidate.score === "number" && Number.isFinite(candidate.score) ? candidate.score : null;
    candidates.push({ action, allowed: candidate.allowed === true, blocked_by: blocked, score });
  }

  const chosen = shortString(entry.chosen_action, 80);
  const chosenAction = chosen && IDENT_RE.test(chosen) ? chosen : null;
  if (chosen && !chosenAction) problems.push("chosen_action:dropped");
  const confidence = typeof entry.confidence === "number" && entry.confidence >= 0 && entry.confidence <= 1 ? entry.confidence : null;

  const guardrails = sanitizeObject(entry.guardrails, (value) => {
    if (!value || typeof value !== "object") return undefined;
    const verdict = ["allow", "block", "error", "skipped"].includes(value.verdict) ? value.verdict : null;
    if (!verdict) return undefined;
    const code = partitionReasonCodes(value.code ? [value.code] : []).known[0] || null;
    return { verdict, code };
  }, problems, "guardrails");

  const versions = sanitizeObject(entry.versions, (value) => shortString(value, 120) ?? undefined, problems, "versions");

  let experiment = null;
  if (entry.experiment && typeof entry.experiment === "object") {
    const experimentId = shortString(entry.experiment.experiment_id, 100);
    const arm = shortString(entry.experiment.arm, 60);
    const propensity = Number(entry.experiment.propensity);
    if (experimentId && arm && propensity > 0 && propensity <= 1) experiment = { experiment_id: experimentId, arm, propensity };
    else problems.push("experiment:dropped");
  }

  let actionRef = null;
  if (entry.action_ref && typeof entry.action_ref === "object") {
    const kind = shortString(entry.action_ref.kind, 40);
    const id = shortString(entry.action_ref.id, 100);
    if (kind && KEY_RE.test(kind)) actionRef = id ? { kind, id } : { kind };
    else problems.push("action_ref:dropped");
  }

  const uuidOrNull = (value, label) => {
    if (value === null || value === undefined || value === "") return null;
    if (isUuid(value)) return String(value);
    problems.push(`${label}:not_uuid`);
    return null;
  };

  const idempotencyKey = `${type}:${rawKey}`;
  return {
    row: {
      decision_id: decisionIdFor(type, rawKey),
      idempotency_key: idempotencyKey,
      decided_at: toIso(decidedMs),
      decision_type: type,
      mode,
      context,
      feature_snapshot_id: uuidOrNull(entry.feature_snapshot_id, "feature_snapshot_id"),
      feature_set_id: shortString(entry.feature_set_id, 120),
      model_version_id: uuidOrNull(entry.model_version_id, "model_version_id"),
      policy_version: shortString(entry.policy_version, 120),
      versions,
      candidates,
      chosen_action: chosenAction,
      confidence,
      guardrails,
      reason_codes: reasonCodes,
      experiment,
      action_ref: actionRef,
      champion_decision_id: uuidOrNull(entry.champion_decision_id, "champion_decision_id"),
    },
    problems,
    fatal: null,
  };
}

function quietLogger() {
  return { warn() {} };
}

/**
 * Build a journal. deps:
 *   store   { insertDecisions(rows) -> {ok} }      (store/intelligence-store.js)
 *   gate    { ceiling(): boolean, enabled(): Promise<boolean> }  (config/flags.js createFlagGate)
 *   logger  { warn(event, data) }
 *   now, setTimer (tests), options (JOURNAL_DEFAULTS overrides)
 */
export function createDecisionJournal({ store, gate, logger = quietLogger(), now = () => Date.now(), setTimer = unrefTimeout, options = {} } = {}) {
  const opts = { ...JOURNAL_DEFAULTS, ...options };
  const buffer = [];
  const stats = {
    accepted: 0,
    written: 0,
    dropped_disabled: 0,
    dropped_invalid: 0,
    dropped_overflow: 0,
    dropped_runtime_off: 0,
    dropped_breaker_open: 0,
    dropped_write_failed: 0,
    write_errors: 0,
    write_timeouts: 0,
    unregistered_reason_codes: 0,
    internal_errors: 0,
    flushes: 0,
  };
  let timer = null;
  let flushing = null;
  let consecutiveFailures = 0;
  let breakerOpenUntil = 0;
  let lastWarnAt = -Infinity;

  function warn(event, data) {
    try {
      const t = now();
      if (t - lastWarnAt < opts.warnIntervalMs) return;
      lastWarnAt = t;
      logger.warn(event, data);
    } catch {
      // a broken logger never breaks the caller
    }
  }

  function failure(kind, detail) {
    consecutiveFailures += 1;
    if (consecutiveFailures >= opts.breakerThreshold) {
      breakerOpenUntil = now() + opts.breakerCooldownMs;
      consecutiveFailures = 0;
    }
    warn("intelligence.journal.write_failed", { kind, detail: String(detail ?? "").slice(0, 200), stats: { ...stats } });
  }

  function schedule() {
    if (timer) return;
    timer = setTimer(() => {
      timer = null;
      flush().catch(() => {});
    }, opts.flushIntervalMs);
  }

  function recordDecisionFailOpen(entry) {
    try {
      if (!gate || typeof gate.ceiling !== "function" || gate.ceiling() !== true) {
        stats.dropped_disabled += 1;
        return { accepted: false, reason: "disabled" };
      }
      if (now() < breakerOpenUntil) {
        stats.dropped_breaker_open += 1;
        return { accepted: false, reason: "breaker_open" };
      }
      const { row, problems, fatal } = buildJournalRow(entry, { now });
      if (fatal) {
        stats.dropped_invalid += 1;
        warn("intelligence.journal.invalid_entry", { fatal });
        return { accepted: false, reason: fatal };
      }
      if (problems.some((p) => p.startsWith("reason_codes:unregistered"))) stats.unregistered_reason_codes += 1;
      if (buffer.length >= opts.bufferCap) {
        stats.dropped_overflow += 1;
        return { accepted: false, reason: "overflow" };
      }
      buffer.push(row);
      stats.accepted += 1;
      schedule();
      return { accepted: true, decision_id: row.decision_id };
    } catch (error) {
      stats.internal_errors += 1;
      warn("intelligence.journal.internal_error", { message: String(error?.message || error).slice(0, 200) });
      return { accepted: false, reason: "internal_error" };
    }
  }

  async function drain() {
    while (buffer.length) {
      const batch = buffer.splice(0, opts.batchSize);
      let enabled = false;
      try {
        enabled = (await gate.enabled()) === true;
      } catch {
        enabled = false;
      }
      if (!enabled) {
        stats.dropped_runtime_off += batch.length;
        continue;
      }
      if (now() < breakerOpenUntil) {
        stats.dropped_breaker_open += batch.length;
        continue;
      }
      const outcome = await settleWithin(() => store.insertDecisions(batch), opts.writeTimeoutMs);
      if (outcome.timedOut) {
        stats.write_timeouts += 1;
        stats.dropped_write_failed += batch.length;
        failure("timeout", `${opts.writeTimeoutMs} ms`);
      } else if (outcome.error || !outcome.value || outcome.value.ok !== true) {
        stats.write_errors += 1;
        stats.dropped_write_failed += batch.length;
        failure("error", outcome.error?.message || outcome.value?.error?.message);
      } else {
        stats.written += batch.length;
        consecutiveFailures = 0;
      }
    }
  }

  /** Flush now (tests, graceful shutdown). Resolves; never rejects. */
  function flush() {
    if (flushing) return flushing;
    flushing = drain()
      .catch((error) => {
        stats.internal_errors += 1;
        warn("intelligence.journal.flush_error", { message: String(error?.message || error).slice(0, 200) });
      })
      .finally(() => {
        stats.flushes += 1;
        flushing = null;
      });
    return flushing;
  }

  return Object.freeze({
    recordDecisionFailOpen,
    flush,
    stats: () => ({ ...stats, buffered: buffer.length, breaker_open: now() < breakerOpenUntil }),
    debugState: () => ({ timerScheduled: timer !== null, timerHasRef: timer && typeof timer.hasRef === "function" ? timer.hasRef() : null }),
    stop() {
      if (timer) clearTimeout(timer);
      timer = null;
      buffer.length = 0;
    },
  });
}

// ── process default (what the hooks call) ──

let defaultJournal = null;

/** Wire the process-wide journal once (lead, after RC 7.1 locks). Until then every call is a no-op. */
export function configureDecisionJournal(deps) {
  if (defaultJournal) defaultJournal.stop();
  defaultJournal = createDecisionJournal(deps);
  return defaultJournal;
}

export function resetDecisionJournal() {
  if (defaultJournal) defaultJournal.stop();
  defaultJournal = null;
}

/** The hook entry point. Disabled (and a no-op) until configured AND both gates are on. */
export function recordDecisionFailOpen(entry) {
  try {
    if (!defaultJournal) return { accepted: false, reason: "not_configured" };
    return defaultJournal.recordDecisionFailOpen(entry);
  } catch {
    return { accepted: false, reason: "internal_error" };
  }
}
