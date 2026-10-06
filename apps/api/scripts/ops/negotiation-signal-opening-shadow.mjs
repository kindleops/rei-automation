#!/usr/bin/env node
/**
 * NEGOTIATION SIGNAL OPENING — shadow evaluation + report (READ-ONLY).
 *
 * Evaluates the signal-based opening / ladder / walk-away for
 *   (a) every offer-ready property among the current campaigns' targets
 *       (active/scheduled campaigns + built campaigns, targets ready/planned —
 *       the same scope as campaign-scoped scoring), and
 *   (b) every real S3+ conversation (inbox_thread_state.seller_stage).
 * Writes the PROPOSED negotiation_shadow rows to a LOCAL JSONL file plus a
 * distribution report (openings vs MAO vs recommended_cash_offer, by signal
 * bucket, outliers). NO database writes, NO sends, NO live pricing.
 *
 * Safety: BEGIN READ ONLY + statement_timeout 30s; the session is closed
 * before evaluation. Source columns are selected by explicit allow-list —
 * protected-class columns are never fetched.
 *
 * Usage (from apps/api):
 *   nice -n 15 node --import ./scripts/register-aliases-ops.mjs scripts/ops/negotiation-signal-opening-shadow.mjs \
 *     --db-url-file /tmp/.dburl --out <dir> [--campaign-id <uuid>]
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { evaluateOfferReadiness } from "../../src/lib/acquisition/offerReadiness.js";
import {
  evaluateShadowOpening,
  buildShadowRow,
  SHADOW_SUBJECTS,
  S3_PLUS_STAGES,
} from "../../src/lib/domain/seller-flow/negotiation-signal-shadow.js";
import { SIGNAL_OPENING_CONFIG_VERSION, SIGNALS } from "../../src/lib/domain/seller-flow/negotiation-signal-opening-config.js";

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--") ? process.argv[i + 1] : fallback;
}

// Same scope as lib/acquisition/scoringBackfill.js (campaign-scoped scoring).
const CAMPAIGN_SCOPE_STATUSES = ["active", "scheduled", "built"];
const QUEUE_ELIGIBLE_TARGET_STATUSES = ["ready", "planned"];

// Allow-listed source columns (never a protected-class column).
export const PROPERTY_COLS = [
  "property_id", "master_owner_id", "property_state", "property_address_state", "canonical_market_id", "property_type",
  "normalized_asset_class", "units_count", "building_condition", "rehab_level", "estimated_repair_cost", "year_built",
  "flood_zone", "property_flags_text", "seller_tags_text", "equity_percent", "total_loan_balance", "active_lien",
  "tax_delinquent", "tax_delinquent_year", "ownership_years", "out_of_state_owner", "owner_type_guess",
  "mls_market_status", "market_status_label", "is_preforeclosure", "is_pre_foreclosure", "is_foreclosure", "is_auction",
  "preforeclosure_status", "foreclosure_status",
];
export const OWNER_COLS = ["master_owner_id", "best_prospect_id", "property_count", "seller_tags_text", "max_ownership_years", "oldest_tax_delinquent_year", "active_lien_count", "owner_type_guess"];
export const PROSPECT_COLS = ["prospect_id", "mob", "marital_status", "est_household_income", "net_asset_value", "buying_power"];
export const SCORE_COLS = [
  "id", "property_id", "valuation_mid", "estimated_repairs", "recommended_cash_offer", "decision_tier", "computed_at",
  "created_at", "landlord_fatigue_score", "evidence_mode:=evidence->'backfill'->>'evidence_mode'",
];

function isoRow(row) {
  const out = {};
  for (const [k, v] of Object.entries(row || {})) out[k] = v instanceof Date ? v.toISOString() : v;
  return out;
}

async function load(client, campaignId) {
  const q = async (sql, params = []) => (await client.query(sql, params)).rows.map(isoRow);
  const campaigns = campaignId
    ? await q(`select id::text, name, status from campaigns where id::text = $1`, [campaignId])
    : await q(`select id::text, name, status from campaigns where status = any($1)`, [CAMPAIGN_SCOPE_STATUSES]);
  const campaignIds = campaigns.map((c) => c.id);
  const targets = campaignIds.length
    ? await q(
        `select distinct property_id::text from campaign_targets where campaign_id::text = any($1) and property_id is not null and target_status = any($2)`,
        [campaignIds, QUEUE_ELIGIBLE_TARGET_STATUSES],
      )
    : [];
  const threads = await q(
    `select thread_key, property_id::text, master_owner_id::text, seller_stage from inbox_thread_state where seller_stage = any($1) and coalesce(is_suppressed, false) = false`,
    [S3_PLUS_STAGES],
  );
  const propertyIds = [...new Set([...targets.map((t) => t.property_id), ...threads.map((t) => t.property_id)].filter(Boolean))];
  const scoreSelect = SCORE_COLS.map((c) => (c.includes(":=") ? `${c.split(":=")[1]} as ${c.split(":=")[0]}` : c)).join(",");
  const scores = propertyIds.length
    ? await q(
        `select ${scoreSelect},
           jsonb_build_object(
             'offer_calculation', jsonb_build_object(
               'effective_authorized_ceiling', evidence->'offer_calculation'->'effective_authorized_ceiling',
               'assignment_margin_floor', evidence->'offer_calculation'->'assignment_margin_floor',
               'protected_margin', evidence->'offer_calculation'->'protected_margin'),
             'subject', jsonb_build_object('normalized_features', jsonb_build_object(
               'vacant', evidence->'subject'->'normalized_features'->'vacant',
               'probate', evidence->'subject'->'normalized_features'->'probate',
               'condition', evidence->'subject'->'normalized_features'->'condition')),
             'backfill', evidence->'backfill',
             'immutable_snapshot_id', evidence->'immutable_snapshot_id') as evidence
         from property_acquisition_scores where property_id::text = any($1)`,
        [propertyIds],
      )
    : [];
  const properties = propertyIds.length ? await q(`select ${PROPERTY_COLS.join(",")} from properties where property_id::text = any($1)`, [propertyIds]) : [];
  const ownerIds = [...new Set(properties.map((p) => p.master_owner_id).filter(Boolean))];
  const owners = ownerIds.length ? await q(`select ${OWNER_COLS.join(",")} from master_owners where master_owner_id::text = any($1)`, [ownerIds]) : [];
  const prospectIds = [...new Set(owners.map((o) => o.best_prospect_id).filter(Boolean))];
  const prospects = prospectIds.length ? await q(`select ${PROSPECT_COLS.join(",")} from prospects where prospect_id::text = any($1)`, [prospectIds]) : [];
  const threadKeys = threads.map((t) => t.thread_key).filter(Boolean);
  const messages = threadKeys.length
    ? await q(
        `select thread_key, direction, message_body as body, coalesce(received_at, sent_at, created_at) as at
           from message_events where thread_key = any($1) and direction in ('inbound','outbound') order by thread_key, at`,
        [threadKeys],
      )
    : [];
  return { campaigns, targets, threads, scores, properties, owners, prospects, messages };
}

const pct = (a, b) => (a != null && b ? Math.round((a / b) * 10_000) / 100 : null);
function quantiles(values, qs = [0.05, 0.25, 0.5, 0.75, 0.95]) {
  const v = values.filter((x) => x != null && Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  const out = { n: v.length, min: v[0], max: v[v.length - 1] };
  for (const qq of qs) out[`p${Math.round(qq * 100)}`] = v[Math.min(v.length - 1, Math.floor(qq * (v.length - 1)))];
  out.mean = Math.round((v.reduce((s, x) => s + x, 0) / v.length) * 100) / 100;
  return out;
}

function distributionOf(ok) {
  return {
    opening_pct_of_mao: quantiles(ok.map((r) => pct(r.opening, r.max_offer_at_eval))),
    opening_pct_of_recommended: quantiles(ok.map((r) => pct(r.opening, r.recommended_offer_at_eval))),
    recommended_pct_of_mao: quantiles(ok.map((r) => pct(r.recommended_offer_at_eval, r.max_offer_at_eval))),
    spread_pct: quantiles(ok.map((r) => (r.spread == null ? null : Math.round(r.spread * 10_000) / 100))),
    raw_signal_spread_pct: quantiles(ok.map((r) => (r.raw_spread == null ? null : Math.round(r.raw_spread * 10_000) / 100))),
    dollars_below_mao: quantiles(ok.map((r) => r.max_offer_at_eval - r.opening)),
    dollars_below_recommended: quantiles(ok.map((r) => (r.recommended_offer_at_eval == null ? null : r.recommended_offer_at_eval - r.opening))),
    opening_pct_of_as_is: quantiles(ok.map((r) => pct(r.opening, r.as_is_value))),
    recommended_pct_of_as_is: quantiles(ok.map((r) => pct(r.recommended_offer_at_eval, r.as_is_value))),
  };
}

export function buildReport(rows, meta = {}) {
  const allOk = rows.filter((r) => r.status === "ok");
  // The headline distribution is OFFER-READY only; openings on a non-ready
  // score (S3+ threads whose property is not offer-ready) are diagnostic.
  const ok = allOk.filter((r) => r.offer_ready === true);
  const holds = {};
  for (const r of rows.filter((x) => x.status !== "ok")) holds[r.reason] = (holds[r.reason] || 0) + 1;
  const dist = distributionOf(ok);
  const diagnosticDist = distributionOf(allOk.filter((r) => r.offer_ready !== true));
  const bySignal = {};
  for (const def of SIGNALS) {
    const buckets = {};
    for (const r of ok) {
      const s = (r.signals || []).find((x) => x.key === def.key);
      const b = !s || !s.captured ? "not_captured" : s.mode !== "enabled" ? `${s.mode}` : s.score > 0 ? "widens" : s.score < 0 ? "narrows" : "neutral";
      (buckets[b] ||= []).push(r.spread * 100);
    }
    bySignal[def.key] = Object.fromEntries(Object.entries(buckets).map(([b, v]) => [b, { n: v.length, mean_spread_pct: Math.round((v.reduce((s, x) => s + x, 0) / v.length) * 100) / 100 }]));
  }
  const byState = {};
  for (const r of ok) (byState[r.state || "?"] ||= []).push(r.spread * 100);
  const spreads = ok.map((r) => r.spread);
  const mean = spreads.reduce((s, x) => s + x, 0) / (spreads.length || 1);
  const sd = Math.sqrt(spreads.reduce((s, x) => s + (x - mean) ** 2, 0) / (spreads.length || 1));
  const outliers = allOk
    .map((r) => {
      const flags = [];
      if (r.reason === "opening_raised_to_fair_floor") flags.push("floor_binding");
      if (r.raw_spread != null && r.spread != null && r.raw_spread !== r.spread) flags.push(r.raw_spread > r.spread ? "clamped_at_max_spread" : "clamped_at_min_spread");
      if (r.recommended_offer_at_eval != null && r.opening >= r.recommended_offer_at_eval) flags.push("opening_not_below_recommended");
      if (sd > 0 && Math.abs(r.spread - mean) / sd > 2) flags.push("spread_z_gt_2");
      if (r.ask_position === "below_fair_floor_review") flags.push("seller_ask_below_fair_floor");
      return flags.length ? { offer_ready: r.offer_ready, property_id: r.property_id, thread_key: r.thread_key ? "[thread]" : null, subject: r.subject_kind, state: r.state, opening: r.opening, mao: r.max_offer_at_eval, recommended: r.recommended_offer_at_eval, floor: r.fair_floor, spread: r.spread, raw_spread: r.raw_spread, flags } : null;
    })
    .filter(Boolean);
  return {
    generated_at: meta.generated_at,
    config_version: SIGNAL_OPENING_CONFIG_VERSION,
    scope: meta.scope,
    totals: { evaluated: rows.length, ok: allOk.length, ok_offer_ready: ok.length, hold: rows.length - allOk.length, by_subject: rows.reduce((acc, r) => ((acc[r.subject_kind] = (acc[r.subject_kind] || 0) + 1), acc), {}) },
    holds_by_reason: holds,
    distribution: dist,
    distribution_non_ready_diagnostic: diagnosticDist,
    by_signal_bucket: bySignal,
    by_state: Object.fromEntries(Object.entries(byState).map(([s, v]) => [s, { n: v.length, mean_spread_pct: Math.round((v.reduce((a, x) => a + x, 0) / v.length) * 100) / 100 }])),
    outliers,
    sends: 0,
    db_writes: 0,
  };
}

async function main() {
  const out = arg("out", "/tmp/negotiation-signal-opening");
  const campaignId = arg("campaign-id");
  const url = String(readFileSync(arg("db-url-file", "/tmp/.dburl"), "utf8")).trim();
  const { default: pg } = await import("pg");
  const client = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  await client.connect();
  let data;
  try {
    await client.query("BEGIN READ ONLY");
    await client.query("SET LOCAL statement_timeout = '30s'");
    data = await load(client, campaignId);
    await client.query("ROLLBACK");
  } finally {
    await client.end();
  }

  const now = new Date().toISOString();
  const scoreBy = new Map(data.scores.map((s) => [String(s.property_id), s]));
  const propBy = new Map(data.properties.map((p) => [String(p.property_id), p]));
  const ownerBy = new Map(data.owners.map((o) => [String(o.master_owner_id), o]));
  const prospectBy = new Map(data.prospects.map((p) => [String(p.prospect_id), p]));
  const msgsBy = new Map();
  for (const m of data.messages) (msgsBy.get(m.thread_key) || msgsBy.set(m.thread_key, []).get(m.thread_key)).push({ direction: m.direction, body: m.body, at: m.at });

  const rows = [];
  const readiness = {};
  const sourcesFor = (propertyId) => {
    const property = propBy.get(propertyId) || null;
    const owner = property?.master_owner_id ? ownerBy.get(String(property.master_owner_id)) || null : null;
    const prospect = owner?.best_prospect_id ? prospectBy.get(String(owner.best_prospect_id)) || null : null;
    return { property, owner, prospect, score: scoreBy.get(propertyId) || null };
  };
  for (const t of data.targets) {
    const id = String(t.property_id);
    const src = sourcesFor(id);
    const verdict = evaluateOfferReadiness(src.score, { now });
    readiness[verdict.reason] = (readiness[verdict.reason] || 0) + 1;
    if (!verdict.ready || !src.property) continue;
    const result = evaluateShadowOpening({ ...src, now });
    rows.push(buildShadowRow({ subject_kind: SHADOW_SUBJECTS.OFFER_READY, property_id: id, master_owner_id: src.property.master_owner_id, offer_ready: true, offer_ready_reason: verdict.reason, result, evaluated_at: now }));
  }
  for (const th of data.threads) {
    if (!th.property_id) {
      rows.push({ subject_kind: SHADOW_SUBJECTS.CONVERSATION, thread_key: th.thread_key, property_id: null, seller_stage: th.seller_stage, status: "hold", reason: "thread_without_property" });
      continue;
    }
    const id = String(th.property_id);
    const src = sourcesFor(id);
    if (!src.property) {
      rows.push({ subject_kind: SHADOW_SUBJECTS.CONVERSATION, thread_key: th.thread_key, property_id: id, seller_stage: th.seller_stage, status: "hold", reason: "property_not_found" });
      continue;
    }
    const verdict = evaluateOfferReadiness(src.score, { now });
    const result = evaluateShadowOpening({ ...src, conversation: { messages: msgsBy.get(th.thread_key) || [] }, now });
    rows.push(buildShadowRow({ subject_kind: SHADOW_SUBJECTS.CONVERSATION, thread_key: th.thread_key, property_id: id, master_owner_id: th.master_owner_id, seller_stage: th.seller_stage, offer_ready: verdict.ready, offer_ready_reason: verdict.reason, result, evaluated_at: now }));
  }

  const report = buildReport(rows, {
    generated_at: now,
    scope: {
      campaigns: data.campaigns.map((c) => ({ id: c.id, name: c.name, status: c.status })),
      campaign_targets: data.targets.length,
      offer_readiness: readiness,
      s3_plus_threads: data.threads.length,
      s3_plus_by_stage: data.threads.reduce((acc, t) => ((acc[t.seller_stage] = (acc[t.seller_stage] || 0) + 1), acc), {}),
    },
  });
  mkdirSync(out, { recursive: true });
  // Thread keys embed phone numbers: redact in the local artifacts.
  const redacted = rows.map((r) => ({ ...r, thread_key: r.thread_key ? `thread:${Buffer.from(r.thread_key).toString("base64url").slice(-10)}` : null, shadow_key: r.shadow_key ? r.shadow_key.replace(r.thread_key || "\u0000", "[thread]") : null }));
  writeFileSync(path.join(out, "negotiation_shadow.rows.jsonl"), redacted.map((r) => JSON.stringify(r)).join("\n") + "\n");
  writeFileSync(path.join(out, "negotiation_shadow.report.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ out, totals: report.totals, holds: report.holds_by_reason, readiness, distribution: report.distribution, diagnostic: report.distribution_non_ready_diagnostic, outliers: report.outliers.length }, null, 2));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
