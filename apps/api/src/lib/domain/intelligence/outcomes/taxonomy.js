/**
 * IC8 OUTCOME TAXONOMY v1 (architecture §4).
 *
 * Keys, versions, subjects, horizons and label sources exactly as the
 * architecture table states them. Two representation choices:
 *   - `fact_acquired@1:{ownership, asking_price, condition, timeline}` is four
 *     keys `fact_acquired:<fact>` at version 1, so each fact type has its own
 *     row under UNIQUE (outcome_key, outcome_version, subject_type, subject_id);
 *   - `stage_progressed@1` carries both horizons (14d, 30d) in one row; the
 *     row's status follows the longest horizon and `value` holds each horizon.
 *
 * Labels come only from behaviour, deterministic versioned rules, operators,
 * transactions and deterministic system events -- never from a previous
 * prediction or a classifier intent.
 */

import { hashObject } from "../util/hash.js";
import { parseDurationMs } from "../util/time.js";
import {
  FACT_COMMITMENT_RULES_V1,
  MEANINGFUL_REPLY_RULES_V1,
  REAL_REVIEW_HOLD_RULES_V1,
  STAGE_PROGRESS_RULES_V1,
  STOP_FAMILY_RULES_V1,
  TRANSACTION_RULES_V1,
} from "./rules.js";

export const OUTCOME_TAXONOMY_VERSION = "ic8_outcomes@1";
export const OUTCOME_SUBJECT_TYPES = Object.freeze(["send", "thread", "decision", "opportunity", "campaign_day", "comp_subject"]);
export const LABEL_SOURCES = Object.freeze(["behavior", "deterministic_rule", "operator", "transaction", "system_event"]);
export const OUTCOME_STATUSES = Object.freeze(["pending", "mature", "censored"]);
export const FACT_TYPES = Object.freeze(["ownership", "asking_price", "condition", "timeline"]);
/** trainable = may be a model target; tracked_only = recorded, never modeled (sparse). */
export const OUTCOME_MODELING = Object.freeze(["trainable", "tracked_only"]);

export function ruleRef(rules) {
  return { id: rules.id, version: rules.version, hash: hashObject(rules) };
}

const SEND_ANCHOR = "coalesce(send_queue.sent_at, send_queue.created_at)";
const INBOUND_TIME = "message_events.created_at (the only true receive time; never received_at/event_timestamp)";

/** The 7.2 wrong-person rule IC8 expects to be injected (labeler rules.wrong_person). */
export const WRONG_PERSON_RULE_EXPECTED = Object.freeze({
  id: "wrong_person_7_2",
  version: 1,
  provider: "7.2 detectWrongPersonClaim (classification/reply-disposition-signals.js)",
});

const SPECS = [
  {
    key: "delivered",
    version: 1,
    subjectType: "send",
    horizons: ["24h"],
    valueType: "boolean",
    labelSource: "behavior",
    modeling: "trainable",
    definition: {
      summary: "send_queue.delivered_at is set and falls within 24h of the anchor",
      anchor: SEND_ANCHOR,
      subject_validity: "a send never attempted (no sent_at and not in a failed status) is censored: not_sent",
    },
  },
  {
    key: "carrier_filtered",
    version: 1,
    subjectType: "send",
    horizons: ["24h"],
    valueType: "boolean",
    labelSource: "behavior",
    modeling: "trainable",
    definition: {
      summary: "an outbound message_events failure for the send (queue_id) with failure_bucket = 'Spam' within 24h",
      anchor: SEND_ANCHOR,
      failure_bucket: "Spam",
    },
  },
  {
    key: "send_failed",
    version: 1,
    subjectType: "send",
    horizons: ["24h"],
    valueType: "boolean",
    labelSource: "behavior",
    modeling: "trainable",
    definition: {
      summary: "send_queue.queue_status in (failed, failed_transport, undelivered); timed by its failure event when one exists",
      anchor: SEND_ANCHOR,
      failed_statuses: ["failed", "failed_transport", "undelivered"],
    },
  },
  {
    key: "reply_any",
    version: 1,
    subjectType: "send",
    horizons: ["72h"],
    valueType: "boolean",
    labelSource: "behavior",
    modeling: "trainable",
    definition: {
      summary: "any inbound message on the send's thread in (anchor, anchor + 72h]",
      anchor: SEND_ANCHOR,
      event_time: INBOUND_TIME,
      attribution: "thread_key; a later send on the thread before the reply is recorded in evidence (intervening_send_ids), not applied in v1",
    },
  },
  {
    key: "opt_out_keyword",
    version: 1,
    subjectType: "send",
    horizons: ["7d"],
    valueType: "boolean",
    labelSource: "deterministic_rule",
    modeling: "trainable",
    definition: {
      summary: "an inbound on the thread within 7 days whose whole text is a STOP-family keyword",
      anchor: SEND_ANCHOR,
      event_time: INBOUND_TIME,
      rules: [ruleRef(STOP_FAMILY_RULES_V1)],
    },
  },
  {
    key: "reply_meaningful",
    version: 1,
    subjectType: "send",
    horizons: ["72h"],
    valueType: "boolean",
    labelSource: "deterministic_rule",
    modeling: "trainable",
    definition: {
      summary:
        "reply_any, excluding STOP keywords, auto-replies, reactions with no engagement and carrier/system notices; split fragments within 3 min merged",
      anchor: SEND_ANCHOR,
      event_time: INBOUND_TIME,
      rules: [ruleRef(MEANINGFUL_REPLY_RULES_V1), ruleRef(STOP_FAMILY_RULES_V1)],
      validation: "precision/recall against the 7.2 operator-reviewed corpus: pending the 7.2 evaluation export",
    },
  },
  {
    key: "wrong_person",
    version: 1,
    subjectType: "send",
    horizons: ["7d"],
    valueType: "boolean",
    labelSource: "deterministic_rule",
    modeling: "trainable",
    definition: {
      summary: "an inbound on the thread within 7 days that the 7.2 wrong-person rule (versioned) matches",
      anchor: SEND_ANCHOR,
      event_time: INBOUND_TIME,
      rule: { ...WRONG_PERSON_RULE_EXPECTED },
    },
  },
  ...FACT_TYPES.map((fact) => ({
    key: `fact_acquired:${fact}`,
    version: 1,
    subjectType: "thread",
    horizons: ["14d"],
    valueType: "boolean",
    labelSource: "system_event",
    modeling: "trainable",
    definition: {
      summary: `a canonical ${fact} fact persisted with commitment CONFIRMED, or LIKELY later confirmed, within 14 days`,
      anchor: "the decision (journal decided_at) or the first inbound of the thread episode",
      fact_type: fact,
      rules: [ruleRef(FACT_COMMITMENT_RULES_V1)],
    },
  })),
  {
    key: "stage_progressed",
    version: 1,
    subjectType: "opportunity",
    horizons: ["14d", "30d"],
    valueType: "boolean_by_horizon",
    labelSource: "system_event",
    modeling: "trainable",
    definition: {
      summary: "a forward move in STAGE_ORDER (closing-authority); bare `closed` is closed-lost and never progress",
      anchor: "the decision time, or the first inbound for opportunities bulk-created on 2026-06-21",
      rules: [ruleRef(STAGE_PROGRESS_RULES_V1)],
    },
  },
  {
    key: "human_review_burden",
    version: 1,
    subjectType: "thread",
    horizons: ["7d"],
    valueType: "boolean",
    labelSource: "system_event",
    modeling: "trainable",
    definition: {
      summary: "a REAL review hold (decision-ledger exception_sla_deadline / human exception) within 7 days; P7 placeholders excluded",
      anchor: "the decision time",
      rules: [ruleRef(REAL_REVIEW_HOLD_RULES_V1)],
    },
  },
  {
    key: "offer_presented",
    version: 1,
    subjectType: "opportunity",
    horizons: ["30d"],
    valueType: "boolean",
    labelSource: "transaction",
    modeling: "tracked_only",
    definition: { summary: "an offer presented to the seller, from transaction records", rules: [ruleRef(TRANSACTION_RULES_V1)] },
  },
  {
    key: "contract",
    version: 1,
    subjectType: "opportunity",
    horizons: ["90d"],
    valueType: "boolean",
    labelSource: "transaction",
    modeling: "tracked_only",
    definition: { summary: "a signed purchase contract, from transaction records", rules: [ruleRef(TRANSACTION_RULES_V1)] },
  },
  {
    key: "closing",
    version: 1,
    subjectType: "opportunity",
    horizons: ["180d"],
    valueType: "boolean",
    labelSource: "transaction",
    modeling: "tracked_only",
    definition: { summary: "a closed-won closing, from transaction records", rules: [ruleRef(TRANSACTION_RULES_V1)] },
  },
];

export function outcomeDefinitionHash(spec) {
  return hashObject({
    key: spec.key,
    version: spec.version,
    subjectType: spec.subjectType,
    horizons: spec.horizons,
    valueType: spec.valueType,
    labelSource: spec.labelSource,
    modeling: spec.modeling,
    definition: spec.definition,
  });
}

function finalize(spec) {
  if (!OUTCOME_SUBJECT_TYPES.includes(spec.subjectType)) throw new Error(`outcome ${spec.key}: bad subject type`);
  if (!LABEL_SOURCES.includes(spec.labelSource)) throw new Error(`outcome ${spec.key}: bad label source`);
  if (!OUTCOME_MODELING.includes(spec.modeling)) throw new Error(`outcome ${spec.key}: bad modeling flag`);
  const horizonsMs = spec.horizons.map(parseDurationMs);
  return Object.freeze({
    ...spec,
    id: `${spec.key}@${spec.version}`,
    horizon: spec.horizons[0],
    horizonMs: horizonsMs[0],
    horizonsMs: Object.freeze(horizonsMs),
    maxHorizonMs: Math.max(...horizonsMs),
    horizons: Object.freeze([...spec.horizons]),
    definition: Object.freeze(spec.definition),
    definitionHash: outcomeDefinitionHash(spec),
  });
}

export const OUTCOME_DEFINITIONS = Object.freeze(SPECS.map(finalize));
const BY_ID = new Map(OUTCOME_DEFINITIONS.map((def) => [def.id, def]));

export function getOutcomeDefinition(key, version) {
  const id = version === undefined ? String(key) : `${key}@${version}`;
  const def = BY_ID.get(id);
  if (!def) throw new Error(`unknown outcome ${id}`);
  return def;
}

export function hasOutcomeDefinition(key, version) {
  return BY_ID.has(version === undefined ? String(key) : `${key}@${version}`);
}

/** Postgres interval text in the unit the taxonomy states ("72h" -> "72 hours", "7d" -> "7 days"). */
function intervalText(horizon) {
  const match = /^(\d+)(h|d)$/.exec(String(horizon));
  if (!match) throw new Error(`unsupported horizon ${horizon}`);
  return `${match[1]} ${match[2] === "h" ? "hours" : "days"}`;
}

/** Mirror row for intelligence.outcome_definitions. */
export function toOutcomeDefinitionRow(def) {
  return {
    outcome_key: def.key,
    version: def.version,
    subject_type: def.subjectType,
    horizon: intervalText(def.horizon),
    value_type: def.valueType,
    label_source: def.labelSource,
    definition: { ...def.definition, horizons: def.horizons, modeling: def.modeling, taxonomy: OUTCOME_TAXONOMY_VERSION },
    definition_hash: def.definitionHash,
  };
}
