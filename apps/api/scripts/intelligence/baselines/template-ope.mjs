#!/usr/bin/env node
/**
 * IC8 Phase 4 -- template off-policy evaluation on the legacy feeder's
 * logged, hash-uniform template draws. EVALUATION ON LOGGED DATA, NOT A
 * COUNTERFACTUAL GUARANTEE.
 *
 * Logging policy (cited at HEAD fb5682ba,
 * apps/api/src/lib/domain/outbound/supabase-candidate-feeder.js):
 *   - buildRotationPool (~:1764): S1 ownership_check pool = top-scored window,
 *     cap 35 (strategy cold_s1_wide_window), after templates recently sent to
 *     the same owner are removed (~:3705-3714);
 *   - buildTemplateRotationSeed (~:1446): owner|property|phone_id|language|
 *     use_case|stage|campaign|UTC day;
 *   - stableSeedModulo (~:1468): parseInt(sha1(seed)[0:8], 16) mod |pool|;
 *   - chooseRotatingTemplate (~:1476) picks pool[index]; the pool, size, seed
 *     and index are logged in send_queue.metadata.template_rotation_* (~:5430).
 * Given the logged pool the choice is a deterministic hash of identifiers,
 * i.e. uniform and unrelated to the seller's response: mu(a | pool) =
 * 1/|pool|. The extract re-computed the hash for every row (seed verified in
 * memory, never stored); only verified rows are used.
 *
 * Offline: reads the sealed snapshot + the template catalogue attributes of
 * the extract work dir. No database access.
 *
 *   node --no-warnings --loader ./tests/alias-loader.mjs \
 *     scripts/intelligence/baselines/template-ope.mjs --dataset=<dir> [--out=<models root>]
 */

import fs from "node:fs";
import path from "node:path";

import { readNdjsonGz } from "../../../src/lib/domain/intelligence/datasets/ndjson-gz.js";
import { DEFAULT_WORK_DIR } from "./extract-first-touch.mjs";
import { evaluatePolicy, perTemplateEstimates, policyVsLogged, restrictPolicy, uniformPolicy, validLoggedRows } from "./lib/ope.mjs";
import { ciText, f, pct } from "./lib/report-writers.mjs";

const MODELS_ROOT = "/Users/ryankindle/.claude/jobs/c39b0175/tmp/ic8/models";
const SEED = "ic8-phase4-ope-v0";

function readWorkTable(name) {
  return fs
    .readFileSync(path.join(DEFAULT_WORK_DIR, `${name}.ndjson`), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

export function loggedRows(records, outcomeId, { leadsOnly }) {
  const out = [];
  const counts = { legacy_with_rotation: 0, verified: 0, outcome_mature: 0, used: 0 };
  for (const r of records) {
    const rot = r.strata?.rotation;
    if (r.strata?.kind !== "first_touch_legacy_feeder" || !rot) continue;
    counts.legacy_with_rotation += 1;
    if (!(rot.hash_matches_logged_index && rot.pool_logged_completely && rot.chosen_matches_pool_slot)) continue;
    counts.verified += 1;
    if (leadsOnly && r.strata.episode_lead !== true) continue;
    const o = r.outcomes[outcomeId];
    if (!o || o.status !== "mature") continue;
    counts.outcome_mature += 1;
    out.push({ pool: rot.pool_ids.map(String), action: String(r.features["template.template_id"]), reward: o.value === true ? 1 : 0, language: r.strata.template_language || "unknown" });
  }
  const valid = validLoggedRows(out);
  counts.used = valid.length;
  return { rows: valid, counts };
}

/** Wilson 95% interval for k of n. */
export function wilson(k, n, z = 1.959964) {
  if (!n) return { rate: null, lower: null, upper: null };
  const p = k / n;
  const d = 1 + (z * z) / n;
  const c = (p + (z * z) / (2 * n)) / d;
  const h = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / d;
  return { rate: p, lower: Math.max(0, c - h), upper: Math.min(1, c + h) };
}

const median = (v) => {
  if (!v.length) return null;
  const s = [...v].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};

/**
 * Template quasi-experiment table (8.1): per logged template and per template
 * family, on verified legacy rotation sends. Delivery/filtering per send;
 * reply / meaningful reply / opt-out per episode lead (mature labels only).
 */
export function quasiExperiment(records, { familyOf }) {
  const groups = new Map();
  const add = (key, r) => {
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  };
  for (const r of records) {
    const rot = r.strata?.rotation;
    if (r.strata?.kind !== "first_touch_legacy_feeder" || !rot || !(rot.hash_matches_logged_index && rot.pool_logged_completely && rot.chosen_matches_pool_slot)) continue;
    const t = String(r.features["template.template_id"]);
    add(`template:${t}`, r);
    add(`family:${familyOf(t)}`, r);
  }
  const rate = (rows, id) => {
    const mature = rows.filter((r) => r.outcomes[id]?.status === "mature");
    return { n: mature.length, ...wilson(mature.filter((r) => r.outcomes[id].value === true).length, mature.length) };
  };
  const out = { templates: [], families: [] };
  for (const [key, rows] of [...groups.entries()].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))) {
    const leads = rows.filter((r) => r.strata.episode_lead === true);
    const latencies = leads
      .filter((r) => r.outcomes["reply_any@1"]?.value === true && r.outcomes["reply_any@1"].observed_at)
      .map((r) => (Date.parse(r.outcomes["reply_any@1"].observed_at) - Date.parse(r.as_of)) / 3600e3);
    const entry = {
      key: key.replace(/^(template|family):/, ""),
      sends: rows.length,
      delivered: rate(rows, "delivered@1"),
      filtered: rate(rows, "carrier_filtered@1"),
      leads: leads.length,
      reply_any: rate(leads, "reply_any@1"),
      reply_meaningful: rate(leads, "reply_meaningful@1"),
      opt_out_keyword: rate(leads, "opt_out_keyword@1"),
      median_reply_latency_hours: median(latencies),
    };
    (key.startsWith("template:") ? out.templates : out.families).push(entry);
  }
  return out;
}

export function buildPolicies({ templates, blocked, governance }) {
  const attr = new Map(templates.map((t) => [String(t.template_id), t]));
  const lengths = templates.map((t) => t.length).filter(Number.isFinite).sort((a, b) => a - b);
  const median = lengths[Math.floor(lengths.length / 2)];
  const status = new Map(governance.map((g) => [String(g.template_id), g.rotation_status]));
  return {
    logged_uniform: { describe: "uniform over the logged pool (= the logging policy; sanity check)", policy: uniformPolicy },
    exclude_blocklisted_now: { describe: `uniform over pool minus the ${blocked.size} ids on system_control.sms_blocked_template_ids today`, policy: restrictPolicy((t) => !blocked.has(t)) },
    exclude_governance_pause: { describe: "uniform over pool minus templates ownership_template_rotation_control marks pause today", policy: restrictPolicy((t) => status.get(t) !== "pause") },
    only_governance_testing: { describe: "uniform over the pool members governance marks testing (defer to logged when none)", policy: restrictPolicy((t) => status.get(t) === "testing") },
    shorter_copy: { describe: `uniform over pool members with copy length <= ${median} chars (catalogue median)`, policy: restrictPolicy((t) => (attr.get(t)?.length ?? Infinity) <= median) },
    longer_copy: { describe: `uniform over pool members with copy length > ${median} chars`, policy: restrictPolicy((t) => (attr.get(t)?.length ?? -Infinity) > median) },
    three_placeholders: { describe: "uniform over pool members with 3 merge fields", policy: restrictPolicy((t) => attr.get(t)?.placeholder_count === 3) },
    four_placeholders: { describe: "uniform over pool members with 4 merge fields", policy: restrictPolicy((t) => attr.get(t)?.placeholder_count === 4) },
  };
}

export function runOpe({ records, templates, blocked, governance }) {
  const rewards = {
    reply_any: { outcome: "reply_any@1", leadsOnly: true, note: "episode leads, delivered or not (wording affects delivery too)" },
    carrier_filtered: { outcome: "carrier_filtered@1", leadsOnly: false, note: "every verified legacy send (filtering is per message)" },
    opt_out_keyword: { outcome: "opt_out_keyword@1", leadsOnly: true, note: "episode leads, 7d horizon" },
  };
  const policies = buildPolicies({ templates, blocked, governance });
  const out = { rewards: {}, policies: Object.fromEntries(Object.entries(policies).map(([k, v]) => [k, v.describe])) };
  for (const [name, spec] of Object.entries(rewards)) {
    const { rows, counts } = loggedRows(records, spec.outcome, { leadsOnly: spec.leadsOnly });
    const onPolicy = rows.reduce((a, r) => a + r.reward, 0) / rows.length;
    const entry = { outcome: spec.outcome, population: spec.note, counts, on_policy_mean: onPolicy, policies: {}, by_language: {} };
    for (const [pname, p] of Object.entries(policies)) {
      entry.policies[pname] = { ...evaluatePolicy(rows, p.policy, { seed: `${SEED}:${name}:${pname}` }), vs_logged: policyVsLogged(rows, p.policy, { seed: `${SEED}:${name}:${pname}:diff` }) };
    }
    for (const lang of ["english", "spanish"]) {
      const sub = rows.filter((r) => String(r.language).toLowerCase() === lang);
      if (sub.length) {
        entry.by_language[lang] = {
          n: sub.length,
          on_policy_mean: sub.reduce((a, r) => a + r.reward, 0) / sub.length,
          per_template: perTemplateEstimates(sub, { iterations: 500, seed: `${SEED}:${name}:${lang}` }),
        };
      }
    }
    out.rewards[name] = entry;
  }
  const attr = new Map(templates.map((t) => [String(t.template_id), t]));
  out.quasi_experiment = quasiExperiment(records, { familyOf: (t) => attr.get(t)?.variant_group_key || "unknown_family" });
  return out;
}

function renderReport(result, { datasetManifest }) {
  const lines = [
    "# Template off-policy evaluation v0 (legacy feeder first touches)",
    "",
    "> **Evaluation on logged data, not a counterfactual guarantee.** Estimates say what the logged randomisation implies for these sellers, in these markets, in Apr-Aug 2026, under that carrier regime. They do not promise the same effect for new campaigns, new wording or the 2026-09-28 filtering regime.",
    "",
    `Dataset \`${datasetManifest.dataset_id}\` (sha256 \`${datasetManifest.sha256}\`).`,
    "",
    "## Logging policy and propensity",
    "",
    "- The legacy feeder chose each first-touch template as `pool[parseInt(sha1(seed)[0:8],16) mod |pool|]`, logging the full pool (`supabase-candidate-feeder.js` buildRotationPool / buildTemplateRotationSeed / stableSeedModulo / chooseRotatingTemplate; metadata.template_rotation_*). Propensity of the logged template = **1/|pool|**.",
    `- Re-computed for every row in the extract (seed hashed in memory, never stored): ${result.rewards.carrier_filtered.counts.verified} of ${result.rewards.carrier_filtered.counts.legacy_with_rotation} legacy rotation rows in the window match the logged index, have a complete pool and the chosen template in the logged slot.`,
    "- Estimands are conditional on the logged pool: a template that was never in a row's pool has zero propensity there (positivity), so a policy can only re-weight pool members. Pools are per template language, so every comparison is within language.",
    "- Weights w = pi(a|pool) x |pool|; IPW = mean(w r); SNIPW = sum(w r)/sum(w); 95% percentile bootstrap over rows (1,000 resamples, seeded); ESS = (sum w)^2 / sum w^2.",
    "",
    "## Policies compared (coarse only)",
    "",
    ...Object.entries(result.policies).map(([k, v]) => `- \`${k}\`: ${v}`),
    "- **Not evaluable:** a language-matched vs non-matched comparison. Template language was set deterministically from the owner's language and was never randomised, so no logged row has a cross-language alternative in its pool (positivity fails). Use-case families are not comparable either: every legacy first touch is S1 ownership_check.",
    "- Copy attributes such as \"asks a question\" or \"names the seller\" are constant across the catalogue (725 of 727 pool templates), so they cannot define a policy.",
    "",
  ];
  for (const [name, e] of Object.entries(result.rewards)) {
    lines.push(`## Reward: ${e.outcome}`, "", `Population: ${e.population}. Rows used ${e.counts.used} (legacy rotation rows ${e.counts.legacy_with_rotation}, verified ${e.counts.verified}, mature ${e.counts.outcome_mature}). On-policy (logged) mean ${pct(e.on_policy_mean)}.`, "");
    lines.push("| policy | rows with mass | ESS | IPW [95% CI] | SNIPW [95% CI] | SNIPW - logged [95% CI] | detectable? |", "|---|---|---|---|---|---|---|");
    for (const [pname, p] of Object.entries(e.policies)) {
      lines.push(`| ${pname} | ${p.rows_with_mass} | ${f(p.ess, 0)} | ${ciText(p.ipw, 4)} | ${ciText(p.snipw, 4)} | ${ciText(p.vs_logged, 4)} | ${p.vs_logged.excludes_zero ? "yes (CI excludes 0)" : "no"} |`);
    }
    lines.push("");
    for (const [lang, L] of Object.entries(e.by_language)) {
      const rowsT = L.per_template.filter((t) => t.logged >= 30).sort((a, b) => b.logged - a.logged);
      lines.push(`### Per-template ${e.outcome}, ${lang} pools (templates logged >= 30 times; ${L.per_template.length} templates ever in a pool; n=${L.n}, logged mean ${pct(L.on_policy_mean)})`, "", "| template | eligible (in pool) | logged | positives | naive rate | IPW [95% CI] | SNIPW [95% CI] | ESS |", "|---|---|---|---|---|---|---|---|");
      for (const t of rowsT) lines.push(`| ${t.template_id} | ${t.eligible} | ${t.logged} | ${t.positives} | ${pct(t.naive)} | ${ciText(t.ipw, 4)} | ${ciText(t.snipw, 4)} | ${f(t.ess, 0)} |`);
      lines.push("");
    }
  }
  const q = result.quasi_experiment;
  const qRow = (e) =>
    `| ${e.key} | ${e.sends} | ${ciText({ estimate: e.delivered.rate, ...e.delivered }, 3)} | ${ciText({ estimate: e.filtered.rate, ...e.filtered }, 3)} | ${e.leads} | ${ciText({ estimate: e.reply_any.rate, ...e.reply_any }, 3)} | ${ciText({ estimate: e.reply_meaningful.rate, ...e.reply_meaningful }, 3)} | ${ciText({ estimate: e.opt_out_keyword.rate, ...e.opt_out_keyword }, 3)} | ${f(e.median_reply_latency_hours, 2)} |`;
  const qHead = "| key | sends | delivered [95% CI] | carrier-filtered [95% CI] | episode leads | real reply (reply_any) [95% CI] | meaningful reply [95% CI] | opt-out keyword (7d) [95% CI] | median reply latency (h) |";
  lines.push(
    "## Template quasi-experiment report (IC 8.1)",
    "",
    "**Assumptions.** (1) Within a logged pool the template was assigned by a hash of identifiers, unrelated to the seller's propensity to answer, so differences between templates that shared pools are not confounded by who received them; (2) templates did NOT share all pools (pools vary by language, owner history and time), so raw per-template rates below still mix in pool composition -- the IPW/SNIPW tables above are the pool-adjusted comparison; (3) carrier behaviour drifted over Apr-Aug and changed again on 2026-09-28, so none of this predicts a template's performance today. Rates are descriptive with Wilson 95% intervals; **no causal claim is made from a single row.**",
    "",
    "**Not reported:** positive / qualified replies (they come from classifier intents -- `detected_intent`, 23% unclear, no version stamp -- not a trustworthy label); wrong person (the versioned 7.2 wrong-person rule was not injected into this labeler run, so `wrong_person@1` is unlabelled).",
    "",
    "### By template family (sms_templates.variant_group_key)",
    "",
    qHead,
    "|---|---|---|---|---|---|---|---|---|",
    ...q.families.map(qRow),
    "",
    "### By template (logged >= 30 sends)",
    "",
    qHead,
    "|---|---|---|---|---|---|---|---|---|",
    ...q.templates.filter((e) => e.sends >= 30).map(qRow),
    "",
    `${q.templates.filter((e) => e.sends < 30).length} templates with fewer than 30 logged sends are in ope.json only.`,
    "",
  );
  lines.push(
    "## Reading the per-template tables",
    "",
    "- naive = positives / times logged. IPW/SNIPW re-weight to the population of rows where the template was ELIGIBLE (in the pool). They differ when pool membership correlates with outcome (e.g. a template eligible mostly in high-reply markets or weeks).",
    "- With ~13 reply positives per template, per-template intervals are wide; per-template winner-picking is not supported by this data (data audit §9, runtime audit §1.3).",
    "",
  );
  return `${lines.join("\n")}\n`;
}

async function main() {
  const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, "").split("=")));
  if (!args.dataset) throw new Error("usage: --dataset=<dir> [--out=<models root>]");
  const datasetManifest = JSON.parse(fs.readFileSync(path.join(args.dataset, "manifest.json"), "utf8"));
  const records = readNdjsonGz(datasetManifest.uri.replace(/^file:\/\//, ""));
  const templates = readWorkTable("templates");
  const blockedRow = readWorkTable("system_control_templates").find((r) => r.key === "sms_blocked_template_ids");
  const blocked = new Set(String(blockedRow?.value ?? "").split(",").map((s) => s.trim()).filter(Boolean));
  const governance = readWorkTable("rotation_control");
  const result = runOpe({ records, templates, blocked, governance });
  const outDir = path.join(args.out || MODELS_ROOT, "template_ope", "v0");
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, "ope.json"), `${JSON.stringify({ dataset_id: datasetManifest.dataset_id, seed: SEED, label: "evaluation on logged data, not a counterfactual guarantee", ...result }, null, 2)}\n`);
  fs.writeFileSync(path.join(outDir, "report.md"), renderReport(result, { datasetManifest }));
  const r = result.rewards.reply_any;
  console.log(`reply_any rows ${r.counts.used} logged ${f(r.on_policy_mean, 4)}`);
  for (const [k, p] of Object.entries(r.policies)) console.log(`  ${k}: snipw ${ciText(p.snipw, 4)} diff ${ciText(p.vs_logged, 4)} ess ${f(p.ess, 0)}`);
  const c = result.rewards.carrier_filtered;
  for (const [k, p] of Object.entries(c.policies)) console.log(`  spam ${k}: snipw ${ciText(p.snipw, 4)} diff ${ciText(p.vs_logged, 4)}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(String(error?.stack || error).slice(0, 800));
    process.exit(1);
  });
}
