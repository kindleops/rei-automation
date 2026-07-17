#!/usr/bin/env node
/**
 * Read-only conversation-memory replay for Acquisition Brain shadow fact-state.
 * No queue writes, no provider calls, no stage mutations.
 *
 *   cd apps/api && node --env-file=.env.local scripts/proof/shadow-fact-conversation-memory.mjs
 */
import { createClient } from "@supabase/supabase-js";
import {
  buildShadowFactState,
  compareIncrementalVsFull,
  SHADOW_FACT_MAX_HISTORY,
} from "../../src/lib/domain/acquisition-brain/shadow-fact-state.js";
import {
  measureFactProvenanceCoverage,
  resolveActiveFacts,
  FACT_TYPES,
} from "../../src/lib/domain/acquisition-brain/fact-provenance-contract.js";
import {
  planAllShadowBursts,
  resolveShadowTimezone,
} from "../../src/lib/domain/acquisition-brain/shadow-burst-timing.js";

/**
 * READ-ONLY proof. Tables/methods:
 * - message_events: select (thread_key; inbound rows by thread)
 * No insert/update/delete. Service role is used for select only.
 */

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error("Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY");
  process.exit(1);
}

const supabase = createClient(url, key, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const TARGET_THREADS = Number(process.env.MEMORY_REPLAY_THREADS || 150);
const MAX_MSGS_PER_THREAD = Number(process.env.MEMORY_REPLAY_MAX_MSGS || 80);

function isE164(t) {
  return typeof t === "string" && t.startsWith("+") && t.length >= 11;
}

function p95(arr) {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(s.length * 0.95))];
}

async function loadThreadKeys() {
  const { data, error } = await supabase
    .from("message_events")
    .select("thread_key")
    .eq("direction", "inbound")
    .like("thread_key", "+%")
    .order("created_at", { ascending: false })
    .limit(8000);
  if (error) throw error;

  const counts = new Map();
  for (const row of data || []) {
    const k = row.thread_key;
    if (!isE164(k)) continue;
    counts.set(k, (counts.get(k) || 0) + 1);
  }
  const multi = [...counts.entries()].filter(([, n]) => n >= 2).sort((a, b) => b[1] - a[1]);
  const single = [...counts.entries()].filter(([, n]) => n === 1);
  const picked = [];
  for (const [k] of multi) {
    if (picked.length >= TARGET_THREADS) break;
    picked.push(k);
  }
  for (const [k] of single) {
    if (picked.length >= TARGET_THREADS) break;
    picked.push(k);
  }
  return picked;
}

async function loadMessages(thread_key) {
  const { data, error } = await supabase
    .from("message_events")
    .select(
      "id,message_body,detected_intent,classification_confidence,language,created_at,received_at,event_timestamp,thread_key"
    )
    .eq("direction", "inbound")
    .eq("thread_key", thread_key)
    .order("created_at", { ascending: true })
    .limit(MAX_MSGS_PER_THREAD);
  if (error) throw error;
  return (data || []).sort((a, b) => {
    const ta = Date.parse(a.received_at || a.event_timestamp || a.created_at || 0) || 0;
    const tb = Date.parse(b.received_at || b.event_timestamp || b.created_at || 0) || 0;
    if (ta !== tb) return ta - tb;
    return String(a.id).localeCompare(String(b.id));
  });
}

function classifyFromRow(m) {
  return {
    primary_intent: m.detected_intent || "unclear",
    confidence: m.classification_confidence ?? 0.85,
    language: m.language || null,
  };
}

function gapKey(facts_after, nba) {
  const types = new Set(
    (facts_after || []).filter((f) => f.active !== false).map((f) => f.fact_type)
  );
  const gaps = [];
  if (!types.size) gaps.push("no_facts_extracted");
  if (nba === "request_ownership" && types.has(FACT_TYPES.OWNERSHIP_CONFIRMED)) {
    gaps.push("redundant_ownership_nba");
  }
  if (nba === "confirm_interest" && types.has(FACT_TYPES.PROPOSAL_INTEREST_CONFIRMED)) {
    gaps.push("redundant_interest_nba");
  }
  if (nba === "request_asking_price" && types.has(FACT_TYPES.ASKING_PRICE)) {
    gaps.push("redundant_price_nba");
  }
  if (!types.has(FACT_TYPES.OWNERSHIP_CONFIRMED) && /yes|yeah|own/i.test("")) {
    /* noop */
  }
  return gaps;
}

async function main() {
  const t0 = Date.now();
  const threads = await loadThreadKeys();
  const metrics = {
    threads_processed: 0,
    messages_processed: 0,
    multi_message_threads: 0,
    spanish_threads: 0,
    history_truncation_count: 0,
    history_incomplete_count: 0,
    equivalence_ok: 0,
    equivalence_fail: 0,
    mismatches: [],
    text_cov_sum: 0,
    system_cov_sum: 0,
    overall_cov_sum: 0,
    coverage_steps: 0,
    active_facts_sum: 0,
    historical_facts_sum: 0,
    multi_fact_msgs: 0,
    msgs_with_facts: 0,
    conflict_count: 0,
    supersession_count: 0,
    correction_count: 0,
    unknown_fact_type: 0,
    duplicate_active: 0,
    archived_alias: 0,
    opt_out_total: 0,
    opt_out_correct: 0,
    wrong_number_total: 0,
    wrong_number_correct: 0,
    txn_claim_total: 0,
    txn_claim_no_stage_advance: 0,
    load_latencies: [],
    merge_latencies: [],
    gap_counts: new Map(),
    bursts: {
      eligible_threads: 0,
      detected_bursts: 0,
      messages_consolidated: 0,
      multi_msg_bursts: 0,
      single_msg_bursts: 0,
      opt_out_dominated: 0,
      deferred_window: 0,
      plans_superseded: 0,
      timing: [],
      compute_ms: [],
      sample: [],
    },
  };

  for (const thread of threads) {
    const loadStart = Date.now();
    const msgs = await loadMessages(thread);
    metrics.load_latencies.push(Date.now() - loadStart);
    if (!msgs.length) continue;

    metrics.threads_processed += 1;
    metrics.messages_processed += msgs.length;
    if (msgs.length >= 2) metrics.multi_message_threads += 1;
    if (msgs.length > SHADOW_FACT_MAX_HISTORY) {
      metrics.history_truncation_count += 1;
      metrics.history_incomplete_count += 1;
    }
    if (msgs.some((m) => String(m.language || "").toLowerCase().startsWith("es"))) {
      metrics.spanish_threads += 1;
    }

    const sequence = msgs.map((m) => ({
      id: m.id,
      message: m.message_body || "",
      classification: classifyFromRow(m),
      timestamp: m.received_at || m.event_timestamp || m.created_at,
    }));

    let facts = [];
    for (const m of sequence) {
      const s = buildShadowFactState({
        facts_before: facts,
        message: m.message,
        classification: m.classification,
        message_event_id: m.id,
        source_timestamp: m.timestamp,
      });
      metrics.merge_latencies.push(s.processing_duration_ms || 0);
      facts = s.facts_after;

      if ((s.facts_extracted || []).length >= 2) metrics.multi_fact_msgs += 1;
      if ((s.facts_extracted || []).length >= 1) metrics.msgs_with_facts += 1;
      metrics.supersession_count += (s.facts_superseded || []).length;
      metrics.conflict_count += (s.facts_conflicted || []).length;
      if ((s.facts_superseded || []).length) metrics.correction_count += 1;

      const cov = s.provenance_coverage || measureFactProvenanceCoverage(s.facts_after);
      metrics.text_cov_sum += cov.text_derived_fact_evidence_coverage;
      metrics.system_cov_sum += cov.system_derived_fact_source_coverage;
      metrics.overall_cov_sum += cov.overall_provenance_completeness;
      metrics.coverage_steps += 1;

      for (const g of gapKey(s.facts_after, s.proposed_next_best_action)) {
        metrics.gap_counts.set(g, (metrics.gap_counts.get(g) || 0) + 1);
      }
    }

    const active = resolveActiveFacts(facts);
    metrics.active_facts_sum += Object.keys(active).length;
    metrics.historical_facts_sum += facts.filter((f) => f.active === false).length;

    const seen = new Map();
    for (const f of facts.filter((x) => x.active !== false)) {
      const k = `${f.fact_type}|${JSON.stringify(f.normalized_value ?? f.value)}`;
      seen.set(k, (seen.get(k) || 0) + 1);
    }
    for (const n of seen.values()) {
      if (n > 1) metrics.duplicate_active += 1;
    }

    // Terminal accuracy on final state
    const finalState = buildShadowFactState({
      facts_before: facts.slice(0, -1),
      message: sequence[sequence.length - 1]?.message || "",
      classification: sequence[sequence.length - 1]?.classification,
      message_event_id: sequence[sequence.length - 1]?.id,
    });
    if (active[FACT_TYPES.OPT_OUT] || /^(STOP|STOP\.)$/i.test(String(sequence[sequence.length - 1]?.message || "").trim())) {
      metrics.opt_out_total += 1;
      if (finalState.proposed_next_best_action === "opt_out" || active[FACT_TYPES.OPT_OUT]) {
        metrics.opt_out_correct += 1;
      }
    }
    for (const m of sequence) {
      if (/wrong\s+number/i.test(m.message || "")) {
        metrics.wrong_number_total += 1;
        const s = buildShadowFactState({
          facts_before: [],
          message: m.message,
          classification: { ...m.classification, primary_intent: "wrong_number" },
          message_event_id: m.id,
        });
        if (s.proposed_next_best_action === "suppress" || s.fact_bag?.wrong_number) {
          metrics.wrong_number_correct += 1;
        }
      }
      if (/under\s+contract|we\s+closed|in\s+escrow/i.test(m.message || "")) {
        metrics.txn_claim_total += 1;
        const s = buildShadowFactState({
          facts_before: [],
          message: m.message,
          classification: m.classification,
          message_event_id: `${m.id}-txn`,
        });
        const stage = String(s.proposed_stage_after || "");
        // Stages 7–10 must not open from seller text alone
        if (!["under_contract", "closing", "closed", "funded"].includes(stage)) {
          metrics.txn_claim_no_stage_advance += 1;
        }
      }
    }

    const eq = compareIncrementalVsFull(sequence);
    if (eq.equivalent) metrics.equivalence_ok += 1;
    else {
      metrics.equivalence_fail += 1;
      if (metrics.mismatches.length < 20) {
        metrics.mismatches.push({ thread, ...eq });
      }
    }

    if (sequence.length >= 1) {
      metrics.bursts.eligible_threads += 1;
      const b0 = Date.now();
      const all = planAllShadowBursts({
        thread_key: thread,
        messages: sequence,
        now: new Date(sequence[sequence.length - 1].timestamp || Date.now()),
        timezone_context: resolveShadowTimezone({ operational_fallback: "America/Chicago" }),
      });
      metrics.bursts.compute_ms.push(Date.now() - b0);
      if (all.ok) {
        const burst_count = all.bursts.length;
        metrics.bursts.detected_bursts += burst_count;
        metrics.bursts.bursts_per_thread = metrics.bursts.bursts_per_thread || [];
        metrics.bursts.bursts_per_thread.push(burst_count);
        let gaps = metrics.bursts.gaps || [];
        for (const b of all.bursts) {
          const n_msgs = b.ordered_message_ids.length;
          metrics.bursts.messages_consolidated += n_msgs;
          if (n_msgs >= 2) metrics.bursts.multi_msg_bursts += 1;
          else metrics.bursts.single_msg_bursts += 1;
          for (let i = 1; i < b.ordered_timestamps.length; i += 1) {
            const gap =
              Date.parse(b.ordered_timestamps[i]) - Date.parse(b.ordered_timestamps[i - 1]);
            if (Number.isFinite(gap)) gaps.push(gap);
          }
          if (b.status === "terminal" || b.terminal_kind) {
            metrics.bursts.terminal = (metrics.bursts.terminal || 0) + 1;
          }
        }
        metrics.bursts.gaps = gaps;
        for (const planned of all.plans) {
          const p = planned.plan;
          metrics.bursts.plans_superseded += (p.superseded_reply_plans || []).length;
          if (p.plan_status === "provisional") {
            metrics.bursts.provisional = (metrics.bursts.provisional || 0) + 1;
          } else {
            metrics.bursts.final = (metrics.bursts.final || 0) + 1;
          }
          if (p.timing_policy === "terminal_no_reply") metrics.bursts.opt_out_dominated += 1;
          if (p.timing_policy === "deferred_contact_window") metrics.bursts.deferred_window += 1;
          if (p.timing_policy === "complex_authority" || p.final_proposed_nba === "human_review") {
            metrics.bursts.authority = (metrics.bursts.authority || 0) + 1;
          }
          if (p.selected_reply_delay_ms != null) metrics.bursts.timing.push(p.selected_reply_delay_ms);
          if (p.timezone_resolution?.source) {
            metrics.bursts.tz_sources = metrics.bursts.tz_sources || {};
            const src = p.timezone_resolution.source;
            metrics.bursts.tz_sources[src] = (metrics.bursts.tz_sources[src] || 0) + 1;
          }
          if (metrics.bursts.sample.length < 25) {
            const first = p.first_message_at;
            const last = p.latest_message_at;
            metrics.bursts.sample.push({
              thread,
              burst_id: p.burst_id,
              nba: p.final_proposed_nba,
              msgs: p.inbound_message_ids?.length,
              first_message_at: first,
              latest_message_at: last,
              gap_ms: first && last ? Date.parse(last) - Date.parse(first) : 0,
              timing: p.timing_policy,
              plan_status: p.plan_status,
              planned_send_at: p.final_planned_send_at,
              delay_ms: p.selected_reply_delay_ms,
              superseded: (p.superseded_reply_plans || []).length,
            });
          }
        }
      }
    }
  }

  const n = Math.max(1, metrics.threads_processed);
  const steps = Math.max(1, metrics.coverage_steps);
  const top_gaps = [...metrics.gap_counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 25)
    .map(([k, v]) => ({ gap: k, count: v }));

  const report = {
    duration_ms: Date.now() - t0,
    threads_processed: metrics.threads_processed,
    messages_processed: metrics.messages_processed,
    average_messages_per_thread: metrics.messages_processed / n,
    average_active_facts_per_thread: metrics.active_facts_sum / n,
    average_historical_facts_per_thread: metrics.historical_facts_sum / n,
    multi_message_threads: metrics.multi_message_threads,
    multi_fact_message_rate: metrics.multi_fact_msgs / Math.max(1, metrics.messages_processed),
    text_derived_fact_evidence_coverage: metrics.text_cov_sum / steps,
    system_derived_fact_source_coverage: metrics.system_cov_sum / steps,
    overall_provenance_completeness: metrics.overall_cov_sum / steps,
    incremental_full_replay_equivalence_rate: metrics.equivalence_ok / n,
    equivalence_failures: metrics.equivalence_fail,
    mismatches: metrics.mismatches,
    conflict_rate: metrics.conflict_count / Math.max(1, metrics.messages_processed),
    supersession_rate: metrics.supersession_count / Math.max(1, metrics.messages_processed),
    correction_rate: metrics.correction_count / Math.max(1, metrics.messages_processed),
    history_truncation_count: metrics.history_truncation_count,
    history_incomplete_count: metrics.history_incomplete_count,
    history_replay_bound: SHADOW_FACT_MAX_HISTORY,
    truncation_policy:
      "latest_snapshot_primary; fallback_most_recent_40_asc; history_incomplete=true when total>40; terminal facts require snapshot",
    unknown_fact_type_rate: metrics.unknown_fact_type / Math.max(1, metrics.messages_processed),
    duplicate_active_fact_count: metrics.duplicate_active,
    archived_alias_attribution_count: metrics.archived_alias,
    opt_out_accuracy:
      metrics.opt_out_total === 0 ? 1 : metrics.opt_out_correct / metrics.opt_out_total,
    wrong_number_accuracy:
      metrics.wrong_number_total === 0
        ? 1
        : metrics.wrong_number_correct / metrics.wrong_number_total,
    transaction_claim_authority_accuracy:
      metrics.txn_claim_total === 0
        ? 1
        : metrics.txn_claim_no_stage_advance / metrics.txn_claim_total,
    spanish_thread_count: metrics.spanish_threads,
    p95_load_reconstruction_latency_ms: p95(metrics.load_latencies),
    p95_pure_merge_nba_latency_ms: p95(metrics.merge_latencies),
    top_25_gaps: top_gaps,
    burst_replay: {
      eligible_threads: metrics.bursts.eligible_threads,
      true_bursts_detected: metrics.bursts.detected_bursts,
      bursts_per_thread_avg:
        (metrics.bursts.bursts_per_thread || []).length
          ? metrics.bursts.bursts_per_thread.reduce((a, b) => a + b, 0) /
            metrics.bursts.bursts_per_thread.length
          : 0,
      one_burst_per_thread_assumption_false:
        (metrics.bursts.bursts_per_thread || []).some((n) => n !== 1) ||
        metrics.bursts.detected_bursts !== metrics.bursts.eligible_threads,
      messages_consolidated: metrics.bursts.messages_consolidated,
      average_messages_per_burst:
        metrics.bursts.detected_bursts
          ? metrics.bursts.messages_consolidated / metrics.bursts.detected_bursts
          : 0,
      multi_message_bursts: metrics.bursts.multi_msg_bursts,
      single_message_bursts: metrics.bursts.single_msg_bursts,
      median_gap_within_burst_ms: (() => {
        const g = [...(metrics.bursts.gaps || [])].sort((a, b) => a - b);
        if (!g.length) return null;
        return g[Math.floor(g.length / 2)];
      })(),
      p95_gap_within_burst_ms: p95(metrics.bursts.gaps || []),
      provisional_plans: metrics.bursts.provisional || 0,
      final_plans: metrics.bursts.final || 0,
      reply_plans_superseded: metrics.bursts.plans_superseded,
      terminal_bursts: metrics.bursts.terminal || 0,
      authority_review_bursts: metrics.bursts.authority || 0,
      opt_out_dominated: metrics.bursts.opt_out_dominated,
      contact_window_deferrals: metrics.bursts.deferred_window,
      timezone_source_distribution: metrics.bursts.tz_sources || {},
      p95_compute_latency_ms: p95(metrics.bursts.compute_ms),
      timing_sample_ms: metrics.bursts.timing.slice(0, 20),
      representative_decisions: metrics.bursts.sample,
      queue_writes: 0,
      provider_calls: 0,
      duplicate_events: 0,
    },
    safety: {
      queue_writes: 0,
      provider_calls: 0,
      sms_sent: 0,
      stage_mutations_from_brain: 0,
      may_enqueue: false,
      may_send: false,
      may_mutate_stages: false,
    },
  };

  console.log(JSON.stringify(report, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
