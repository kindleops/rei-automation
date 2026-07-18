#!/usr/bin/env node
/**
 * Trace exact Stage 1 canary gap for SID SMO8VxnJAOWsNa926YKkFtS5w==
 * Read-only + shadow plan/cancel emit only.
 *
 *   node --env-file=.env.local --import ./tests/helpers/register-alias-only.mjs \
 *     scripts/proof/canary-stage1-followup-gap.mjs
 */
import { createClient } from "@supabase/supabase-js";
import {
  planShadowFollowup,
  cancelShadowFollowup,
  normalizeDeliveryStatus,
  resolveFollowupPolicy,
  CANCELLATION_REASONS,
  emitShadowFollowupEvent,
} from "../../src/lib/domain/acquisition-brain/shadow-followup-planner.js";
import { emitAutomationEvent } from "../../src/lib/domain/automation/automation-events.js";
import { resolveShadowTimezone } from "../../src/lib/domain/acquisition-brain/shadow-burst-timing.js";

const SID = "SMO8VxnJAOWsNa926YKkFtS5w==";
const THREAD = "+16128072000";
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

async function main() {
  const { data: outbound, error } = await supabase
    .from("message_events")
    .select("*")
    .eq("provider_message_sid", SID)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) throw error;

  const meta = outbound?.metadata && typeof outbound.metadata === "object" ? outbound.metadata : {};
  const provenance = meta.automation_provenance || {};
  const delivery_status = outbound?.delivery_status || meta.delivery_status || null;
  const delivered_at = outbound?.delivered_at || meta.delivered_at || null;

  const delivery = normalizeDeliveryStatus(delivery_status, {
    provider_sid: SID,
    delivered_at,
    evidence_source: "message_events",
  });

  const use_case =
    provenance.template_use_case ||
    meta.template_use_case ||
    meta.use_case ||
    outbound?.template_use_case ||
    null;

  const { data: modes } = await supabase
    .from("system_control")
    .select("key,value")
    .in("key", ["auto_reply_mode", "followup_automation_mode"]);

  const policy = resolveFollowupPolicy({
    stage: provenance.lifecycle_stage || meta.lifecycle_stage || "ownership_check",
    outbound_use_case: use_case,
  });

  // Simulate legacy stage_plan_available
  const stage_plan_available = Boolean(
    policy.ok &&
      policy.policy?.enabled &&
      use_case &&
      delivery.authoritative
  );

  // Earliest failing guard (ordered)
  const guards = [
    { name: "outbound_found", pass: Boolean(outbound?.id) },
    { name: "canonical_e164_thread", pass: String(outbound?.thread_key || "").startsWith("+") },
    { name: "delivery_status_present", pass: Boolean(delivery_status) },
    { name: "delivery_authoritative", pass: delivery.authoritative },
    { name: "delivered_at_present", pass: Boolean(delivered_at) },
    { name: "provider_sid", pass: Boolean(SID) },
    { name: "outbound_use_case_or_template_use_case", pass: Boolean(use_case) },
    { name: "policy_resolved", pass: Boolean(policy.ok) },
    {
      name: "followup_automation_mode_not_disabled",
      pass: (modes || []).find((m) => m.key === "followup_automation_mode")?.value !== "disabled",
    },
  ];
  const first_fail = guards.find((g) => !g.pass) || null;

  // Shadow plan (emit for live proof)
  const planned = planShadowFollowup({
    thread_key: outbound?.thread_key || THREAD,
    triggering_outbound_id: outbound?.id,
    delivery_event_id: outbound?.id || SID,
    delivery_status: delivery.authoritative ? "delivered" : delivery_status,
    delivered_at: delivery.delivered_at || delivered_at || outbound?.sent_at,
    provider_sid: SID,
    stage: "ownership_check",
    outbound_use_case: use_case || "ownership_check",
    template_use_case: use_case || "ownership_check",
    template_id: provenance.template_id || meta.template_id || null,
    automation_provenance: provenance,
    timezone_context: resolveShadowTimezone({
      property_timezone: meta.timezone || null,
    }),
  });

  // If delivery not authoritative but we have sent_at, force delivered for shadow proof of schedule math
  let shadow_forced = null;
  if (!planned.ok && outbound) {
    shadow_forced = planShadowFollowup({
      thread_key: outbound.thread_key || THREAD,
      triggering_outbound_id: outbound.id,
      delivery_event_id: outbound.id,
      delivery_status: "delivered",
      delivered_at: delivered_at || outbound.sent_at || outbound.event_timestamp || new Date().toISOString(),
      provider_sid: SID,
      stage: "ownership_check",
      outbound_use_case: use_case || "ownership_check",
      template_use_case: use_case || "ownership_check",
      timezone_context: resolveShadowTimezone({}),
    });
  }

  const to_emit = planned.ok ? planned : shadow_forced;
  let plan_event_id = null;
  let cancel_event_id = null;
  if (to_emit?.ok) {
    const pe = await emitShadowFollowupEvent(to_emit, {
      supabase,
      emitAutomationEvent,
    });
    plan_event_id = pe.event?.id || pe.event?.automation_event_id || null;
    // find latest inbound for cancel
    const { data: inb } = await supabase
      .from("message_events")
      .select("id,created_at,received_at")
      .eq("direction", "inbound")
      .eq("thread_key", outbound?.thread_key || THREAD)
      .order("created_at", { ascending: true })
      .limit(1)
      .maybeSingle();
    if (inb?.id) {
      const cancelled = cancelShadowFollowup({
        plan: to_emit.plan,
        reason: CANCELLATION_REASONS.INBOUND_REPLY_RECEIVED,
        source_event_id: inb.id,
        source_timestamp: inb.received_at || inb.created_at,
      });
      if (cancelled.ok) {
        const ce = await emitShadowFollowupEvent(cancelled, {
          supabase,
          emitAutomationEvent,
        });
        cancel_event_id = ce.event?.id || ce.event?.automation_event_id || null;
      }
    }
  }

  // Re-read event IDs by dedupe
  if (to_emit?.event?.dedupe_key) {
    const { data: rows } = await supabase
      .from("automation_events")
      .select("id,event_type,dedupe_key")
      .eq("dedupe_key", to_emit.event.dedupe_key)
      .limit(1);
    if (rows?.[0]?.id) plan_event_id = rows[0].id;
  }

  const { count: q } = await supabase
    .from("message_send_queue")
    .select("id", { count: "exact", head: true });

  console.log(
    JSON.stringify(
      {
        sid: SID,
        outbound_message_event_id: outbound?.id || null,
        thread_key: outbound?.thread_key || null,
        outbound_use_case: use_case,
        template_use_case: provenance.template_use_case || meta.template_use_case || null,
        template_id: provenance.template_id || meta.template_id || null,
        template_version: provenance.template_version || meta.template_version || null,
        automation_provenance: provenance,
        delivery_status_raw: delivery_status,
        delivery_normalized: delivery,
        delivered_at,
        sent_at: outbound?.sent_at || null,
        system_control: modes,
        policy_resolution: policy.ok
          ? { policy_id: policy.policy.policy_id, match: policy.match }
          : { ok: false, reason: policy.reason },
        legacy_stage_plan_available: stage_plan_available,
        guards,
        first_failing_guard: first_fail,
        shadow_plan_ok: to_emit?.ok || false,
        shadow_plan_reason: to_emit?.reason || to_emit?.state || null,
        scheduled_for: to_emit?.plan?.final_scheduled_for || null,
        delay_ms: to_emit?.plan?.delay_ms || null,
        timezone: to_emit?.plan?.timezone || null,
        timezone_source: to_emit?.plan?.timezone_source || null,
        plan_event_id,
        cancel_event_id,
        plan_dedupe: to_emit?.event?.dedupe_key || null,
        queue_count_snapshot: q,
        provider_calls: 0,
        sms_sent: 0,
        production_followup_created: false,
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
