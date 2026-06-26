#!/usr/bin/env node
/**
 * Miami production continue — template assignment, failure terminalization, queue hydrate.
 */

import {
  callJson,
  createMarker,
  supabase,
  routeSummary,
} from "./campaign-proof-utils.mjs";

const MIAMI_ID = process.env.PROOF_CAMPAIGN_ID || "320c798a-84c9-45b8-a7c9-d166ddd7bd46";
const marker = createMarker();
const label = "miami production continue";

function clean(v) {
  return String(v ?? "").trim();
}

function normalizeLang(language) {
  const l = clean(language).toLowerCase();
  if (l === "korea" || l === "ko") return "Korean";
  if (l === "en" || l === "english") return "English";
  if (l === "es" || l === "spanish") return "Spanish";
  if (l === "ru" || l === "russian") return "Russian";
  return clean(language) || "English";
}

function isBlacklistFailure(reason = "") {
  const r = clean(reason).toLowerCase();
  return r.includes("21610") || r.includes("blacklist");
}

async function loadTemplateMap() {
  const { data, error } = await supabase
    .from("sms_templates")
    .select("id,template_id,template_name,language,use_case,stage_code")
    .eq("is_active", true)
    .eq("use_case", "ownership_check")
    .eq("stage_code", "S1");
  if (error) throw error;
  const map = new Map();
  for (const row of data || []) {
    const lang = normalizeLang(row.language);
    if (!map.has(lang)) map.set(lang, row);
  }
  // Preferred ownership_check templates used by live Miami sends
  const preferred = {
    English: "840901",
    Spanish: "840906",
    Russian: "211262",
    Korean: "215083",
  };
  for (const [lang, tid] of Object.entries(preferred)) {
    const hit = (data || []).find((r) => clean(r.template_id || r.id) === tid);
    if (hit) map.set(lang, hit);
  }
  return map;
}

async function fixTemplateGaps(templateMap) {
  const { data: pending, error } = await supabase
    .from("campaign_targets")
    .select("*")
    .eq("campaign_id", MIAMI_ID)
    .neq("template_status", "ready");
  if (error) throw error;

  let fixed = 0;
  let unmapped = 0;
  for (const target of pending || []) {
    const lang = normalizeLang(target.language);
    const tpl = templateMap.get(lang);
    if (!tpl) {
      unmapped += 1;
      continue;
    }
    const templateId = clean(tpl.template_id || tpl.id);
    const metadata = {
      ...(target.metadata || {}),
      template_id: templateId,
      template_name: tpl.template_name || null,
      template_use_case: "ownership_check",
    };
    const { error: updErr } = await supabase
      .from("campaign_targets")
      .update({
        template_status: "ready",
        target_status: target.routing_status === "ready" ? "ready" : target.target_status,
        metadata,
        updated_at: new Date().toISOString(),
      })
      .eq("id", target.id);
    if (updErr) throw updErr;
    fixed += 1;
  }
  return { pending: pending?.length || 0, fixed, unmapped };
}

async function terminalizeBlacklistFailures() {
  const { data: rows, error } = await supabase
    .from("send_queue")
    .select("id,campaign_target_id,to_phone_number,from_phone_number,failed_reason,metadata,queue_status")
    .eq("campaign_id", MIAMI_ID)
    .eq("queue_status", "failed");
  if (error) throw error;

  let terminal = 0;
  let retried = 0;
  for (const row of rows || []) {
    const reason = clean(row.failed_reason);
    const blacklist = isBlacklistFailure(reason);
    const stale = reason === "stale_runnable_row_expired";
    const meta = { ...(row.metadata || {}) };
    meta.failure_category = blacklist ? "compliance_terminalization" : stale ? "internal_execution_error" : meta.failure_category || "provider_failure";
    meta.terminal = true;
    meta.retryable = false;
    meta.provider_code = blacklist ? "21610" : meta.provider_code || null;
    meta.non_retryable_reason = blacklist ? "textgrid_21610_blacklist" : stale ? "stale_runnable_row_expired" : meta.non_retryable_reason || reason;

    await supabase.from("send_queue").update({ metadata: meta, updated_at: new Date().toISOString() }).eq("id", row.id);

    if (blacklist && row.campaign_target_id) {
      await supabase.from("campaign_targets").update({
        suppression_status: "blocked",
        target_status: "suppressed",
        block_reason: "provider_blacklist_21610",
        updated_at: new Date().toISOString(),
      }).eq("id", row.campaign_target_id);
      terminal += 1;
    } else if (stale) {
      terminal += 1;
    }
  }
  return { total: rows?.length || 0, terminal, retried };
}

async function countQueue() {
  const statuses = ["queued", "scheduled", "pending", "ready", "approved"];
  const { count: active } = await supabase.from("send_queue").select("id", { count: "exact", head: true }).eq("campaign_id", MIAMI_ID).in("queue_status", statuses);
  const { count: scheduled } = await supabase.from("send_queue").select("id", { count: "exact", head: true }).eq("campaign_id", MIAMI_ID).eq("queue_status", "scheduled");
  const { count: delivered } = await supabase.from("send_queue").select("id", { count: "exact", head: true }).eq("campaign_id", MIAMI_ID).eq("queue_status", "delivered");
  const { count: failed } = await supabase.from("send_queue").select("id", { count: "exact", head: true }).eq("campaign_id", MIAMI_ID).eq("queue_status", "failed");
  return { active: active || 0, scheduled: scheduled || 0, delivered: delivered || 0, failed: failed || 0 };
}

async function main() {
  if (!supabase) throw new Error("supabase_unavailable");

  const templateMap = await loadTemplateMap();
  const templates = await fixTemplateGaps(templateMap);
  marker.mark("template gaps assigned", templates.fixed === 28, `fixed=${templates.fixed}/${templates.pending} unmapped=${templates.unmapped}`);

  const failures = await terminalizeBlacklistFailures();
  marker.mark("failures terminalized", failures.total > 0, `total=${failures.total} terminal=${failures.terminal}`);

  await callJson(`/api/cockpit/campaigns/${MIAMI_ID}/lifecycle`, {
    method: "POST",
    body: JSON.stringify({ action: "sync_metrics" }),
    timeout_seconds: 120,
  });

  const hydrate = await callJson(`/api/cockpit/campaigns/${MIAMI_ID}/queue-batch`, {
    method: "POST",
    body: JSON.stringify({
      confirm_live: true,
      explicit_operator_action: true,
      batch_max: 50,
      spread_interval_seconds: 60,
      respect_contact_window: true,
    }),
    timeout_seconds: 300,
  });
  marker.mark("queue batch hydrated", hydrate.status === 200, routeSummary(hydrate));

  await callJson(`/api/cockpit/campaigns/${MIAMI_ID}/lifecycle`, {
    method: "POST",
    body: JSON.stringify({ action: "sync_metrics" }),
    timeout_seconds: 120,
  });

  const summary = await callJson(`/api/cockpit/campaigns/${MIAMI_ID}/summary`, { timeout_seconds: 60 });
  const queue = await countQueue();
  const { count: gapRemaining } = await supabase
    .from("campaign_targets")
    .select("id", { count: "exact", head: true })
    .eq("campaign_id", MIAMI_ID)
    .neq("template_status", "ready");

  console.log("CONTINUE_RESULT", JSON.stringify({
    templates,
    failures,
    hydrate: hydrate.json,
    summary_counts: summary.json?.counts,
    queue,
    gap_remaining: gapRemaining,
  }, null, 2));

  marker.finish(label);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});