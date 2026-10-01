/**
 * INBOX LEDGER FACTS — the desktop triage ledger's per-row state, projected.
 *
 * The list rows stay on the compact contract (canonical-inbox-row-contract.js,
 * <=51 keys, asserted in inbox-live-v2-service.test.mjs). The desktop ledger
 * asks for the rest separately, for the rows it is actually showing, so no
 * existing caller pays for it and the compact budget is untouched.
 *
 * Everything here is READ and PROJECTED, never decided:
 *
 *   flags          the canonical bucket predicate itself (v_inbox_thread_state_buckets
 *                  in_* columns) — the same SQL the counts and the lists use, so a
 *                  row can never disagree with the chip above it
 *   is_read        inbox_thread_state.is_read (an operator opened it)
 *   needs review   why the predicate holds: manual_override, or confidence < 0.5,
 *                  or the explicit needs_review bucket
 *   timestamps     last_inbound_at / last_outbound_at / follow_up_at /
 *                  next_scheduled_for / snoozed_until — verbatim
 *   valuation      properties.estimated_value / equity_percent / equity_amount —
 *                  the stored estimates only. ARV is NOT substituted for the
 *                  estimated value and equity is NOT derived from a percentage:
 *                  estimated, modelled and actual are never collapsed.
 *
 * Columns verified against information_schema (2026-10-01). PostgREST fails the
 * whole select on one unknown column, so these lists are deliberately literal.
 */
import { supabase as defaultSupabase } from "@/lib/supabase/client.js";

export const LEDGER_FACTS_MAX_KEYS = 120;

export const LEDGER_FACT_FLAG_COLUMNS = Object.freeze([
  "in_priority",
  "in_new_replies",
  "in_needs_review",
  "in_waiting",
  "in_follow_up",
  "in_scheduled",
  "in_snoozed",
  "in_suppressed",
  "in_dead",
  "in_cold",
  "in_archived",
]);

export const LEDGER_FACT_STATE_COLUMNS = Object.freeze([
  "thread_key",
  "property_id",
  "is_read",
  "last_inbound_at",
  "last_outbound_at",
  "latest_message_at",
  "latest_direction",
  "latest_delivery_status",
  "snoozed_until",
  "follow_up_at",
  "next_scheduled_for",
  "disposition",
  "last_intent",
  "confidence",
  "manual_override",
  "f_needs_review",
  "f_pending_schedule",
  "seller_stage",
  "lifecycle_stage",
]);

export const LEDGER_FACT_PROPERTY_COLUMNS = Object.freeze([
  "property_id",
  "estimated_value",
  "equity_percent",
  "equity_amount",
]);

function clean(value) {
  return String(value ?? "").trim();
}

function finiteOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function positiveOrNull(value) {
  const parsed = finiteOrNull(value);
  return parsed !== null && parsed > 0 ? parsed : null;
}

function isoOrNull(value) {
  const text = clean(value);
  if (!text) return null;
  const ms = Date.parse(text);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

/** `?keys=a,b,c` → unique, trimmed, bounded. */
export function parseLedgerFactKeys(raw) {
  const parts = Array.isArray(raw) ? raw : String(raw ?? "").split(",");
  const seen = new Set();
  const keys = [];
  for (const part of parts) {
    const key = clean(part);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    keys.push(key);
    if (keys.length >= LEDGER_FACTS_MAX_KEYS) break;
  }
  return keys;
}

/**
 * Why the canonical needs-review predicate holds for this thread, in the
 * predicate's own terms (v_inbox_thread_state_buckets: available AND
 * (bucket = needs_review OR manual_override OR confidence < 0.5)).
 */
export function resolveNeedsReviewReason(state = {}) {
  if (state.in_needs_review !== true) return null;
  if (state.manual_override === true) return "manual_override";
  const confidence = finiteOrNull(state.confidence);
  if (confidence !== null && confidence < 0.5) return "low_confidence";
  return "needs_review_bucket";
}

/** One thread's facts. Pure — the route and the tests share it. */
export function shapeLedgerFacts(state = {}, property = null) {
  const flags = LEDGER_FACT_FLAG_COLUMNS
    .filter((column) => state[column] === true)
    .map((column) => column.slice(3));
  const confidence = finiteOrNull(state.confidence);
  return {
    thread_key: clean(state.thread_key) || null,
    property_id: clean(state.property_id) || null,
    flags,
    is_read: typeof state.is_read === "boolean" ? state.is_read : null,
    needs_review_reason: resolveNeedsReviewReason(state),
    confidence: confidence !== null && confidence >= 0 && confidence <= 1 ? confidence : null,
    last_intent: clean(state.last_intent) || null,
    disposition: clean(state.disposition) || null,
    stage: clean(state.seller_stage) || clean(state.lifecycle_stage) || null,
    seller_stage: clean(state.seller_stage) || null,
    latest_direction: clean(state.latest_direction).toLowerCase() || null,
    latest_delivery_status: clean(state.latest_delivery_status).toLowerCase() || null,
    pending_send: state.f_pending_schedule === true,
    last_inbound_at: isoOrNull(state.last_inbound_at),
    last_outbound_at: isoOrNull(state.last_outbound_at),
    latest_message_at: isoOrNull(state.latest_message_at),
    snoozed_until: isoOrNull(state.snoozed_until),
    follow_up_at: isoOrNull(state.follow_up_at),
    next_scheduled_for: isoOrNull(state.next_scheduled_for),
    estimated_value: positiveOrNull(property?.estimated_value),
    equity_percent: positiveOrNull(property?.equity_percent),
    equity_amount: positiveOrNull(property?.equity_amount),
  };
}

/**
 * Facts for up to LEDGER_FACTS_MAX_KEYS thread keys. Two bounded reads: the
 * canonical predicate view by thread_key, then properties by the property ids
 * those threads carry. A valuation read failing never fails the state facts.
 */
export async function getInboxLedgerFacts(threadKeys = [], deps = {}) {
  const supabase = deps.supabase || defaultSupabase;
  const keys = parseLedgerFactKeys(threadKeys);
  if (!keys.length) return { facts: {}, missing: [] };

  const { data, error } = await supabase
    .from("v_inbox_thread_state_buckets")
    .select([...LEDGER_FACT_STATE_COLUMNS, ...LEDGER_FACT_FLAG_COLUMNS].join(","))
    .in("thread_key", keys);
  if (error) throw error;

  const rows = Array.isArray(data) ? data : [];
  const propertyIds = [...new Set(rows.map((row) => clean(row.property_id)).filter(Boolean))];
  let propertyById = new Map();
  if (propertyIds.length) {
    const result = await supabase
      .from("properties")
      .select(LEDGER_FACT_PROPERTY_COLUMNS.join(","))
      .in("property_id", propertyIds);
    if (!result.error && Array.isArray(result.data)) {
      propertyById = new Map(result.data.map((property) => [clean(property.property_id), property]));
    }
  }

  const facts = {};
  for (const row of rows) {
    const key = clean(row.thread_key);
    if (!key) continue;
    facts[key] = shapeLedgerFacts(row, propertyById.get(clean(row.property_id)) || null);
  }
  return { facts, missing: keys.filter((key) => !facts[key]) };
}
