import { getDefaultSupabaseClient } from "@/lib/supabase/default-client.js";
import { hasSupabaseConfig } from "@/lib/supabase/client.js";
import { processSellerInboundMessage } from "@/lib/domain/seller-flow/process-seller-inbound-message.js";
import { loadContextWithFallback } from "@/lib/domain/context/load-context-with-fallback.js";
import { loadContext } from "@/lib/domain/context/load-context.js";
import { resolveRoute } from "@/lib/domain/routing/resolve-route.js";
import { resolveGuardedAutoReplyMode } from "@/lib/domain/seller-flow/auto-reply-mode.js";
import { summarizeSellerInboundOrchestration } from "@/lib/domain/seller-flow/seller-inbound-orchestration-summary.js";
import {
  runSellerInboundProofCases,
  DEFAULT_SELLER_INBOUND_PROOF_CASES,
} from "@/lib/domain/seller-flow/run-seller-inbound-proof-cases.js";
import { info, warn } from "@/lib/logging/logger.js";

const RECOVERY_LOOKBACK_HOURS = 72;
const STALE_REPLY_WINDOW_HOURS = 4;

function clean(value) {
  return String(value ?? "").trim();
}

function isRecent(timestamp = null, hours = STALE_REPLY_WINDOW_HOURS) {
  if (!timestamp) return false;
  const ts = new Date(timestamp).getTime();
  if (Number.isNaN(ts)) return false;
  return Date.now() - ts <= hours * 60 * 60 * 1000;
}

function resolveHumanReviewRequired(row = {}) {
  const metadata = row.metadata && typeof row.metadata === "object" ? row.metadata : {};
  if (Object.prototype.hasOwnProperty.call(row, "human_review_required")) {
    return row.human_review_required;
  }
  if (Object.prototype.hasOwnProperty.call(metadata, "human_review_required")) {
    return metadata.human_review_required;
  }
  if (Object.prototype.hasOwnProperty.call(metadata, "needs_human_review")) {
    return metadata.needs_human_review;
  }
  return null;
}

function needsRecovery(row = {}) {
  const metadata = row.metadata && typeof row.metadata === "object" ? row.metadata : {};
  const classification = metadata.classification || row.classification || null;
  const detected_intent = clean(row.detected_intent || metadata.detected_intent);
  const automation_decision = metadata.automation_decision || row.automation_decision || null;
  const human_review_required = resolveHumanReviewRequired(row);

  if (!detected_intent && !classification?.primary_intent) return true;
  if (!automation_decision && !metadata.seller_flow_decision) return true;
  if (human_review_required === null && detected_intent === "unclear") return true;
  if (metadata.recovery_status === "incomplete") return true;
  return false;
}

/**
 * Recovery worker: finds inbound messages with incomplete seller-flow processing
 * and re-runs the canonical orchestration path.
 */
function messageMatchesFilters(row = {}, { bodyContains = null, detectedIntent = null } = {}) {
  const body = clean(row.message_body).toLowerCase();
  const intent = clean(row.detected_intent || row.metadata?.detected_intent).toLowerCase();
  const classification_intent = clean(
    row.metadata?.classification?.primary_intent
  ).toLowerCase();

  if (bodyContains) {
    const needle = clean(bodyContains).toLowerCase();
    if (!body.includes(needle)) return false;
  }

  if (detectedIntent) {
    const wanted = clean(detectedIntent).toLowerCase();
    if (intent !== wanted && classification_intent !== wanted) return false;
  }

  return true;
}

export async function recoverUnprocessedInboundMessages({
  supabaseClient = null,
  limit = 25,
  dryRun = true,
  autoReplyMode = null,
  lookbackHours = RECOVERY_LOOKBACK_HOURS,
  proofCases = null,
  messageEventId = null,
  bodyContains = null,
  detectedIntent = null,
  loadContextImpl = null,
  processInboundImpl = null,
} = {}) {
  const supabase = supabaseClient || (hasSupabaseConfig() ? getDefaultSupabaseClient() : null);
  const processInbound = processInboundImpl || processSellerInboundMessage;
  const resolveContext =
    loadContextImpl ||
    (async (args) =>
      loadContextWithFallback({
        ...args,
        loadContextImpl: loadContext,
      }));

  if (Array.isArray(proofCases) && proofCases.length > 0) {
    const proof = await runSellerInboundProofCases({
      cases: proofCases,
      autoReplyMode,
      dryRun: true,
      proofRun: true,
      supabaseClient: supabase,
    });
    return {
      ok: true,
      dry_run: true,
      proof_only: true,
      ...proof,
    };
  }

  if (!supabase) {
    return { ok: false, reason: "missing_supabase" };
  }
  const since = new Date(Date.now() - lookbackHours * 60 * 60 * 1000).toISOString();
  const select_fields =
    "id,provider_message_sid,from_phone_number,to_phone_number,message_body,received_at,detected_intent,metadata,master_owner_id,prospect_id,property_id,phone_number_id,stage_before";

  let candidates = [];
  let error = null;

  if (messageEventId) {
    const targeted = await supabase
      .from("message_events")
      .select(select_fields)
      .eq("id", messageEventId)
      .eq("direction", "inbound")
      .maybeSingle();
    candidates = targeted.data ? [targeted.data] : [];
    error = targeted.error;
  } else {
    const scanned = await supabase
      .from("message_events")
      .select(select_fields)
      .eq("direction", "inbound")
      .gte("received_at", since)
      .order("received_at", { ascending: false })
      .limit(Math.max(Number(limit) * 8, 100));
    candidates = scanned.data;
    error = scanned.error;
  }

  if (error) {
    return { ok: false, reason: "query_failed", error: error.message };
  }

  const filtered = (Array.isArray(candidates) ? candidates : []).filter((row) =>
    messageMatchesFilters(row, { bodyContains, detectedIntent })
  );
  const rows = (messageEventId ? filtered : filtered.filter(needsRecovery)).slice(0, limit);
  const mode_resolution = resolveGuardedAutoReplyMode({ requestedMode: autoReplyMode });
  const results = [];

  for (const row of rows) {
    const inbound_from = clean(row.from_phone_number);
    const inbound_to = clean(row.to_phone_number);
    const message_body = clean(row.message_body);
    const recent = isRecent(row.received_at);

    let context = null;
    try {
      context = await resolveContext({
        inbound_from,
        inbound_to,
        create_brain_if_missing: false,
      });
    } catch (context_error) {
      results.push({
        message_event_id: row.id,
        ok: false,
        reason: "context_load_failed",
        error: context_error?.message,
      });
      continue;
    }

    if (!context?.found) {
      results.push({
        message_event_id: row.id,
        ok: false,
        reason: "context_not_found",
      });
      continue;
    }

    const classification = row.metadata?.classification || null;
    let route = null;
    try {
      route = await resolveRoute({
        classification: classification || { primary_intent: row.detected_intent || "unclear" },
        context,
      });
    } catch {
      route = null;
    }

    const allow_live_send = recent && !dryRun;

    try {
      const orchestration = await processInbound({
        message: message_body,
        threadKey: inbound_from,
        propertyId: row.property_id || context?.ids?.property_id || null,
        prospectId: row.prospect_id || context?.ids?.prospect_id || null,
        ownerId: row.master_owner_id || context?.ids?.master_owner_id || null,
        phoneId: row.phone_number_id || context?.ids?.phone_item_id || null,
        classification,
        context,
        route,
        inboundFrom: inbound_from,
        inboundTo: inbound_to,
        inboundEventId: row.id,
        providerMessageId: row.provider_message_sid,
        stageBefore:
          row.stage_before ||
          row.metadata?.stage_before ||
          row.metadata?.conversation_stage ||
          context?.summary?.conversation_stage ||
          null,
        autoReplyMode: mode_resolution.mode,
        executionAllowed: allow_live_send,
        dryRun: !allow_live_send,
        skipNotifications: dryRun,
        supabaseClient: supabase,
      });

      results.push(
        summarizeSellerInboundOrchestration(orchestration, {
          message: message_body,
          message_event_id: row.id,
          live_send_allowed: allow_live_send,
          recovery_action: allow_live_send ? "reprocessed_live" : "reprocessed_shadow",
        })
      );

      if (!dryRun) {
        await supabase
          .from("message_events")
          .update({
            metadata: {
              ...(row.metadata || {}),
              recovery_status: "reprocessed",
              recovery_at: new Date().toISOString(),
              seller_flow_decision: orchestration.decision || null,
            },
          })
          .eq("id", row.id);
      }
    } catch (recovery_error) {
      warn("[INBOUND_RECOVERY_FAILED]", {
        message_event_id: row.id,
        error: recovery_error?.message || "recovery_failed",
      });
      results.push({
        message_event_id: row.id,
        ok: false,
        reason: "orchestration_failed",
        error: recovery_error?.message || "recovery_failed",
      });
    }
  }

  info("[INBOUND_RECOVERY_COMPLETE]", {
    scanned: candidates?.length || 0,
    recovered: results.filter((r) => r.ok).length,
    failed: results.filter((r) => !r.ok).length,
    dry_run: Boolean(dryRun),
  });

  return {
    ok: true,
    scanned: candidates?.length || 0,
    candidate_count: rows.length,
    recovered_count: results.filter((r) => r.ok).length,
    dry_run: Boolean(dryRun),
    filters: {
      message_event_id: messageEventId || null,
      body_contains: bodyContains || null,
      detected_intent: detectedIntent || null,
    },
    results,
  };
}

export { DEFAULT_SELLER_INBOUND_PROOF_CASES };
export default recoverUnprocessedInboundMessages;