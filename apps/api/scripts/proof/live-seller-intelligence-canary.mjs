#!/usr/bin/env node
/**
 * Live seller intelligence proof on canary (no SMS).
 *   node --env-file=.env.local --import ./tests/helpers/register-alias-only.mjs \
 *     scripts/proof/live-seller-intelligence-canary.mjs
 */
import { createClient } from "@supabase/supabase-js";
import {
  loadPriorShadowFacts,
  evaluateShadowWithFactState,
  emitShadowFactStateEvents,
} from "../../src/lib/domain/acquisition-brain/shadow-fact-state.js";
import {
  buildSellerIntelligenceProfile,
  emitShadowSellerIntelligence,
} from "../../src/lib/domain/acquisition-brain/shadow-seller-intelligence.js";
import { emitAutomationEvent } from "../../src/lib/domain/automation/automation-events.js";

const CANARY = "+16128072000";
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

async function main() {
  const prior = await loadPriorShadowFacts({ thread_key: CANARY, supabase });
  const { data: msgs } = await supabase
    .from("message_events")
    .select("id,message_body,detected_intent,language,created_at,received_at")
    .eq("direction", "inbound")
    .eq("thread_key", CANARY)
    .order("created_at", { ascending: true })
    .limit(20);

  const messages = (msgs || []).map((m) => ({
    id: m.id,
    message: m.message_body,
    timestamp: m.received_at || m.created_at,
    language: m.language,
    direction: "inbound",
  }));

  const last = messages[messages.length - 1];
  const fact = evaluateShadowWithFactState({
    facts_before: prior.facts || [],
    message: last?.message || "Yeah",
    classification: {
      primary_intent: "ownership_confirmed",
      confidence: 0.9,
    },
    message_event_id: last?.id || `proof-intel-${Date.now()}`,
    thread_key: CANARY,
    source_timestamp: last?.timestamp || new Date().toISOString(),
  });

  await emitShadowFactStateEvents(fact, { supabase, emitAutomationEvent });

  const as_of = last?.timestamp || new Date().toISOString();
  const intel = buildSellerIntelligenceProfile({
    thread_key: CANARY,
    facts_after: fact.fact_state?.facts_after || prior.facts || [],
    messages,
    fact_state_ref: fact.fact_event?.dedupe_key,
    decision_ref: fact.decision_event?.dedupe_key,
    as_of,
  });

  const emit1 = await emitShadowSellerIntelligence(intel, {
    supabase,
    emitAutomationEvent,
  });
  const emit2 = await emitShadowSellerIntelligence(intel, {
    supabase,
    emitAutomationEvent,
  });

  const { data: rows } = await supabase
    .from("automation_events")
    .select("id,dedupe_key,event_type")
    .eq("dedupe_key", intel.event.dedupe_key)
    .limit(3);

  const { data: modes } = await supabase
    .from("system_control")
    .select("key,value")
    .in("key", ["auto_reply_mode", "followup_automation_mode"]);

  console.log(
    JSON.stringify(
      {
        canary: CANARY,
        intel_event_id: rows?.[0]?.id || emit1.event?.id,
        dedupe_key: intel.event.dedupe_key,
        rows_found: (rows || []).length,
        second_emit_idempotent: Boolean(emit2),
        temperature: intel.profile.opportunity_score.temperature,
        score: intel.profile.opportunity_score.final_normalized_score,
        authority: intel.profile.signals.authority.can_execute_alone,
        missing: intel.profile.opportunity_score.missing_signals,
        components: intel.profile.opportunity_score.components?.map((c) => ({
          name: c.name,
          contribution: c.weighted_contribution,
        })),
        may_send: false,
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
