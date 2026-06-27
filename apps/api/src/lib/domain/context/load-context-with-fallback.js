// ─── load-context-with-fallback.js ────────────────────────────────────────
// Resolves inbound SMS context from recent outbound pair (authoritative for
// campaign replies) with Podio phone lookup as secondary path.

import loadContext from "@/lib/domain/context/load-context.js";
import { findRecentOutboundContextPair } from "@/lib/domain/context/find-recent-outbound-pair.js";
import { info } from "@/lib/logging/logger.js";

function clean(value) {
  return String(value ?? "").trim();
}

function buildFallbackContext({
  inbound_from,
  lookup_sources_tried,
  fallback_result,
}) {
  const fallback_match = fallback_result.context?.match || {};
  const fallback_match_data = {
    queue_row_id: fallback_result.context?.queue_row_id || null,
    event_id: fallback_result.context?.event_id || null,
    matched_queue_id:
      fallback_match.matched_queue_id ||
      fallback_result.context?.queue_row_id ||
      null,
    matched_queue_status: fallback_match.matched_queue_status || null,
    matched_sent_at: fallback_match.matched_sent_at || null,
    matched_source: fallback_match.matched_source || null,
    skipped_newer_orphan_count: fallback_match.skipped_newer_orphan_count || 0,
    match_strategy: fallback_match.match_strategy || null,
    context_verified: Boolean(fallback_match.context_verified),
  };

  const fallback_match_id =
    fallback_result.context?.queue_row_id || fallback_result.context?.event_id || null;
  const fallback_ids = fallback_result.context?.ids || {};
  const conversation_brain_id = fallback_ids.conversation_brain_id || null;
  const brain_item_id = /^\d+$/.test(clean(conversation_brain_id))
    ? conversation_brain_id
    : null;

  return {
    found: true,
    inbound_from,
    lookup_sources_tried,
    fallback_pair_match: true,
    fallback_match_source: fallback_result.source,
    fallback_match_id,
    fallback_match_data,
    reason: null,
    ids: {
      phone_item_id: null,
      brain_item_id,
      conversation_brain_id,
      master_owner_id: fallback_ids.master_owner_id || null,
      owner_id: null,
      prospect_id: fallback_ids.prospect_id || null,
      property_id: fallback_ids.property_id || null,
      template_id: fallback_ids.template_id || null,
      textgrid_number_id: fallback_ids.textgrid_number_id || null,
      assigned_agent_id: null,
      market_id: null,
    },
    items: {
      phone_item: null,
      brain_item: null,
      master_owner_item: null,
      owner_item: null,
      prospect_item: null,
      property_item: null,
      agent_item: null,
      market_item: null,
    },
    flags: {
      do_not_call: "FALSE",
      dnc_source: null,
      engagement_tier: null,
      phone_activity_status: "Unknown",
      follow_up_trigger_state: null,
      status_ai_managed: null,
    },
    recent: {
      recently_used_template_ids: fallback_result.context?.ids?.template_id
        ? [fallback_result.context.ids.template_id]
        : [],
      touch_count: 1,
      last_template_id: fallback_result.context?.ids?.template_id || null,
      last_inbound_message: "",
      last_outbound_message: fallback_result.context?.recent?.last_outbound_message || "",
      recent_events: [],
      outbound_pair_match: fallback_match_data,
    },
    summary: {
      conversation_stage:
        fallback_result.context?.summary?.conversation_stage || "ownership_check",
      language_preference:
        fallback_result.context?.summary?.language_preference || "unknown",
      contact_window: fallback_result.context?.summary?.contact_window || "unknown",
      property_address: fallback_result.context?.summary?.property_address || null,
      seller_first_name: fallback_result.context?.summary?.seller_first_name || null,
      owner_name: fallback_result.context?.summary?.owner_name || null,
      market: fallback_result.context?.summary?.market || null,
      campaign_id: fallback_result.context?.summary?.campaign_id || null,
      deal_strategy: fallback_result.context?.summary?.deal_strategy || null,
      inbound_to: fallback_result.context?.summary?.inbound_to || null,
      textgrid_number: fallback_result.context?.summary?.textgrid_number || null,
    },
  };
}

async function tryOutboundPairContext({
  inbound_from,
  inbound_to,
  lookup_sources_tried,
  findRecentOutboundContextPairImpl,
}) {
  if (!clean(inbound_to)) return null;

  lookup_sources_tried.push("fallback_outbound_pair");
  info("context.load_attempting_outbound_pair", { inbound_from, inbound_to });

  const fallback_result = await findRecentOutboundContextPairImpl(inbound_from, inbound_to);
  if (!fallback_result?.found) {
    info("context.load_outbound_pair_not_found", {
      inbound_from,
      inbound_to,
      fallback_reason: fallback_result?.reason || "unknown",
    });
    return null;
  }

  info("context.load_outbound_pair_succeeded", {
    inbound_from,
    inbound_to,
    fallback_source: fallback_result.source,
    master_owner_id: fallback_result.context?.ids?.master_owner_id,
    prospect_id: fallback_result.context?.ids?.prospect_id,
  });

  return buildFallbackContext({
    inbound_from,
    lookup_sources_tried,
    fallback_result,
  });
}

/**
 * Load context with outbound-pair-first resolution for campaign replies.
 */
export async function loadContextWithFallback({
  inbound_from,
  inbound_to,
  create_brain_if_missing = true,
  primary_context = null,
  loadContextImpl = loadContext,
  findRecentOutboundContextPairImpl = findRecentOutboundContextPair,
} = {}) {
  const lookup_sources_tried = [];

  // Campaign replies should bind to the outbound send_queue/message_event pair first.
  const pair_context = await tryOutboundPairContext({
    inbound_from,
    inbound_to,
    lookup_sources_tried,
    findRecentOutboundContextPairImpl,
  });
  if (pair_context) return pair_context;

  lookup_sources_tried.push("phone");

  let context = primary_context;
  if (!context) {
    context = await loadContextImpl({
      inbound_from,
      create_brain_if_missing,
    });
  }

  if (context?.found) {
    return {
      ...context,
      lookup_sources_tried,
      fallback_pair_match: false,
      fallback_match_source: null,
      fallback_match_id: null,
      fallback_match_data: null,
    };
  }

  return {
    ...context,
    lookup_sources_tried,
    fallback_pair_match: false,
    fallback_match_source: null,
    fallback_match_id: null,
    fallback_match_data: null,
  };
}

export default loadContextWithFallback;