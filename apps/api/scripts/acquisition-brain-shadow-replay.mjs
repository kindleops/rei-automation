#!/usr/bin/env node
// Read-only stratified shadow replay. No production mutations.
import { createClient } from "@supabase/supabase-js";
import { readFileSync, existsSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const __dirname = dirname(fileURLToPath(import.meta.url));
const apiRoot = resolve(__dirname, "..");

// Load shadow modules via register-aliases pattern
process.chdir(apiRoot);
const { pathToFileURL } = await import("url");
// Dynamic import of built paths
const { evaluateAcquisitionBrainShadow, COMPARISON_CATEGORY } = await import(
  "../src/lib/domain/acquisition-brain/shadow-inbound-decision.js"
);

function loadEnv(p) {
  if (!existsSync(p)) return {};
  const out = {};
  for (const line of readFileSync(p, "utf8").split("\n")) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (!m) continue;
    let v = m[2].trim();
    if (
      (v.startsWith('"') && v.endsWith('"')) ||
      (v.startsWith("'") && v.endsWith("'"))
    ) {
      v = v.slice(1, -1);
    }
    out[m[1]] = v;
  }
  return out;
}

const env = {
  ...loadEnv(resolve(apiRoot, ".env.local")),
  ...loadEnv(resolve(apiRoot, ".env.production.local")),
  ...loadEnv(resolve(apiRoot, ".env.vercel.production")),
  ...process.env,
};

const sb = createClient(
  env.SUPABASE_URL || env.NEXT_PUBLIC_SUPABASE_URL,
  env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_SERVICE_KEY,
  { auth: { persistSession: false } }
);

function categorize(body, intent) {
  const t = String(body || "").toLowerCase();
  const i = String(intent || "").toLowerCase();
  const cats = [];
  if (i === "ownership_confirmed" || /^(yeah|yes|yep|i do)\b/.test(t)) cats.push("ownership_confirmations");
  if (i === "not_interested" || /not interested|no thanks/.test(t)) cats.push("ownership_denials");
  if (i === "wrong_number" || /wrong number|not me/.test(t)) cats.push("wrong_numbers");
  if (/tenant|renter|i rent/.test(t)) cats.push("renters_tenants");
  if (/husband|wife|brother|sister|mom|dad|family/.test(t)) cats.push("family_members");
  if (/agent|realtor|property manager/.test(t)) cats.push("agents_managers");
  if (/proposal|interested|maybe/.test(t) || i === "asks_offer") cats.push("proposal_interest");
  if (i === "asking_price_provided" || /\$|\d{2,3}k|\d{5,}/.test(t)) cats.push("asking_price");
  if (/roof|hvac|repair|condition|needs work/.test(t)) cats.push("condition");
  if (/timeline|soon|asap|month|week/.test(t)) cats.push("timeline_motivation");
  if (/too low|not enough|price is low/.test(t)) cats.push("price_objections");
  if (/what'?s the proposal|send.*proposal|how much/.test(t)) cats.push("proposal_requests");
  if (/paperwork|contract|email me/.test(t)) cats.push("contract_requests");
  if (/co-?owner|spouse|also owns|on title/.test(t)) cats.push("co_owner_spouse");
  if (/\bllc\b|trust|probate|estate|executor|passed away/.test(t)) cats.push("entity_probate");
  if (i === "hostile_or_legal" || /sue|lawyer|fcc|harass/.test(t)) cats.push("hostile_legal");
  if (i === "opt_out" || /^stop\b|unsubscribe/.test(t)) cats.push("opt_outs");
  if (/[áéíóúñ¿¡]|\b(sí|hola|gracias|propiedad)\b/.test(t)) cats.push("spanish");
  if (/under contract|we closed|already closed/.test(t)) cats.push("transaction_claims");
  if (!cats.length) cats.push("other");
  return cats;
}

const { data: rows, error } = await sb
  .from("message_events")
  .select(
    "id,message_body,thread_key,detected_intent,classification_confidence,current_stage,stage_before,stage_after,auto_reply_status,created_at,direction,language"
  )
  .eq("direction", "inbound")
  .order("created_at", { ascending: false })
  .limit(600);

if (error) {
  console.error(JSON.stringify({ error: error.message }));
  process.exit(1);
}

const stats = {
  total_fetched: rows?.length || 0,
  eligible: 0,
  excluded: { empty_body: 0 },
  categories: {},
  results: {},
  safety_list: [],
  reason_freq: {},
  opt_out_disagreement: 0,
  wrong_number_disagreement: 0,
  unsupported_advance: 0,
  alias_attribution: 0,
  latencies: [],
  per_stage: {},
  en: { n: 0, exact: 0, compatible: 0, safety: 0 },
  es: { n: 0, exact: 0, compatible: 0, safety: 0 },
  redundant_legacy: 0,
  redundant_brain: 0,
  unknown_mapping: 0,
  patterns: {},
};

for (const row of rows || []) {
  const body = String(row.message_body || "").trim();
  if (!body) {
    stats.excluded.empty_body += 1;
    continue;
  }
  stats.eligible += 1;
  const intent = row.detected_intent || "unclear";
  for (const c of categorize(body, intent)) {
    stats.categories[c] = (stats.categories[c] || 0) + 1;
  }
  if (row.thread_key && !String(row.thread_key).startsWith("+") && /^\d{10}$/.test(row.thread_key)) {
    stats.alias_attribution += 1;
  }

  const classification = {
    primary_intent: intent,
    confidence: row.classification_confidence ?? 0.9,
    language: row.language || "English",
  };
  const legacy = {
    stage_before: row.stage_before,
    stage_after: row.stage_after || row.current_stage,
    effective_action: null,
    use_case: null,
  };
  // Derive weak legacy labels from stored fields when present
  if (["opt_out", "wrong_number", "not_interested", "hostile_or_legal"].includes(intent)) {
    legacy.effective_action =
      intent === "opt_out" ? "opt_out" : intent === "hostile_or_legal" ? "human_review" : "suppress";
    legacy.use_case = intent === "wrong_number" ? "wrong_number" : intent;
  } else if (row.auto_reply_status === "queued" || row.auto_reply_status === "sent") {
    legacy.effective_action = "queue_auto_reply";
    if (intent === "ownership_confirmed") legacy.use_case = "consider_selling";
    if (intent === "asks_offer") legacy.use_case = "seller_asking_price";
  }

  const t0 = Date.now();
  const shadow = evaluateAcquisitionBrainShadow({
    message: body,
    classification,
    current_stage: row.stage_before || row.current_stage,
    thread_key: row.thread_key,
    message_event_id: row.id,
    legacy_decision: legacy,
  });
  const ms = Date.now() - t0;
  stats.latencies.push(ms);

  const cat = shadow.comparison?.category || shadow.comparison?.result || "unknown";
  stats.results[cat] = (stats.results[cat] || 0) + 1;
  for (const code of shadow.comparison?.reason_codes || []) {
    stats.reason_freq[code] = (stats.reason_freq[code] || 0) + 1;
    if (code === "redundant_question_legacy") stats.redundant_legacy += 1;
    if (code === "redundant_question_brain") stats.redundant_brain += 1;
    if (code === "unknown_legacy_mapping" || code === "unknown_brain_mapping") {
      stats.unknown_mapping += 1;
    }
  }
  if (shadow.comparison?.safety_divergence) {
    stats.safety_list.push({
      id: row.id,
      reason_codes: shadow.comparison.reason_codes,
      body: body.slice(0, 100),
      evidence: shadow.comparison.evidence,
      brain: shadow.comparison.brain_normalized,
      legacy: shadow.comparison.legacy_normalized,
    });
  }
  if (shadow.brain_decision?.unsupported_transition_reason) stats.unsupported_advance += 1;
  if (intent === "opt_out" && shadow.brain_decision?.proposed_next_best_action !== "opt_out") {
    stats.opt_out_disagreement += 1;
  }
  if (
    intent === "wrong_number" &&
    shadow.brain_decision?.proposed_next_best_action !== "suppress"
  ) {
    stats.wrong_number_disagreement += 1;
  }
  const stage = shadow.brain_decision?.proposed_lifecycle_stage_after || "null";
  stats.per_stage[stage] = (stats.per_stage[stage] || 0) + 1;

  const isEs =
    /[áéíóúñ¿¡]/.test(body) ||
    String(row.language || "").toLowerCase().includes("spanish");
  const bucket = isEs ? stats.es : stats.en;
  bucket.n += 1;
  if (cat === "exact_match") bucket.exact += 1;
  if (cat === "compatible_match") bucket.compatible += 1;
  if (cat === "safety_divergence") bucket.safety += 1;

  const pattern = `${cat}|${(shadow.comparison?.reason_codes || []).slice(0, 2).join("+") || "none"}`;
  stats.patterns[pattern] = (stats.patterns[pattern] || 0) + 1;
}

const n = stats.eligible || 1;
const sortedLat = [...stats.latencies].sort((a, b) => a - b);
const p95 = sortedLat[Math.floor(sortedLat.length * 0.95)] || 0;
const avg = sortedLat.length
  ? Math.round(sortedLat.reduce((a, b) => a + b, 0) / sortedLat.length)
  : 0;
const top20 = Object.entries(stats.patterns)
  .sort((a, b) => b[1] - a[1])
  .slice(0, 20)
  .map(([k, v]) => ({ pattern: k, count: v }));

console.log(
  JSON.stringify(
    {
      total_fetched: stats.total_fetched,
      eligible_sample: stats.eligible,
      excluded: stats.excluded,
      category_counts: stats.categories,
      rates: {
        exact_match: +( (stats.results.exact_match || 0) / n).toFixed(3),
        compatible_match: +((stats.results.compatible_match || 0) / n).toFixed(3),
        brain_improvement: +((stats.results.brain_improvement || 0) / n).toFixed(3),
        legacy_improvement: +((stats.results.legacy_improvement || 0) / n).toFixed(3),
        behavioral_divergence: +((stats.results.behavioral_divergence || 0) / n).toFixed(3),
        safety_divergence_count: stats.safety_list.length,
        unknown_mapping_rate: +(stats.unknown_mapping / n).toFixed(3),
        redundant_question_legacy_rate: +(stats.redundant_legacy / n).toFixed(3),
        redundant_question_brain_rate: +(stats.redundant_brain / n).toFixed(3),
      },
      counts: stats.results,
      safety_divergences: stats.safety_list,
      opt_out_disagreement: stats.opt_out_disagreement,
      wrong_number_disagreement: stats.wrong_number_disagreement,
      unsupported_advance: stats.unsupported_advance,
      archived_alias_attribution: stats.alias_attribution,
      per_stage: stats.per_stage,
      english: stats.en,
      spanish: stats.es,
      latency_ms: { avg, p95, max: sortedLat[sortedLat.length - 1] || 0 },
      top_20_patterns: top20,
      reason_code_frequency: stats.reason_freq,
    },
    null,
    2
  )
);
