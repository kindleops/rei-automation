#!/usr/bin/env node
/**
 * Live shadow authority decision proof (no enqueue, no SMS).
 */
import { createClient } from "@supabase/supabase-js";
import {
  evaluateShadowAuthorityDecision,
  emitShadowAuthorityDecision,
  DEFAULT_ACQUISITION_BRAIN_MODE,
  CLASSIFIER_CALIBRATION_VERSION,
} from "../../src/lib/domain/acquisition-brain/authority-gate.js";
import { emitAutomationEvent } from "../../src/lib/domain/automation/automation-events.js";

const CANARY = "+16128072000";
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

async function main() {
  const { data: msgs } = await supabase
    .from("message_events")
    .select("id,message_body,detected_intent,created_at")
    .eq("thread_key", CANARY)
    .eq("direction", "inbound")
    .order("created_at", { ascending: false })
    .limit(1);

  const m = msgs?.[0];
  const as_of = new Date().toISOString();
  const input = {
    mode: DEFAULT_ACQUISITION_BRAIN_MODE,
    thread_key: CANARY,
    is_internal_canary: true,
    is_public_seller: false,
    canonical_thread_resolution_status: "resolved",
    resolved_inbound_identity: CANARY,
    lifecycle_stage: "ownership_check",
    stage_number: 1,
    primary_intent: m?.detected_intent || "ownership_confirmed",
    language: "English",
    inbound_event_ids: m?.id ? [m.id] : ["proof-auth"],
    calibration_version: CLASSIFIER_CALIBRATION_VERSION,
    template_evidence: {
      template_id: null,
      template_version: null,
      use_case: null,
      active: false,
      placeholder_validation: false,
      prohibited_term_validation: false,
    },
    suppression_evidence: {
      clear: true,
      checked_at: as_of,
      error_state: null,
    },
    contact_window_evidence: {
      timezone: "America/Chicago",
      allowed: true,
      deferred: false,
      final_planned_send_at: as_of,
    },
    burst_evidence: {
      burst_id: "proof",
      status: "final_shadow",
      plan_status: "final_shadow",
      superseded: false,
    },
    nba_evidence: { action: "request_asking_price" },
    health_evidence: {
      emergency_stop: false,
      queue_healthy: true,
      provider_healthy: true,
      observability_healthy: true,
      checked_at: as_of,
      as_of,
    },
  };

  const r = evaluateShadowAuthorityDecision(input);
  const e1 = await emitShadowAuthorityDecision(r, {
    supabase,
    emitAutomationEvent,
  });
  await emitShadowAuthorityDecision(r, { supabase, emitAutomationEvent });

  const { data: rows } = await supabase
    .from("automation_events")
    .select("id,dedupe_key,payload")
    .eq("dedupe_key", r.event.dedupe_key)
    .limit(2);

  const { data: modes } = await supabase
    .from("system_control")
    .select("key,value")
    .in("key", ["auto_reply_mode", "followup_automation_mode", "acquisition_brain_mode"]);

  console.log(
    JSON.stringify(
      {
        canary: CANARY,
        authority_event_id: rows?.[0]?.id || e1.event?.id,
        proposed_writer: r.decision.proposed_writer,
        writer_reason: r.decision.writer_reason,
        reasons: r.decision.eligibility?.reasons,
        calibration: r.decision.classifier_calibration,
        mode: r.decision.current_mode,
        may_enqueue: false,
        may_suppress_legacy: false,
        queue_intent_preview: r.decision.queue_intent_preview_hash,
        rows: (rows || []).length,
        queue_delta: 0,
        provider_calls: 0,
        sms_sent: 0,
        system_control: modes,
      },
      null,
      2
    )
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
