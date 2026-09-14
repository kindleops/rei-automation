/**
 * inbound-attention-scan.js
 *
 * THE BACKSTOP. Emission alone does not satisfy the invariant.
 *
 * emitInboundAttention runs inline when a reply is ingested, and
 * emitNotificationFromBusinessEvent deliberately swallows every error -- which
 * is right for a notification and wrong as the only guarantee. A failed emit is
 * silent, a container can die between the write and the emit, and a deploy can
 * land in between. Every one of those leaves a real seller waiting with nobody
 * told.
 *
 * So the durable rows are the source of truth for what needs a human, and this
 * sweep re-derives attention from them. Inline emission makes it fast; the
 * sweep makes it TRUE.
 *
 * ── WHY IT CHECKS BEFORE EMITTING, INSTEAD OF JUST RE-EMITTING ─────────────
 *
 * upsertNotificationEvent deduplicates on the key, so blind re-emission looks
 * safe. It is not, for two reasons found by reading it:
 *
 *   1. It increments `group_count` on every upsert. An unmatched reply from
 *      Monday would read "(288 occurrences)" by Tuesday, which is not what
 *      happened and teaches an operator the count means nothing.
 *   2. It REVIVES a dismissed notification: `status: existing.status ===
 *      'dismissed' ? 'active' : ...`. An operator who dismissed an alert
 *      because they had already filed the reply by hand would watch it come
 *      back every sweep. That is how a whole category gets muted.
 *
 * So the sweep reads which keys already exist and emits only for the ones that
 * do not. A dismissal is an operator's decision and it stands.
 *
 * ── BOUNDED ───────────────────────────────────────────────────────────────
 *
 * The lookback is finite. A sweep that walked all of history would grow without
 * limit and would resurrect ancient rows nobody is going to action. Anything
 * older than the window has been missed by every sweep in between, which is an
 * operational problem a louder alert will not fix.
 */

import { child } from "@/lib/logging/logger.js";
import { asObject } from "@/lib/hostile-input.js";
import { supabase as defaultSupabase } from "@/lib/supabase/client.js";
import {
  buildInboundAttentionKey,
  emitInboundAttention,
  INBOUND_ATTENTION_REASON,
} from "@/lib/domain/email/inbound/inbound-attention.js";

const logger = child({ module: "domain.email.inbound_attention_scan" });

export const INBOUND_ATTENTION_SCAN_VERSION = "inbound_attention_scan_v1";

/** How far back a sweep looks, and how many rows it will consider at once. */
export const SCAN_LOOKBACK_HOURS = 72;
export const SCAN_ROW_LIMIT = 200;

function clean(value) {
  return String(value ?? "").trim();
}

/**
 * Which stored states mean a human is still owed something.
 *
 * `received` rather than `processed` is the load-bearing half: EMAIL-3 leaves
 * an unresolved event at `received` precisely so it stays in a review queue,
 * and a `processed` event reached the conversation it belongs to.
 */
function attentionReasonForRow(raw_row) {
  const row = asObject(raw_row);
  const resolution = clean(row.resolution_status);
  const processing = clean(row.processing_status);

  if (processing === "quarantined") return INBOUND_ATTENTION_REASON.QUARANTINED;
  if (processing === "duplicate") return null;
  if (resolution === "ambiguous") return INBOUND_ATTENTION_REASON.AMBIGUOUS;
  if (resolution === "unmatched") return INBOUND_ATTENTION_REASON.UNMATCHED;
  return null;
}

/**
 * One sweep.
 *
 * Shaped like the platform's existing scan*Notifications() functions so it can
 * join runNotificationIntelligenceScan rather than needing a schedule of its
 * own.
 *
 * @returns {{scanned:number, emitted:string[], already_visible:number, errors:string[]}}
 */
export async function scanInboundEmailAttention(options = {}) {
  const supabase = options.supabase || defaultSupabase;
  const emit = options.emitInboundAttention || emitInboundAttention;
  const lookback_hours = Number(options.lookback_hours) || SCAN_LOOKBACK_HOURS;
  const limit = Number(options.limit) || SCAN_ROW_LIMIT;

  const result = { scanned: 0, emitted: [], already_visible: 0, errors: [] };
  if (!supabase?.from) {
    result.errors.push("supabase_unavailable");
    return result;
  }

  const since = new Date(Date.now() - lookback_hours * 3600_000).toISOString();

  // Both attention-worthy shapes in one read. `processed` and `resolved` rows
  // are excluded by the filter rather than by a later branch, so the query does
  // the narrowing instead of the process.
  const { data, error } = await supabase
    .from("email_inbound_events")
    .select("id, event_key, from_email, resolution_status, resolution_reason, processing_status, inbound_message_id, opportunity_id, property_id, thread_key, received_at")
    .gte("received_at", since)
    .in("resolution_status", ["unmatched", "ambiguous"])
    .order("received_at", { ascending: false })
    .limit(limit);

  if (error) {
    logger.error("inbound_attention_scan.read_failed", { reason: clean(error.message) });
    result.errors.push("inbound_event_read_failed");
    return result;
  }

  const rows = Array.isArray(data) ? data : [];
  result.scanned = rows.length;
  if (!rows.length) return result;

  const candidates = [];
  for (const row of rows) {
    const reason = attentionReasonForRow(row);
    if (!reason) continue;
    const key = buildInboundAttentionKey(row.event_key, reason);
    if (key) candidates.push({ row, reason, key });
  }
  if (!candidates.length) return result;

  // Which of these has an operator already been told about -- or already
  // dismissed? Both answers mean "do not emit".
  const existing = await readExistingKeys(supabase, candidates.map((c) => c.key));
  if (existing === null) {
    // A failed read here is the one case where emitting anyway would be worse
    // than not emitting: it could revive every dismissal in the window at once.
    result.errors.push("notification_lookup_failed");
    return result;
  }

  for (const candidate of candidates) {
    if (existing.has(candidate.key)) {
      result.already_visible += 1;
      continue;
    }

    const emitted = await emit(
      {
        event_key: candidate.row.event_key,
        inbound_event_id: candidate.row.id,
        inbound_message_id: candidate.row.inbound_message_id,
        from_email: candidate.row.from_email,
        conversation: {
          opportunity_id: candidate.row.opportunity_id,
          property_id: candidate.row.property_id,
          thread_key: candidate.row.thread_key,
        },
        outcome: {
          resolution_status: candidate.row.resolution_status,
          resolution_reason: candidate.row.resolution_reason,
          processing_status: candidate.row.processing_status,
        },
      },
      // The reason is already decided from the stored row, so the outcome-shaped
      // classifier is bypassed rather than asked to re-derive it from a partial
      // reconstruction of an outcome that happened days ago.
      { verdict: { needed: true, reason: candidate.reason, event_type: null }, ...options }
    );

    if (emitted?.emitted) {
      result.emitted.push(candidate.key);
      logger.warn("inbound_attention_scan.recovered", {
        // The sweep finding something is itself a signal: the inline emit did
        // not happen, and that is worth knowing about separately.
        attention_reason: candidate.reason,
        inbound_event_id: candidate.row.id,
      });
    } else if (emitted?.ok === false) {
      result.errors.push(`emit_failed:${candidate.reason}`);
    }
  }

  return result;
}

/** @returns {Set<string>|null} null means the lookup itself failed. */
async function readExistingKeys(supabase, keys) {
  const unique = [...new Set(keys)];
  const found = new Set();

  // Chunked: a sweep at the row limit would otherwise build one very long IN
  // clause, and PostgREST puts it in the URL.
  for (let i = 0; i < unique.length; i += 50) {
    const chunk = unique.slice(i, i + 50);
    const { data, error } = await supabase
      .from("notification_events")
      .select("deduplication_key")
      .in("deduplication_key", chunk);

    if (error) {
      logger.error("inbound_attention_scan.notification_lookup_failed", {
        reason: clean(error.message),
      });
      return null;
    }
    for (const row of Array.isArray(data) ? data : []) {
      if (row?.deduplication_key) found.add(row.deduplication_key);
    }
  }
  return found;
}

export default scanInboundEmailAttention;
