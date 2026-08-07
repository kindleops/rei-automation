// ─── find-recent-outbound-pair.js ─────────────────────────────────────────
// Fallback context resolution for inbound SMS when phone lookup fails.
// Looks for recent outbound send_queue or message_events matching From/To pair.

import { supabase } from "@/lib/supabase/client.js";
import { normalizeInboundTextgridPhone } from "@/lib/providers/textgrid.js";
import { normalizePhone } from "@/lib/utils/phones.js";
import { warn } from "@/lib/logging/logger.js";

const SEND_QUEUE_PAIR_LIMIT = 50;

const DEPRIORITIZED_QUEUE_STATUSES = new Set([
  "blocked",
  "paused_name_missing",
  "paused_global_lock",
  "paused_duplicate",
  "failed",
  "cancelled",
  "canceled",
]);

const DEPRIORITIZED_SOURCES = new Set(["inbox", "leadcommand_inbox"]);

function clean(value) {
  return String(value ?? "").trim();
}

/** Build phone variants so pair lookup matches E.164 (+1…) and legacy 10-digit rows. */
function phonePairLookupVariants(value) {
  const digits = clean(value).replace(/\D/g, "");
  if (!digits) return [];

  const ten_digit =
    digits.length === 11 && digits.startsWith("1") ? digits.slice(1) : digits.length === 10 ? digits : null;
  const e164 = normalizePhone(value) || (ten_digit ? `+1${ten_digit}` : "");
  const eleven_digit = ten_digit ? `1${ten_digit}` : digits.length === 11 ? digits : null;

  return [...new Set([e164, ten_digit, eleven_digit, digits].filter(Boolean))];
}

async function queryOutboundPairRows(db, table, filters, limit) {
  const [to_values, from_values] = filters;
  const { data, error } = await db
    .from(table)
    .select("*")
    .in("to_phone_number", to_values)
    .in("from_phone_number", from_values)
    .order("sent_at", { ascending: false, nullsFirst: false })
    .order("created_at", { ascending: false })
    .limit(limit);

  return { data, error };
}

function lower(value) {
  return clean(value).toLowerCase();
}

function hasValue(value) {
  return clean(value) !== "";
}

function asTimestamp(value) {
  const parsed = Date.parse(clean(value));
  return Number.isFinite(parsed) ? parsed : 0;
}

function rowTimestamp(row = {}) {
  return Math.max(asTimestamp(row.sent_at), asTimestamp(row.created_at));
}

function metadata(row = {}) {
  return row?.metadata && typeof row.metadata === "object" ? row.metadata : {};
}

function pickFirst(...values) {
  for (const value of values) {
    if (hasValue(value)) return value;
  }
  return null;
}

function resolveQueueSource(row = {}) {
  const meta = metadata(row);
  return clean(
    pickFirst(
      row.source,
      row.queue_source,
      row.source_app,
      meta.source,
      meta.queue_source,
      meta.source_app
    )
  );
}

function resolveConversationBrainId(row = {}) {
  const meta = metadata(row);
  return pickFirst(
    row.conversation_brain_id,
    row.brain_id,
    row.conversation_item_id,
    meta.conversation_brain_id,
    meta.brain_id,
    meta.conversation_item_id
  );
}

function resolveTextgridNumberId(row = {}) {
  const meta = metadata(row);
  return pickFirst(
    row.textgrid_number_id,
    row.textgrid_number_item_id,
    row.outbound_number_item_id,
    meta.textgrid_number_id,
    meta.textgrid_number_item_id,
    meta.selected_textgrid_number_id
  );
}

function hasUsableContext(row = {}) {
  return hasValue(row.master_owner_id) && hasValue(row.property_id);
}

function isDeprioritizedSource(row = {}) {
  return DEPRIORITIZED_SOURCES.has(lower(resolveQueueSource(row)));
}

const SUCCESSFUL_OUTBOUND_QUEUE_STATUSES = new Set(["sent", "delivered"]);

function isValidSentContextualQueueRow(row = {}) {
  return (
    SUCCESSFUL_OUTBOUND_QUEUE_STATUSES.has(lower(row.queue_status)) &&
    hasValue(row.sent_at) &&
    hasUsableContext(row)
  );
}

function isSkippedContextCandidate(row = {}) {
  const status = lower(row.queue_status);
  return (
    DEPRIORITIZED_QUEUE_STATUSES.has(status) ||
    !SUCCESSFUL_OUTBOUND_QUEUE_STATUSES.has(status) ||
    !hasValue(row.sent_at) ||
    !hasUsableContext(row) ||
    isDeprioritizedSource(row)
  );
}

function sortLatestFirst(rows = []) {
  return [...rows].sort((a, b) => {
    const timestamp_delta = rowTimestamp(b) - rowTimestamp(a);
    if (timestamp_delta !== 0) return timestamp_delta;
    return clean(b.id).localeCompare(clean(a.id));
  });
}

/**
 * A message that actually reached the seller.
 *
 * DELIBERATELY does not require master_owner_id/property_id. Those are deal
 * IDENTITY facts; whether the seller received this text is a CONVERSATION fact.
 * Conflating the two is the 2026-08-06 defect: the fresh ownership opening
 * (queue_status sent, real provider SID, seller replied 36s later) carried null
 * owner/property ids, so it failed isValidSentContextualQueueRow, was counted as
 * a "newer orphan", and a four-day-old delivered S2 auto-reply became the
 * question the orchestrator believed "Yeah" was answering.
 *
 * Abandoned, duplicate-blocked, cancelled, failed and never-sent rows are
 * excluded here and can therefore never become the conversation authority: a
 * seller cannot reply to a message that was never delivered to them.
 */
function isSuccessfulOutbound(row = {}) {
  return (
    SUCCESSFUL_OUTBOUND_QUEUE_STATUSES.has(lower(row.queue_status)) &&
    hasValue(row.sent_at)
  );
}

/** Exact classifier linkage: the provider SID it bound to, or the queue row id. */
function matchesContextSourceId(row = {}, context_source_id) {
  const wanted = clean(context_source_id);
  if (!wanted) return false;
  return (
    clean(row.provider_message_id) === wanted ||
    clean(row.id) === wanted ||
    clean(row.textgrid_message_id) === wanted
  );
}

/**
 * Selects the outbound the seller is replying to, and separately the row that
 * supplies deal identity.
 *
 * Precedence for CONVERSATION AUTHORITY (what the seller is answering):
 *   1. the row the classifier explicitly bound to (context_source_id) — exact
 *      provider linkage always wins;
 *   2. the freshest genuinely-sent outbound, preferring a non-deprioritized
 *      source, regardless of whether it carries deal ids;
 *   3. only if nothing was ever sent, the latest pair row at all (unverified).
 *
 * Deal IDENTITY (owner/prospect/property/brain) comes from the authority row
 * when it has it, and is otherwise BACKFILLED from the freshest row on the same
 * thread that does. Identity is a property of the thread and survives; the
 * conversation turn is a property of one message and must never be borrowed
 * from an older one.
 */
function selectSendQueuePairMatch(rows = [], { context_source_id = null, inbound_received_at = null } = {}) {
  const all = sortLatestFirst(Array.isArray(rows) ? rows : []);
  if (!all.length) return null;

  // Never let an outbound created AFTER this inbound become the question it
  // answered. Bounded on sent_at, the moment it could have reached the handset,
  // so the selection agrees with buildConversationContext by construction.
  const bound_ms = asTimestamp(inbound_received_at);
  const ordered = bound_ms
    ? all.filter((row) => {
        const sent_ms = asTimestamp(row.sent_at);
        return !sent_ms || sent_ms <= bound_ms;
      })
    : all;
  if (!ordered.length) return null;

  const sent_rows = ordered.filter(isSuccessfulOutbound);
  const linked = ordered.find(
    (row) => matchesContextSourceId(row, context_source_id) && isSuccessfulOutbound(row)
  );

  const authority =
    linked ||
    sent_rows.find((row) => !isDeprioritizedSource(row)) ||
    sent_rows[0] ||
    null;

  if (!authority) {
    return {
      row: ordered[0],
      identity_row: null,
      context_verified: false,
      match_strategy: "fallback_latest_pair_match",
      skipped_newer_orphan_count: 0,
      context_linked: false,
    };
  }

  const identity_row = hasUsableContext(authority)
    ? authority
    : ordered.find((row) => isValidSentContextualQueueRow(row)) || null;

  const selected_index = ordered.indexOf(authority);
  const skipped_newer_orphan_count = ordered
    .slice(0, Math.max(selected_index, 0))
    .filter(isSkippedContextCandidate)
    .length;

  const match_strategy = linked
    ? "classifier_context_linked_outbound"
    : hasUsableContext(authority)
      ? "valid_sent_contextual_outbound"
      : "fresh_sent_outbound_backfilled_context";

  return {
    row: authority,
    identity_row,
    context_verified: Boolean(identity_row && hasUsableContext(identity_row)),
    match_strategy,
    skipped_newer_orphan_count,
    context_linked: Boolean(linked),
  };
}

function buildSendQueueMatchContext(row = {}, match = {}) {
  const matched_source = resolveQueueSource(row) || null;
  const matched_sent_at = clean(row.sent_at) || null;
  const matched_queue_status = clean(row.queue_status) || null;
  const matched_queue_id = row.id || null;
  const row_meta = metadata(row);

  // The row that supplies deal identity. Defaults to the conversation authority
  // itself; only differs when the authority is a genuinely-sent message that
  // carries no owner/property linkage of its own.
  const identity = match.identity_row || row;
  const identity_meta = metadata(identity);
  const backfilled = identity !== row;

  const conversation_brain_id =
    resolveConversationBrainId(row) || resolveConversationBrainId(identity);
  const textgrid_number_id =
    resolveTextgridNumberId(row) || resolveTextgridNumberId(identity);

  return {
    ids: {
      // IDENTITY — a property of the thread, so it may come from history.
      master_owner_id: row.master_owner_id || identity.master_owner_id || null,
      prospect_id: row.prospect_id || identity.prospect_id || null,
      property_id: row.property_id || identity.property_id || null,
      textgrid_number_id: textgrid_number_id || null,
      conversation_brain_id: conversation_brain_id || null,
      // CONVERSATION — the template of THIS outbound only. Never inherited: a
      // template borrowed from an older turn reads downstream as "already
      // sent / already answered", which is precisely how a fresh S1 ownership
      // question presented as a settled S2 proposal ask.
      template_id: row.template_id || null,
    },
    summary: {
      seller_first_name:
        pickFirst(
          row.seller_first_name,
          row_meta.seller_first_name,
          identity.seller_first_name,
          identity_meta.seller_first_name
        ) || null,
      owner_name:
        pickFirst(
          row.seller_display_name,
          row_meta.seller_display_name,
          identity.seller_display_name,
          identity_meta.seller_display_name
        ) || null,
      property_address:
        pickFirst(
          row.property_address,
          row_meta.property_address,
          identity.property_address,
          identity_meta.property_address
        ) || null,
      market:
        pickFirst(row.market, row_meta.market, identity.market, identity_meta.market) || null,
      campaign_id:
        pickFirst(
          row.campaign_id,
          row_meta.campaign_id,
          identity.campaign_id,
          identity_meta.campaign_id
        ) || null,
      inbound_to: row.from_phone_number || null,
      textgrid_number: row.from_phone_number || null,
    },
    recent: {
      // CONVERSATION — strictly the authority row.
      last_outbound_message: clean(row.message_body || row.message_text) || null,
      last_outbound_at: row.sent_at || row.created_at || null,
    },
    queue_row_id: matched_queue_id,
    match: {
      matched_queue_id,
      matched_queue_status,
      matched_sent_at,
      matched_source,
      matched_provider_message_id: clean(row.provider_message_id) || null,
      skipped_newer_orphan_count: match.skipped_newer_orphan_count || 0,
      match_strategy: match.match_strategy || "fallback_latest_pair_match",
      context_verified: Boolean(match.context_verified),
      context_linked: Boolean(match.context_linked),
      identity_backfilled_from: backfilled ? identity.id || null : null,
    },
  };
}

function buildMessageEventMatchContext(row = {}) {
  const conversation_brain_id = resolveConversationBrainId(row);
  const textgrid_number_id = resolveTextgridNumberId(row);

  return {
    ids: {
      master_owner_id: row.master_owner_id || null,
      prospect_id: row.prospect_id || null,
      property_id: row.property_id || null,
      template_id: row.template_id || null,
      textgrid_number_id: textgrid_number_id || null,
      conversation_brain_id: conversation_brain_id || null,
    },
    recent: {
      last_outbound_message: clean(row.message_body) || null,
      last_outbound_at: row.sent_at || row.created_at || null,
    },
    event_id: row.id,
    match: {
      matched_queue_id: null,
      matched_queue_status: null,
      matched_sent_at: row.sent_at || null,
      matched_source: resolveQueueSource(row) || null,
      skipped_newer_orphan_count: 0,
      match_strategy: "fallback_latest_pair_match",
      context_verified: false,
    },
  };
}

/**
 * Try to find recent outbound context by matching inbound From/To pair.
 *
 * When an inbound SMS arrives from a phone not in our personal phones table,
 * we can look for a recent outbound message to that number from our TextGrid
 * number. If found, we extract master_owner_id, prospect_id, property_id, etc
 * from the outbound record.
 *
 * @param {string} inbound_from - Normalized inbound From number (e.g., +16128072000)
 * @param {string} inbound_to - Normalized inbound To number (e.g., +16128060495)
 * @param {object} [opts]
 * @returns {Promise<{
 *   found: boolean,
 *   source?: string,
 *   reason?: string,
 *   context?: {
 *     ids: {
 *       master_owner_id: string|null,
 *       prospect_id: string|null,
 *       property_id: string|null,
 *       template_id: string|null,
 *       textgrid_number_id: string|null,
 *       conversation_brain_id: string|null,
 *     },
 *     recent: {
 *       last_outbound_message?: string,
 *       last_outbound_at?: string,
 *     }
 *   }
 * }>}
 */
export async function findRecentOutboundContextPair(inbound_from, inbound_to, opts = {}) {
  const db = opts.supabase || opts.db || supabase;

  // Normalize both numbers into TextGrid's inbound canonical form for matching.
  const from_e164 = normalizeInboundTextgridPhone(inbound_from);
  const to_e164 = normalizeInboundTextgridPhone(inbound_to);

  if (!from_e164 || !to_e164) {
    warn("context.fallback_pair_invalid_numbers", {
      inbound_from,
      inbound_to,
      from_e164,
      to_e164,
    });

    return {
      found: false,
      reason: "invalid_phone_numbers",
      source: "recent_outbound",
    };
  }

  const outbound_to_variants = phonePairLookupVariants(from_e164);
  const outbound_from_variants = phonePairLookupVariants(to_e164);

  // Step 1: Try send_queue. Inbound From/To reverses outbound To/From.
  try {
    const { data: sq_rows, error: sq_error } = await queryOutboundPairRows(
      db,
      "send_queue",
      [outbound_to_variants, outbound_from_variants],
      SEND_QUEUE_PAIR_LIMIT
    );

    if (sq_error) {
      warn("context.fallback_pair_send_queue_error", {
        inbound_from,
        inbound_to,
        error: sq_error.message,
      });
    } else if (sq_rows && sq_rows.length > 0) {
      // Null only when every pair row was sent AFTER this inbound, i.e. there is
      // no outbound it could be answering. Fall through rather than bind to a
      // message the seller had not yet received.
      const match = selectSendQueuePairMatch(sq_rows, {
        context_source_id: opts.context_source_id || null,
        inbound_received_at: opts.inbound_received_at || null,
      });
      if (match) {
        const row = match.row;
        const context = buildSendQueueMatchContext(row, match);

        warn("context.fallback_pair_found_in_send_queue", {
          inbound_from,
          to_phone_number: from_e164,
          from_phone_number: to_e164,
          master_owner_id: context.ids.master_owner_id,
          prospect_id: context.ids.prospect_id,
          property_id: context.ids.property_id,
          queue_id: context.queue_row_id,
          ...context.match,
        });

        return {
          found: true,
          source: "recent_outbound_send_queue",
          context,
        };
      }
    }
  } catch (err) {
    warn("context.fallback_pair_send_queue_exception", {
      inbound_from,
      inbound_to,
      error: err.message,
    });
  }

  // Step 2: Try message_events when send_queue has no pair match.
  try {
    const { data: me_rows, error: me_error } = await db
      .from("message_events")
      .select("*")
      .eq("direction", "outbound")
      .in("to_phone_number", outbound_to_variants)
      .in("from_phone_number", outbound_from_variants)
      .order("sent_at", { ascending: false, nullsFirst: false })
      .order("created_at", { ascending: false })
      .limit(1);

    if (me_error) {
      warn("context.fallback_pair_message_events_error", {
        inbound_from,
        inbound_to,
        error: me_error.message,
      });
    } else if (me_rows && me_rows.length > 0) {
      const row = me_rows[0];
      const context = buildMessageEventMatchContext(row);

      warn("context.fallback_pair_found_in_message_events", {
        inbound_from,
        to_phone_number: from_e164,
        from_phone_number: to_e164,
        master_owner_id: context.ids.master_owner_id,
        prospect_id: context.ids.prospect_id,
        event_id: context.event_id,
      });

      return {
        found: true,
        source: "recent_outbound_message_event",
        context,
      };
    }
  } catch (err) {
    warn("context.fallback_pair_message_events_exception", {
      inbound_from,
      inbound_to,
      error: err.message,
    });
  }

  warn("context.fallback_pair_not_found", {
    inbound_from,
    to_phone_number: from_e164,
    from_phone_number: to_e164,
  });

  return {
    found: false,
    reason: "no_recent_outbound_pair",
    source: "recent_outbound",
  };
}

export default findRecentOutboundContextPair;
