/**
 * IC8 OUTCOME LABELER (architecture §4). Pure: every read is injected, `now`
 * is explicit, nothing touches a database.
 *
 * Status rules:
 *   - pending   until the horizon ends or the event is observed;
 *   - mature    an observed positive is mature immediately; a negative is
 *               mature once the horizon has fully elapsed;
 *   - censored  observability ended before the horizon (thread suppressed for
 *               another cause, campaign deleted, data gap, send never
 *               attempted). Events after the censoring instant are not counted
 *               (no survivorship). Censored rows are excluded from training,
 *               never counted as negatives.
 *
 * Evidence holds ids and counts only -- never message text.
 *
 * Injected reads (all optional, by outcome):
 *   inbound        [{ id, created_at, direction, event_type, message_body }] on the send's thread
 *   laterSends     [{ id, sent_at|created_at }] later sends on the thread (evidence only)
 *   outboundEvents [{ id, queue_id, created_at, event_type, failure_bucket }] for the send
 *   factEvents     [{ id, fact, commitment, canonical, persisted_at, confirmed_at }]
 *   stageEvents    [{ id, from_stage, to_stage, at }]
 *   reviewHolds    [{ id, kind, at, source_view, reason, actor }]
 *   transactions   [{ id, type, at }]
 *   observability  { endsAt, reason }
 *   ruleContext    passed to injected rules (e.g. { addressee_name })
 */

import { isP7Placeholder } from "../datasets/exclusions.js";
import { coalesceMs, toIso, toMs } from "../util/time.js";
import {
  FACT_COMMITMENT_RULES_V1,
  MEANINGFUL_REPLY_RULES_V1,
  REAL_REVIEW_HOLD_RULES_V1,
  STAGE_PROGRESS_RULES_V1,
  STOP_FAMILY_RULES_V1,
  TRANSACTION_RULES_V1,
  classifyLogicalReply,
  isForwardStageMove,
  isStopFamilyExact,
  mergeInboundFragments,
} from "./rules.js";
import { WRONG_PERSON_RULE_EXPECTED } from "./taxonomy.js";

export const LABELER_VERSION = "ic8_labeler@1";

const FAILED_STATUSES = Object.freeze(["failed", "failed_transport", "undelivered"]);
const ATTEMPTED_STATUSES = Object.freeze(["sent", "delivered", ...FAILED_STATUSES]);

export class OutcomeLabelError extends Error {
  constructor(message, code = "OUTCOME_LABEL") {
    super(message);
    this.name = "OutcomeLabelError";
    this.code = code;
  }
}

const lower = (value) => String(value ?? "").trim().toLowerCase();

/**
 * One horizon window. Events count only in (anchor, min(horizonEnd,
 * observabilityEnd, now)] -- or [anchor, ...] when inclusiveStart.
 */
export function resolveWindow({
  anchorMs,
  horizonMs,
  nowMs,
  positiveAtMs = null,
  observabilityEndMs = null,
  observabilityReason = null,
  inclusiveStart = false,
}) {
  const horizonEnd = anchorMs + horizonMs;
  const cutoff = Math.min(horizonEnd, observabilityEndMs ?? Infinity, nowMs);
  const afterStart = positiveAtMs !== null && (inclusiveStart ? positiveAtMs >= anchorMs : positiveAtMs > anchorMs);
  if (afterStart && positiveAtMs <= cutoff) {
    return { status: "mature", value: true, observedAtMs: positiveAtMs, censorReason: null };
  }
  if (observabilityEndMs !== null && observabilityEndMs < horizonEnd && observabilityEndMs <= nowMs) {
    return { status: "censored", value: null, observedAtMs: null, censorReason: observabilityReason || "observability_ended" };
  }
  if (nowMs >= horizonEnd) return { status: "mature", value: false, observedAtMs: horizonEnd, censorReason: null };
  return { status: "pending", value: null, observedAtMs: null, censorReason: null };
}

function earliest(times) {
  let best = null;
  for (const t of times) if (t !== null && (best === null || t < best)) best = t;
  return best;
}

function isSellerInbound(message) {
  if (!message || typeof message !== "object") return false;
  if (message.direction !== undefined && lower(message.direction) !== "inbound") return false;
  return !lower(message.event_type).startsWith("internal_");
}

function inboundAfter(reads, anchorMs) {
  return (reads.inbound || [])
    .filter(isSellerInbound)
    .map((message) => ({ message, t: toMs(message.created_at) }))
    .filter((entry) => entry.t !== null && entry.t > anchorMs)
    .sort((a, b) => a.t - b.t || String(a.message.id ?? "").localeCompare(String(b.message.id ?? "")));
}

function sendWasAttempted(send) {
  return toMs(send.sent_at) !== null || ATTEMPTED_STATUSES.includes(lower(send.queue_status));
}

function anchorOf(def, subject) {
  if (def.subjectType === "send") return coalesceMs(subject.sent_at, subject.created_at);
  return coalesceMs(subject.anchor_at, subject.decided_at, subject.created_at);
}

function labelSend(def, subject, reads, nowMs, anchorMs, rules) {
  if (!sendWasAttempted(subject)) return { censorReason: "not_sent" };
  const window = { anchorMs, horizonMs: def.horizonMs, nowMs };
  const obs = reads.observability || {};
  const observability = { observabilityEndMs: toMs(obs.endsAt), observabilityReason: obs.reason || null };
  const evidence = {};
  let positiveAtMs = null;
  let inclusiveStart = false;

  switch (def.key) {
    case "delivered": {
      inclusiveStart = true;
      positiveAtMs = toMs(subject.delivered_at);
      if (positiveAtMs !== null) evidence.delivered = true;
      break;
    }
    case "carrier_filtered": {
      inclusiveStart = true;
      const spam = (reads.outboundEvents || []).filter(
        (e) => (e.queue_id === undefined || String(e.queue_id) === String(subject.id)) && String(e.failure_bucket ?? "") === "Spam",
      );
      positiveAtMs = earliest(spam.map((e) => toMs(e.created_at)).filter((t) => t !== null && t >= anchorMs));
      if (positiveAtMs !== null) evidence.failure_event_ids = spam.map((e) => e.id).filter(Boolean).slice(0, 10);
      break;
    }
    case "send_failed": {
      inclusiveStart = true;
      const failed = FAILED_STATUSES.includes(lower(subject.queue_status));
      if (failed) {
        const failures = (reads.outboundEvents || []).filter(
          (e) => (e.queue_id === undefined || String(e.queue_id) === String(subject.id)) && (e.failure_bucket || /fail|undeliver/i.test(String(e.event_type ?? ""))),
        );
        positiveAtMs = earliest(failures.map((e) => toMs(e.created_at)).filter((t) => t !== null && t >= anchorMs));
        evidence.queue_status = lower(subject.queue_status);
        if (positiveAtMs === null) {
          // Status-only failure: no dated failure event. Counted as observed now,
          // flagged so evaluation can treat its timing as approximate.
          evidence.timing = "status_only";
          positiveAtMs = Math.min(nowMs, anchorMs + def.horizonMs);
        }
      }
      break;
    }
    case "reply_any": {
      const replies = inboundAfter(reads, anchorMs);
      if (replies.length) {
        positiveAtMs = replies[0].t;
        evidence.reply_message_ids = [replies[0].message.id ?? null].filter(Boolean);
      }
      break;
    }
    case "opt_out_keyword": {
      const stop = inboundAfter(reads, anchorMs).find((entry) => isStopFamilyExact(entry.message.message_body, rules.stop));
      if (stop) {
        positiveAtMs = stop.t;
        evidence.opt_out_message_ids = [stop.message.id ?? null].filter(Boolean);
      }
      break;
    }
    case "reply_meaningful": {
      const after = inboundAfter(reads, anchorMs).map((entry) => entry.message);
      const logical = mergeInboundFragments(after, { windowMs: rules.meaningful.fragmentMergeMs });
      const excluded = {};
      for (const reply of logical) {
        const verdict = classifyLogicalReply(reply, rules.meaningful, rules.stop);
        if (verdict.meaningful) {
          positiveAtMs = reply.first_at;
          evidence.reply_message_ids = reply.ids.slice(0, 10);
          break;
        }
        excluded[verdict.exclusion] = (excluded[verdict.exclusion] || 0) + 1;
      }
      evidence.excluded_logical_replies = excluded;
      evidence.logical_replies = logical.length;
      evidence.fragments_merged = after.length - logical.length;
      break;
    }
    case "wrong_person": {
      const rule = rules.wrongPerson;
      if (!rule || typeof rule.test !== "function") {
        throw new OutcomeLabelError("wrong_person@1 needs the injected 7.2 wrong-person rule (rules.wrong_person)", "RULE_UNAVAILABLE");
      }
      if (rule.id !== def.definition.rule.id || rule.version !== def.definition.rule.version) {
        throw new OutcomeLabelError(
          `wrong_person@1 expects ${def.definition.rule.id}@${def.definition.rule.version}, got ${rule.id}@${rule.version}`,
          "RULE_VERSION_MISMATCH",
        );
      }
      const after = inboundAfter(reads, anchorMs).map((entry) => entry.message);
      for (const reply of mergeInboundFragments(after, { windowMs: rules.meaningful.fragmentMergeMs })) {
        const verdict = rule.test(reply.text, reads.ruleContext || {});
        if (verdict && verdict.matched) {
          positiveAtMs = reply.first_at;
          evidence.reply_message_ids = reply.ids.slice(0, 10);
          evidence.rule_id = verdict.rule_id || null;
          break;
        }
      }
      break;
    }
    default:
      throw new OutcomeLabelError(`no send labeler for ${def.id}`, "UNKNOWN_OUTCOME");
  }

  if (def.key === "reply_any" || def.key === "reply_meaningful") {
    const until = positiveAtMs ?? anchorMs + def.horizonMs;
    evidence.intervening_send_ids = (reads.laterSends || [])
      .filter((s) => {
        const t = coalesceMs(s.sent_at, s.created_at);
        return t !== null && t > anchorMs && t < until && String(s.id) !== String(subject.id);
      })
      .map((s) => s.id)
      .slice(0, 10);
  }
  return { window: resolveWindow({ ...window, ...observability, positiveAtMs, inclusiveStart }), evidence };
}

function positiveForThreadOrOpportunity(def, reads, anchorMs) {
  const evidence = {};
  let positiveAtMs = null;
  if (def.key.startsWith("fact_acquired:")) {
    const fact = def.definition.fact_type;
    const qualifying = [];
    for (const e of reads.factEvents || []) {
      if (lower(e.fact) !== fact || e.canonical === false) continue;
      const commitment = String(e.commitment ?? "").toUpperCase();
      if (FACT_COMMITMENT_RULES_V1.accepted.includes(commitment)) qualifying.push({ id: e.id, t: toMs(e.persisted_at) });
      else if (FACT_COMMITMENT_RULES_V1.acceptedWhenConfirmed.includes(commitment) && toMs(e.confirmed_at) !== null) {
        qualifying.push({ id: e.id, t: toMs(e.confirmed_at) });
      }
    }
    const first = qualifying.filter((q) => q.t !== null && q.t > anchorMs).sort((a, b) => a.t - b.t)[0];
    if (first) {
      positiveAtMs = first.t;
      evidence.fact_event_ids = [first.id].filter(Boolean);
    }
  } else if (def.key === "human_review_burden") {
    let skipped = 0;
    const real = [];
    for (const hold of reads.reviewHolds || []) {
      if (!REAL_REVIEW_HOLD_RULES_V1.kinds.includes(lower(hold.kind))) continue;
      if (isP7Placeholder(hold)) {
        skipped += 1;
        continue;
      }
      real.push({ id: hold.id, t: coalesceMs(hold.at, hold.created_at) });
    }
    const first = real.filter((h) => h.t !== null && h.t > anchorMs).sort((a, b) => a.t - b.t)[0];
    if (first) {
      positiveAtMs = first.t;
      evidence.review_hold_ids = [first.id].filter(Boolean);
    }
    evidence.p7_placeholders_skipped = skipped;
  } else if (def.key === "stage_progressed") {
    const forward = (reads.stageEvents || [])
      .filter((e) => isForwardStageMove(e.from_stage, e.to_stage, STAGE_PROGRESS_RULES_V1))
      .map((e) => ({ id: e.id, t: toMs(e.at) }))
      .filter((e) => e.t !== null && e.t > anchorMs)
      .sort((a, b) => a.t - b.t);
    if (forward.length) {
      positiveAtMs = forward[0].t;
      evidence.stage_event_ids = [forward[0].id].filter(Boolean);
    }
  } else if (["offer_presented", "contract", "closing"].includes(def.key)) {
    const type = TRANSACTION_RULES_V1.types[def.key];
    const hits = (reads.transactions || [])
      .filter((tx) => lower(tx.type) === type)
      .map((tx) => ({ id: tx.id, t: toMs(tx.at) }))
      .filter((tx) => tx.t !== null && tx.t > anchorMs)
      .sort((a, b) => a.t - b.t);
    if (hits.length) {
      positiveAtMs = hits[0].t;
      evidence.transaction_ids = [hits[0].id].filter(Boolean);
    }
  } else {
    throw new OutcomeLabelError(`no labeler for ${def.id}`, "UNKNOWN_OUTCOME");
  }
  return { positiveAtMs, evidence };
}

/**
 * Label one outcome for one subject.
 * @param def      an OUTCOME_DEFINITIONS entry
 * @param subject  send row (id, sent_at, created_at, delivered_at, queue_status)
 *                 or { id, anchor_at, decision_id } for thread/opportunity subjects
 * @param reads    injected event reads (see module doc)
 * @param options  { now (required), rules: { wrong_person } }
 */
export function labelOutcome(def, subject, reads = {}, { now, rules = {} } = {}) {
  const nowMs = toMs(now);
  if (nowMs === null) throw new OutcomeLabelError("labelOutcome needs an explicit `now`", "NOW_REQUIRED");
  if (!def || !def.key) throw new OutcomeLabelError("unknown outcome definition", "UNKNOWN_OUTCOME");
  if (!subject || subject.id === undefined || subject.id === null) throw new OutcomeLabelError("subject.id is required", "SUBJECT_REQUIRED");
  const declaredType = subject.subject_type ?? subject.type;
  if (declaredType && declaredType !== def.subjectType) {
    throw new OutcomeLabelError(`${def.id} labels ${def.subjectType} subjects, got ${declaredType}`, "SUBJECT_TYPE_MISMATCH");
  }
  const resolvedRules = {
    stop: STOP_FAMILY_RULES_V1,
    meaningful: MEANINGFUL_REPLY_RULES_V1,
    wrongPerson: rules.wrong_person || null,
  };
  const anchorMs = anchorOf(def, subject);
  const base = {
    outcome_key: def.key,
    outcome_version: def.version,
    subject_type: def.subjectType,
    subject_id: String(subject.id),
    decision_id: subject.decision_id ?? null,
    labeler_version: LABELER_VERSION,
  };
  if (anchorMs === null) {
    return {
      ...base,
      anchor_at: null,
      horizon_ends_at: null,
      status: "censored",
      value: null,
      observed_at: null,
      censor_reason: "missing_anchor_time",
      evidence: { definition_hash: def.definitionHash },
    };
  }
  const horizonEndsAt = toIso(anchorMs + def.maxHorizonMs);

  if (def.subjectType === "send") {
    const result = labelSend(def, subject, reads, nowMs, anchorMs, resolvedRules);
    if (result.censorReason) {
      return {
        ...base,
        anchor_at: toIso(anchorMs),
        horizon_ends_at: horizonEndsAt,
        status: "censored",
        value: null,
        observed_at: null,
        censor_reason: result.censorReason,
        evidence: { definition_hash: def.definitionHash },
      };
    }
    const { window, evidence } = result;
    return {
      ...base,
      anchor_at: toIso(anchorMs),
      horizon_ends_at: horizonEndsAt,
      status: window.status,
      value: window.value,
      observed_at: toIso(window.observedAtMs),
      censor_reason: window.censorReason,
      evidence: { ...evidence, definition_hash: def.definitionHash },
    };
  }

  const { positiveAtMs, evidence } = positiveForThreadOrOpportunity(def, reads, anchorMs);
  const obs = reads.observability || {};
  const windows = def.horizonsMs.map((horizonMs) =>
    resolveWindow({
      anchorMs,
      horizonMs,
      nowMs,
      positiveAtMs,
      observabilityEndMs: toMs(obs.endsAt),
      observabilityReason: obs.reason || null,
    }),
  );
  const longest = windows[windows.length - 1];
  if (def.horizons.length === 1) {
    return {
      ...base,
      anchor_at: toIso(anchorMs),
      horizon_ends_at: horizonEndsAt,
      status: longest.status,
      value: longest.value,
      observed_at: toIso(longest.observedAtMs),
      censor_reason: longest.censorReason,
      evidence: { ...evidence, definition_hash: def.definitionHash },
    };
  }
  const value = {};
  const byHorizon = {};
  def.horizons.forEach((h, i) => {
    value[h] = windows[i].value;
    byHorizon[h] = windows[i].status;
  });
  return {
    ...base,
    anchor_at: toIso(anchorMs),
    horizon_ends_at: horizonEndsAt,
    status: longest.status,
    value: Object.values(value).every((v) => v === null) ? null : value,
    observed_at: toIso(positiveAtMs !== null && longest.value === true ? positiveAtMs : longest.observedAtMs),
    censor_reason: longest.censorReason,
    evidence: { ...evidence, status_by_horizon: byHorizon, definition_hash: def.definitionHash },
  };
}

export function labelOutcomes(defs, subject, reads, options) {
  return defs.map((def) => labelOutcome(def, subject, reads, options));
}

/** Is a labeled result a positive at a given horizon (multi-horizon aware)? */
export function isPositive(result, horizon = null) {
  if (!result || result.value === null || result.value === undefined) return false;
  if (typeof result.value === "object") return horizon ? result.value[horizon] === true : Object.values(result.value).some((v) => v === true);
  return result.value === true;
}

/** Row for intelligence.outcomes (idempotent upsert on the UNIQUE key). */
export function toOutcomeRow(result) {
  return {
    outcome_key: result.outcome_key,
    outcome_version: result.outcome_version,
    subject_type: result.subject_type,
    subject_id: result.subject_id,
    decision_id: result.decision_id,
    anchor_at: result.anchor_at,
    horizon_ends_at: result.horizon_ends_at,
    status: result.status,
    value: result.value,
    observed_at: result.observed_at,
    censor_reason: result.censor_reason,
    evidence: result.evidence,
    labeler_version: result.labeler_version,
  };
}

export { WRONG_PERSON_RULE_EXPECTED };
