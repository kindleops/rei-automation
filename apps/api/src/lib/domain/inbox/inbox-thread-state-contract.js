/**
 * Canonical inbox_thread_state contract — single source for count/list predicates.
 * Columns reflect the live production schema (no inbox_category / universal_status).
 */
import {
  deriveInboxBucketFromThreadState,
} from "@/lib/domain/inbox/resolve-inbox-state-from-classification.js";
import {
  isStaleExplicitInboxBucket,
  threadMatchesBucketFilter,
} from "@/lib/domain/inbox/inbox-bucket-predicates.js";

function clean(value) {
  return String(value ?? "").trim();
}

function lower(value) {
  return clean(value).toLowerCase();
}

/** Production inbox_thread_state columns used for bucket derivation and tab predicates. */
export const INBOX_THREAD_STATE_SCHEMA = {
  explicit_bucket: "inbox_bucket",
  message_direction: "latest_direction",
  last_inbound_at: "last_inbound_at",
  last_outbound_at: "last_outbound_at",
  detected_intent: "last_intent",
  workflow_stage: "stage",
  workflow_status: "status",
  automation_lane: "automation_lane",
  automation_status: "automation_status",
  automation_state: "automation_state",
  suppression_status: "is_suppressed",
  disposition: "disposition",
  follow_up_due: "follow_up_at",
  next_scheduled_action: "next_scheduled_for",
  next_action: "next_action",
  next_action_at: "next_action_at",
  priority_evidence: "is_urgent",
  delivery_status: "latest_delivery_status",
  reason_codes: "reason_codes",
  metadata: "metadata",
};

export const INBOX_THREAD_STATE_SELECT_FIELDS = [
  "thread_key",
  "inbox_bucket",
  "latest_direction",
  "last_inbound_at",
  "last_outbound_at",
  "latest_delivery_status",
  "last_intent",
  "stage",
  "status",
  "disposition",
  "is_suppressed",
  "automation_lane",
  "automation_status",
  "automation_state",
  "follow_up_at",
  "next_scheduled_for",
  "next_action",
  "next_action_at",
  "is_urgent",
  "is_hot_lead",
  "confidence",
  "reason_codes",
  "metadata",
  "property_id",
  "pending_queue_count",
  "blocked_queue_count",
  "failed_queue_count",
].join(",");

const ACTIVE_TABS = new Set(["priority", "new_replies", "needs_review", "follow_up", "active"]);
const TERMINAL_BUCKETS = new Set(["dead", "suppressed"]);

export function normalizeInboxThreadStateRow(row = {}) {
  const metadata = row.metadata && typeof row.metadata === "object" ? row.metadata : {};
  return {
    ...row,
    latest_message_direction: row.latest_direction ?? row.latest_message_direction ?? null,
    primary_intent: row.last_intent ?? row.primary_intent ?? row.detected_intent ?? null,
    detected_intent: row.last_intent ?? row.detected_intent ?? null,
    universal_status: row.status ?? row.universal_status ?? null,
    needs_review: row.needs_review === true || metadata.needs_review === true,
    compliance_flag: row.compliance_flag ?? metadata.compliance_flag ?? null,
    objection: row.objection ?? metadata.objection ?? null,
    automation_decision: row.automation_decision ?? metadata.automation_decision ?? null,
  };
}

export function resolveCanonicalInboxBucket(row = {}) {
  return deriveInboxBucketFromThreadState(normalizeInboxThreadStateRow(row));
}

export function resolveEffectiveInboxBucket(row = {}, nowMs = Date.now()) {
  const normalized = normalizeInboxThreadStateRow(row);
  const explicit = lower(normalized.inbox_bucket);
  const canonical = lower(resolveCanonicalInboxBucket(normalized) || "");

  if (explicit && !isStaleExplicitInboxBucket(normalized, explicit, nowMs)) {
    return explicit;
  }
  if (canonical) return canonical;
  return explicit;
}

function tabToBuckets(tab) {
  const normalized = lower(tab);
  if (normalized === "active") {
    return ["priority", "new_replies", "needs_review", "follow_up"];
  }
  if (normalized === "cold") return ["cold"];
  return [normalized];
}

export function threadMatchesInboxTab(row = {}, tab = "all") {
  const normalizedTab = lower(tab);
  if (!normalizedTab || normalizedTab === "all") return true;
  if (normalizedTab === "unlinked") return row.property_id == null;

  const normalized = normalizeInboxThreadStateRow(row);
  const effectiveBucket = resolveEffectiveInboxBucket(normalized);

  if (normalizedTab === "cold") {
    return threadMatchesBucketFilter(normalized, "cold", Date.now());
  }

  if (normalizedTab === "waiting") {
    return threadMatchesBucketFilter(normalized, "waiting", Date.now());
  }

  if (normalizedTab === "new_replies") {
    return threadMatchesBucketFilter(normalized, "new_replies", Date.now());
  }

  const allowed = tabToBuckets(normalizedTab);
  if (!allowed.length) return false;
  if (TERMINAL_BUCKETS.has(effectiveBucket) && ACTIVE_TABS.has(normalizedTab)) {
    return false;
  }
  return allowed.includes(effectiveBucket);
}

export function countRowsForInboxTab(rows = [], tab = "all") {
  return rows.reduce((total, row) => total + (threadMatchesInboxTab(row, tab) ? 1 : 0), 0);
}

export async function fetchDerivedNullBucketThreadKeysForTab(supabase, tab, { pageSize = 1000 } = {}) {
  const normalizedTab = lower(tab);
  if (!normalizedTab || normalizedTab === "all") return [];

  const keys = [];
  let offset = 0;
  let hasMore = true;

  while (hasMore) {
    const { data, error } = await supabase
      .from("inbox_thread_state")
      .select(INBOX_THREAD_STATE_SELECT_FIELDS)
      .is("inbox_bucket", null)
      .range(offset, offset + pageSize - 1);

    if (error) throw error;
    const rows = Array.isArray(data) ? data : [];
    if (!rows.length) {
      hasMore = false;
      break;
    }

    for (const row of rows) {
      if (threadMatchesInboxTab(row, normalizedTab)) {
        const key = clean(row.thread_key);
        if (key) keys.push(key);
      }
    }

    offset += rows.length;
    hasMore = rows.length === pageSize;
  }

  return keys;
}