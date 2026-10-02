/**
 * IC8 DATASET EXCLUSIONS, versioned (architecture §7; poison inventory in the
 * Phase 0 data audit §5).
 *
 * Each rule has an action:
 *   drop       the row never enters the dataset (counted by reason)
 *   recompute  kept; a derived value is recomputed from canonical geography
 *              (wrong stored time zone -> features use the PROPERTY zone)
 *   reanchor   kept; its anchor time is replaced (bulk-created opportunity
 *              dates -> first-message time)
 *   annotate   kept and flagged (e.g. spam-retry generation)
 *
 * Rows are plain objects prepared by the dataset source adapter. Fields read
 * (all optional): thread_key, to_phone_number, from_phone_number, phone,
 * source, message_type, event_type, metadata{internal_canary,
 * exclude_from_kpis, internal_test, spam_retry_generation}, property_id,
 * master_owner_id, opportunity_id, campaign_is_test, asking_price,
 * asking_price_canonical, canonical, duplicate_of, sent_at, created_at,
 * anchor_at, first_message_at, timezone, property_address_state,
 * property_address_zip, promotion_reason, source_view, reason, actor,
 * p7_placeholder.
 */

import { INTERNAL_TEST_PHONE_SET } from "../../../config/internal-phones.js";
import { deriveTimezoneFromGeography, timezoneLabelToIana } from "../../campaigns/contact-window-timezone.js";
import { coalesceMs, toMs } from "../util/time.js";

export const EXCLUSIONS_VERSION = "ic8_exclusions@1";

/**
 * Canary / test opportunities: the three in the RC 7.1 d2 cleanup list, plus
 * two found by the IC8 data audit that are not in it (pending owner
 * confirmation; excluded meanwhile -- the stricter reading).
 */
export const CANARY_OPPORTUNITY_IDS = Object.freeze({
  confirmed: Object.freeze([
    "1cda1a2f-b34a-4031-9cd8-06992354b253",
    "f554add3-4503-4454-bcd3-ea6b578ee8a2",
    "b228d1d0-13a7-4241-b447-ea29e514ba0a",
  ]),
  pending_owner_confirmation: Object.freeze([
    "78e4cce2-c5fc-42b3-9923-f8ad3428dda2",
    "bdd43b67-0ffc-4bac-ba2d-af9ef2d1d1a1",
  ]),
});
const CANARY_OPPORTUNITY_SET = new Set([...CANARY_OPPORTUNITY_IDS.confirmed, ...CANARY_OPPORTUNITY_IDS.pending_owner_confirmation]);

/** send_queue.source values that are proof/test traffic (platform/events/adapters/messages.js). */
export const TEST_SOURCES = Object.freeze(["internal_canary", "inbox_lock_certification", "queue_limited_cap_proof"]);
const TEST_ID_PREFIX_RE = /^(selftest|canaryprop|canary|mo_canary|test|fixture|proof)/i;
const BULK_OPPORTUNITY_DAY = "2026-06-21";
const BULK_OPPORTUNITY_REASON = "backfill_from_universal_inbox_threads";
const PARSE_JUNK_ASK_BELOW = 10000;

const clean = (value) => String(value ?? "").trim();
const lower = (value) => clean(value).toLowerCase();
const truthy = (value) => value === true || ["true", "1", "yes"].includes(lower(value));
const metadataOf = (row) => (row && row.metadata && typeof row.metadata === "object" ? row.metadata : {});

/** Every spelling of the internal test phones: E.164, 11-digit, 10-digit. */
export function internalPhoneSpellings(set = INTERNAL_TEST_PHONE_SET) {
  const out = new Set();
  for (const phone of set) {
    const digits = String(phone).replace(/\D/g, "");
    out.add(String(phone));
    out.add(digits);
    out.add(`+${digits}`);
    if (digits.length === 11 && digits.startsWith("1")) out.add(digits.slice(1));
  }
  return out;
}
const INTERNAL_PHONES = internalPhoneSpellings();

/**
 * P7 placeholder human-review flag (gap-recovery sweep): ULSE next_action rows
 * with source_view seller_execution_gap_recovery + reason
 * stale_active_without_next_action, or deal history by actor gap_recovery_sweep.
 */
export function isP7Placeholder(row = {}) {
  if (row.p7_placeholder === true) return true;
  const sourceView = lower(row.source_view ?? row.review_source_view);
  const reason = lower(row.reason ?? row.review_reason);
  const actor = lower(row.actor ?? row.review_actor);
  if (sourceView === "seller_execution_gap_recovery" && reason === "stale_active_without_next_action") return true;
  return actor === "gap_recovery_sweep";
}

/** True event time per subject type (null = cannot be placed in time). */
export const TRUE_TIME_OF = Object.freeze({
  send: (row) => coalesceMs(row.sent_at, row.created_at),
  inbound: (row) => toMs(row.created_at),
  thread: (row) => coalesceMs(row.anchor_at, row.decided_at, row.created_at),
  opportunity: (row) => resolveOpportunityAnchor(row),
  review_hold: (row) => coalesceMs(row.at, row.created_at),
  decision: (row) => coalesceMs(row.decided_at, row.anchor_at),
});

export function isBulkCreatedOpportunity(row = {}) {
  const created = clean(row.created_at).slice(0, 10);
  return created === BULK_OPPORTUNITY_DAY && lower(row.promotion_reason) === BULK_OPPORTUNITY_REASON;
}

/** Opportunities bulk-created on 2026-06-21 are anchored on their first message; others on created_at. */
export function resolveOpportunityAnchor(row = {}) {
  if (row.anchor_at) return toMs(row.anchor_at);
  if (isBulkCreatedOpportunity(row)) return toMs(row.first_message_at);
  return coalesceMs(row.created_at, row.first_message_at);
}

/** Stored send time zone contradicts the PROPERTY's derivable zone. */
export function storedTimezoneContradictsProperty(row = {}) {
  const stored = clean(row.timezone);
  if (!stored) return false;
  const derived = deriveTimezoneFromGeography(row.property_address_state, row.property_address_zip);
  if (!derived || !derived.confident || !derived.iana) return false;
  const storedIana = stored.includes("/") ? stored : timezoneLabelToIana(stored.charAt(0).toUpperCase() + stored.slice(1).toLowerCase());
  if (!storedIana) return false;
  return storedIana !== derived.iana;
}

/** Keep the first occurrence per provider SID (by true time, then id); mark the rest duplicate_of. */
export function dedupeByProviderSid(events = [], { sidOf = (e) => e.provider_message_sid, timeOf = (e) => toMs(e.created_at) } = {}) {
  const ordered = [...events].sort(
    (a, b) => (timeOf(a) ?? Infinity) - (timeOf(b) ?? Infinity) || clean(a.id).localeCompare(clean(b.id)),
  );
  const firstBySid = new Map();
  const kept = [];
  const duplicates = [];
  for (const event of ordered) {
    const sid = clean(sidOf(event));
    if (sid && firstBySid.has(sid)) {
      duplicates.push({ ...event, duplicate_of: firstBySid.get(sid) });
      continue;
    }
    if (sid) firstBySid.set(sid, event.id ?? sid);
    kept.push(event);
  }
  return { kept, duplicates };
}

export const EXCLUSION_RULES = Object.freeze([
  {
    id: "internal_test_phone",
    action: "drop",
    description: "thread/recipient/sender is an INTERNAL_TEST_PHONE_SET number (any spelling)",
    test: (row) => [row.thread_key, row.to_phone_number, row.from_phone_number, row.phone].some((p) => INTERNAL_PHONES.has(clean(p))),
  },
  {
    id: "internal_canary_source",
    action: "drop",
    description: "proof/canary/test source, metadata test flags, Self Test message type or internal_* event",
    test: (row) => {
      const md = metadataOf(row);
      return (
        TEST_SOURCES.includes(lower(row.source)) ||
        truthy(md.internal_canary) ||
        truthy(md.exclude_from_kpis) ||
        truthy(md.internal_test) ||
        lower(row.message_type) === "self test" ||
        lower(row.event_type).startsWith("internal_")
      );
    },
  },
  {
    id: "test_fixture_id",
    action: "drop",
    description: "property_id / master_owner_id with a selftest/canary/test/fixture/proof prefix",
    test: (row) => TEST_ID_PREFIX_RE.test(clean(row.property_id)) || TEST_ID_PREFIX_RE.test(clean(row.master_owner_id)),
  },
  {
    id: "canary_test_deal",
    action: "drop",
    description: "one of the canary/test opportunities (d2 list + 2 pending owner confirmation)",
    test: (row) => CANARY_OPPORTUNITY_SET.has(lower(row.opportunity_id)),
  },
  {
    id: "test_campaign",
    action: "drop",
    description: "campaign flagged test by the Analytics Lab campaignIntegrity rule (computed by the source adapter)",
    test: (row) => row.campaign_is_test === true,
  },
  {
    id: "p7_placeholder_review",
    action: "drop",
    appliesTo: ["thread", "opportunity", "review_hold"],
    description: "P7 placeholder human-review flag (gap-recovery stamp), never a real review",
    test: (row) => isP7Placeholder(row),
  },
  {
    id: "parse_junk_ask",
    action: "drop",
    appliesTo: ["opportunity", "thread", "fact"],
    description: "asking price below $10,000 or a canonical:false history entry",
    test: (row) =>
      (row.asking_price !== null && row.asking_price !== undefined && Number(row.asking_price) < PARSE_JUNK_ASK_BELOW) ||
      row.asking_price_canonical === false ||
      row.canonical === false,
  },
  {
    id: "duplicate_event",
    action: "drop",
    description: "a duplicate of an earlier event (same provider SID), see dedupeByProviderSid",
    test: (row) => row.duplicate_of !== null && row.duplicate_of !== undefined,
  },
  {
    id: "missing_true_event_time",
    action: "drop",
    description: "the row's true event time is missing",
    test: (row, ctx) => {
      const timeOf = TRUE_TIME_OF[ctx.subjectType];
      return timeOf ? timeOf(row) === null : false;
    },
  },
  {
    id: "wrong_tz_send",
    action: "recompute",
    appliesTo: ["send"],
    description: "stored send_queue.timezone contradicts the property zone; time features use the PROPERTY zone",
    test: (row) => storedTimezoneContradictsProperty(row),
  },
  {
    id: "bulk_created_opportunity_date",
    action: "reanchor",
    appliesTo: ["opportunity"],
    description: "opportunity bulk-created 2026-06-21; anchored on the first-message time",
    test: (row) => isBulkCreatedOpportunity(row),
  },
  {
    id: "spam_retry_generation",
    action: "annotate",
    appliesTo: ["send"],
    description: "spam-retry regeneration of an earlier send (not a new seller contact)",
    test: (row) => Number(metadataOf(row).spam_retry_generation) >= 1,
  },
]);

/**
 * Evaluate every rule on a row. drop = any drop rule matched; reasons are the
 * matched drop rule ids, annotations the matched non-drop rule ids.
 */
export function evaluateExclusions(row, { subjectType, rules = EXCLUSION_RULES } = {}) {
  const reasons = [];
  const annotations = [];
  const pendingConfirmation = [];
  for (const rule of rules) {
    if (rule.appliesTo && !rule.appliesTo.includes(subjectType)) continue;
    if (!rule.test(row || {}, { subjectType })) continue;
    if (rule.action === "drop") reasons.push(rule.id);
    else annotations.push(rule.id);
    if (rule.id === "canary_test_deal" && CANARY_OPPORTUNITY_IDS.pending_owner_confirmation.includes(lower(row.opportunity_id))) {
      pendingConfirmation.push(rule.id);
    }
  }
  return { drop: reasons.length > 0, reasons, annotations, pendingConfirmation };
}

/** Counts by reason; a row with several reasons counts once in rows_dropped. */
export function createExclusionCounter(initial = null) {
  const state = {
    version: EXCLUSIONS_VERSION,
    rows_seen: 0,
    rows_dropped: 0,
    dropped_by_reason: {},
    annotated: {},
    pending_owner_confirmation: 0,
    ...(initial ? JSON.parse(JSON.stringify(initial)) : {}),
  };
  return {
    record(result) {
      state.rows_seen += 1;
      if (result.drop) state.rows_dropped += 1;
      for (const reason of result.reasons) state.dropped_by_reason[reason] = (state.dropped_by_reason[reason] || 0) + 1;
      for (const note of result.annotations) state.annotated[note] = (state.annotated[note] || 0) + 1;
      if (result.pendingConfirmation && result.pendingConfirmation.length) state.pending_owner_confirmation += 1;
    },
    /** A row already recorded (and kept) that a later stage dropped. */
    recordDrop(reason) {
      state.rows_dropped += 1;
      state.dropped_by_reason[reason] = (state.dropped_by_reason[reason] || 0) + 1;
    },
    toJSON: () => JSON.parse(JSON.stringify(state)),
  };
}
