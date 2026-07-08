/**
 * outbound-provenance.js
 *
 * Canonical outbound provenance for the automation control plane.
 *
 * Every outbound SMS — regardless of which surface created it — must carry a
 * consistent provenance record so the same automation lifecycle can take over
 * from the first message. This module normalizes the source surface and the
 * lifecycle fields from what the caller already recorded; it never invents
 * touch numbers or stages (touch_number/stage_number stay null unless the
 * caller's payload/metadata actually carries them).
 */

import {
  LIFECYCLE_STAGE_META,
} from "@/lib/domain/lead-state/universal-lead-state-registry.js";
import { mapSellerFlowStageToUniversal } from "@/lib/domain/seller-flow/seller-flow-decision-contract.js";

export const OUTBOUND_SOURCE_SURFACES = Object.freeze([
  "map_command",
  "campaign_command",
  "inbox_manual",
  "queue_processor",
  "workflow_studio",
  "follow_up_scheduler",
  "auto_reply",
]);

const SOURCE_SURFACE_SET = new Set(OUTBOUND_SOURCE_SURFACES);

// Aliases already written by existing surfaces (metadata.source / created_from /
// send_source / message_type values observed in the queue writers).
const SOURCE_SURFACE_ALIASES = Object.freeze({
  map_command: "map_command",
  leadcommand_map: "map_command",
  command_map: "map_command",
  send_ownership_check: "map_command",
  campaign_command: "campaign_command",
  campaign: "campaign_command",
  campaign_launch: "campaign_command",
  campaign_feeder: "campaign_command",
  inbox: "inbox_manual",
  manual_inbox: "inbox_manual",
  inbox_manual: "inbox_manual",
  leadcommand_inbox: "inbox_manual",
  manual_reply: "inbox_manual",
  queue_processor: "queue_processor",
  queue_runner: "queue_processor",
  queue_run: "queue_processor",
  retry_runner: "queue_processor",
  workflow_studio: "workflow_studio",
  workflow: "workflow_studio",
  workflow_v2: "workflow_studio",
  follow_up_scheduler: "follow_up_scheduler",
  followup_scheduler: "follow_up_scheduler",
  seller_followup_scheduler: "follow_up_scheduler",
  seller_inbound_orchestrator: "follow_up_scheduler",
  followup: "follow_up_scheduler",
  auto_reply: "auto_reply",
  autoreply: "auto_reply",
  inbound_autopilot: "auto_reply",
  seller_stage_reply: "auto_reply",
});

function clean(value) {
  return String(value ?? "").trim();
}

function lower(value) {
  return clean(value).toLowerCase();
}

function asPositiveInt(value) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

export function normalizeSourceSurface(value = null) {
  const key = lower(value).replace(/[-\s]+/g, "_");
  if (!key) return null;
  if (SOURCE_SURFACE_SET.has(key)) return key;
  return SOURCE_SURFACE_ALIASES[key] || null;
}

/**
 * Resolve the canonical source surface for a queue payload. Explicit
 * declarations win; otherwise fall back to the aliases existing surfaces
 * already stamp. Returns null (never a guess) when nothing is declared.
 */
export function resolveSourceSurface({ payload = {}, metadata = {} } = {}) {
  const declared =
    normalizeSourceSurface(metadata.source_surface) ||
    normalizeSourceSurface(payload.source_surface);
  if (declared) return declared;

  const candidates = [
    metadata.source,
    metadata.send_source,
    metadata.created_from,
    metadata.origin_surface,
    metadata.action,
    payload.message_type,
    payload.type,
  ];
  for (const candidate of candidates) {
    const resolved = normalizeSourceSurface(candidate);
    if (resolved) return resolved;
  }

  // Structural signals: campaign rows always carry campaign identifiers.
  if (clean(payload.campaign_id) || clean(payload.campaign_target_id)) {
    return "campaign_command";
  }
  if (clean(payload.workflow_id) || clean(metadata.workflow_id)) {
    return "workflow_studio";
  }
  return null;
}

function resolveStage({ payload = {}, metadata = {} } = {}) {
  const declared_stage =
    clean(metadata.seller_stage) ||
    clean(payload.seller_stage) ||
    clean(payload.stage_after) ||
    clean(payload.current_stage) ||
    clean(metadata.stage) ||
    null;
  if (!declared_stage) return { seller_stage: null, stage_number: null };

  const canonical = mapSellerFlowStageToUniversal(declared_stage);
  const meta = LIFECYCLE_STAGE_META[canonical] || null;
  return {
    seller_stage: canonical || declared_stage,
    stage_number:
      asPositiveInt(metadata.stage_number) ??
      asPositiveInt(payload.stage_number) ??
      meta?.number ??
      null,
  };
}

/**
 * Build the canonical provenance record for an outbound queue payload.
 * Only normalizes what the caller declared — no fabricated touch/stage.
 */
export function buildOutboundProvenance(payload = {}) {
  const metadata =
    payload.metadata && typeof payload.metadata === "object" ? payload.metadata : {};
  const { seller_stage, stage_number } = resolveStage({ payload, metadata });

  return {
    provenance_version: "outbound_provenance_v1",
    source_surface: resolveSourceSurface({ payload, metadata }),
    source_id:
      clean(metadata.source_id) ||
      clean(payload.source_id) ||
      clean(payload.campaign_target_id) ||
      null,
    campaign_id: clean(payload.campaign_id) || clean(metadata.campaign_id) || null,
    workflow_id: clean(payload.workflow_id) || clean(metadata.workflow_id) || null,
    property_id: clean(payload.property_id) || clean(metadata.property_id) || null,
    master_owner_id:
      clean(payload.master_owner_id) || clean(metadata.master_owner_id) || null,
    prospect_id: clean(payload.prospect_id) || clean(metadata.prospect_id) || null,
    phone_id:
      clean(payload.phone_id) ||
      clean(metadata.canonical_phone_id) ||
      clean(payload.phone_number_id) ||
      null,
    canonical_e164: clean(payload.to_phone_number) || clean(payload.thread_key) || null,
    template_id: clean(payload.template_id) || clean(metadata.template_id) || null,
    template_use_case:
      clean(payload.use_case_template) ||
      clean(metadata.template_use_case) ||
      clean(payload.message_type) ||
      null,
    template_language: clean(payload.language) || clean(metadata.template_language) || null,
    message_event_id: clean(metadata.message_event_id) || null,
    provider_message_id:
      clean(payload.provider_message_sid) || clean(metadata.provider_message_id) || null,
    touch_number:
      asPositiveInt(metadata.touch_number) ?? asPositiveInt(payload.touch_number) ?? null,
    stage_number,
    seller_stage,
    seller_status: clean(metadata.seller_status) || clean(payload.seller_status) || null,
    seller_temperature:
      clean(metadata.seller_temperature) || clean(payload.seller_temperature) || null,
    automation_origin:
      clean(metadata.automation_origin) ||
      resolveSourceSurface({ payload, metadata }) ||
      null,
    automation_authority:
      clean(metadata.automation_authority) ||
      clean(metadata.auto_reply_mode) ||
      clean(metadata.execution_mode) ||
      null,
    next_action: clean(metadata.next_action) || clean(payload.next_action) || null,
    followup_intent: clean(metadata.followup_intent) || null,
  };
}

/**
 * Stamp normalized provenance onto queue metadata (non-destructive: an
 * explicit automation_provenance provided by the caller wins).
 */
export function attachOutboundProvenance(payload = {}) {
  const metadata =
    payload.metadata && typeof payload.metadata === "object" ? payload.metadata : {};
  if (metadata.automation_provenance && typeof metadata.automation_provenance === "object") {
    return metadata;
  }
  return {
    ...metadata,
    automation_provenance: buildOutboundProvenance(payload),
  };
}

export default buildOutboundProvenance;
